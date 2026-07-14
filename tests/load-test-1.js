// ============================================================================
// APPROACH 1 — SYNCHRONOUS
//
//   k6 run tests/load-test-1.js                    -> A/B  (closed, 300 VUs)
//   k6 run -e PROFILE=stress tests/load-test-1.js  -> STRESS (open, arrival rate)
//
// Single Node process, no reverse proxy. The request holds its connection
// through the whole payment call, so the HTTP response IS the confirmation.
// There is nothing to poll — that is the architecture, and it is why this
// file has no status loop while load-test-2 does.
//
// Everything that affects MEASUREMENT comes from ./config.js and is identical
// to Approach 2.
// ============================================================================

import http from 'k6/http';
import { sleep } from 'k6';
import {
    OPTIONS, PROFILE, PRODUCT_ID, MAX_RETRIES, RETRYABLE, THINK_TIME,
    metrics, backoff, idempotencyKey, randomToken,
    verifyPreconditions, reportInvariant,
} from './config.js';

export const options = OPTIONS;

// ARCHITECTURAL: bare process, direct. No nginx, no containers.
const BASE_URL = 'http://localhost:3000';
const PURCHASE_ENDPOINT = `${BASE_URL}/order/buy`;

export function setup() {
    console.log('\n' + '='.repeat(74));
    console.log('  APPROACH 1 — SYNCHRONOUS');
    console.log('='.repeat(74));
    verifyPreconditions(BASE_URL);
    console.log('='.repeat(74) + '\n');
}

export default function () {
    const token = randomToken();

    // ---- Shopper behaviour (A/B profile only) ------------------------------
    // In the stress profile we hit the write path bare: a GET + sleep would
    // dilute the arrival rate we are trying to impose.
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
    // ONE key for this logical purchase, reused across every retry below.
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
            // Connection refused / reset / socket exhaustion. Under the open
            // model this is the shape a synchronous server fails in.
            metrics.timeouts.add(1);
            metrics.purchaseErrors.add(1);
            if (attempt < MAX_RETRIES) { sleep(backoff(attempt)); continue; }
            metrics.ordersTimeout.add(1);
            metrics.orderSuccessRate.add(0);
            return;
        }

        const elapsed = Date.now() - start;
        metrics.purchaseLatency.add(elapsed);

        // ---- CONFIRMED ----------------------------------------------------
        // Synchronous: a 201 means payment cleared and the order is committed.
        // ack latency == total order time here, by design.
        if (res.status === 200 || res.status === 201) {
            metrics.purchasesAccepted.add(1);
            metrics.ordersConfirmed.add(1);
            metrics.totalOrderTime.add(elapsed);
            metrics.orderSuccessRate.add(1);
            metrics.purchaseErrors.add(0);

            // A retry must REPLAY the original order. A different id means the
            // retry created a second order against a second unit of stock —
            // exactly what the idempotency layer exists to prevent.
            try {
                const orderId = JSON.parse(res.body).order?.id;
                if (attempt > 1 && firstOrderId !== null) {
                    if (String(orderId) === String(firstOrderId)) {
                        metrics.idempotentReplays.add(1);
                    } else {
                        metrics.idempotencyBreaks.add(1);
                        console.error(`[IDEMPOTENCY BREAK] key=${idemKey} first=${firstOrderId} retry=${orderId}`);
                    }
                }
                if (firstOrderId === null) firstOrderId = orderId;
            } catch (e) { /* body shape varies */ }

            return;
        }

        // ---- DECLINED (terminal) ------------------------------------------
        // Stock was taken, payment refused, stock refunded. A business answer,
        // not a glitch — so it is NOT an error and it is NOT retried.
        if (res.status === 402) {
            metrics.purchasesAccepted.add(1);
            metrics.paymentDeclined.add(1);
            metrics.ordersFailed.add(1);
            metrics.totalOrderTime.add(elapsed);
            metrics.orderSuccessRate.add(0);
            metrics.purchaseErrors.add(0);
            return;
        }

        // ---- SOLD OUT (terminal) ------------------------------------------
        // Correct behaviour. Excluded from order_success_rate — it never
        // entered the funnel. A system is not penalised for refusing correctly.
        if (res.status === 409) {
            metrics.outOfStock.add(1);
            metrics.purchaseErrors.add(0);
            return;
        }

        // ---- Terminal client errors ---------------------------------------
        if (res.status === 401) { metrics.unauthorized.add(1); metrics.purchaseErrors.add(1); return; }
        if (res.status === 400) { metrics.badRequest.add(1);   metrics.purchaseErrors.add(1); return; }

        // ---- Transient — retry --------------------------------------------
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
    reportInvariant(BASE_URL, 'APPROACH 1 — SYNCHRONOUS');
}