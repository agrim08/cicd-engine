import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { registerRunner, sendHeartbeat, claimJob } from '../controllers/runners.controller';
import { runnerAuth } from '../middleware/runnerAuth';
import { AppError } from '../middleware/errors';

export const runnersRouter = Router();

const registerRunnerSchema = z.object({
  name: z.string().min(1, { message: 'Runner name is required' }),
  labels: z.array(z.string()).default([]),
});

function validateRegisterRunner(req: Request, res: Response, next: NextFunction): void {
  const parseResult = registerRunnerSchema.safeParse(req.body);
  if (!parseResult.success) {
    return next(new AppError(parseResult.error.errors[0].message, 400));
  }
  next();
}

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
runnersRouter.post('/register', validateRegisterRunner, registerRunner);

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
runnersRouter.post('/heartbeat', runnerAuth, sendHeartbeat);

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
runnersRouter.post('/claim', runnerAuth, claimJob);
