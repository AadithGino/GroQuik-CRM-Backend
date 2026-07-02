import IORedis from "ioredis";
import { env } from "./env.js";

const commonOptions = { maxRetriesPerRequest: null };

export const redisConnection = env.REDIS_URL
  ? new IORedis(env.REDIS_URL, {
      ...commonOptions,
      connectTimeout: 10_000,
      ...(env.REDIS_URL.startsWith('rediss://') ? { tls: {} } : {}),
    })
  : new IORedis({
      host: env.REDIS_HOST,
      port: env.REDIS_PORT,
      password: env.REDIS_PASSWORD,
      connectTimeout: 10_000,
      ...commonOptions,
    });

redisConnection.on('error', (err) => {
  if (env.NODE_ENV !== 'test') {
    console.error('Redis connection error:', err.message);
  }
});
