import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import { db } from '../storage/db';
import { AppError } from './errors';

export interface RunnerInfo {
  id: string;
  name: string;
  labels: unknown; // JSONB from DB
  status: string;
  last_heartbeat: Date | null;
}

/**
 * Custom Request type that includes the authenticated runner's metadata.
 */
export interface RunnerRequest extends Request {
  runner?: RunnerInfo;
}

/**
 * Middleware to authenticate runner requests.
 * Extracts the Bearer token from the Authorization header, hashes it using SHA-256,
 * and matches it against `auth_token_hash` in the database.
 */
export async function runnerAuth(req: RunnerRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return next(new AppError('Unauthorized: Missing or invalid Authorization header. Expected Bearer token.', 401));
    }

    const token = authHeader.substring(7).trim();
    if (!token) {
      return next(new AppError('Unauthorized: Empty Bearer token.', 401));
    }

    // Compute the SHA-256 hash of the incoming token
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');

    // Retrieve the runner from the database matching the hashed token
    const runner = await db('runners').where({ auth_token_hash: tokenHash }).first();
    if (!runner) {
      return next(new AppError('Unauthorized: Invalid runner token.', 401));
    }

    // Attach authenticated runner to request context
    req.runner = {
      id: runner.id as string,
      name: runner.name as string,
      labels: runner.labels,
      status: runner.status as string,
      last_heartbeat: runner.last_heartbeat ? new Date(runner.last_heartbeat) : null,
    };

    next();
  } catch (error) {
    next(error);
  }
}
