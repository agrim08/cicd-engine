import Redis from 'ioredis';
import { env } from '../config/env';

/**
 * Dedicated Redis Client Instance for Pub/Sub Subscriptions.
 * Subscribed clients are locked in subscription mode and cannot execute regular commands,
 * necessitating a separate Redis connection instance.
 */
export const redisSubscriber = new Redis(env.REDIS_URL);

redisSubscriber.on('connect', () => {
  console.log('✅ Connected to Redis Subscriber successfully.');
});

redisSubscriber.on('error', (err: Error) => {
  console.error('❌ Redis Subscriber connection error:', err);
});
