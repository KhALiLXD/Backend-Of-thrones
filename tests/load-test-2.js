import http from 'k6/http';
import { check, sleep } from 'k6';
import { Counter, Trend } from 'k6/metrics';

// ✅ Success Metrics
const successfulPurchases = new Counter('successful_purchases');

// 🔴 Expected Failures (طبيعية ومتوقعة)
const paymentDeclined = new Counter('payment_declined_402');       // فشل من المستخدم
const outOfStock = new Counter('out_of_stock_409');               // المخزون خلص
const queueFull = new Counter('queue_full_503');                  // الطابور ممتلئ
const rateLimited = new Counter('rate_limited_429');              // Rate limiting

// ⚠️ Real Issues (مشاكل حقيقية!)
const badRequest = new Counter('bad_request_400');                // خطأ في البيانات
const unauthorized = new Counter('unauthorized_401');             // مشكلة Auth
const notFound = new Counter('not_found_404');                   // منتج مش موجود
const timeout = new Counter('timeout_408');                      // بطء في المعالجة
const serverErrors = new Counter('server_errors_5xx');           // أخطاء السيرفر
const unknownErrors = new Counter('unknown_errors');             // أخطاء غير معروفة

// 📊 Performance Metrics
const purchaseLatency = new Trend('purchase_latency');

export const options = {
  stages: [
    { duration: '30s', target: 100 },
    { duration: '1m', target: 300 },
    { duration: '2m', target: 500 },
    { duration: '1m', target: 200 },
    { duration: '30s', target: 0 },
  ],
  thresholds: {
    // ⚠️ المشاكل الحقيقية يجب أن تكون أقل من 5%
    'server_errors_5xx': ['count<100'],
    'bad_request_400': ['count<50'],
    'unauthorized_401': ['count<10'],
    'timeout_408': ['count<50'],
  }
};

const BASE_URL = 'http://localhost/api';
const PRODUCT_IDS = [10];
const MAX_RETRIES = 3;

let TEST_USERS = [];

