import { Router, Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import { db } from '../storage/db';
import { AppError } from '../middleware/errors';
import { parseGitHubUrl, fetchPipelineYaml } from '../github/api';
import { parseWorkflow } from '../executor/parser';
import { isTriggerMatched } from '../executor/trigger';
import { jobQueue } from '../queue/manager';
import { ParsedJob } from '../executor/types';

export const webhookRouter = Router();

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
 * @openapi
 * /webhook/github:
 *   post:
 *     summary: GitHub Webhook endpoint
 *     description: Ingests push or pull_request events, verifies payload signature, and schedules workflow execution.
 *     headers:
 *       X-Hub-Signature-256:
 *         schema:
 *           type: string
 *         required: true
 *         description: HMAC-SHA256 signature of the payload
 *     responses:
 *       200:
 *         description: Webhook received. Event is not push/pull_request.
 *       202:
 *         description: Webhook received. Workflow run scheduled.
 *       401:
 *         description: Invalid signature.
 *       404:
 *         description: Repository not registered.
 */
webhookRouter.post('/github', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const signatureHeader = req.headers['x-hub-signature-256'];
    if (!signatureHeader || typeof signatureHeader !== 'string') {
      return next(new AppError('Missing X-Hub-Signature-256 header', 401));
    }

    // Check if the body is a raw Buffer (configured using express.raw() middleware in server.ts)
    if (!Buffer.isBuffer(req.body)) {
      return next(new AppError('Request body must be parsed as a raw Buffer for signature verification', 500));
    }

    const rawBody = req.body;
    let payload: GitHubWebhookPayload;
    
    try {
      payload = JSON.parse(rawBody.toString('utf-8'));
    } catch (err) {
      return next(new AppError('Invalid JSON payload', 400));
    }

    // Extract repository URL to lookup the registration
    const repoUrl = payload.repository?.html_url;
    if (!repoUrl) {
      return next(new AppError('Repository URL missing in payload', 400));
    }

    // Look up repository registration in database
    const repo = await db('repos').where({ github_repo_url: repoUrl }).first();
    if (!repo) {
      return next(new AppError(`Repository '${repoUrl}' is not registered`, 404));
    }

    // Verify HMAC-SHA256 signature
    const isValid = verifySignature(rawBody, signatureHeader, repo.webhook_secret);
    if (!isValid) {
      return next(new AppError('Invalid signature. HMAC-SHA256 validation failed.', 401));
    }

    // Extract GitHub event type
    const eventType = req.headers['x-github-event'];
    if (eventType !== 'push' && eventType !== 'pull_request') {
      console.log(`ℹ️ Webhook received for non-tracked event type: '${eventType}'`);
      return res.status(200).json({
        status: 'success',
        message: `Webhook received but event type '${eventType}' is not processed.`,
      });
    }

    // Extract basic information
    let sha = '';
    let branch = '';

    if (eventType === 'push') {
      sha = payload.after || '';
      // Ref is in format refs/heads/branch_name
      branch = payload.ref ? payload.ref.replace('refs/heads/', '') : 'unknown';
    } else if (eventType === 'pull_request') {
      sha = payload.pull_request?.head?.sha || '';
      branch = payload.pull_request?.head?.ref || 'unknown';
    }

    console.log(`🚀 Webhook validated. Event: ${eventType}, Repository: ${repoUrl}, Commit: ${sha}, Branch: ${branch}`);

    // Trigger asynchronous background processing (not awaited)
    handleWebhookAsync(repo.id, repoUrl, sha, branch, eventType, repo.github_token).catch((err) => {
      console.error('[Background Error] Failed to schedule webhook background processing:', err);
    });

    // Return 202 Accepted immediately to GitHub
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
});

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

    // 1. Parse repository owner and repo names
    const { owner, repo } = parseGitHubUrl(repoUrl);

    // 2. Fetch the pipeline YAML content from GitHub at the exact commit ref
    const yamlContent = await fetchPipelineYaml(owner, repo, sha, token);

    // 3. Parse and validate the workflow YAML using our executor parser
    const parsedWorkflow = parseWorkflow(yamlContent);

    // 4. Validate if incoming event/branch matches the trigger settings
    const eventType = trigger === 'push' || trigger === 'pull_request' ? trigger : 'push';
    const isMatched = isTriggerMatched(parsedWorkflow, eventType, branch);

    if (!isMatched) {
      console.log(`[Background] Event branch '${branch}' does not match workflow triggers. Skipping execution.`);
      return;
    }

    const jobsToEnqueue: { dbJobId: string; job: ParsedJob }[] = [];
    let runId = '';

    // 5. Database transaction: upsert workflow, run, and matrix-expanded jobs + steps
    await db.transaction(async (trx) => {
      // Upsert workflow config
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

      // Create new pending run record
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

      // Insert expanded jobs and steps
      for (const job of parsedWorkflow.jobs) {
        const [dbJob] = await trx('jobs')
          .insert({
            run_id: runId,
            name: job.name,
            status: 'queued',
            matrix_value: job.matrixValue ? job.matrixValue : null,
            started_at: null,
            completed_at: null,
          })
          .returning('*');

        // Populate steps in correct order
        for (const [index, step] of job.steps.entries()) {
          await trx('steps').insert({
            job_id: dbJob.id,
            name: step.name,
            status: 'pending',
            exit_code: null,
            duration_ms: null,
            step_order: index,
          });
        }

        jobsToEnqueue.push({ dbJobId: dbJob.id, job });
      }

      console.log(`[Background] Successfully created Run '${runId}' with ${parsedWorkflow.jobs.length} jobs.`);
    });

    // 6. Enqueue jobs to BullMQ after database transaction succeeds
    for (const item of jobsToEnqueue) {
      // Extract required secret names from step runs (e.g. ${{ secrets.SECRET_NAME }})
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
