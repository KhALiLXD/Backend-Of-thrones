import http from 'k6/http';
import { check, sleep } from 'k6';
import { Counter, Trend, Rate } from 'k6/metrics';

// ✅ Success Metrics
const successfulPurchases = new Counter('successful_purchases');
const fullyConfirmedOrders = new Counter('fully_confirmed_orders');

// 🔴 Expected Failures (طبيعية ومتوقعة)
const paymentDeclined = new Counter('payment_declined_402');
const outOfStock = new Counter('out_of_stock_409');
const queueFull = new Counter('queue_full_503');
const rateLimited = new Counter('rate_limited_429');

// ⚠️ Real Issues (مشاكل حقيقية!)
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

// Success Rate
const orderSuccessRate = new Rate('order_success_rate');

export const options = {
  stages: [
    { duration: '30s', target: 50 },   
    { duration: '1m', target: 150 }, 
    { duration: '2m', target: 300 },   
    { duration: '1m', target: 100 },  
    { duration: '30s', target: 0 },
  ],
  thresholds: {
    'server_errors_5xx': ['count<100'],
    'bad_request_400': ['count<50'],
    'unauthorized_401': ['count<10'],
    'timeout_408': ['count<50'],
    'order_success_rate': ['rate>0.85'], 
    'total_order_time': ['p(95)<15000'],
  }
};

const BASE_URL = 'http://localhost/api';
const PRODUCT_IDS = [143];
const MAX_RETRIES = 3;
const MAX_STATUS_CHECKS = 60; // 30 محاولة × 500ms = 15 ثانية max
const STATUS_CHECK_INTERVAL = 0.5; // نص ثانية
const USE_FLASH_BUY=true
let TEST_USERS = [];

export function setup() {
  console.log('\n' + '='.repeat(70));
  console.log('🚀 BLACK FRIDAY LOAD TEST - WITH ORDER TRACKING');
  console.log('='.repeat(70) + '\n');

  console.log('Creating test users...');
  for (let i = 0; i < 50; i++) {
    const userData = {
      name: `TestUser${i}`,
      email: `testuser${i}@test.com`,
      password: 'test123456'
    };

    try {
      let res = http.post(
        `${BASE_URL}/auth/register`,
        JSON.stringify(userData),
        { headers: { 'Content-Type': 'application/json' }, timeout: '10s' }
      );

      if (res.status === 409) {
        res = http.post(
          `${BASE_URL}/auth/login`,
          JSON.stringify({ email: userData.email, password: userData.password }),
          { headers: { 'Content-Type': 'application/json' }, timeout: '10s' }
        );
      }

      if (res.status === 200 || res.status === 201) {
        TEST_USERS.push(JSON.parse(res.body).token);
      }
    } catch (e) {
      console.log(`Failed to setup user ${i}`);
    }
  }

  console.log(`✅ ${TEST_USERS.length} users ready\n`);
  return { testUsers: TEST_USERS };
}