export function setup() {
  console.log('\n' + '='.repeat(70));
  console.log('🚀 BLACK FRIDAY LOAD TEST - DETAILED ANALYSIS');
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

export default function(data) {
  if (!data || !data.testUsers || data.testUsers.length === 0) {
    console.log('❌ No users available');
    return;
  }

  const userToken = data.testUsers[Math.floor(Math.random() * data.testUsers.length)];
  const productId = PRODUCT_IDS[Math.floor(Math.random() * PRODUCT_IDS.length)];
  
  const shouldLog = __VU % 50 === 0;

  // Get product stock
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
  
  for (let attempt = 1; attempt <= MAX_RETRIES && !purchaseSuccess; attempt++) {
    const idempotencyKey = `${__VU}_${__ITER}_${productId}_${Date.now()}_attempt${attempt}`;
    
    const purchasePayload = JSON.stringify({ productId: productId });
    const startTime = Date.now();

    let purchaseRes;
    try {
      purchaseRes = http.post(
        `${BASE_URL}/order/buy-flash`,
        purchasePayload,
        {
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${userToken}`,
            'X-Idempotency-Key': idempotencyKey,
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

    // ✅ Success Cases (200, 201, 202)
    if (purchaseRes.status === 200 || purchaseRes.status === 201 || purchaseRes.status === 202) {
      successfulPurchases.add(1);
      purchaseSuccess = true;
      if (shouldLog) console.log(`[VU ${__VU}] ✅ SUCCESS (${purchaseRes.status})`);
      return;
    }
    
    // 🔴 Expected Failures - طبيعية ومتوقعة
    else if (purchaseRes.status === 402) {
      // Payment declined by user (بطاقة مرفوضة/رصيد غير كافي)
      paymentDeclined.add(1);
      if (shouldLog) console.log(`[VU ${__VU}] 💳 Payment Declined (402) - User Issue`);
      return; // لا نعيد المحاولة - المشكلة من المستخدم
    }
    
    else if (purchaseRes.status === 409) {
      // Out of stock (المخزون خلص)
      outOfStock.add(1);
      if (shouldLog) console.log(`[VU ${__VU}] 📦 Out of Stock (409) - Expected`);
      return; // لا نعيد المحاولة
    }
    
    else if (purchaseRes.status === 503) {
      // Queue full (الطابور ممتلئ)
      queueFull.add(1);
      if (shouldLog) console.log(`[VU ${__VU}] ⏳ Queue Full (503) - System Protection`);
      
      // نعيد المحاولة مع backoff
      if (attempt < MAX_RETRIES) {
        const backoff = 2 * attempt;
        sleep(backoff);
        continue;
      }
      return;
    }
    
    else if (purchaseRes.status === 429) {
      // Rate limited
      rateLimited.add(1);
      if (shouldLog) console.log(`[VU ${__VU}] 🚦 Rate Limited (429) - Protection Active`);
      
      if (attempt < MAX_RETRIES) {
        sleep(3 * attempt);
        continue;
      }
      return;
    }
    
    // ⚠️ Real Issues - مشاكل حقيقية تحتاج تحقيق!
    else if (purchaseRes.status === 400) {
      badRequest.add(1);
      if (shouldLog) {
        console.log(`[VU ${__VU}] ⚠️  BAD REQUEST (400) - INVESTIGATE!`);
        console.log(`Body: ${purchaseRes.body}`);
      }
      return;
    }
    
    else if (purchaseRes.status === 401) {
      unauthorized.add(1);
      if (shouldLog) console.log(`[VU ${__VU}] ⚠️  UNAUTHORIZED (401) - AUTH ISSUE!`);
      return;
    }
    
    else if (purchaseRes.status === 404) {
      notFound.add(1);
      if (shouldLog) console.log(`[VU ${__VU}] ⚠️  NOT FOUND (404) - PRODUCT MISSING!`);
      return;
    }
    
    else if (purchaseRes.status === 408) {
      timeout.add(1);
      if (shouldLog) console.log(`[VU ${__VU}] ⚠️  TIMEOUT (408) - PERFORMANCE ISSUE!`);
      
      if (attempt < MAX_RETRIES) {
        sleep(3 * attempt);
        continue;
      }
      return;
    }
    
    else if (purchaseRes.status >= 500 && purchaseRes.status < 600) {
      serverErrors.add(1);
      if (shouldLog) {
        console.log(`[VU ${__VU}] 🚨 SERVER ERROR (${purchaseRes.status}) - CRITICAL!`);
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
  console.log('📊 TEST RESULTS ANALYSIS');
  console.log('='.repeat(70));
  
  console.log('\n✅ SUCCESS:');
  console.log('  • successful_purchases - الطلبات الناجحة');
  
  console.log('\n🔴 EXPECTED FAILURES (طبيعية):');
  console.log('  • payment_declined_402 - فشل دفع من المستخدم (محاكاة)');
  console.log('  • out_of_stock_409 - المخزون خلص (طبيعي)');
  console.log('  • queue_full_503 - الطابور ممتلئ (حماية)');
  console.log('  • rate_limited_429 - Rate limiting (حماية)');
  
  console.log('\n⚠️  REAL ISSUES (يجب التحقيق!):');
  console.log('  • bad_request_400 - خطأ في البيانات');
  console.log('  • unauthorized_401 - مشكلة Authentication');
  console.log('  • not_found_404 - منتج مش موجود');
  console.log('  • timeout_408 - بطء في المعالجة');
  console.log('  • server_errors_5xx - أخطاء السيرفر الحقيقية');
  console.log('  • unknown_errors - أخطاء غير معروفة');
  
  console.log('\n💡 TIP:');
  console.log('  ركز على الـ Real Issues - هذي المشاكل الحقيقية!');
  console.log('  Expected Failures طبيعية في Flash Sales');
  
  console.log('\n' + '='.repeat(70) + '\n');
}