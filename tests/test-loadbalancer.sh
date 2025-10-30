#!/bin/bash

echo "🧪 Testing Load Balancer Distribution..."
echo "========================================"
echo ""

# عدد الـ requests
REQUESTS=100

# عدادات
declare -A instance_count

for i in $(seq 1 $REQUESTS); do
  # اعمل request واجيب الـ Instance ID من الـ header
  INSTANCE=$(curl -s -I http://localhost/api/health/redis | grep -i "X-Instance-ID" | awk '{print $2}' | tr -d '\r')
  
  if [ -n "$INSTANCE" ]; then
    # زود العداد للـ instance ده
    instance_count[$INSTANCE]=$((${instance_count[$INSTANCE]:-0} + 1))
    echo "Request #$i → Instance: $INSTANCE"
  else
    echo "Request #$i → ❌ No Instance-ID header found"
  fi
  
  # استنى شوية بين كل request
  sleep 0
done

echo ""
echo "========================================"
echo "📊 Distribution Results:"
echo "========================================"

total=0
for instance in "${!instance_count[@]}"; do
  count=${instance_count[$instance]}
  total=$((total + count))
  percentage=$(awk "BEGIN {printf \"%.1f\", ($count/$REQUESTS)*100}")
  echo "Instance $instance: $count requests ($percentage%)"
done

echo ""
echo "Total requests: $total"

# تحقق إن الـ requests اتوزعت على أكتر من container
if [ ${#instance_count[@]} -gt 1 ]; then
  echo "✅ Load balancing is working! Requests distributed across ${#instance_count[@]} containers."
else
  echo "⚠️  All requests went to the same container. Check your nginx config."
fi