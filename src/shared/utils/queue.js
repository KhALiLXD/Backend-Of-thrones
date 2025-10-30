import { redis } from '../config/redis.js';

export const Queue = {
    // Add to queue
    async push(queueName, data) {
        const message = JSON.stringify(data);
        await redis.lpush(queueName, message);
        return true;
    },

    // Get from queue (blocking)
    async pop(queueName, timeoutSeconds = 0) {
        const result = await redis.brpop(queueName, timeoutSeconds);
        if (!result) return null;

        const [, message] = result;
        return JSON.parse(message);
    },

    // Get queue length
    async length(queueName) {
        return await redis.llen(queueName);
    },

    // Clear queue
    async clear(queueName) {
        await redis.del(queueName);
    }
};

export const QUEUES = {
    ORDERS: 'queue:orders',
    PAYMENTS: 'queue:payments'
};