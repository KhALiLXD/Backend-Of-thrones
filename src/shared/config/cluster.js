import cluster from 'cluster';
import os from 'os';

export const setupCluster = (workerCount, startWorker, processName = 'Worker') => {
    const numWorkers = parseInt(workerCount);

    if (cluster.isPrimary) {
        console.log(`🚀 [${processName}] Primary process ${process.pid} is running`);
        console.log(`📊 [${processName}] Starting ${numWorkers} workers...`);

        for (let i = 0; i < numWorkers; i++) {
            cluster.fork();
        }

        cluster.on('online', (worker) => {
            console.log(`✅ [${processName}] Worker ${worker.process.pid} is online`);
        });

        cluster.on('exit', (worker, code, signal) => {
            console.log(`❌ [${processName}] Worker ${worker.process.pid} died (code: ${code}, signal: ${signal})`);
            console.log(`🔄 [${processName}] Starting a new worker...`);
            cluster.fork();
        });

        cluster.on('message', (worker, message) => {
            if (message.type === 'ready') {
                console.log(`✅ [${processName}] Worker ${worker.process.pid} is ready`);
            }
        });
    } else {
        startWorker();

        if (process.send) {
            process.send({ type: 'ready' });
        }

        console.log(`👷 [${processName}] Worker ${process.pid} started`);
    }
};

export const isWorker = () => cluster.isWorker;
export const isPrimary = () => cluster.isPrimary;