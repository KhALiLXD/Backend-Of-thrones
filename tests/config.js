// ============================================================================
// SHARED TEST CONFIGURATION
//
//   k6 run tests/load-test-1.js                    -> AB profile (default)
//   k6 run -e PROFILE=stress tests/load-test-1.js  -> STRESS profile
//
// Both test files import from here. Anything that affects MEASUREMENT lives
// in this file so the two approaches cannot drift apart. Only genuinely
// ARCHITECTURAL things (base URL, purchase endpoint, how completion is
// observed) live in the test files.
//
// ---------------------------------------------------------------------------
// THE TWO PROFILES MEASURE DIFFERENT THINGS. Do not mix their numbers.
// ---------------------------------------------------------------------------
//
// AB (closed model, ramping-vus):
//   Fixed pool of VUs. Each VU waits for its response before sending again.
//   If the system slows down, the offered load drops with it — the load
//   self-throttles. Good for a controlled A/B: same VU count, same think
//   time, same everything, so latency differences are attributable to the
//   architecture.
//
//   BUT it FLATTERS a slow synchronous system. Approach 1 holds a connection
//   through a ~700ms-2.5s payment call; under a closed model the VUs simply
//   queue up politely and the error rate stays low. That is not what a flash
//   sale does.
//
// STRESS (open model, ramping-arrival-rate):
//   k6 generates a target REQUESTS-PER-SECOND regardless of how slow the
//   system is. Real users do not wait their turn — 100,000 people hit the
//   endpoint when the sale opens whether the server is ready or not.
//
//   This is where the architectural difference actually shows. Approach 1's
//   in-flight connections pile up until something gives. Approach 2 acks in
//   ~50ms and lets the queue absorb the burst.
//
// ---------------------------------------------------------------------------
// ON "100,000 USERS"
// ---------------------------------------------------------------------------
//   100k CONCURRENT VUs is not achievable on one 8-core / 16GB laptop that is
//   also running the system under test. k6 needs ~2-5MB per VU, and Windows
//   caps ephemeral ports around 16k by default.
//
//   But 100k concurrent VUs is NOT what a 100k-user flash sale is. It is an
//   ARRIVAL RATE: 100,000 people arriving over a 60s window is ~1,667 req/s.
//   That is the number that matters to the server, and it is measurable here.
//
//   So the stress profile ramps ARRIVAL RATE, not VU count. Report it as:
//   "modeled a 100k-user flash sale as a sustained arrival rate of X req/s"
//   — never as "100k concurrent users".
// ============================================================================

import { SharedArray } from 'k6/data';
import http from 'k6/http';
import { Counter, Trend, Rate } from 'k6/metrics';

export const PROFILE = __ENV.PROFILE || 'ab';

// ---------------------------------------------------------------------------
// Tokens — seeded offline by scripts/seed-users.js
//
// SharedArray keeps ONE copy in memory across all VUs. Without it, 10k tokens
// x 12,000 VUs would blow out the heap before the test starts.
// ---------------------------------------------------------------------------

export const TOKENS = new SharedArray('tokens', () => JSON.parse(open('./tokens.json')));

export function randomToken() {
    return TOKENS[Math.floor(Math.random() * TOKENS.length)];
}

// ---------------------------------------------------------------------------
// Profiles
// ---------------------------------------------------------------------------

