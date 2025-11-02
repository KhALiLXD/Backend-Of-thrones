import http from 'k6/http';
import { sleep } from 'k6';
import { Counter, Trend, Rate } from 'k6/metrics';

// ✅ Success Metrics
const successfulPurchases = new Counter('successful_purchases');
const fullyConfirmedOrders = new Counter('fully_confirmed_orders');

// 🔴 Expected Failures
const paymentDeclined = new Counter('payment_declined_402');
const outOfStock = new Counter('out_of_stock_409');
const queueFull = new Counter('queue_full_503');
const rateLimited = new Counter('rate_limited_429');

// ⚠️ Real Issues
const badRequest = new Counter('bad_request_400');
const unauthorized = new Counter('unauthorized_401');
const notFound = new Counter('not_found_404');
const timeout = new Counter('timeout_408');
const serverErrors = new Counter('server_errors_5xx');
const unknownErrors = new Counter('unknown_errors');

// 📊 Performance Metrics
const purchaseLatency = new Trend('purchase_latency');
const orderProcessingTime = new Trend('order_processing_time');
const paymentProcessingTime = new Trend('payment_processing_time');
const totalOrderTime = new Trend('total_order_time');

// 📈 Order Status Tracking
const ordersQueued = new Counter('orders_queued');
const ordersProcessing = new Counter('orders_processing');
const ordersPending = new Counter('orders_pending');
const ordersAwaitingPayment = new Counter('orders_awaiting_payment');
const ordersProcessingPayment = new Counter('orders_processing_payment');
const ordersConfirmed = new Counter('orders_confirmed');
const ordersFailed = new Counter('orders_failed');
const ordersPaymentFailed = new Counter('orders_payment_failed');
const ordersTimeout = new Counter('orders_timeout');

// Success Rate (بين المقبولين فقط)
const orderSuccessRate = new Rate('order_success_rate');

// ===== k6 options =====
export const options = {
  stages: [
    { duration: '30s', target: 100 },
    { duration: '1m', target: 300 },
    { duration: '2m', target: 500 },
    { duration: '1m', target: 200 },
    { duration: '30s', target: 0 },
  ],
  thresholds: {
    'server_errors_5xx': ['count<100'],
    'bad_request_400': ['count<50'],
    'unauthorized_401': ['count<10'],
    'timeout_408': ['count<50'],
    'order_success_rate': ['rate>0.7'],
    'total_order_time': ['p(95)<15000'],
  },
};

// ===== CONFIG =====
const BASE_URL = 'http://localhost/api';
const PRODUCT_ID = 21;              // غيّرها لو بدك
const MAX_RETRIES = 3;
const POLL_WINDOW_MS = 20000;       // 20s نافذة تتبّع
const POLL_INTERVAL_MS = 400;       // 0.4s بين الاستعلامات
const FINAL_RECONCILE = true;       // تصالح أخير GET /order/:id

let TEST_USERS = [];

// ===== Utils =====
const NC_HEADERS = {
  'Cache-Control': 'no-cache',
  'Pragma': 'no-cache',
};

function norm(s) {
  return String(s || '').trim().toLowerCase();
}

function extractToken(res) {
  try {
    const b = JSON.parse(res.body);
    return b.token || b.accessToken || b.jwt || null;
  } catch { return null; }
}

function parseOrderRef(body, headers) {
  let orderId = null, statusUrl = null;
  try {
    const d = JSON.parse(body || '{}');
    orderId = d.orderId ?? d.id ?? d.order_id ?? null;
    statusUrl = d.checkStatusUrl ?? d.status_url ?? null;
  } catch {}
  if (!statusUrl && headers && (headers.Location || headers.location)) {
    statusUrl = headers.Location || headers.location;
  }
  if (statusUrl && statusUrl.startsWith('/')) {
    statusUrl = `${BASE_URL.replace(/\/$/, '')}${statusUrl}`;
  }
  return { orderId, statusUrl };
}

function tagState(state) {
  switch (state) {
    case 'queued': ordersQueued.add(1); break;
    case 'processing': ordersProcessing.add(1); break;
    case 'pending': ordersPending.add(1); break;
    case 'awaiting_payment': ordersAwaitingPayment.add(1); break;
    case 'processing_payment': ordersProcessingPayment.add(1); break;
    case 'confirmed':
    case 'completed':
    case 'success':
    case 'paid':
      ordersConfirmed.add(1); break;
    case 'payment_failed':
      ordersPaymentFailed.add(1); break;
    case 'failed':
    case 'canceled':
    case 'cancelled':
    case 'declined':
      ordersFailed.add(1); break;
  }
}

