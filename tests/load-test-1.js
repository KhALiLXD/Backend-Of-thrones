import http from 'k6/http';
import { check, sleep } from 'k6';
import { Counter, Trend } from 'k6/metrics';

// Metrics
const successfulPurchases = new Counter('successful_purchases');
const failedPurchases = new Counter('failed_purchases');
const declinePurchases  = new Counter('decline_purchases');
const outOfStockAttempts = new Counter('out_of_stock_attempts');
const queueFullErrors = new Counter('queue_full_503');
const rateLimitedRequests = new Counter('rate_limited');
const purchaseLatency = new Trend('purchase_latency');

export const options = {
  stages: [
    { duration: '30s', target: 50 },   
    { duration: '1m', target: 150 }, 
    { duration: '2m', target: 300 },   
    { duration: '1m', target: 100 },  
    { duration: '30s', target: 0 },
  ],
};

const BASE_URL = 'http://localhost:3000';
const PRODUCT_ID = 12;  // Flash sale product (iPhone 15 Pro)
const MAX_RETRIES = 3;

let TEST_USERS = [];

export function setup() {
  console.log('\n' + '='.repeat(70));
  console.log('🐛 DEBUG BLACK FRIDAY TEST');
  console.log('='.repeat(70) + '\n');

  console.log('Creating test users...');
  for (let i = 0; i < 50; i++) {
    const userData = {
      name: `DebugUser${i}`,
      email: `debuguser${i}@test.com`,
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
  console.log('='.repeat(70) + '\n');

  return { testUsers: TEST_USERS };
}

export default function(data) {
  if (!data || !data.testUsers || data.testUsers.length === 0) {
    console.log('❌ No users available');
    return;
  }

  const userToken = data.testUsers[Math.floor(Math.random() * data.testUsers.length)];
  const productId = PRODUCT_ID;  // Single product for flash sale

  const shouldLog = __VU % 50 === 0;
  
  if (shouldLog) {
    console.log(`\n[VU ${__VU} Iter ${__ITER}] Starting purchase flow for product ${productId}`);
  }

  const productRes = http.get(`${BASE_URL}/products/${productId}`, { timeout: '5s' });
  
  if (shouldLog) {
    console.log(`[VU ${__VU}] GET /products/${productId} → ${productRes.status}`);
  }

  if (productRes.status !== 200) {
    if (shouldLog) console.log(`[VU ${__VU}] ❌ Failed to get product`);
    failedPurchases.add(1);
    sleep(1);
    return;
  }

  let product;
  try {
    product = JSON.parse(productRes.body);
  } catch (e) {
    if (shouldLog) console.log(`[VU ${__VU}] ❌ Failed to parse product`);
    failedPurchases.add(1);
    return;
  }

  if (shouldLog) {
    console.log(`[VU ${__VU}] Product ${productId} stock: ${product.stock}`);
  }

  if (product.stock <= 0) {
    if (shouldLog) console.log(`[VU ${__VU}] ⚠️  Product out of stock`);
    outOfStockAttempts.add(1);
    return;
  }

  sleep(0.3);

  let purchaseSuccess = false;
  
  for (let attempt = 1; attempt <= MAX_RETRIES && !purchaseSuccess; attempt++) {
    const idempotencyKey = `${__VU}_${__ITER}_${productId}_${Date.now()}_attempt${attempt}`;
    
    if (shouldLog) {
      console.log(`[VU ${__VU}] Attempt ${attempt}/${MAX_RETRIES} - POST /order/buy`);
    }

    const purchasePayload = JSON.stringify({ productId: productId });
    const startTime = Date.now();

    let purchaseRes;
    try {
      purchaseRes = http.post(
        `${BASE_URL}/order/buy`,
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
      if (shouldLog) {
        console.log(`[VU ${__VU}] ❌ Request failed: ${e.message}`);
      }
      failedPurchases.add(1);
      
      if (attempt < MAX_RETRIES) {
        sleep(2 * attempt);
        continue;
      }
      return;
    }

    const duration = Date.now() - startTime;
    purchaseLatency.add(duration);

    if (shouldLog) {
      console.log(`[VU ${__VU}] Response: ${purchaseRes.status} (${duration}ms)`);
    }

    if (purchaseRes.status === 200 || purchaseRes.status === 201) {
      successfulPurchases.add(1);
      purchaseSuccess = true;
      if (shouldLog) console.log(`[VU ${__VU}] ✅ SUCCESS!`);
      return;
    }
    else if (purchaseRes.status === 503) {
      queueFullErrors.add(1);
      if (shouldLog) console.log(`[VU ${__VU}] ⏳ Queue full (503)`);
      
      if (attempt < MAX_RETRIES) {
        const backoff = 2 * attempt;
        if (shouldLog) console.log(`[VU ${__VU}] Waiting ${backoff}s before retry...`);
        sleep(backoff);
        continue;
      }
      failedPurchases.add(1);
      return;
    }
    else if (purchaseRes.status === 429) {
      rateLimitedRequests.add(1);
      if (shouldLog) console.log(`[VU ${__VU}] 🚦 Rate limited (429)`);
      
      if (attempt < MAX_RETRIES) {
        sleep(3 * attempt);
        continue;
      }
      failedPurchases.add(1);
      return;
    }else if (purchaseRes.status === 402){
      declinePurchases.add(1)
      if (shouldLog) console.log(`[VU ${__VU}] ❌ Decline Payment (402)`);

    }
    else if (purchaseRes.status === 400) {
      outOfStockAttempts.add(1);
      if (shouldLog) console.log(`[VU ${__VU}] 📦 Out of stock (400)`);
      return; 
    }
    else if (purchaseRes.status === 401) {
      if (shouldLog) console.log(`[VU ${__VU}] ❌ Unauthorized (401)`);
      failedPurchases.add(1);
      return; 
    }
    else {
      if (shouldLog) {
        console.log(`[VU ${__VU}] ❌ Unexpected status: ${purchaseRes.status}`);
        if (purchaseRes.body) {
          console.log(`[VU ${__VU}] Body: ${purchaseRes.body.substring(0, 100)}`);
        }
      }
      failedPurchases.add(1);
      
      if (attempt < MAX_RETRIES) {
        sleep(2 * attempt);
        continue;
      }
      return;
    }
  }

  if (!purchaseSuccess) {
    failedPurchases.add(1);
    if (shouldLog) console.log(`[VU ${__VU}] ❌ All retries exhausted`);
  }
}

export function teardown(data) {
  console.log('\n' + '='.repeat(70));
  console.log('🐛 DEBUG TEST COMPLETED');
  console.log('='.repeat(70));
  console.log('\nCheck metrics above for:');
  console.log('  • successful_purchases');
  console.log('  • failed_purchases');
  console.log('  • queue_full_503');
  console.log('  • rate_limited');
  console.log('  • out_of_stock_attempts');
  console.log('\n' + '='.repeat(70) + '\n');
}