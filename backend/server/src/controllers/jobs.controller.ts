import { Request, Response, NextFunction } from 'express';
import { db } from '../storage/db';
import { AppError } from '../middleware/errors';
import { RunnerRequest } from '../middleware/runnerAuth';
import { redis } from '../storage/redis';
import { maskSecrets } from '../utils/mask';

/**
 * Update job execution status (invoked by runners)
 */
export async function updateJobStatus(req: RunnerRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const { jobId } = req.params;
    const runner = req.runner;

    if (!runner) {
      return next(new AppError('Internal Server Error: Runner context missing.', 500));
    }

    const { status, exitCode } = req.body as { status: string; exitCode?: number };

    await db.transaction(async (trx) => {
      const job = await trx('jobs').where({ id: jobId }).first();
      if (!job) {
        throw new AppError('Job not found', 404);
      }
      if (job.runner_id !== runner.id) {
        throw new AppError('Unauthorized: Job is not assigned to this runner', 403);
      }

      const isTerminal = ['success', 'failed', 'cancelled', 'timeout'].includes(status);
      const updateData: Record<string, unknown> = {
        status,
        exit_code: exitCode !== undefined ? exitCode : null,
      };

      if (status === 'running' && !job.started_at) {
        updateData.started_at = trx.fn.now();
      }
      if (isTerminal) {
        updateData.completed_at = trx.fn.now();
      }

      await trx('jobs').where({ id: jobId }).update(updateData);

      if (isTerminal) {
        await trx('runners').where({ id: runner.id }).update({ status: 'idle' });
      }

      const siblingJobs = await trx('jobs').where({ run_id: job.run_id });
      const allDone = siblingJobs.every((j) => ['success', 'failed', 'cancelled', 'timeout'].includes(j.status));

      if (allDone) {
        const hasFailures = siblingJobs.some((j) => ['failed', 'cancelled', 'timeout'].includes(j.status));
        const finalRunStatus = hasFailures ? 'failed' : 'success';

        await trx('runs')
          .where({ id: job.run_id })
          .update({
            status: finalRunStatus,
            completed_at: trx.fn.now(),
          });
      }
    });

    res.status(200).json({
      status: 'success',
      message: 'Job status updated successfully.',
    });
  } catch (error) {
    next(error);
  }
}

/**
 * Update step execution status (invoked by runners)
 */
export async function updateStepStatus(req: RunnerRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const { jobId, stepId } = req.params;
    const runner = req.runner;

    if (!runner) {
      return next(new AppError('Internal Server Error: Runner context missing.', 500));
    }

    const { status, exitCode, durationMs } = req.body as { status: string; exitCode?: number; durationMs?: number };

    const job = await db('jobs').where({ id: jobId }).first();
    if (!job) {
      return next(new AppError('Job not found', 404));
    }
    if (job.runner_id !== runner.id) {
      return next(new AppError('Unauthorized: Job is not assigned to this runner', 403));
    }

    const step = await db('steps').where({ id: stepId, job_id: jobId }).first();
    if (!step) {
      return next(new AppError('Step not found', 404));
    }

    await db('steps')
      .where({ id: stepId })
      .update({
        status,
        exit_code: exitCode !== undefined ? exitCode : null,
        duration_ms: durationMs !== undefined ? durationMs : null,
      });

    res.status(200).json({
      status: 'success',
      message: 'Step status updated successfully.',
    });
  } catch (error) {
    next(error);
  }
}

/**
 * Persist log output (invoked by runners). Supports batch array payloads.
 */
export async function postLogs(req: RunnerRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const { jobId } = req.params;
    const runner = req.runner;

    if (!runner) {
      return next(new AppError('Internal Server Error: Runner context missing.', 500));
    }

    const logsList = Array.isArray(req.body)
      ? (req.body as Array<{ stepId?: string | null; lineNo: number; content: string }>)
      : [req.body as { stepId?: string | null; lineNo: number; content: string }];

    if (logsList.length === 0) {
      res.status(200).json({
        status: 'success',
        message: 'No logs provided.',
      });
      return;
    }

    const jobInfo = await db('jobs')
      .join('runs', 'jobs.run_id', 'runs.id')
      .join('workflows', 'runs.workflow_id', 'workflows.id')
      .where('jobs.id', jobId)
      .select('jobs.runner_id', 'workflows.repo_id')
      .first();

    if (!jobInfo) {
      return next(new AppError('Job not found', 404));
    }
    if (jobInfo.runner_id !== runner.id) {
      return next(new AppError('Unauthorized: Job is not assigned to this runner', 403));
    }

    const repoId = jobInfo.repo_id as string;
    const dbLogs = [];

    for (const log of logsList) {
      const maskedContent = await maskSecrets(log.content, repoId);

      dbLogs.push({
        job_id: jobId,
        step_id: log.stepId || null,
        line_no: log.lineNo,
        content: maskedContent,
        timestamp: db.fn.now(),
      });

      await redis.publish(
        `job:${jobId}:logs`,
        JSON.stringify({
          stepId: log.stepId || null,
          lineNo: log.lineNo,
          content: maskedContent,
          timestamp: new Date().toISOString(),
        })
      );
    }

    await db('logs').insert(dbLogs);

    res.status(201).json({
      status: 'success',
      message: `${dbLogs.length} log line(s) persisted.`,
    });
  } catch (error) {
    next(error);
  }
}

/**
 * Retrieve log lines for a specific job.
 * Supports query parameter grouped=true to classify logs by step_id.
 */
export async function getLogs(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { jobId } = req.params;
    const { grouped } = req.query as { grouped?: string };

    const job = await db('jobs').where({ id: jobId }).first();
    if (!job) {
      return next(new AppError('Job not found', 404));
    }

    const logs = await db('logs')
      .where({ job_id: jobId })
      .orderBy('timestamp', 'asc')
      .orderBy('line_no', 'asc');

    if (grouped === 'true') {
      const stepLogs: Record<string, Array<{ lineNo: number; content: string; timestamp: string }>> = {};
      const globalLogs: Array<{ lineNo: number; content: string; timestamp: string }> = [];

      for (const log of logs) {
        const formatted = {
          lineNo: log.line_no as number,
          content: log.content as string,
          timestamp: (log.timestamp as Date).toISOString(),
        };

        if (log.step_id) {
          if (!stepLogs[log.step_id]) {
            stepLogs[log.step_id] = [];
          }
          stepLogs[log.step_id].push(formatted);
        } else {
          globalLogs.push(formatted);
        }
      }

      res.status(200).json({
        status: 'success',
        data: {
          stepLogs,
          globalLogs,
        },
      });
      return;
    }

    const flatLogs = logs.map((log) => ({
      stepId: log.step_id as string | null,
      lineNo: log.line_no as number,
      content: log.content as string,
      timestamp: (log.timestamp as Date).toISOString(),
    }));

    res.status(200).json({
      status: 'success',
      data: flatLogs,
    });
  } catch (error) {
    next(error);
  }
}

/**
 * Get jobs and steps for a specific run
 */
export async function getRunJobs(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { runId } = req.params;
    const jobs = await db('jobs').where({ run_id: runId }).orderBy('started_at', 'asc');

    const jobsWithSteps = await Promise.all(
      jobs.map(async (job) => {
        const steps = await db('steps').where({ job_id: job.id }).orderBy('step_order', 'asc');
        return {
          ...job,
          steps,
        };
      })
    );

    res.status(200).json({
      status: 'success',
      data: jobsWithSteps,
    });
  } catch (error) {
    next(error);
  }
}