function trackOrderStatus(orderId, userToken, shouldLog) {
  let currentStatus = 'queued';
  let attempts = 0;
  const startTime = Date.now();
  let lastStatus = null;
  
  const statusTimings = {
    queued: null,
    processing: null,
    pending: null,
    awaiting_payment: null,
    processing_payment: null,
    confirmed: null,
    failed: null
  };

  while (attempts < MAX_STATUS_CHECKS) {
    sleep(STATUS_CHECK_INTERVAL);
    attempts++;

    try {
      const statusRes = http.get(
        `${BASE_URL}/order/${orderId}/status`,
        {
          headers: { 'Authorization': `Bearer ${userToken}` },
          timeout: '5s'
        }
      );

      if (statusRes.status === 200) {
        const data = JSON.parse(statusRes.body);
        currentStatus = data.status;
        
        if (currentStatus !== lastStatus && statusTimings.hasOwnProperty(currentStatus)) {
          statusTimings[currentStatus] = Date.now() - startTime;
          lastStatus = currentStatus;
          
          switch(currentStatus) {
            case 'queued': ordersQueued.add(1); break;
            case 'processing': ordersProcessing.add(1); break;
            case 'pending': ordersPending.add(1); break;
            case 'awaiting_payment': ordersAwaitingPayment.add(1); break;
            case 'processing_payment': ordersProcessingPayment.add(1); break;
            case 'confirmed': ordersConfirmed.add(1); break;
            case 'failed': ordersFailed.add(1); break;
            case 'payment_failed': ordersPaymentFailed.add(1); break;
          }
        }

        if (currentStatus === 'confirmed') {
          const totalTime = Date.now() - startTime;
          totalOrderTime.add(totalTime);
          
          if (statusTimings.processing && statusTimings.queued) {
            orderProcessingTime.add(statusTimings.processing - statusTimings.queued);
          }
          
          if (statusTimings.confirmed && statusTimings.awaiting_payment) {
            paymentProcessingTime.add(statusTimings.confirmed - statusTimings.awaiting_payment);
          }
          
          fullyConfirmedOrders.add(1);
          orderSuccessRate.add(1);
          
          if (shouldLog) {
            console.log(`[Order ${orderId}] ✅ CONFIRMED in ${totalTime}ms`);
            console.log(`  Timings: queued→processing: ${statusTimings.processing}ms, payment: ${statusTimings.confirmed - statusTimings.awaiting_payment}ms`);
          }
          
          return { success: true, status: 'confirmed', totalTime, statusTimings };
        }
        
        if (currentStatus === 'failed' || currentStatus === 'payment_failed') {
          const totalTime = Date.now() - startTime;
          orderSuccessRate.add(0);
          
          if (shouldLog) {
            console.log(`[Order ${orderId}] ❌ FAILED: ${currentStatus} after ${totalTime}ms`);
            if (data.error) console.log(`  Error: ${data.error}`);
          }
          
          return { success: false, status: currentStatus, totalTime, error: data.error };
        }

      } else if (statusRes.status === 404) {
        if (shouldLog) console.log(`[Order ${orderId}] ❌ NOT FOUND (404)`);
        return { success: false, status: 'not_found', error: 'order not found' };
      }

    } catch (e) {
      if (shouldLog) console.log(`[Order ${orderId}] ⚠️  Status check error: ${e.message}`);
    }
  }

  const totalTime = Date.now() - startTime;
  ordersTimeout.add(1);
  orderSuccessRate.add(0);
  
  if (shouldLog) {
    console.log(`[Order ${orderId}] ⏱️  TIMEOUT after ${attempts} checks (${totalTime}ms)`);
    console.log(`  Last known status: ${currentStatus}`);
  }
  
  return { success: false, status: 'timeout', lastKnownStatus: currentStatus, totalTime };
}

