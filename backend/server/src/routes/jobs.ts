import { Router, Response, NextFunction } from 'express';
import { z } from 'zod';
import { updateJobStatus, updateStepStatus, postLogs, getLogs, getRunJobs } from '../controllers/jobs.controller';
import { runnerAuth, RunnerRequest } from '../middleware/runnerAuth';
import { AppError } from '../middleware/errors';

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

const jobLogBatchSchema = z.union([jobLogSchema, z.array(jobLogSchema)]);

function validateJobStatus(req: RunnerRequest, res: Response, next: NextFunction): void {
  const parseResult = jobStatusSchema.safeParse(req.body);
  if (!parseResult.success) {
    return next(new AppError(parseResult.error.errors[0].message, 400));
  }
  next();
}

function validateStepStatus(req: RunnerRequest, res: Response, next: NextFunction): void {
  const parseResult = stepStatusSchema.safeParse(req.body);
  if (!parseResult.success) {
    return next(new AppError(parseResult.error.errors[0].message, 400));
  }
  next();
}

function validateJobLog(req: RunnerRequest, res: Response, next: NextFunction): void {
  const parseResult = jobLogBatchSchema.safeParse(req.body);
  if (!parseResult.success) {
    return next(new AppError(parseResult.error.errors[0].message, 400));
  }
  next();
}

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
jobsRouter.post('/:jobId/status', runnerAuth, validateJobStatus, updateJobStatus);

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
jobsRouter.post('/:jobId/steps/:stepId/status', runnerAuth, validateStepStatus, updateStepStatus);

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
jobsRouter.post('/:jobId/logs', runnerAuth, validateJobLog, postLogs);

/**
 * @openapi
 * /api/v1/jobs/{jobId}/logs:
 *   get:
 *     summary: Retrieve logs for a specific job
 *     description: Fetches job logs, optionally grouped by step.
 *     parameters:
 *       - in: path
 *         name: jobId
 *         schema:
 *           type: string
 *           format: uuid
 *         required: true
 *       - in: query
 *         name: grouped
 *         schema:
 *           type: boolean
 *         description: If true, logs are returned grouped by stepId
 *     responses:
 *       200:
 *         description: Logs retrieved successfully.
 *       404:
 *         description: Job not found.
 */
jobsRouter.get('/:jobId/logs', getLogs);

// Phase 6 Additional Route for run jobs
jobsRouter.get('/runs/:runId', getRunJobs);
