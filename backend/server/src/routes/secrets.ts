import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { createOrUpdateSecret, listSecrets, deleteSecret } from '../controllers/secrets.controller';
import { AppError } from '../middleware/errors';

export const secretsRouter = Router({ mergeParams: true });

const createSecretSchema = z.object({
  name: z.string()
    .min(1, { message: 'Secret name is required' })
    .regex(/^[A-Z_][A-Z0-9_]*$/, { message: 'Secret name must contain only uppercase letters, numbers, and underscores, and start with a letter/underscore' }),
  value: z.string().min(1, { message: 'Secret value is required' }),
});

function validateCreateSecret(req: Request, res: Response, next: NextFunction): void {
  const parseResult = createSecretSchema.safeParse(req.body);
  if (!parseResult.success) {
    return next(new AppError(parseResult.error.errors[0].message, 400));
  }
  next();
}

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
secretsRouter.post('/', validateCreateSecret, createOrUpdateSecret);

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
secretsRouter.get('/', listSecrets);

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
secretsRouter.delete('/:name', deleteSecret);
