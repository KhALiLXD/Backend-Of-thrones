import 'dotenv/config';
import Redis from 'ioredis';

export const redis = new Redis(process.env.REDIS_URL, {
  maxRetriesPerRequest: 1,
  enableAutoPipelining: true
});

redis.on('connect', () => console.log('✅ Redis connected'));
redis.on('error', (e) => console.error('❌ Redis error', e.message));
