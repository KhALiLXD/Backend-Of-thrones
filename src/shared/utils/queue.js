import { redis } from '../config/redis.js';

export const Queue = {
    async push(queueName, data) {
        const message = JSON.stringify(data);
        await redis.lpush(queueName, message);
        return true;
    },

    async pop(queueName, timeoutSeconds = 0) {
        const result = await redis.brpop(queueName, timeoutSeconds);
        if (!result) return null;

        const [, message] = result;
        return JSON.parse(message);
    },

    async length(queueName) {
        return await redis.llen(queueName);
    },

    async clear(queueName) {
        await redis.del(queueName);
    }
};

export const QUEUES = {
    ORDERS: 'queue:orders',
    PAYMENTS: 'queue:payments'
};