import { redis } from "../config/redis.js";

const MAX_LIMIT = 300;
const KEY = "CURRENT_PROCESS";
export const processHandlerLimit = async (req,res,next) =>{
    try { 
        const currentProcess = await redis.incr(KEY);
        console.log("[redis-limiter] Current Process",currentProcess)
        // For memory leak
        if(currentProcess === 1) {
            await redis.expire(KEY,60);
        } 

        if(currentProcess > MAX_LIMIT){
            await redis.decr(KEY);
            res.set("Retry-After","5");
            return res.status(503).json({error: "Service is busy. Please try again later"});
        }

        const dec = async () => {
            const count = await redis.decr(KEY).catch(() => {});
            console.log("[redis-limiter] Mission Done.... Current Process: ",count )
            if (count < 1) await redis.set(KEY, 0);
        };
        res.on('finish',dec);
        res.on('close',dec);

        return next();
    }catch (err) {
        res.status(500).json({error:"process-handler",message: err.message})
    }
}