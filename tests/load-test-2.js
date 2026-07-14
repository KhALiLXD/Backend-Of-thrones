// ============================================================================
// APPROACH 2 — QUEUE-BASED WORKERS
//
//   k6 run tests/load-test-2.js                    -> A/B  (closed, 300 VUs)
//   k6 run -e PROFILE=stress tests/load-test-2.js  -> STRESS (open, arrival rate)
//
// The API validates, reserves stock atomically in Redis, enqueues, and returns
// 202. Fulfillment happens in background workers, so the HTTP response is NOT
// the confirmation — completion must be observed separately. That is why this
// file has a status loop and load-test-1 does not. Architectural difference,
// not a measurement one.
//
// POLLING NOTE: the system exposes SSE (/sse/products/stock/:id), but this
// test POLLS. Polling is what is measured, so no claim about SSE reducing
// load may be drawn from these numbers.
//
// STRESS NOTE: the stress profile does NOT poll. At 6,000 req/s, holding each
// VU for a 30s status loop would require ~180,000 concurrent VUs. So stress
// measures INGRESS capacity (can the API absorb the burst?) and the real
// fulfillment count is read from the DB after the queue drains:
//
//     SELECT status, count(*) FROM "Orders" GROUP BY status;
//
// That split is itself the finding: Approach 2 can ACK a burst it cannot yet
// FULFILL. The queue absorbs it. Approach 1 has nowhere to put it.
// ============================================================================

import http from 'k6/http';
import { sleep } from 'k6';
import {
    OPTIONS, PROFILE, PRODUCT_ID, MAX_RETRIES, RETRYABLE,
    THINK_TIME, TRACK_ORDERS,
    metrics, backoff, idempotencyKey, randomToken,
    verifyPreconditions, reportInvariant,
} from './config.js';

export const options = OPTIONS;

// ARCHITECTURAL: behind nginx, load-balanced across 2 API containers.
const BASE_URL = 'http://localhost/api';
const PURCHASE_ENDPOINT = `${BASE_URL}/order/buy-flash`;

const MAX_STATUS_CHECKS = 60;        // 60 x 0.5s = 30s window
const STATUS_CHECK_INTERVAL = 0.5;

export function setup() {
    console.log('\n' + '='.repeat(74));
    console.log('  APPROACH 2 — QUEUE-BASED WORKERS');
    console.log('='.repeat(74));
    verifyPreconditions(BASE_URL);
    console.log('='.repeat(74) + '\n');
}

// ---------------------------------------------------------------------------
// Poll a queued order to a terminal state.  (A/B profile only.)
// ---------------------------------------------------------------------------
function trackOrder(orderId, token, acceptedAt) {
    for (let i = 0; i < MAX_STATUS_CHECKS; i++) {
        sleep(STATUS_CHECK_INTERVAL);

        const res = http.get(`${BASE_URL}/order/${orderId}/status`, {
            headers: { 'Authorization': `Bearer ${token}` },
            timeout: '10s',
        });

        if (res.status !== 200) continue;

        let status;
        try {
            status = JSON.parse(res.body).status;
        } catch (e) {
            continue;
        }

        if (status === 'confirmed') {
            metrics.ordersConfirmed.add(1);
            metrics.totalOrderTime.add(Date.now() - acceptedAt);
            metrics.orderSuccessRate.add(1);
            return;
        }

        if (status === 'payment_failed' || status === 'failed') {
            if (status === 'payment_failed') metrics.paymentDeclined.add(1);
            metrics.ordersFailed.add(1);
            metrics.totalOrderTime.add(Date.now() - acceptedAt);
            metrics.orderSuccessRate.add(0);
            return;
        }

        // The gateway timed out and the charge outcome is UNKNOWN. The system
        // deliberately refuses to guess: it will not release the stock (the
        // customer may have been charged) and it will not confirm (they may
        // not have been). It flags for manual reconciliation instead.
        if (status === 'needs_reconciliation') {
            console.error(`[RECONCILIATION] ${orderId} — gateway outcome unknown`);
            metrics.needsReconciliation.add(1);
            metrics.orderSuccessRate.add(0);
            return;
        }

        // pending / processing / awaiting_payment / processing_payment -> wait
    }

    // Never resolved inside the window. From the customer's point of view an
    // order that never completes has failed.
    metrics.ordersTimeout.add(1);
    metrics.orderSuccessRate.add(0);
}