export default function(data) {
  if (!data || !data.testUsers || data.testUsers.length === 0) {
    console.log('❌ No users available');
    return;
  }

  const userToken = data.testUsers[Math.floor(Math.random() * data.testUsers.length)];
  const productId = PRODUCT_IDS[Math.floor(Math.random() * PRODUCT_IDS.length)];
  
  const shouldLog = __VU % 100 === 0;

  const productRes = http.get(`${BASE_URL}/products/${productId}`, { timeout: '5s' });
  
  if (productRes.status !== 200) {
    if (shouldLog) console.log(`[VU ${__VU}] ❌ Failed to get product`);
    return;
  }

  let product;
  try {
    product = JSON.parse(productRes.body);
  } catch (e) {
    if (shouldLog) console.log(`[VU ${__VU}] ❌ Failed to parse product`);
    return;
  }

  if (product.stock <= 0) {
    if (shouldLog) console.log(`[VU ${__VU}] ⚠️  Product already out of stock`);
    outOfStock.add(1);
    return;
  }

  sleep(0.3);

  // Attempt purchase with retry
  let purchaseSuccess = false;
  let orderId = null;
  
  const endpoint = USE_FLASH_BUY ? `${BASE_URL}/order/buy-flash` : `${BASE_URL}/order/buy`;
  
  for (let attempt = 1; attempt <= MAX_RETRIES && !purchaseSuccess; attempt++) {
    const purchasePayload = JSON.stringify({ productId: productId });
    const startTime = Date.now();

    let purchaseRes;
    try {
      purchaseRes = http.post(
        endpoint,
        purchasePayload,
        {
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${userToken}`,
          },
          timeout: '15s',
        }
      );
    } catch (e) {
      if (shouldLog) console.log(`[VU ${__VU}] ❌ Request exception: ${e.message}`);
      unknownErrors.add(1);
      
      if (attempt < MAX_RETRIES) {
        sleep(2 * attempt);
        continue;
      }
      return;
    }

    const duration = Date.now() - startTime;
    purchaseLatency.add(duration);

    if (purchaseRes.status === 202 || purchaseRes.status === 200 || purchaseRes.status === 201) {
      successfulPurchases.add(1);
      purchaseSuccess = true;
      
      try {
        const responseData = JSON.parse(purchaseRes.body);
        orderId = responseData.orderId || responseData.order?.id;
        
        if (shouldLog) {
          console.log(`[VU ${__VU}] ✅ Order Created: ${orderId || 'N/A'}`);
          console.log(`  Status: ${responseData.status || 'success'}`);
          if (responseData.checkStatusUrl) {
            console.log(`  Check URL: ${responseData.checkStatusUrl}`);
          }
        }
        
        // تتبع الطلب فقط لو في orderId أو status URL
        if (orderId) {
          const trackingResult = trackOrderStatus(orderId, userToken, shouldLog);
          
          if (!trackingResult.success) {
            if (trackingResult.status === 'timeout') {
              timeout.add(1);
            }
          }
        } else if (USE_FLASH_BUY) {
          if (shouldLog) console.log(`[VU ${__VU}] ⚠️  No orderId returned from flash-buy!`);
        } else {
          // لو buy عادي، معناه خلص مباشرة
          fullyConfirmedOrders.add(1);
          orderSuccessRate.add(1);
          if (shouldLog) console.log(`[VU ${__VU}] ✅ Regular buy completed immediately`);
        }
        
      } catch (e) {
        if (shouldLog) console.log(`[VU ${__VU}] ❌ Failed to parse response: ${e.message}`);
      }
      
      return;
    }
    
    else if (purchaseRes.status === 402) {
      paymentDeclined.add(1);
      if (shouldLog) console.log(`[VU ${__VU}] 💳 Payment Declined (402)`);
      return;
    }
    
    else if (purchaseRes.status === 409) {
      outOfStock.add(1);
      if (shouldLog) console.log(`[VU ${__VU}] 📦 Out of Stock (409)`);
      return;
    }
    
    else if (purchaseRes.status === 503) {
      queueFull.add(1);
      if (shouldLog) console.log(`[VU ${__VU}] ⏳ Queue Full (503)`);
      
      if (attempt < MAX_RETRIES) {
        sleep(2 * attempt);
        continue;
      }
      return;
    }
    
    else if (purchaseRes.status === 429) {
      rateLimited.add(1);
      if (shouldLog) console.log(`[VU ${__VU}] 🚦 Rate Limited (429)`);
      
      if (attempt < MAX_RETRIES) {
        sleep(3 * attempt);
        continue;
      }
      return;
    }
    
    else if (purchaseRes.status === 400) {
      badRequest.add(1);
      if (shouldLog) {
        console.log(`[VU ${__VU}] ⚠️  BAD REQUEST (400)`);
        console.log(`Body: ${purchaseRes.body}`);
      }
      return;
    }
    
    else if (purchaseRes.status === 401) {
      unauthorized.add(1);
      if (shouldLog) console.log(`[VU ${__VU}] ⚠️  UNAUTHORIZED (401)`);
      return;
    }
    
    else if (purchaseRes.status === 404) {
      notFound.add(1);
      if (shouldLog) console.log(`[VU ${__VU}] ⚠️  NOT FOUND (404)`);
      return;
    }
    
    else if (purchaseRes.status === 408) {
      timeout.add(1);
      if (shouldLog) console.log(`[VU ${__VU}] ⚠️  TIMEOUT (408)`);
      
      if (attempt < MAX_RETRIES) {
        sleep(3 * attempt);
        continue;
      }
      return;
    }
    
    else if (purchaseRes.status >= 500 && purchaseRes.status < 600) {
      serverErrors.add(1);
      if (shouldLog) {
        console.log(`[VU ${__VU}] 🚨 SERVER ERROR (${purchaseRes.status})`);
        console.log(`Body: ${purchaseRes.body ? purchaseRes.body.substring(0, 200) : 'empty'}`);
      }
      
      if (attempt < MAX_RETRIES) {
        sleep(2 * attempt);
        continue;
      }
      return;
    }
    
    else {
      unknownErrors.add(1);
      if (shouldLog) {
        console.log(`[VU ${__VU}] ❓ UNKNOWN STATUS: ${purchaseRes.status}`);
        console.log(`Body: ${purchaseRes.body ? purchaseRes.body.substring(0, 200) : 'empty'}`);
      }
      return;
    }
  }
}

export function teardown(data) {
  console.log('\n' + '='.repeat(70));
  console.log('📊 DETAILED TEST RESULTS ANALYSIS');
  console.log('='.repeat(70));
  
  console.log('\n✅ SUCCESS METRICS:');
  console.log('  • successful_purchases - الطلبات المُنشأة (202)');
  console.log('  • fully_confirmed_orders - الطلبات المؤكدة كاملاً');
  console.log('  • order_success_rate - معدل النجاح الكلي');
  
  console.log('\n📈 ORDER STATUS FLOW:');
  console.log('  • orders_queued - في قائمة الانتظار');
  console.log('  • orders_processing - جاري المعالجة');
  console.log('  • orders_pending - محفوظة في DB');
  console.log('  • orders_awaiting_payment - في انتظار الدفع');
  console.log('  • orders_processing_payment - جاري الدفع');
  console.log('  • orders_confirmed - مؤكدة ✅');
  console.log('  • orders_failed - فاشلة ❌');
  console.log('  • orders_payment_failed - فشل الدفع 💳');
  console.log('  • orders_timeout - Timeout ⏱️');
  
  console.log('\n⏱️ PERFORMANCE METRICS:');
  console.log('  • purchase_latency - وقت إنشاء الطلب');
  console.log('  • order_processing_time - وقت المعالجة (queued → pending)');
  console.log('  • payment_processing_time - وقت الدفع');
  console.log('  • total_order_time - الوقت الكلي (queued → confirmed)');
  
  console.log('\n🔴 EXPECTED FAILURES (طبيعية):');
  console.log('  • payment_declined_402 - فشل دفع');
  console.log('  • out_of_stock_409 - المخزون خلص');
  console.log('  • queue_full_503 - الطابور ممتلئ');
  console.log('  • rate_limited_429 - Rate limiting');
  
  console.log('\n⚠️  REAL ISSUES (يجب التحقيق!):');
  console.log('  • bad_request_400 - خطأ في البيانات');
  console.log('  • unauthorized_401 - مشكلة Auth');
  console.log('  • not_found_404 - منتج مش موجود');
  console.log('  • timeout_408 - بطء في المعالجة');
  console.log('  • server_errors_5xx - أخطاء السيرفر');
  console.log('  • unknown_errors - أخطاء غير معروفة');
  
  console.log('\n💡 ANALYSIS TIPS:');
  console.log('  1. قارن successful_purchases مع fully_confirmed_orders');
  console.log('  2. شوف order_success_rate - لازم يكون فوق 85% للطلبات المقبولة');
  console.log('  3. راقب total_order_time - لازم p95 أقل من 15 ثانية');
  console.log('  4. لو orders_timeout كثيرة، في مشكلة أداء في الـ workers!');
  console.log('  5. تتبع الـ Order Flow عشان تعرف وين الـ bottleneck');
  console.log('  6. 409/503 طبيعية - معناها النظام بيحمي نفسه');
  console.log('  7. المهم: من الطلبات اللي دخلت (202)، كم وصلت confirmed؟');
  
  console.log('\n' + '='.repeat(70) + '\n');
}