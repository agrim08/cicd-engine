import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { registerRepo, listRepos, getRepoById, getRepoRuns, getRepoConfig, triggerRepoRun } from '../controllers/repos.controller';
import { AppError } from '../middleware/errors';

export const reposRouter = Router();

const registerRepoSchema = z.object({
  github_repo_url: z.string().url({ message: 'github_repo_url must be a valid repository URL' }),
  github_token: z.string().optional(),
});

// Middleware to validate body payload
function validateRegisterRepo(req: Request, res: Response, next: NextFunction): void {
  const parseResult = registerRepoSchema.safeParse(req.body);
  if (!parseResult.success) {
    return next(new AppError(parseResult.error.errors[0].message, 400));
  }
  next();
}

/**
 * @openapi
 * /api/v1/repos:
 *   post:
 *     summary: Register a new repository
 *     description: Creates a repository record and returns a unique webhook secret.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - github_repo_url
 *             properties:
 *               github_repo_url:
 *                 type: string
 *                 example: https://github.com/octocat/hello-world
 *               github_token:
 *                 type: string
 *                 example: ghp_token
 *     responses:
 *       201:
 *         description: Repository registered successfully.
 *       400:
 *         description: Invalid input or repository URL already registered.
 */
reposRouter.post('/', validateRegisterRepo, registerRepo);

/**
 * @openapi
 * /api/v1/repos:
 *   get:
 *     summary: List all registered repositories
 *     responses:
 *       200:
 *         description: List of registered repositories retrieved successfully.
 */
reposRouter.get('/', listRepos);

/**
 * @openapi
 * /api/v1/repos/{id}:
 *   get:
 *     summary: Retrieve repository by ID
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *     responses:
 *       200:
 *         description: Repository details retrieved successfully.
 *       404:
 *         description: Repository not found.
 */
reposRouter.get('/:id', getRepoById);

// Phase 6 Additional API Endpoints
reposRouter.get('/:id/runs', getRepoRuns);
reposRouter.get('/:id/config', getRepoConfig);
reposRouter.post('/:id/runs', triggerRepoRun);
