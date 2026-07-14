import { Router } from 'express';
import { z } from 'zod';
import { db } from '../storage/db';
import { AppError } from '../middleware/errors';
import { encrypt } from '../utils/crypto';

// Merge parameters to access :repoId from the parent router mount
export const secretsRouter = Router({ mergeParams: true });

// Zod Schema to validate secret creation/update payload
const createSecretSchema = z.object({
  name: z.string()
    .min(1, { message: 'Secret name is required' })
    .regex(/^[A-Z_][A-Z0-9_]*$/, { message: 'Secret name must contain only uppercase letters, numbers, and underscores, and start with a letter/underscore' }),
  value: z.string().min(1, { message: 'Secret value is required' }),
});

/**
 * @openapi
 * /api/v1/repos/{repoId}/secrets:
 *   post:
 *     summary: Add or update repository secret
 *     parameters:
 *       - in: path
 *         name: repoId
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - name
 *               - value
 *             properties:
 *               name:
 *                 type: string
 *                 example: DOCKER_PASSWORD
 *               value:
 *                 type: string
 *                 example: my-secret-password
 *     responses:
 *       200:
 *         description: Secret added or updated successfully.
 *       400:
 *         description: Invalid input parameters.
 *       404:
 *         description: Repository not found.
 */
secretsRouter.post('/', async (req, res, next) => {
  try {
    const { repoId } = req.params as unknown as { repoId: string };

    const parseResult = createSecretSchema.safeParse(req.body);
    if (!parseResult.success) {
      return next(new AppError(parseResult.error.errors[0].message, 400));
    }

    const { name, value } = parseResult.data;

    // Verify repository exists
    const repo = await db('repos').where({ id: repoId }).first();
    if (!repo) {
      return next(new AppError('Repository not found', 404));
    }

    // Encrypt the value using AES-256-GCM
    const { encrypted, iv } = encrypt(value);

    // Upsert secret on conflict (repo_id, name)
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
});

/**
 * @openapi
 * /api/v1/repos/{repoId}/secrets:
 *   get:
 *     summary: List all secrets (names only) for a repository
 *     parameters:
 *       - in: path
 *         name: repoId
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *     responses:
 *       200:
 *         description: Secrets retrieved successfully.
 *       404:
 *         description: Repository not found.
 */
secretsRouter.get('/', async (req, res, next) => {
  try {
    const { repoId } = req.params as unknown as { repoId: string };

    // Verify repository exists
    const repo = await db('repos').where({ id: repoId }).first();
    if (!repo) {
      return next(new AppError('Repository not found', 404));
    }

    // Retrieve secrets, masking sensitive data (encrypted_value and iv are excluded)
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
});

/**
 * @openapi
 * /api/v1/repos/{repoId}/secrets/{name}:
 *   delete:
 *     summary: Delete a repository secret by name
 *     parameters:
 *       - in: path
 *         name: repoId
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *       - in: path
 *         name: name
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Secret deleted successfully.
 *       404:
 *         description: Repository or secret not found.
 */
secretsRouter.delete('/:name', async (req, res, next) => {
  try {
    const { repoId, name } = req.params as unknown as { repoId: string; name: string };

    // Verify repository exists
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
});
