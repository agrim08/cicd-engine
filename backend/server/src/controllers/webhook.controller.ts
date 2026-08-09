import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import { db } from '../storage/db';
import { AppError } from '../middleware/errors';
import { parseGitHubUrl, fetchPipelineYaml } from '../github/api';
import { parseWorkflow } from '../executor/parser';
import { isTriggerMatched } from '../executor/trigger';
import { jobQueue } from '../queue/manager';
import { ParsedJob } from '../executor/types';

interface GitHubWebhookPayload {
  repository?: {
    html_url?: string;
  };
  ref?: string;
  after?: string;
  pull_request?: {
    head?: {
      sha?: string;
      ref?: string;
    };
  };
}

/**
 * Validates the GitHub HMAC-SHA256 signature using a timing-safe comparison.
 */
function verifySignature(payload: Buffer, signatureHeader: string, secret: string): boolean {
  const expected = `sha256=${crypto
    .createHmac('sha256', secret)
    .update(payload)
    .digest('hex')}`;

  const expectedBuffer = Buffer.from(expected);
  const signatureBuffer = Buffer.from(signatureHeader);

  if (expectedBuffer.length !== signatureBuffer.length) {
    return false;
  }

  return crypto.timingSafeEqual(expectedBuffer, signatureBuffer);
}

/**
 * Handle incoming GitHub push/pull_request webhook event
 */
export async function handleWebhook(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const signatureHeader = req.headers['x-hub-signature-256'];
    if (!signatureHeader || typeof signatureHeader !== 'string') {
      return next(new AppError('Missing X-Hub-Signature-256 header', 401));
    }

    if (!Buffer.isBuffer(req.body)) {
      return next(new AppError('Request body must be parsed as a raw Buffer for signature verification', 500));
    }

    const rawBody = req.body;
    let payload: GitHubWebhookPayload;

    try {
      payload = JSON.parse(rawBody.toString('utf-8')) as GitHubWebhookPayload;
    } catch (err) {
      return next(new AppError('Invalid JSON payload', 400));
    }

    const repoUrl = payload.repository?.html_url;
    if (!repoUrl) {
      return next(new AppError('Repository URL missing in payload', 400));
    }

    const repo = await db('repos').where({ github_repo_url: repoUrl }).first();
    if (!repo) {
      return next(new AppError(`Repository '${repoUrl}' is not registered`, 404));
    }

    const isValid = verifySignature(rawBody, signatureHeader, repo.webhook_secret);
    if (!isValid) {
      return next(new AppError('Invalid signature. HMAC-SHA256 validation failed.', 401));
    }

    const eventType = req.headers['x-github-event'];
    if (eventType !== 'push' && eventType !== 'pull_request') {
      console.log(`ℹ️ Webhook received for non-tracked event type: '${eventType}'`);
      res.status(200).json({
        status: 'success',
        message: `Webhook received but event type '${eventType}' is not processed.`,
      });
      return;
    }

    let sha = '';
    let branch = '';

    if (eventType === 'push') {
      sha = payload.after || '';
      branch = payload.ref ? payload.ref.replace('refs/heads/', '') : 'unknown';
    } else if (eventType === 'pull_request') {
      sha = payload.pull_request?.head?.sha || '';
      branch = payload.pull_request?.head?.ref || 'unknown';
    }

    console.log(`🚀 Webhook validated. Event: ${eventType}, Repository: ${repoUrl}, Commit: ${sha}, Branch: ${branch}`);

    handleWebhookAsync(repo.id, repoUrl, sha, branch, eventType, repo.github_token).catch((err: unknown) => {
      console.error('[Background Error] Failed to schedule webhook background processing:', err);
    });

    res.status(202).json({
      status: 'accepted',
      message: 'GitHub webhook verified. Pipeline run creation has been triggered asynchronously.',
      data: {
        event: eventType,
        repository: repoUrl,
        commit_sha: sha,
        branch,
      },
    });
  } catch (error) {
    next(error);
  }
}

/**
 * Background worker to fetch pipeline YAML configuration and create a pending run transactionally.
 */
async function handleWebhookAsync(
  repoId: string,
  repoUrl: string,
  sha: string,
  branch: string,
  trigger: string,
  token?: string | null
): Promise<void> {
  try {
    console.log(`[Background] Starting pipeline file retrieval for repo ${repoUrl} (Commit: ${sha})...`);

    const { owner, repo } = parseGitHubUrl(repoUrl);
    const yamlContent = await fetchPipelineYaml(owner, repo, sha, token);
    const parsedWorkflow = parseWorkflow(yamlContent);

    const eventType = trigger === 'push' || trigger === 'pull_request' ? trigger : 'push';
    const isMatched = isTriggerMatched(parsedWorkflow, eventType, branch);

    if (!isMatched) {
      console.log(`[Background] Event branch '${branch}' does not match workflow triggers. Skipping execution.`);
      return;
    }

    const jobsToEnqueue: { dbJobId: string; job: ParsedJob }[] = [];
    let runId = '';

    await db.transaction(async (trx) => {
      const [workflow] = await trx('workflows')
        .insert({
          repo_id: repoId,
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
          sha,
          branch,
          trigger,
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
            condition: step.condition,
          });
        }

        jobsToEnqueue.push({ dbJobId: dbJob.id, job });
      }

      console.log(`[Background] Successfully created Run '${runId}' with ${parsedWorkflow.jobs.length} jobs.`);
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
          repoId,
          image: item.job.image,
          steps: item.job.steps,
          env: { ...parsedWorkflow.env, ...item.job.env },
          secretNames: Array.from(secretNames),
        },
      });

      console.log(`[Background] Enqueued job '${item.job.name}' (ID: ${item.dbJobId}) to BullMQ queue.`);
    }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[Background] Failed to process webhook for repo ${repoUrl} (Commit: ${sha}):`, message);
  }
}
