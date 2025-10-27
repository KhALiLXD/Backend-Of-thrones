import { redis } from "../config/redis.js";
const TTL = 3600;

export const idempotency  = async (req,res,next) => {
    const key = req.get('Idempotency-Key');

    if (!key) {
        console.log("[warning] there is no Idempotency-Key!");
        return next()
    };

    const storedKey = await redis.get(key);

    if (storedKey){
        const keyData = JSON.parse(storedKey);

        if (keyData.response) {
            console.log(`[Redis] Process finished on ${key} Key. Sending...`);
            return res.status(keyData.status).json(keyData.response)
        }else{
            console.log(`[Redis] Key is processing. Key: ${key}`);
            return res.status(409).json({ error: 'Request is already sent.' });
        }
    }

    // Make new key status as "PENDING"
    await redis.set(
        key,
        JSON.stringify({ status: 'PENDING' }),
        'EX',
        TTL
    )

    console.log(`[Redis] New Key Stored: ${key}`);
    const resultSnap = res.json;
    res.json = async function (body) {
        if (res.status >= 200 && res.status < 300){
            await redis.del(key)
            console.log(`[Redis] Success Process. Removing Lock..`);
        }else{
            const failedResult = { 
                response: body, 
                status: res.statusCode,
                timestamp: new Date().toISOString()
            };

            await redis.set(
                key,
                JSON.stringify(failedResult),
                'EX',
                TTL 
            )
        }

        return resultSnap.apply(res,arguments)
    }

    next();
}