import { Router } from 'express';
import { z } from 'zod';
import crypto from 'crypto';
import { db } from '../storage/db';
import { AppError } from '../middleware/errors';
import { parseGitHubUrl, checkPipelineFileExists } from '../github/api';

export const reposRouter = Router();

// Zod Schema to validate repo registration payload
const registerRepoSchema = z.object({
  github_repo_url: z.string().url({ message: 'github_repo_url must be a valid repository URL' }),
  github_token: z.string().optional(),
});

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
reposRouter.post('/', async (req, res, next) => {
  try {
    const parseResult = registerRepoSchema.safeParse(req.body);
    if (!parseResult.success) {
      return next(new AppError(parseResult.error.errors[0].message, 400));
    }

    const { github_repo_url, github_token } = parseResult.data;

    // Parse URL first to validate structure and get owner/repo
    let owner: string;
    let repo: string;
    try {
      const parsed = parseGitHubUrl(github_repo_url);
      owner = parsed.owner;
      repo = parsed.repo;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return next(new AppError(message, 400));
    }

    // Check if repository already exists in DB
    const existing = await db('repos').where({ github_repo_url }).first();
    if (existing) {
      return next(new AppError('Repository URL is already registered', 400));
    }

    // Perform onboarding check on GitHub
    let hasPipeline = false;
    try {
      hasPipeline = await checkPipelineFileExists(owner, repo, github_token);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      return next(
        new AppError(
          `Unable to access GitHub repository. Please check repository URL or access token. Details: ${message}`,
          400
        )
      );
    }

    // Generate random 32-byte hex string (64 characters) for webhook HMAC validation
    const webhookSecret = crypto.randomBytes(32).toString('hex');

    const [newRepo] = await db('repos')
      .insert({
        github_repo_url,
        webhook_secret: webhookSecret,
        github_token: github_token || null,
      })
      .returning('*');

    const protocol = req.protocol;
    const host = req.get('host');
    const webhookUrl = `${protocol}://${host}/webhook/github`;

    const responseData = {
      id: newRepo.id as string,
      github_repo_url: newRepo.github_repo_url as string,
      webhook_url: webhookUrl,
      webhook_secret: newRepo.webhook_secret as string,
      created_at: newRepo.created_at as string,
      warning: undefined as string | undefined,
    };

    if (!hasPipeline) {
      responseData.warning = "Pipeline configuration file '.cicd/pipeline.yaml' not found in repository. Please create it to run workflows.";
    }

    res.status(201).json({
      status: 'success',
      data: responseData,
    });
  } catch (error) {
    next(error);
  }
});

/**
 * @openapi
 * /api/v1/repos:
 *   get:
 *     summary: List all registered repositories
 *     responses:
 *       200:
 *         description: List of registered repositories retrieved successfully.
 */
reposRouter.get('/', async (req, res, next) => {
  try {
    const reposList = await db('repos').select('id', 'github_repo_url', 'created_at');
    res.status(200).json({
      status: 'success',
      results: reposList.length,
      data: reposList,
    });
  } catch (error) {
    next(error);
  }
});

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
reposRouter.get('/:id', async (req, res, next) => {
  try {
    const { id } = req.params;
    const repo = await db('repos').where({ id }).first();

    if (!repo) {
      return next(new AppError('Repository not found', 404));
    }

    const protocol = req.protocol;
    const host = req.get('host');
    const webhookUrl = `${protocol}://${host}/webhook/github`;

    res.status(200).json({
      status: 'success',
      data: {
        id: repo.id,
        github_repo_url: repo.github_repo_url,
        webhook_url: webhookUrl,
        created_at: repo.created_at,
      },
    });
  } catch (error) {
    next(error);
  }
});