function isFinalSuccess(state) {
  state = norm(state);
  return state === 'confirmed' || state === 'completed' || state === 'success' || state === 'paid';
}
function isFinalFail(state) {
  state = norm(state);
  return (
    state === 'failed' ||
    state === 'payment_failed' ||
    state === 'canceled' ||
    state === 'cancelled' ||
    state === 'declined'
  );
}

function statusCandidates(orderId, statusUrl) {
  const arr = [];
  if (statusUrl) arr.push(statusUrl);
  if (orderId) {
    arr.push(`${BASE_URL}/order/${orderId}/status`);
    arr.push(`${BASE_URL}/orders/${orderId}/status`);
  }
  return arr;
}

function getJson(url, headers, timeoutMs) {
  try {
    const res = http.get(url, { headers, timeout: `${timeoutMs}ms` });
    if (res.status === 200) {
      try { return { ok: true, data: JSON.parse(res.body), res }; }
      catch { return { ok: true, data: {}, res }; }
    }
    return { ok: false, res };
  } catch (e) {
    return { ok: false, err: e };
  }
}

function trackOrder({ orderId, statusUrl, userToken, shouldLog }) {
  const start = Date.now();
  const until = start + POLL_WINDOW_MS;
  let lastState = null;

  const timings = {
    queued: null,
    processing: null,
    pending: null,
    awaiting_payment: null,
    processing_payment: null,
    confirmed: null,
  };

  const headers = { Authorization: `Bearer ${userToken}`, ...NC_HEADERS };

  while (Date.now() < until) {
    const candidates = statusCandidates(orderId, statusUrl);

    let got = null, data = null;
    for (const url of candidates) {
      const r = getJson(url, headers, 5000);
      if (r.ok) { got = r.res; data = r.data; break; }
      // لو 404، جرّب مسار تاني، غيره تجاهله كمؤقت
    }

    if (got && got.status === 200) {
      const state = norm(data?.status || data?.state || data?.order_status);
      if (state) {
        if (state !== lastState) {
          tagState(state);
          lastState = state;
          const now = Date.now() - start;
          if (timings.hasOwnProperty(state)) timings[state] = now;
        }

        if (isFinalSuccess(state)) {
          const total = Date.now() - start;
          totalOrderTime.add(total);
          if (timings.processing != null && timings.queued != null)
            orderProcessingTime.add(timings.processing - timings.queued);
          if (timings.confirmed != null && timings.awaiting_payment != null)
            paymentProcessingTime.add(timings.confirmed - timings.awaiting_payment);
          fullyConfirmedOrders.add(1);
          orderSuccessRate.add(1);
          if (shouldLog) console.log(`[Order ${orderId || '?'}] ✅ ${state} in ${total}ms`);
          return { success: true, state, total };
        }
        if (isFinalFail(state)) {
          orderSuccessRate.add(0);
          if (shouldLog) console.log(`[Order ${orderId || '?'}] ❌ ${state}`);
          return { success: false, state };
        }
      }
    }
    sleep(POLL_INTERVAL_MS / 1000);
  }

  // مصالحة نهائية
  if (FINAL_RECONCILE && orderId) {
    const r = getJson(`${BASE_URL}/order/${orderId}/status`, { Authorization: `Bearer ${userToken}`, ...NC_HEADERS }, 5000);
    if (r.ok) {
      const st = norm(r.data?.status || r.data?.state || r.data?.order_status);
      if (isFinalSuccess(st)) {
        const total = Date.now() - start;
        totalOrderTime.add(total);
        fullyConfirmedOrders.add(1);
        orderSuccessRate.add(1);
        console.log(`[Order ${orderId}] ✅ confirmed (late) after polling window`);
        return { success: true, state: st, total, late: true };
      }
      if (isFinalFail(st)) {
        orderSuccessRate.add(0);
        console.log(`[Order ${orderId}] ❌ ${st} (found on reconcile)`);
        return { success: false, state: st };
      }
    }
  }

  ordersTimeout.add(1);
  orderSuccessRate.add(0);
  if (shouldLog) console.log(`[Order ${orderId || '?'}] ⏱️ timeout after ${POLL_WINDOW_MS}ms`);
  return { success: false, state: 'timeout' };
}