const PROFILES = {

    // -- A/B COMPARISON --------------------------------------------------
    // Controlled, closed model. This is the run whose numbers go in the
    // report's headline comparison table.
    ab: {
        productId: 13,
        initialStock: 10000000,
        thinkTime: true,          // GET /products + 0.3s, like a real shopper
        trackOrders: true,        // poll to completion (Approach 2)
        maxRetries: 3,

        scenario: {
            executor: 'ramping-vus',
            startVUs: 0,
            gracefulRampDown: '30s',
            stages: [
                { duration: '30s', target: 50 },
                { duration: '1m',  target: 150 },
                { duration: '2m',  target: 300 },   // peak
                { duration: '1m',  target: 100 },
                { duration: '30s', target: 0 },
            ],
        },

        thresholds: {
            'order_success_rate': ['rate>0.85'],
            'purchase_latency':   ['p(95)<1000'],
            'total_order_time':   ['p(95)<15000'],
            'http_req_failed':    ['rate<0.05'],
            'server_errors_5xx':  ['count<100'],
            'timeout_408':        ['count<50'],
            'unauthorized_401':   ['count<10'],
        },
    },

    // -- STRESS / BREAKING POINT ------------------------------------------
    // Open model. Finds where each architecture actually falls over.
    //
    // Arrival-rate targets, and the flash-sale population each represents
    // if the sale window is 60 seconds:
    //
    //     500 req/s   ->  ~30,000 users
    //   1,700 req/s   -> ~100,000 users   <-- the headline scenario
    //   3,500 req/s   -> ~210,000 users
    //   6,000 req/s   -> ~360,000 users
    //
    // maxVUs is a CEILING, not a target. k6 allocates VUs as needed to
    // sustain the arrival rate; if the system is slow it needs more of them.
    // When k6 prints "Insufficient VUs, reached X active VUs and cannot
    // initiate iteration" — THAT IS THE FINDING. It means the system could
    // not absorb the offered load and requests are backing up. Record the
    // rate at which it first appears.
    stress: {
        productId: 13,
        initialStock: 10_000_000,   // must never sell out, or you measure 409s
        thinkTime: false,           // bare write path, no GET, no sleep
        trackOrders: true,         // polling would need 300k+ VUs at 10k req/s
        maxRetries: 1,              // retries distort the arrival rate

        scenario: {
            executor: 'ramping-arrival-rate',
            startRate: 100,
            timeUnit: '1s',
            preAllocatedVUs: 500,
            maxVUs: 12000,          // raise only if you also raise Windows ports
            stages: [
                { duration: '30s', target: 100 },    // warm-up
                { duration: '30s', target: 500 },
                { duration: '90s', target: 500 },    // hold — is it steady?
                { duration: '30s', target: 1700 },
                { duration: '90s', target: 1700 },   // <-- 100k-user equivalent
                { duration: '30s', target: 3500 },
                { duration: '90s', target: 3500 },
                { duration: '30s', target: 6000 },
                { duration: '90s', target: 6000 },
                { duration: '30s', target: 0 },
            ],
        },

        // No abortOnFail: we WANT to see it break, not stop at the first crack.
        thresholds: {
            'purchase_errors':  ['rate<0.01'],
            'purchase_latency': ['p(95)<2000'],
        },
    },
};

const P = PROFILES[PROFILE];
if (!P) throw new Error(`Unknown PROFILE "${PROFILE}". Use: ab | stress`);

export const PRODUCT_ID    = P.productId;
export const INITIAL_STOCK = P.initialStock;
export const THINK_TIME    = P.thinkTime;
export const TRACK_ORDERS  = P.trackOrders;
export const MAX_RETRIES   = P.maxRetries;

export const OPTIONS = {
    scenarios: { main: P.scenario },
    thresholds: P.thresholds,
    setupTimeout: '120s',
    teardownTimeout: '120s',
    noConnectionReuse: false,        // keep-alive — otherwise Windows runs out of ports
    summaryTrendStats: ['avg', 'med', 'p(90)', 'p(95)', 'p(99)', 'max'],
};

// ---------------------------------------------------------------------------
// Metrics — identical names in both test files
// ---------------------------------------------------------------------------

export const metrics = {
    purchasesAccepted:  new Counter('purchases_accepted'),
    ordersConfirmed:    new Counter('orders_confirmed'),
    ordersFailed:       new Counter('orders_failed'),
    ordersTimeout:      new Counter('orders_timeout'),
    needsReconciliation:new Counter('needs_reconciliation'),

    outOfStock:         new Counter('out_of_stock_409'),
    paymentDeclined:    new Counter('payment_declined_402'),
    queueFull:          new Counter('queue_full_503'),
    rateLimited:        new Counter('rate_limited_429'),
    timeouts:           new Counter('timeout_408'),
    serverErrors:       new Counter('server_errors_5xx'),
    unauthorized:       new Counter('unauthorized_401'),
    badRequest:         new Counter('bad_request_400'),
    unknownErrors:      new Counter('unknown_errors'),

    idempotentReplays:  new Counter('idempotent_replays'),
    idempotencyBreaks:  new Counter('idempotency_breaks'),   // > 0 == BUG

    purchaseLatency:    new Trend('purchase_latency'),       // the POST (ack)
    totalOrderTime:     new Trend('total_order_time'),       // POST -> confirmed

    orderSuccessRate:   new Rate('order_success_rate'),      // confirmed / entered-funnel
    purchaseErrors:     new Rate('purchase_errors'),         // stress-profile headline
};

