import { Request, Response, NextFunction } from 'express';
import { db } from '../storage/db';
import { AppError } from '../middleware/errors';
import { encrypt } from '../utils/crypto';

/**
 * Add or update repository secret
 */
export async function createOrUpdateSecret(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { repoId } = req.params as { repoId: string };
    const { name, value } = req.body as { name: string; value: string };

    const repo = await db('repos').where({ id: repoId }).first();
    if (!repo) {
      return next(new AppError('Repository not found', 404));
    }

    const { encrypted, iv } = encrypt(value);

    await db('secrets')
      .insert({
        repo_id: repoId,
        name,
        encrypted_value: encrypted,
        iv,
      })
      .onConflict(['repo_id', 'name'])
      .merge({
        encrypted_value: encrypted,
        iv,
        updated_at: db.fn.now(),
      });

    res.status(200).json({
      status: 'success',
      message: `Secret '${name}' configured successfully.`,
    });
  } catch (error) {
    next(error);
  }
}

/**
 * List all secrets (names only) for a repository
 */
export async function listSecrets(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { repoId } = req.params as { repoId: string };

    const repo = await db('repos').where({ id: repoId }).first();
    if (!repo) {
      return next(new AppError('Repository not found', 404));
    }

    const repoSecrets = await db('secrets')
      .where({ repo_id: repoId })
      .select('id', 'name', 'updated_at');

    res.status(200).json({
      status: 'success',
      results: repoSecrets.length,
      data: repoSecrets,
    });
  } catch (error) {
    next(error);
  }
}

/**
 * Delete a repository secret by name
 */
export async function deleteSecret(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { repoId, name } = req.params as { repoId: string; name: string };

    const repo = await db('repos').where({ id: repoId }).first();
    if (!repo) {
      return next(new AppError('Repository not found', 404));
    }

    const deletedCount = await db('secrets')
      .where({ repo_id: repoId, name })
      .del();

    if (deletedCount === 0) {
      return next(new AppError(`Secret '${name}' not found`, 404));
    }

    res.status(200).json({
      status: 'success',
      message: `Secret '${name}' deleted successfully.`,
    });
  } catch (error) {
    next(error);
  }
}
