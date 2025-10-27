import { redis } from '../config/redis.js';

export const apiRateLimiter = async (req,res,next) => {
    try {
        const ip = req.ip || req.connection.remoteAddress;
        const maxRequests = process.env.API_RATE_LIMIT_MAX || 100;
        const windowSeconds = process.env.API_RATE_LIMIT_WINDOW || 60;
        const rateLimitKey = `api_rate_limit:ip:${ip}`;

        const currentRequests = await redis.get(rateLimitKey);

        if (currentRequests && parseInt(currentRequests) >= maxRequests) {
            const ttl = await redis.ttl(rateLimitKey);
            return res.status(429).json({
                err: 'too many requests',
                retryAfter: ttl > 0 ? ttl : windowSeconds
            });
        }

        const pipeline = redis.pipeline();
        pipeline.incr(rateLimitKey);
        if (!currentRequests) pipeline.expire(rateLimitKey, windowSeconds);
        await pipeline.exec();

        const newRequests = currentRequests ? parseInt(currentRequests) + 1 : 1;
        res.setHeader('X-RateLimit-Limit', maxRequests);
        res.setHeader('X-RateLimit-Remaining', Math.max(0, maxRequests - newRequests));

        next();
    } catch (err) {
        next();
    }
};