import { env, isConfigured } from './env.js';
import { redisConnection } from './redis.js';

function redisLabel() {
  if (env.REDIS_URL) {
    try {
      const url = new URL(env.REDIS_URL);
      return `url (${url.hostname})`;
    } catch {
      return 'url';
    }
  }
  return `${env.REDIS_HOST}:${env.REDIS_PORT}`;
}

export async function pingRedis() {
  try {
    const pong = await Promise.race([
      redisConnection.ping(),
      new Promise((_, reject) => {
        setTimeout(() => reject(new Error('Redis ping timeout')), 10_000);
      }),
    ]);
    return pong === 'PONG';
  } catch {
    return false;
  }
}

export async function runStartupChecks() {
  const redisConnected = await pingRedis();
  const meta = {
    verifyToken: isConfigured(env.META_VERIFY_TOKEN),
    pageAccessToken: isConfigured(env.META_PAGE_ACCESS_TOKEN),
    appSecret: isConfigured(env.META_APP_SECRET),
    graphApiVersion: env.META_GRAPH_API_VERSION,
  };

  console.log(`Redis (${redisLabel()}): ${redisConnected ? 'connected' : 'FAILED'}`);
  console.log(
    `Meta webhook: verify token ${meta.verifyToken ? 'set' : 'missing'}, ` +
      `page token ${meta.pageAccessToken ? 'set' : 'missing'}, ` +
      `app secret ${meta.appSecret ? 'set' : 'missing'}, ` +
      `Graph API ${meta.graphApiVersion}`,
  );

  if (!redisConnected) {
    throw new Error(
      'Redis connection failed. Set REDIS_URL (Upstash rediss://...) or REDIS_HOST/REDIS_PORT for local Redis.',
    );
  }

  if (env.NODE_ENV === 'production' && !meta.pageAccessToken) {
    console.warn('META_PAGE_ACCESS_TOKEN is not set — live Meta leads cannot be fetched from Graph API.');
  }

  if (env.NODE_ENV === 'production' && !meta.appSecret) {
    console.warn('META_APP_SECRET is not set — webhook signature verification is disabled.');
  }
}
