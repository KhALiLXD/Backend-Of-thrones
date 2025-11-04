import { redis } from "../config/redis.js";
import crypto from "crypto";
const TTL = 300;


function stableStringify (obj){
    const allKeys = [];
    JSON.stringify(obj,(k,v)=> (allKeys.push(k),v))
    allKeys.sort()
    return JSON.stringify(obj,allKeys);
}
export const idempotency  = async (req,res,next) => {
    const userId = req.user?.userId || "anon";
    const bodyStr = stableStringify(req.body || {});
    const hash = crypto.createHash("sha256").update(bodyStr).digest("hex");


    const  key = `X_:${userId}:${req.method}:${req.originalUrl}:${hash}`
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

    await redis.set(
        key,
        JSON.stringify({ status: 'PENDING' }),
        'EX',
        TTL
    )

    console.log(`[Redis] New Key Stored: ${key}`);
    const resultSnap = res.json.bind(res);
    res.json = async function (body) {
        if (res.statusCode >= 200 && res.statusCode < 300){
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