// ===== Setup =====
export function setup() {
  console.log('\n' + '='.repeat(70));
  console.log('🚀 BLACK FRIDAY LOAD TEST — truthful tracking');
  console.log('='.repeat(70) + '\n');

  const users = [];
  for (let i = 0; i < 50; i++) {
    const u = { name: `TestUser${i}`, email: `testuser${i}@test.com`, password: 'test123456' };
    try {
      let res = http.post(`${BASE_URL}/auth/register`, JSON.stringify(u),
        { headers: { 'Content-Type': 'application/json' }, timeout: '10s' });
      if (res.status === 409) {
        res = http.post(`${BASE_URL}/auth/login`, JSON.stringify({ email: u.email, password: u.password }),
          { headers: { 'Content-Type': 'application/json' }, timeout: '10s' });
      }
      const t = extractToken(res);
      if (t) users.push(t);
    } catch { /* ignore */ }
  }
  console.log(`✅ ${users.length} users ready\n`);
  return { testUsers: users };
}

// ===== Main =====
export default function (data) {
  if (!data?.testUsers?.length) {
    console.log('❌ No users available');
    return;
  }

  const userToken = data.testUsers[Math.floor(Math.random() * data.testUsers.length)];
  const shouldLog = __VU % 100 === 0;

  let orderId = null, statusUrl = null, purchaseSuccess = false;

  for (let attempt = 1; attempt <= MAX_RETRIES && !purchaseSuccess; attempt++) {
    const payload = JSON.stringify({ productId: PRODUCT_ID });
    const started = Date.now();

    let res;
    try {
      res = http.post(`${BASE_URL}/order/buy-flash`, payload, {
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${userToken}` },
        timeout: '15s',
      });
    } catch (e) {
      if (shouldLog) console.log(`[VU ${__VU}] ❌ POST error: ${e.message}`);
      unknownErrors.add(1);
      if (attempt < MAX_RETRIES) { sleep(2 * attempt); continue; }
      return;
    }

    const latency = Date.now() - started;
    purchaseLatency.add(latency);

    // نقبل 200/201/202 + 302/303 (redirect with Location)
    if ([200, 201, 202].includes(res.status) || [302, 303].includes(res.status)) {
      successfulPurchases.add(1);
      purchaseSuccess = true;

      const ref = parseOrderRef(res.body, res.headers);
      orderId = ref.orderId || orderId;
      statusUrl = ref.statusUrl || statusUrl;

      if (shouldLog) console.log(`[VU ${__VU}] ✅ accepted: id=${orderId || 'n/a'} url=${statusUrl || 'n/a'}`);

      const r = trackOrder({ orderId, statusUrl, userToken, shouldLog });
      if (!r.success && r.state === 'timeout') timeout.add(1);
      return;
    }

    // Expected
    if (res.status === 402) { paymentDeclined.add(1); if (shouldLog) console.log(`[VU ${__VU}] 402`); return; }
    if (res.status === 409) { outOfStock.add(1);       if (shouldLog) console.log(`[VU ${__VU}] 409`); return; }
    if (res.status === 503) { queueFull.add(1);        if (attempt < MAX_RETRIES) { sleep(2 * attempt); continue; } return; }
    if (res.status === 429) { rateLimited.add(1);      if (attempt < MAX_RETRIES) { sleep(3 * attempt); continue; } return; }

    // Real issues
    if (res.status === 400) { badRequest.add(1); if (shouldLog) console.log(`[VU ${__VU}] 400 ${res.body?.slice(0,200)||''}`); return; }
    if (res.status === 401) { unauthorized.add(1);     if (shouldLog) console.log(`[VU ${__VU}] 401`); return; }
    if (res.status === 404) { notFound.add(1);         if (shouldLog) console.log(`[VU ${__VU}] 404`); return; }
    if (res.status === 408) { timeout.add(1);          if (attempt < MAX_RETRIES) { sleep(3 * attempt); continue; } return; }
    if (res.status >= 500) { serverErrors.add(1);      if (attempt < MAX_RETRIES) { sleep(2 * attempt); continue; } return; }

    unknownErrors.add(1);
    if (shouldLog) console.log(`[VU ${__VU}] ??? status=${res.status}`);
    return;
  }
}

// ===== Teardown =====
export function teardown() {
  console.log('\n' + '='.repeat(70));
  console.log('📊 DETAILED TEST RESULTS ANALYSIS');
  console.log('='.repeat(70));
  console.log('\n✅ SUCCESS METRICS: successful_purchases, fully_confirmed_orders, order_success_rate');
  console.log('\n📈 FLOW: queued, processing, pending, awaiting_payment, processing_payment, confirmed/failed/payment_failed/timeout');
  console.log('\n⏱️ PERF: purchase_latency, order_processing_time, payment_processing_time, total_order_time');
  console.log('\n🔴 EXPECTED: 402/409/503/429 | ⚠️ REAL: 400/401/404/408/5xx/unknown');
  console.log('\n' + '='.repeat(70) + '\n');
}
