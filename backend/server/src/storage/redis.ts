import Redis from 'ioredis';
import { env } from '../config/env';

/**
 * Global Redis Client Instance.
 * Connects to Redis using the configured REDIS_URL.
 * Configured with maxRetriesPerRequest: null, which is required for integration with BullMQ.
 */
export const redis = new Redis(env.REDIS_URL, {
  maxRetriesPerRequest: null,
});

redis.on('connect', () => {
  console.log('✅ Connected to Redis successfully.');
});

redis.on('error', (err: Error) => {
  console.error('❌ Redis connection error:', err);
});