// ---------------------------------------------------------------------------
// Retry policy — identical in both.
// Retry ONLY transient failures. 402 (declined) and 409 (sold out) are
// business answers, not glitches. 425 = idempotency layer says the original
// request is still in flight.
// ---------------------------------------------------------------------------

export const RETRYABLE = [425, 503, 429, 408, 500, 502, 504];

export function backoff(attempt) {
    return 2 * attempt;
}

// ---------------------------------------------------------------------------
// Idempotency key — STABLE across retries of the same logical purchase.
// A key containing Date.now() or the attempt number is not an idempotency
// key: every retry becomes a brand-new operation and the layer does nothing.
// Call ONCE per iteration, OUTSIDE the retry loop.
// ---------------------------------------------------------------------------

export function idempotencyKey(vu, iter) {
    return `k6-${PROFILE}-${vu}-${iter}`;
}

// ---------------------------------------------------------------------------
// Preconditions. Fail LOUD — a run against a dirty DB produces numbers that
// look plausible and mean nothing.
// ---------------------------------------------------------------------------

export function verifyPreconditions(baseUrl) {
    if (TOKENS.length === 0) {
        throw new Error('SETUP FAILED: tests/tokens.json is empty. Run scripts/seed-users.js first.');
    }

    const res = http.get(`${baseUrl}/products/${PRODUCT_ID}`, { timeout: '10s' });
    if (res.status !== 200) {
        throw new Error(`SETUP FAILED: GET /products/${PRODUCT_ID} -> ${res.status}`);
    }

    const stock = JSON.parse(res.body).stock;
    if (stock !== INITIAL_STOCK) {
        throw new Error(
            `SETUP FAILED: stock is ${stock}, expected ${INITIAL_STOCK}.\n` +
            `  UPDATE "Products" SET stock = ${INITIAL_STOCK} WHERE id = ${PRODUCT_ID};\n` +
            `  then re-run scripts/initStock.js`
        );
    }

    console.log(`profile=${PROFILE}  product=${PRODUCT_ID}  stock=${stock}  tokens=${TOKENS.length}`);
}

// ---------------------------------------------------------------------------
// Teardown: the stock invariant.
//
//     purchases_accepted  <=  INITIAL_STOCK + payment_declined_402
//
// Every accepted order consumes one reserved unit; a decline releases it.
// Exceeding this bound means the reservation counter was corrupted and the
// API handed out acks against stock that did not exist. The pre-fix run
// failed this: 1,275 accepted against 1,000 units.
// ---------------------------------------------------------------------------

export function reportInvariant(baseUrl, label) {
    const res = http.get(`${baseUrl}/products/${PRODUCT_ID}`, { timeout: '10s' });
    const finalStock = res.status === 200 ? JSON.parse(res.body).stock : 'UNKNOWN';

    console.log('\n' + '='.repeat(74));
    console.log(`  ${label}  [profile: ${PROFILE}]`);
    console.log('='.repeat(74));
    console.log(`  stock:  ${INITIAL_STOCK}  ->  ${finalStock}`);
    console.log('');
    console.log('  CHECK against the metrics below:');
    console.log(`    purchases_accepted  <=  ${INITIAL_STOCK} + payment_declined_402`);
    console.log(`    orders_confirmed    <=  ${INITIAL_STOCK}`);
    console.log('    idempotency_breaks  ==  0        <-- any value above 0 is a BUG');
    console.log('    final_stock         >=  0');

    if (!TRACK_ORDERS) {
        console.log('');
        console.log('  This profile does not poll for completion. Get the real');
        console.log('  fulfillment numbers from the DB after the queue drains:');
        console.log('');
        console.log('    SELECT status, count(*) FROM "Orders" GROUP BY status;');
    }
    console.log('='.repeat(74) + '\n');
}
