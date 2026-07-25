import { Worker, Job, ConnectionOptions } from 'bullmq';
import { redis } from '../storage/redis';
import { JobPayload } from './manager';

/**
 * BullMQ Worker Instance (Processor).
 * Listens to the 'ci-jobs' queue and logs job consumption events.
 * 
 * Note: In Phase 3, this serves as a type-safe verification mechanism. In subsequent
 * phases, the execution is claimed by external runners via HTTP polling.
 */
export const jobWorker = new Worker<JobPayload, { status: string }, string>(
  'ci-jobs',
  async (job: Job<JobPayload>): Promise<{ status: string }> => {
    console.log(`📥 [Queue Worker] Ingesting Job: '${job.name}' (Job ID: ${job.data.jobId})`);
    console.log(`🐳 Docker Image: ${job.data.image}`);
    console.log(`🔧 Steps: ${job.data.steps.map(s => s.name).join(', ')}`);
    return { status: 'queued_and_logged' };
  },
  {
    connection: redis as unknown as ConnectionOptions,
    // Do not start worker immediately in production/test if polling execution is running
    autorun: true,
  }
);

jobWorker.on('completed', (job: Job<JobPayload> | undefined) => {
  if (job) {
    console.log(`✅ [Queue Worker] Job '${job.name}' verified successfully in queue.`);
  }
});

jobWorker.on('failed', (job: Job<JobPayload> | undefined, err: Error) => {
  console.error(`❌ [Queue Worker] Job '${job?.name}' failed in queue with error:`, err);
});
