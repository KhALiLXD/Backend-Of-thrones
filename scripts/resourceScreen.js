
export function startSystemMonitoring(intervalMs = 2000) {
  
  let lastCpuUsage = process.cpuUsage();
  let lastHrTime = process.hrtime.bigint();

  const HEAP_LIMIT_MB = 6144;
  
  const CLEAR_SCREEN = '\x1B[2J\x1B[H';

  console.log(`System monitoring starting... Logging live every ${intervalMs}ms.`);
  console.log(`Monitoring against Heap Limit: ${HEAP_LIMIT_MB} MB`);
  console.log(`Thread Pool Size (UV_THREADPOOL_SIZE): ${process.env.UV_THREADPOOL_SIZE || 'default (4)'}`);
  
  setTimeout(() => {
    setInterval(() => {
      const memoryUsage = process.memoryUsage();
      const rssMB = (memoryUsage.rss / 1024 / 1024).toFixed(2);
      const heapUsedMB = (memoryUsage.heapUsed / 1024 / 1024).toFixed(2);
      const heapTotalMB = (memoryUsage.heapTotal / 1024 / 1024).toFixed(2);
      const heapUsedPercent = ((heapUsedMB / HEAP_LIMIT_MB) * 100).toFixed(2);

      const now = process.hrtime.bigint();
      const elapsedMs = Number(now - lastHrTime) / 1_000_000;
      const cpuUsageDiff = process.cpuUsage(lastCpuUsage);
      const cpuUsageMs = (cpuUsageDiff.user + cpuUsageDiff.system) / 1000;
      const cpuPercent = ((cpuUsageMs / elapsedMs) * 100).toFixed(2);

      lastCpuUsage = process.cpuUsage();
      lastHrTime = now;

      const output = [];
      output.push('==================================================');
      output.push(`    Node.js Live System Monitor (PID: ${process.pid})`);
      output.push('==================================================');
      output.push(`Last update: ${new Date().toISOString()}`);
      output.push(''); 
      
      output.push('--- 🧠 Memory ---');
      output.push(`Memory (RSS):           ${rssMB} MB`);
      output.push(`Heap Used:              ${heapUsedMB} MB / ${HEAP_LIMIT_MB} MB (${heapUsedPercent}%)`);
      output.push(`Heap Total (Allocated): ${heapTotalMB} MB`);
      output.push(''); 

      output.push('--- CPU & Threadpool ---');
      output.push(`CPU Usage (% of 1 core): ${cpuPercent}%`);
      output.push(`Thread Pool Size:        ${process.env.UV_THREADPOOL_SIZE || 'default (4)'}`);
      output.push(''); 
      output.push('Press (Ctrl + C) to exit.');

      process.stdout.write(CLEAR_SCREEN + output.join('\n'));

    }, intervalMs);
  }, 500);
}