export default function () {
    const token = randomToken();

    // ---- Shopper behaviour (A/B profile only) ------------------------------
    if (THINK_TIME) {
        const productRes = http.get(`${BASE_URL}/products/${PRODUCT_ID}`, { timeout: '10s' });

        if (productRes.status !== 200) {
            metrics.unknownErrors.add(1);
            sleep(1);
            return;
        }

        let product;
        try {
            product = JSON.parse(productRes.body);
        } catch (e) {
            metrics.unknownErrors.add(1);
            return;
        }

        if (product.stock <= 0) {
            metrics.outOfStock.add(1);
            return;
        }

        sleep(0.3);
    }

    // ---- Purchase ---------------------------------------------------------
    const idemKey = idempotencyKey(__VU, __ITER);
    let firstOrderId = null;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        const start = Date.now();

        let res;
        try {
            res = http.post(
                PURCHASE_ENDPOINT,
                JSON.stringify({ productId: PRODUCT_ID }),
                {
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${token}`,
                        'Idempotency-Key': idemKey,
                    },
                    timeout: '60s',
                }
            );
        } catch (e) {
            metrics.timeouts.add(1);
            metrics.purchaseErrors.add(1);
            if (attempt < MAX_RETRIES) { sleep(backoff(attempt)); continue; }
            metrics.ordersTimeout.add(1);
            metrics.orderSuccessRate.add(0);
            return;
        }

        const elapsed = Date.now() - start;
        metrics.purchaseLatency.add(elapsed);

        // ---- ACCEPTED (202) -----------------------------------------------
        // Stock is RESERVED and the order is queued. This is the ACK, not the
        // confirmation. The whole point of the architecture is that this
        // number stays small while fulfillment happens elsewhere.
        if (res.status === 202 || res.status === 201 || res.status === 200) {
            let orderId;
            try {
                orderId = JSON.parse(res.body).orderId;
            } catch (e) {
                metrics.unknownErrors.add(1);
                metrics.purchaseErrors.add(1);
                return;
            }

            if (!orderId) {
                console.error('[BUG] accepted with no orderId');
                metrics.unknownErrors.add(1);
                metrics.purchaseErrors.add(1);
                return;
            }

            // A retry must replay the ORIGINAL order. A different id means the
            // retry consumed a SECOND unit of stock.
            if (attempt > 1 && firstOrderId !== null) {
                if (String(orderId) === String(firstOrderId)) {
                    metrics.idempotentReplays.add(1);
                } else {
                    metrics.idempotencyBreaks.add(1);
                    console.error(`[IDEMPOTENCY BREAK] key=${idemKey} first=${firstOrderId} retry=${orderId}`);
                }
            }
            if (firstOrderId === null) firstOrderId = orderId;

            metrics.purchasesAccepted.add(1);
            metrics.purchaseErrors.add(0);

            if (TRACK_ORDERS) trackOrder(orderId, token, start);
            return;
        }

        // ---- SOLD OUT (terminal) ------------------------------------------
        // The Redis DECR went negative and was rolled back. Correct behaviour.
        if (res.status === 409) {
            metrics.outOfStock.add(1);
            metrics.purchaseErrors.add(0);
            return;
        }

        // ---- Terminal client errors ---------------------------------------
        if (res.status === 401) { metrics.unauthorized.add(1); metrics.purchaseErrors.add(1); return; }
        if (res.status === 400) { metrics.badRequest.add(1);   metrics.purchaseErrors.add(1); return; }

        // ---- Transient — retry --------------------------------------------
        // 503 = the queue limiter shed load. That is backpressure working as
        // designed, so the client backs off and retries with the SAME key.
        if (res.status === 503)      metrics.queueFull.add(1);
        else if (res.status === 429) metrics.rateLimited.add(1);
        else if (res.status === 425) { /* idempotency in-flight — retry */ }
        else if (res.status === 408) metrics.timeouts.add(1);
        else if (res.status >= 500)  metrics.serverErrors.add(1);
        else                         metrics.unknownErrors.add(1);

        metrics.purchaseErrors.add(1);

        if (RETRYABLE.includes(res.status) && attempt < MAX_RETRIES) {
            sleep(backoff(attempt));
            continue;
        }

        metrics.ordersFailed.add(1);
        metrics.orderSuccessRate.add(0);
        return;
    }
}

export function teardown() {
    reportInvariant(BASE_URL, 'APPROACH 2 — QUEUE-BASED');
}