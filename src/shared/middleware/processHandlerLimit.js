import { redis } from "../config/redis.js";
import { Queue, QUEUES } from "../utils/queue.js";

const MAX_QUEUE_SIZE = 300;

export const queueLimiterMiddleware = async (req, res, next) => {
    try {
        // Check current queue length
        const currentQueueSize = await Queue.length(QUEUES.PAYMENTS);
        
        console.log(`[queue-limiter] Current Queue Size: ${currentQueueSize}/${MAX_QUEUE_SIZE}`);

        // If queue is full, reject the request
        if (currentQueueSize >= MAX_QUEUE_SIZE) {
            res.set("Retry-After", "10");
            return res.status(503).json({
                error: "queue-full",
                message: "System is at maximum capacity. Please try again later",
                queueSize: currentQueueSize,
                maxQueueSize: MAX_QUEUE_SIZE
            });
        }

        // Queue has space, allow request to proceed
        return next();

    } catch (err) {
        console.error("[queue-limiter] Error:", err.message);
        return res.status(500).json({
            error: "queue-limiter-error",
            message: err.message
        });
    }
};
