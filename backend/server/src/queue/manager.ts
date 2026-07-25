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
 * BullMQ Job Queue instance.
 * Backed by Redis connection. Configured with standard retry policies.
 */
export const jobQueue = new Queue<JobPayload, any, string>('ci-jobs', {
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
