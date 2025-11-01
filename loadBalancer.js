// src/approach-2/loadbalancer.js
import cluster from 'cluster';
import os from 'os';
import path from 'path';
cluster.schedulingPolicy = cluster.SCHED_RR;
const numCPUs = 4; 
const API_PATH = './approach-2/index.sse.js';

if (cluster.isPrimary) {
  console.log(`📦 Load Balancer (Primary PID: ${process.pid})`);
  console.log(`⚙️  Spawning ${numCPUs} API workers...\n`);

  for (let i = 0; i < numCPUs; i++) cluster.fork();

  cluster.on('online', (worker) => {
    console.log(`✅ Worker ${worker.process.pid} is online`);
  });

  cluster.on('exit', (worker, code, signal) => {
    console.log(`⚠️ Worker ${worker.process.pid} died (code: ${code}, signal: ${signal}). Restarting...`);
    cluster.fork();
  });

} else {
  console.log(`🔹 Worker ${process.pid} started — running API instance`);
  await import(API_PATH);
}
