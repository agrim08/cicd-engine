import { Router, Response, NextFunction } from 'express';
import { z } from 'zod';
import { db } from '../storage/db';
import { AppError } from '../middleware/errors';
import { runnerAuth, RunnerRequest } from '../middleware/runnerAuth';

export const jobsRouter = Router();

const jobStatusSchema = z.object({
  status: z.enum(['running', 'success', 'failed', 'cancelled', 'timeout']),
  exitCode: z.number().optional(),
});

const stepStatusSchema = z.object({
  status: z.enum(['pending', 'running', 'success', 'failed']),
  exitCode: z.number().optional(),
  durationMs: z.number().optional(),
});

const jobLogSchema = z.object({
  stepId: z.string().uuid().nullable().optional(),
  lineNo: z.number().int().min(1),
  content: z.string(),
});

/**
 * @openapi
 * /api/v1/jobs/{jobId}/status:
 *   post:
 *     summary: Update job execution status
 *     description: Invoked by runner agents to report changes in job execution state and exit codes.
 *     parameters:
 *       - in: path
 *         name: jobId
 *         schema:
 *           type: string
 *           format: uuid
 *         required: true
 *         description: The unique ID of the job
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - status
 *             properties:
 *               status:
 *                 type: string
 *                 enum: [running, success, failed, cancelled, timeout]
 *               exitCode:
 *                 type: integer
 *     responses:
 *       200:
 *         description: Job status updated successfully.
 *       403:
 *         description: Forbidden. Job is not assigned to this runner.
 *       404:
 *         description: Job not found.
 */
jobsRouter.post('/:jobId/status', runnerAuth, async (req: RunnerRequest, res: Response, next: NextFunction) => {
  try {
    const { jobId } = req.params;
    const runner = req.runner;

    if (!runner) {
      return next(new AppError('Internal Server Error: Runner context missing.', 500));
    }

    const parseResult = jobStatusSchema.safeParse(req.body);
    if (!parseResult.success) {
      return next(new AppError(parseResult.error.errors[0].message, 400));
    }

    const { status, exitCode } = parseResult.data;

    await db.transaction(async (trx) => {
      // Validate job exists and is assigned to the current runner
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

      // If job is in terminal state, release the runner back to idle status
      if (isTerminal) {
        await trx('runners').where({ id: runner.id }).update({ status: 'idle' });
      }

      // Check all jobs in the run to see if parent run status needs updating
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
});

/**
 * @openapi
 * /api/v1/jobs/{jobId}/steps/{stepId}/status:
 *   post:
 *     summary: Update step execution status
 *     description: Invoked by runner agents to report changes in step execution state.
 *     parameters:
 *       - in: path
 *         name: jobId
 *         schema:
 *           type: string
 *           format: uuid
 *         required: true
 *       - in: path
 *         name: stepId
 *         schema:
 *           type: string
 *           format: uuid
 *         required: true
 *     security:
 *       - bearerAuth: []

 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - status
 *             properties:
 *               status:
 *                 type: string
 *                 enum: [pending, running, success, failed]
 *               exitCode:
 *                 type: integer
 *               durationMs:
 *                 type: integer
 *     responses:
 *       200:
 *         description: Step status updated successfully.
 *       403:
 *         description: Forbidden. Job is not assigned to this runner.
 *       404:
 *         description: Job or step not found.
 */
jobsRouter.post('/:jobId/steps/:stepId/status', runnerAuth, async (req: RunnerRequest, res: Response, next: NextFunction) => {
  try {
    const { jobId, stepId } = req.params;
    const runner = req.runner;

    if (!runner) {
      return next(new AppError('Internal Server Error: Runner context missing.', 500));
    }

    const parseResult = stepStatusSchema.safeParse(req.body);
    if (!parseResult.success) {
      return next(new AppError(parseResult.error.errors[0].message, 400));
    }

    const { status, exitCode, durationMs } = parseResult.data;

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
});

/**
 * @openapi
 * /api/v1/jobs/{jobId}/logs:
 *   post:
 *     summary: Persist log output
 *     description: Appends a line of console log output to the database.
 *     parameters:
 *       - in: path
 *         name: jobId
 *         schema:
 *           type: string
 *           format: uuid
 *         required: true
 *     security:
 *       - bearerAuth: []

 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - lineNo
 *               - content
 *             properties:
 *               stepId:
 *                 type: string
 *                 format: uuid
 *               lineNo:
 *                 type: integer
 *               content:
 *                 type: string
 *     responses:
 *       201:
 *         description: Log persisted successfully.
 *       403:
 *         description: Forbidden. Job is not assigned to this runner.
 *       404:
 *         description: Job not found.
 */
jobsRouter.post('/:jobId/logs', runnerAuth, async (req: RunnerRequest, res: Response, next: NextFunction) => {
  try {
    const { jobId } = req.params;
    const runner = req.runner;

    if (!runner) {
      return next(new AppError('Internal Server Error: Runner context missing.', 500));
    }

    const parseResult = jobLogSchema.safeParse(req.body);
    if (!parseResult.success) {
      return next(new AppError(parseResult.error.errors[0].message, 400));
    }

    const { stepId, lineNo, content } = parseResult.data;

    const job = await db('jobs').where({ id: jobId }).first();
    if (!job) {
      return next(new AppError('Job not found', 404));
    }
    if (job.runner_id !== runner.id) {
      return next(new AppError('Unauthorized: Job is not assigned to this runner', 403));
    }

    await db('logs').insert({
      job_id: jobId,
      step_id: stepId || null,
      line_no: lineNo,
      content,
      timestamp: db.fn.now(),
    });

    res.status(201).json({
      status: 'success',
      message: 'Log persisted.',
    });
  } catch (error) {
    next(error);
  }
});
