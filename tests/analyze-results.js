// Black Friday Load Test Results Analyzer
// Usage: node analyze-results.js results.json

import fs from 'fs';
import readline from 'readline'
const resultsFile = process.argv[2];

if (!resultsFile) {
  console.log('\n❌ Usage: node analyze-results.js <results.json>\n');
  console.log('Example:');
  console.log('  k6 run --out json=results.json realistic-blackfriday-test.js');
  console.log('  node analyze-results.js results.json\n');
  process.exit(1);
}

if (!fs.existsSync(resultsFile)) {
  console.log(`\n❌ File not found: ${resultsFile}\n`);
  process.exit(1);
}

console.log('\n' + '='.repeat(70));
console.log('🛒 BLACK FRIDAY LOAD TEST ANALYSIS');
console.log('='.repeat(70) + '\n');
console.log(`📊 Analyzing: ${resultsFile}\n`);

const metrics = {
  successful_purchases: 0,
  failed_purchases: 0,
  out_of_stock_attempts: 0,
  rate_limited: 0,
  queued_requests: 0,
  queue_full_503: 0,
  errors: 0,
  http_req_duration: [],
  purchase_latency: [],
  queue_wait_time: [],
  http_req_failed: 0,
  total_requests: 0,
};

async function analyzeResults() {
  const fileStream = fs.createReadStream(resultsFile);
  const rl = readline.createInterface({
    input: fileStream,
    crlfDelay: Infinity
  });

  for await (const line of rl) {
    try {
      const data = JSON.parse(line);
      
      if (data.type === 'Point' && data.metric) {
        const metricName = data.metric;
        const value = data.data?.value;
        
        // Counter metrics
        if (metricName === 'successful_purchases' && value) {
          metrics.successful_purchases = value;
        } else if (metricName === 'failed_purchases' && value) {
          metrics.failed_purchases = value;
        } else if (metricName === 'out_of_stock_attempts' && value) {
          metrics.out_of_stock_attempts = value;
        } else if (metricName === 'rate_limited' && value) {
          metrics.rate_limited = value;
        } else if (metricName === 'queued_requests' && value) {
          metrics.queued_requests = value;
        }
        
        // Trend metrics
        else if (metricName === 'http_req_duration' && value) {
          metrics.http_req_duration.push(value);
        } else if (metricName === 'purchase_latency' && value) {
          metrics.purchase_latency.push(value);
        } else if (metricName === 'queue_wait_time' && value) {
          metrics.queue_wait_time.push(value);
        }
        
        // Rate metrics
        else if (metricName === 'errors' && value !== undefined) {
          metrics.errors = value;
        } else if (metricName === 'http_req_failed' && value !== undefined) {
          metrics.http_req_failed = value;
        }
        
        // Count total requests
        if (metricName === 'http_reqs' && value) {
          metrics.total_requests = value;
        }
      }
    } catch (e) {
      // Skip invalid JSON lines
    }
  }

  printAnalysis();
}

function calculatePercentile(arr, percentile) {
  if (arr.length === 0) return 0;
  const sorted = arr.sort((a, b) => a - b);
  const index = Math.ceil((percentile / 100) * sorted.length) - 1;
  return sorted[index];
}

