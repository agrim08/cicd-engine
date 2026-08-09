import { Response, NextFunction } from 'express';
import crypto from 'crypto';
import { db } from '../storage/db';
import { AppError } from '../middleware/errors';
import { RunnerRequest } from '../middleware/runnerAuth';
import { env } from '../config/env';
import { decrypt } from '../utils/crypto';

/**
 * Register a new runner agent
 */
export async function registerRunner(req: RunnerRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return next(new AppError('Unauthorized: Missing or invalid registration token.', 401));
    }

    const regSecret = authHeader.substring(7).trim();
    if (regSecret !== env.RUNNER_JWT_SECRET) {
      return next(new AppError('Unauthorized: Invalid registration token.', 401));
    }

    const { name, labels } = req.body as { name: string; labels: string[] };

    const token = crypto.randomBytes(32).toString('hex');
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');

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
}

/**
 * Update runner heartbeat status
 */
export async function sendHeartbeat(req: RunnerRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const runner = req.runner;
    if (!runner) {
      return next(new AppError('Internal Server Error: Runner context missing.', 500));
    }

    await db('runners')
      .where({ id: runner.id })
      .update({
        last_heartbeat: db.fn.now(),
        status: 'idle',
      });

    res.status(200).json({
      status: 'success',
      message: 'Heartbeat acknowledged.',
    });
  } catch (error) {
    next(error);
  }
}

/**
 * Claim a queued job atomically
 */
export async function claimJob(req: RunnerRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const runner = req.runner;
    if (!runner) {
      return next(new AppError('Internal Server Error: Runner context missing.', 500));
    }

    const payload = await db.transaction(async (trx) => {
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

      await trx('jobs')
        .where({ id: job.id })
        .update({
          status: 'running',
          runner_id: runner.id,
          started_at: trx.fn.now(),
        });

      await trx('runners')
        .where({ id: runner.id })
        .update({
          status: 'busy',
          last_heartbeat: trx.fn.now(),
        });

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

      const steps = await trx('steps')
        .where({ job_id: job.id })
        .orderBy('step_order', 'asc');

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
      res.status(204).end();
      return;
    }

    res.status(200).json({
      status: 'success',
      data: payload,
    });
  } catch (error) {
    next(error);
  }
}
