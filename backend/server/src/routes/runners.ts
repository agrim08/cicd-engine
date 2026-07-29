import { Router, Response, NextFunction } from 'express';
import { z } from 'zod';
import crypto from 'crypto';
import { db } from '../storage/db';
import { env } from '../config/env';
import { AppError } from '../middleware/errors';
import { runnerAuth, RunnerRequest } from '../middleware/runnerAuth';
import { decrypt } from '../utils/crypto';

export const runnersRouter = Router();

// Zod schema for runner registration payload
const registerRunnerSchema = z.object({
  name: z.string().min(1, { message: 'Runner name is required' }),
  labels: z.array(z.string()).default([]),
});

/**
 * @openapi
 * /api/v1/runners/register:
 *   post:
 *     summary: Register a new runner agent
 *     description: Creates a runner record in the database and returns a unique auth token.
 *     security:
 *       - regAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - name
 *             properties:
 *               name:
 *                 type: string
 *                 example: runner-local-1
 *               labels:
 *                 type: array
 *                 items:
 *                   type: string
 *                 example: ["ubuntu", "docker"]
 *     responses:
 *       201:
 *         description: Runner registered successfully. Returns authentication credentials.
 *       401:
 *         description: Unauthorized. Invalid registration secret.
 *       400:
 *         description: Invalid input parameters.
 */
runnersRouter.post('/register', async (req, res, next) => {
  try {
    // 1. Verify shared registration secret in Authorization header
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return next(new AppError('Unauthorized: Missing or invalid registration token.', 401));
    }

    const regSecret = authHeader.substring(7).trim();
    if (regSecret !== env.RUNNER_JWT_SECRET) {
      return next(new AppError('Unauthorized: Invalid registration token.', 401));
    }

    // 2. Validate request body
    const parseResult = registerRunnerSchema.safeParse(req.body);
    if (!parseResult.success) {
      return next(new AppError(parseResult.error.errors[0].message, 400));
    }

    const { name, labels } = parseResult.data;

    // 3. Generate secure random token and its SHA-256 hash
    const token = crypto.randomBytes(32).toString('hex');
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');

    // 4. Insert or update the runner record
    const [runner] = await db('runners')
      .insert({
        name,
        labels: JSON.stringify(labels),
        auth_token_hash: tokenHash,
        status: 'idle',
      })
      .onConflict('name')
      .merge({
        auth_token_hash: tokenHash,
        status: 'idle',
        last_heartbeat: null,
      })
      .returning('*');

    res.status(201).json({
      status: 'success',
      data: {
        runnerId: runner.id as string,
        name: runner.name as string,
        token,
      },
    });
  } catch (error) {
    next(error);
  }
});

/**
 * @openapi
 * /api/v1/runners/heartbeat:
 *   post:
 *     summary: Update runner heartbeat status
 *     description: Sets the last_heartbeat timestamp and updates runner status to idle.
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Heartbeat updated successfully.
 *       401:
 *         description: Unauthorized. Invalid runner token.
 */
runnersRouter.post('/heartbeat', runnerAuth, async (req: RunnerRequest, res: Response, next: NextFunction) => {
  try {
    const runner = req.runner;
    if (!runner) {
      return next(new AppError('Internal Server Error: Runner context missing.', 500));
    }

    // Update last_heartbeat and ensure status is idle
    await db('runners')
      .where({ id: runner.id })
      .update({
        last_heartbeat: db.fn.now(),
        status: 'idle', // Heartbeat implies runner is alive and idle (ready for jobs)
      });

    res.status(200).json({
      status: 'success',
      message: 'Heartbeat acknowledged.',
    });
  } catch (error) {
    next(error);
  }
});

/**
 * @openapi
 * /api/v1/runners/claim:
 *   post:
 *     summary: Claim a queued job atomically
 *     description: Lock the oldest queued job in a transaction, transition statuses, decrypt repository secrets, and return the execution payload.
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Job claimed successfully. Returns execution payload.
 *       204:
 *         description: No queued jobs available.
 *       401:
 *         description: Unauthorized. Invalid runner token.
 */
runnersRouter.post('/claim', runnerAuth, async (req: RunnerRequest, res: Response, next: NextFunction) => {
  try {
    const runner = req.runner;
    if (!runner) {
      return next(new AppError('Internal Server Error: Runner context missing.', 500));
    }

    const payload = await db.transaction(async (trx) => {
      // 1. Atomically query and lock the oldest queued job using SKIP LOCKED
      const job = await trx('jobs')
        .join('runs', 'jobs.run_id', 'runs.id')
        .where('jobs.status', 'queued')
        .select('jobs.*')
        .orderBy('runs.created_at', 'asc')
        .forUpdate()
        .skipLocked()
        .first();

      if (!job) {
        return null;
      }

      // 2. Transition job state to running and assign runner
      await trx('jobs')
        .where({ id: job.id })
        .update({
          status: 'running',
          runner_id: runner.id,
          started_at: trx.fn.now(),
        });

      // 3. Transition runner state to busy
      await trx('runners')
        .where({ id: runner.id })
        .update({
          status: 'busy',
          last_heartbeat: trx.fn.now(),
        });

      // 4. Transition parent run state to running if it is still pending
      const run = await trx('runs')
        .join('workflows', 'runs.workflow_id', 'workflows.id')
        .where('runs.id', job.run_id)
        .select('runs.id', 'runs.status', 'workflows.repo_id')
        .first();

      if (run && run.status === 'pending') {
        await trx('runs')
          .where({ id: run.id })
          .update({
            status: 'running',
          });
      }

      // 5. Fetch steps configuration
      const steps = await trx('steps')
        .where({ job_id: job.id })
        .orderBy('step_order', 'asc');

      // 6. Fetch and decrypt repository secrets
      const secrets = await trx('secrets').where({ repo_id: run.repo_id });
      const decryptedSecrets: Record<string, string> = {};
      for (const secret of secrets) {
        decryptedSecrets[secret.name] = decrypt(secret.encrypted_value, secret.iv);
      }

      const parsedJobEnv = typeof job.env === 'string' ? JSON.parse(job.env) : (job.env || {});

      const mappedSteps = steps.map((s) => ({
        id: s.id as string,
        name: s.name as string,
        status: s.status as string,
        step_order: s.step_order as number,
        run: s.run as string,
        env: typeof s.env === 'string' ? JSON.parse(s.env) : (s.env || {}),
        condition: s.condition as string | null,
      }));

      return {
        jobId: job.id as string,
        runId: job.run_id as string,
        image: job.image as string,
        env: parsedJobEnv,
        steps: mappedSteps,
        secrets: decryptedSecrets,
      };
    });

    if (!payload) {
      return res.status(204).end();
    }

    res.status(200).json({
      status: 'success',
      data: payload,
    });
  } catch (error) {
    next(error);
  }
});
