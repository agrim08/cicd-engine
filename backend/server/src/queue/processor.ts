import { Worker, Job, ConnectionOptions } from 'bullmq';
import { redis } from '../storage/redis';
import { db } from '../storage/db';
import { QueueJobData } from './manager';

/**
 * BullMQ Worker Instance (Processor).
 * Listens to the 'ci-jobs' queue and handles execution jobs as well as scheduler events.
 */
export const jobWorker = new Worker<QueueJobData, { status: string }, string>(
  'ci-jobs',
  async (job: Job<QueueJobData>): Promise<{ status: string }> => {
    if (job.data.type === 'cleanup-runners') {
      console.log('⏰ [Scheduler Worker] Starting offline runner cleanup...');
      
      const count = await db.transaction(async (trx) => {
        const twoMinutesAgo = new Date(Date.now() - 2 * 60 * 1000);
        
        // Find runners whose last heartbeat was more than 2 minutes ago and are not marked offline
        const deadRunners = await trx('runners')
          .where('last_heartbeat', '<', twoMinutesAgo)
          .whereNot('status', 'offline');
          
        if (deadRunners.length === 0) {
          return 0;
        }
        
        const deadRunnerIds = deadRunners.map(r => r.id as string);
        console.log(`⚠️ [Scheduler Worker] Found ${deadRunners.length} dead runners: ${deadRunners.map(r => r.name).join(', ')}`);
        
        // Update dead runners status to offline
        await trx('runners')
          .whereIn('id', deadRunnerIds)
          .update({
            status: 'offline',
          });
          
        // Reset running jobs assigned to these dead runners back to 'queued' state
        const resetCount = await trx('jobs')
          .whereIn('runner_id', deadRunnerIds)
          .where('status', 'running')
          .update({
            status: 'queued',
            runner_id: null,
            started_at: null,
          });
          
        console.log(`✅ [Scheduler Worker] Marked dead runners offline. Re-queued ${resetCount} active running jobs.`);
        return deadRunners.length;
      });
      
      return { status: `cleanup_complete_runners_processed_${count}` };
    }

    if (job.data.type === 'execute-job') {
      const payload = job.data.payload;
      console.log(`📥 [Queue Worker] Ingesting Job: '${job.name}' (Job ID: ${payload.jobId})`);
      console.log(`🐳 Docker Image: ${payload.image}`);
      console.log(`🔧 Steps: ${payload.steps.map(s => s.name).join(', ')}`);
      return { status: 'queued_and_logged' };
    }

    return { status: 'unknown_job_type' };
  },
  {
    connection: redis as unknown as ConnectionOptions,
    autorun: true,
  }
);

jobWorker.on('completed', (job: Job<QueueJobData> | undefined) => {
  if (job) {
    console.log(`✅ [Queue Worker] Job '${job.name}' verified successfully in queue.`);
  }
});

jobWorker.on('failed', (job: Job<QueueJobData> | undefined, err: Error) => {
  console.error(`❌ [Queue Worker] Job '${job?.name}' failed in queue with error:`, err);
});