function calculateAverage(arr) {
  if (arr.length === 0) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function printAnalysis() {
  console.log('📈 KEY PERFORMANCE INDICATORS');
  console.log('='.repeat(70));
  
  const totalItems = 1000;
  const successful = metrics.successful_purchases;
  const failed = metrics.failed_purchases;
  const outOfStock = metrics.out_of_stock_attempts;
  const rateLimited = metrics.rate_limited;
  const queued = metrics.queued_requests;
  
  console.log(`✅ Successful Purchases:     ${successful} / ${totalItems}`);
  console.log(`❌ Failed Purchases:         ${failed}`);
  console.log(`📦 Out of Stock Attempts:   ${outOfStock}`);
  console.log(`🚦 Rate Limited:             ${rateLimited}`);
  console.log(`⏳ Queued Requests:          ${queued}`);
  console.log(`📊 Total Requests:          ${metrics.total_requests}`);
  
  // Success rate
  const totalAttempts = successful + failed + outOfStock;
  if (totalAttempts > 0) {
    const successRate = ((successful / totalAttempts) * 100).toFixed(2);
    console.log(`\n📊 Success Rate:             ${successRate}%`);
  }
  
  // Items sold percentage
  const soldPercentage = ((successful / totalItems) * 100).toFixed(2);
  console.log(`📦 Items Sold:               ${soldPercentage}%`);
  
  console.log('\n⚡ RESPONSE TIME ANALYSIS');
  console.log('='.repeat(70));
  
  // HTTP Request Duration
  if (metrics.http_req_duration.length > 0) {
    const avg = calculateAverage(metrics.http_req_duration).toFixed(2);
    const p95 = calculatePercentile(metrics.http_req_duration, 95).toFixed(2);
    const p99 = calculatePercentile(metrics.http_req_duration, 99).toFixed(2);
    const max = Math.max(...metrics.http_req_duration).toFixed(2);
    
    console.log('HTTP Request Duration:');
    console.log(`  Average:  ${avg}ms`);
    console.log(`  P95:      ${p95}ms`);
    console.log(`  P99:      ${p99}ms`);
    console.log(`  Max:      ${max}ms`);
  }
  
  // Purchase Latency
  if (metrics.purchase_latency.length > 0) {
    const avg = calculateAverage(metrics.purchase_latency).toFixed(2);
    const p95 = calculatePercentile(metrics.purchase_latency, 95).toFixed(2);
    const p99 = calculatePercentile(metrics.purchase_latency, 99).toFixed(2);
    
    console.log('\nPurchase Latency:');
    console.log(`  Average:  ${avg}ms`);
    console.log(`  P95:      ${p95}ms`);
    console.log(`  P99:      ${p99}ms`);
  }
  
  // Queue Wait Time
  if (metrics.queue_wait_time.length > 0) {
    const avg = (calculateAverage(metrics.queue_wait_time) / 1000).toFixed(2);
    const p95 = (calculatePercentile(metrics.queue_wait_time, 95) / 1000).toFixed(2);
    const p99 = (calculatePercentile(metrics.queue_wait_time, 99) / 1000).toFixed(2);
    
    console.log('\nQueue Wait Time:');
    console.log(`  Average:  ${avg}s`);
    console.log(`  P95:      ${p95}s`);
    console.log(`  P99:      ${p99}s`);
  }
  
  console.log('\n💡 RECOMMENDATIONS');
  console.log('='.repeat(70));
  
  const recommendations = [];
  
  // Success rate analysis
  if (successful < 800) {
    recommendations.push({
      level: '🔴 CRITICAL',
      issue: `Low success rate (${successful}/1000 items sold)`,
      actions: [
        'Increase queue size from 300 to 500-1000',
        'Add horizontal scaling (multiple server instances)',
        'Implement Redis-based distributed queue',
        'Optimize database connection pool',
        'Add database read replicas'
      ]
    });
  } else if (successful < 950) {
    recommendations.push({
      level: '🟡 GOOD',
      issue: `Acceptable success rate (${successful}/1000 items sold)`,
      actions: [
        'System performed well under load',
        'Consider minor optimizations for peak traffic',
        'Monitor database performance during load'
      ]
    });
  } else {
    recommendations.push({
      level: '🟢 EXCELLENT',
      issue: `High success rate (${successful}/1000 items sold)`,
      actions: [
        'System is well-optimized for Black Friday!',
        'Current architecture can handle the load',
        'Keep monitoring for future scalability'
      ]
    });
  }
  
  // Rate limiting analysis
  if (rateLimited > 2000) {
    recommendations.push({
      level: '🟡 WARNING',
      issue: `High rate limiting (${rateLimited} requests blocked)`,
      actions: [
        'Review rate limit thresholds per user',
        'Implement sliding window rate limiting',
        'Use Redis for distributed rate limiting',
        'Consider different limits for authenticated users'
      ]
    });
  }
  
  // Queue analysis
  if (queued > 5000) {
    recommendations.push({
      level: '🟡 WARNING',
      issue: `Many queued requests (${queued} had to wait/retry)`,
      actions: [
        'Increase concurrent request limit beyond 300',
        'Implement priority queue (VIP users)',
        'Add message queue system (RabbitMQ/Bull)',
        'Consider horizontal scaling with load balancer'
      ]
    });
  }
  
  // Response time analysis
  if (metrics.http_req_duration.length > 0) {
    const p95 = calculatePercentile(metrics.http_req_duration, 95);
    if (p95 > 3000) {
      recommendations.push({
        level: '🔴 CRITICAL',
        issue: `Slow response times (P95: ${p95.toFixed(0)}ms)`,
        actions: [
          'Optimize database queries (add indexes)',
          'Implement caching layer (Redis)',
          'Review slow endpoints in APM',
          'Consider database query optimization'
        ]
      });
    }
  }
  
  // Print recommendations
  recommendations.forEach((rec, index) => {
    console.log(`\n${rec.level} ${rec.issue}`);
    rec.actions.forEach(action => {
      console.log(`  • ${action}`);
    });
  });
  
  console.log('\n' + '='.repeat(70));
  console.log('📋 FINAL GRADE');
  console.log('='.repeat(70));
  
  let grade, status;
  if (successful >= 950) {
    grade = 'A+';
    status = '🎉 EXCELLENT - Black Friday Ready!';
  } else if (successful >= 900) {
    grade = 'A';
    status = '✅ VERY GOOD - System handles load well';
  } else if (successful >= 800) {
    grade = 'B';
    status = '✅ GOOD - Minor optimizations recommended';
  } else if (successful >= 600) {
    grade = 'C';
    status = '⚠️  FAIR - Significant improvements needed';
  } else {
    grade = 'D';
    status = '❌ NEEDS IMPROVEMENT - Major optimizations required';
  }
  
  console.log(`\nGrade:  ${grade}`);
  console.log(`Status: ${status}`);
  console.log(`Result: ${successful}/${totalItems} items sold (${soldPercentage}%)\n`);
  
  console.log('='.repeat(70));
  console.log('✅ Analysis complete!\n');
}

analyzeResults().catch(err => {
  console.error('❌ Error analyzing results:', err.message);
  process.exit(1);
});