import IORedis from "ioredis";
import { env } from "./env.js";

const commonOptions = { maxRetriesPerRequest: null };

function buildRedisOptions() {
  if (env.REDIS_URL) {
    return {
      ...commonOptions,
      connectTimeout: 10_000,
      ...(env.REDIS_URL.startsWith("rediss://") ? { tls: {} } : {}),
      // BullMQ expects either `url` or host/port; keep url for Upstash.
      url: env.REDIS_URL,
    };
  }
  return {
    ...commonOptions,
    host: env.REDIS_HOST,
    port: env.REDIS_PORT,
    password: env.REDIS_PASSWORD,
    connectTimeout: 10_000,
  };
}

/** Shared ioredis client for cache / non-BullMQ usage. */
export const redisConnection = env.REDIS_URL
  ? new IORedis(env.REDIS_URL, {
      ...commonOptions,
      connectTimeout: 10_000,
      ...(env.REDIS_URL.startsWith("rediss://") ? { tls: {} } : {}),
    })
  : new IORedis({
      host: env.REDIS_HOST,
      port: env.REDIS_PORT,
      password: env.REDIS_PASSWORD,
      connectTimeout: 10_000,
      ...commonOptions,
    });

redisConnection.on("error", (err) => {
  if (env.NODE_ENV !== "test") {
    console.error("Redis connection error:", err.message);
  }
});

/**
 * Fresh connection options for BullMQ Queue/Worker.
 * Do NOT pass the shared `redisConnection` instance — BullMQ needs its own clients.
 */
export function getBullmqConnectionOptions() {
  return buildRedisOptions();
}
