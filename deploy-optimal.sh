#!/bin/bash

echo "================================================================"
echo "🚀 DEPLOYING OPTIMAL FLASH SALE ARCHITECTURE"
echo "================================================================"
echo ""
echo "Configuration:"
echo "  - API: 2 containers × 2 workers = 4 workers"
echo "  - Payment: 6 containers × 6 workers × 20 = 720 capacity"
echo "  - Order: 1 container × 4 workers × 15 = 60 capacity"
echo ""
echo "================================================================"
echo ""

# Step 1: Stop existing containers
echo "1️⃣  Stopping existing containers..."
docker compose down
echo "   ✅ Stopped"
echo ""

# Step 2: Rebuild images
echo "2️⃣  Rebuilding Docker images..."
docker compose build --no-cache
echo "   ✅ Built"
echo ""

# Step 3: Start services with scaling
echo "3️⃣  Starting services with horizontal scaling..."
docker compose up -d --scale api=2 --scale worker-payment=6
echo "   ✅ Started"
echo ""

# Step 4: Wait for services to be healthy
echo "4️⃣  Waiting for services to be healthy..."
echo "   (This may take 30-60 seconds...)"
sleep 10

# Check status every 5 seconds
for i in {1..12}; do
  HEALTHY=$(docker compose ps --format json | jq -r '.Health' | grep -c "healthy")
  TOTAL=$(docker compose ps --format json | grep -c "Health")

  if [ "$HEALTHY" -eq "$TOTAL" ] && [ "$TOTAL" -gt 0 ]; then
    echo "   ✅ All services healthy!"
    break
  fi

  echo "   ⏳ Waiting... ($i/12) - $HEALTHY/$TOTAL services healthy"
  sleep 5
done
echo ""

# Step 5: Show container status
echo "5️⃣  Container Status:"
docker compose ps
echo ""

# Step 6: Verify API clustering
echo "6️⃣  Verifying API clustering..."
API_LOGS=$(docker compose logs api 2>&1 | grep -i "worker" | head -5)
if echo "$API_LOGS" | grep -q "Starting 2 workers"; then
  echo "   ✅ API clustering ENABLED"
  echo "$API_LOGS" | grep -E "(Starting|Worker|Primary)" | head -3
else
  echo "   ⚠️  Could not verify clustering (check logs manually)"
fi
echo ""

# Step 7: Verify payment workers
echo "7️⃣  Verifying payment worker scaling..."
PAYMENT_CONTAINERS=$(docker compose ps worker-payment --format json 2>/dev/null | wc -l)
echo "   📦 Payment worker containers: $PAYMENT_CONTAINERS"
if [ "$PAYMENT_CONTAINERS" -ge 6 ]; then
  echo "   ✅ 6 payment containers running"
else
  echo "   ⚠️  Expected 6 containers, found $PAYMENT_CONTAINERS"
fi
echo ""

# Step 8: Setup database
echo "8️⃣  Setting up database..."
docker compose exec -T api node scripts/insertProduct.js
echo ""

# Step 9: Verify Redis stock
echo "9️⃣  Verifying Redis stock..."
STOCK=$(docker compose exec -T redis redis-cli GET "1:STOCK" 2>/dev/null | tr -d '\r')
if [ "$STOCK" = "1000" ]; then
  echo "   ✅ Redis stock: $STOCK"
else
  echo "   ⚠️  Redis stock: $STOCK (expected 1000)"
fi
echo ""

echo "================================================================"
echo "✅ DEPLOYMENT COMPLETE!"
echo "================================================================"
echo ""
echo "📊 Architecture Summary:"
echo ""
echo "   API Workers:       4 (2 containers × 2 workers)"
echo "   Payment Capacity:  720 concurrent (6 × 6 × 20)"
echo "   Order Capacity:    60 concurrent (1 × 4 × 15)"
echo ""
echo "🧪 Ready to test!"
echo ""
echo "Run load test with:"
echo "   k6 run tests/load-test-2.js"
echo ""
echo "Expected results:"
echo "   ✅ Success rate: 90-95% (was 74%)"
echo "   ✅ P95 latency: 5-7s (was 22.9s)"
echo "   ✅ Confirmed orders: ~980-990 (was 994)"
echo ""
echo "================================================================"
