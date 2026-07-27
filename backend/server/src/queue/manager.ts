import { Queue, ConnectionOptions } from 'bullmq';
import { redis } from '../storage/redis';
import { ParsedStep } from '../executor/types';

/**
 * Job Payload definition.
 * Specifies exactly what payload metadata is passed to the queue.
 * Ensures strict typing.
 */
export interface JobPayload {
  jobId: string;
  runId: string;
  repoId: string;
  image: string;
  steps: ParsedStep[];
  env: Record<string, string>;
  secretNames: string[];
}

/**
 * Discriminated union for type-safe queue payloads.
 */
export type QueueJobData =
  | { type: 'execute-job'; payload: JobPayload }
  | { type: 'cleanup-runners' };

/**
 * BullMQ Job Queue instance.
 * Backed by Redis connection. Configured with standard retry policies.
 */
export const jobQueue = new Queue<QueueJobData, any, string>('ci-jobs', {
  connection: redis as unknown as ConnectionOptions,
  defaultJobOptions: {
    attempts: 3,
    backoff: {
      type: 'exponential',
      delay: 5000, // 5 seconds exponential backoff delay
    },
    removeOnComplete: 100,
    removeOnFail: 200,
  },
});

/**
 * Registers the runner cleanup job schedule on server bootstrap using the latest BullMQ Job Schedulers API.
 */
export async function registerSchedulerJobs(): Promise<void> {
  try {
    await jobQueue.upsertJobScheduler(
      'cleanup-runners-cron',
      {
        pattern: '*/1 * * * *', // Run every 1 minute
      },
      {
        name: 'cleanup-runners',
        data: { type: 'cleanup-runners' },
      }
    );
    console.log('📅 BullMQ: Registered cleanup-runners repeatable job scheduler.');
  } catch (err) {
    console.error('❌ BullMQ: Failed to register cleanup-runners repeatable job scheduler:', err);
  }
}
