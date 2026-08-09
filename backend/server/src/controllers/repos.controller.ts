import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import { db } from '../storage/db';
import { AppError } from '../middleware/errors';
import { parseGitHubUrl, checkPipelineFileExists, fetchPipelineYaml, getOctokit } from '../github/api';
import { parseWorkflow } from '../executor/parser';
import { jobQueue } from '../queue/manager';
import { ParsedJob } from '../executor/types';

/**
 * Register a new repository
 */
export async function registerRepo(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { github_repo_url, github_token } = req.body as { github_repo_url: string; github_token?: string };

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

    const existing = await db('repos').where({ github_repo_url }).first();
    if (existing) {
      return next(new AppError('Repository URL is already registered', 400));
    }

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
}

/**
 * List all registered repositories
 */
export async function listRepos(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    // Fetch repos with their latest run details using a postgres DISTINCT ON query
    const reposList = await db.raw(`
      SELECT DISTINCT ON (r.id) 
        r.id, 
        r.github_repo_url, 
        r.created_at,
        run.id as last_run_id, 
        run.status as last_run_status, 
        run.branch as last_run_branch,
        run.created_at as last_run_created_at, 
        run.trigger as last_run_trigger
      FROM repos r
      LEFT JOIN workflows w ON w.repo_id = r.id
      LEFT JOIN runs run ON run.workflow_id = w.id
      ORDER BY r.id, run.created_at DESC
    `);

    res.status(200).json({
      status: 'success',
      results: reposList.rows.length,
      data: reposList.rows,
    });
  } catch (error) {
    next(error);
  }
}

/**
 * Retrieve repository by ID
 */
export async function getRepoById(req: Request, res: Response, next: NextFunction): Promise<void> {
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
}

/**
 * Retrieve execution runs for a repository
 */
export async function getRepoRuns(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { id } = req.params;

    const repo = await db('repos').where({ id }).first();
    if (!repo) {
      return next(new AppError('Repository not found', 404));
    }

    const runs = await db('runs')
      .join('workflows', 'runs.workflow_id', 'workflows.id')
      .where('workflows.repo_id', id)
      .select(
        'runs.id',
        'runs.sha',
        'runs.branch',
        'runs.trigger',
        'runs.status',
        'runs.created_at',
        'runs.completed_at'
      )
      .orderBy('runs.created_at', 'desc');

    const runsWithFailedStep = await Promise.all(
      runs.map(async (run) => {
        if (run.status === 'failed') {
          const failedStep = await db('steps')
            .join('jobs', 'steps.job_id', 'jobs.id')
            .where('jobs.run_id', run.id)
            .where('steps.status', 'failed')
            .select('steps.name')
            .orderBy('steps.step_order', 'asc')
            .first();
          return {
            ...run,
            failed_step_name: failedStep ? failedStep.name : null,
          };
        }
        return {
          ...run,
          failed_step_name: null,
        };
      })
    );

    res.status(200).json({
      status: 'success',
      data: runsWithFailedStep,
    });
  } catch (error) {
    next(error);
  }
}

/**
 * Retrieve the detected pipeline config (YAML) for a repository
 */
export async function getRepoConfig(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { id } = req.params;

    const repo = await db('repos').where({ id }).first();
    if (!repo) {
      return next(new AppError('Repository not found', 404));
    }

    const workflow = await db('workflows')
      .where({ repo_id: id })
      .orderBy('updated_at', 'desc')
      .first();

    res.status(200).json({
      status: 'success',
      data: {
        yaml_content: workflow ? workflow.yaml_content : null,
      },
    });
  } catch (error) {
    next(error);
  }
}

/**
 * Manually trigger a run for a repository
 */
export async function triggerRepoRun(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { id } = req.params;
    const { branch: reqBranch } = req.body as { branch?: string };
    const branch = reqBranch || 'main';

    const repo = await db('repos').where({ id }).first();
    if (!repo) {
      return next(new AppError('Repository not found', 404));
    }

    const { owner, repo: repoName } = parseGitHubUrl(repo.github_repo_url);
    const token = repo.github_token;

    const octokit = getOctokit(token);
    let sha = '';
    try {
      const commitRes = await octokit.repos.getCommit({
        owner,
        repo: repoName,
        ref: branch,
      });
      sha = commitRes.data.sha;
    } catch (err: any) {
      return next(new AppError(`Failed to fetch latest commit for branch ${branch}: ${err.message}`, 400));
    }

    let yamlContent = '';
    try {
      yamlContent = await fetchPipelineYaml(owner, repoName, sha, token);
    } catch (err: any) {
      return next(new AppError(`Pipeline config file '.cicd/pipeline.yaml' not found in branch ${branch}.`, 400));
    }

    const parsedWorkflow = parseWorkflow(yamlContent);
    const runSha = `${sha.substring(0, 7)}-manual-${Date.now()}`;

    const jobsToEnqueue: { dbJobId: string; job: ParsedJob }[] = [];
    let runId = '';

    await db.transaction(async (trx) => {
      const [workflow] = await trx('workflows')
        .insert({
          repo_id: repo.id,
          name: parsedWorkflow.name,
          yaml_content: yamlContent,
          updated_at: trx.fn.now(),
        })
        .onConflict(['repo_id', 'name'])
        .merge({
          yaml_content: yamlContent,
          updated_at: trx.fn.now(),
        })
        .returning('*');

      const [newRun] = await trx('runs')
        .insert({
          workflow_id: workflow.id,
          sha: runSha,
          branch,
          trigger: 'manual',
          status: 'pending',
          created_at: trx.fn.now(),
        })
        .returning('*');

      runId = newRun.id;

      for (const job of parsedWorkflow.jobs) {
        const [dbJob] = await trx('jobs')
          .insert({
            run_id: runId,
            name: job.name,
            status: 'queued',
            matrix_value: job.matrixValue ? job.matrixValue : null,
            image: job.image || 'ubuntu-latest',
            env: JSON.stringify(job.env || {}),
            started_at: null,
            completed_at: null,
          })
          .returning('*');

        for (const [index, step] of job.steps.entries()) {
          await trx('steps').insert({
            job_id: dbJob.id,
            name: step.name,
            status: 'pending',
            exit_code: null,
            duration_ms: null,
            step_order: index,
            run: step.run,
            env: JSON.stringify(step.env || {}),
            condition: step.condition || null,
          });
        }

        jobsToEnqueue.push({ dbJobId: dbJob.id, job });
      }
    });

    for (const item of jobsToEnqueue) {
      const secretNames = new Set<string>();
      for (const step of item.job.steps) {
        const matches = step.run.match(/\$\{\{\s*secrets\.([A-Z_][A-Z0-9_]*)\s*\}\}/g);
        if (matches) {
          for (const match of matches) {
            const secretName = match
              .replace(/\$\{\{\s*secrets\./, '')
              .replace(/\s*\}\}/, '')
              .trim();
            secretNames.add(secretName);
          }
        }
      }

      await jobQueue.add('execute-job', {
        type: 'execute-job',
        payload: {
          jobId: item.dbJobId,
          runId,
          repoId: repo.id,
          image: item.job.image,
          steps: item.job.steps,
          env: { ...parsedWorkflow.env, ...item.job.env },
          secretNames: Array.from(secretNames),
        },
      });
    }

    res.status(201).json({
      status: 'success',
      message: 'Run triggered successfully.',
      data: {
        run_id: runId,
      },
    });
  } catch (error: any) {
    next(error);
  }
}
