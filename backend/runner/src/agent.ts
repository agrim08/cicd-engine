import * as path from 'path';
import * as dotenv from 'dotenv';
import Docker from 'dockerode';
import { Writable } from 'stream';

// Load environment variables from the root .env file
dotenv.config({ path: path.resolve(__dirname, '../../../../.env') });

const RUNNER_NAME = process.env.RUNNER_NAME || 'runner-local-agent';
const PORT = process.env.PORT || '8080';
const SERVER_URL = process.env.SERVER_URL || `http://localhost:${PORT}`;
const RUNNER_SHARED_SECRET = process.env.RUNNER_JWT_SECRET || 'default_jwt_secret_for_testing';

let runnerId: string | null = null;
let authToken: string | null = null;
let heartbeatInterval: NodeJS.Timeout | null = null;
const docker = new Docker();

interface RegisterResponse {
  status: string;
  data: {
    runnerId: string;
    name: string;
    token: string;
  };
}

interface HeartbeatResponse {
  status: string;
  message: string;
}

interface Step {
  id: string;
  name: string;
  status: string;
  step_order: number;
  run: string;
  env: Record<string, string>;
  condition: string | null;
}

interface Job {
  jobId: string;
  runId: string;
  image: string;
  env: Record<string, string>;
  steps: Step[];
  secrets: Record<string, string>;
}

interface ClaimResponse {
  status: string;
  data: Job;
}

let isExecuting = false;

/**
 * Custom writable stream parser to split buffer chunks into individual log lines.
 */
class LogStream extends Writable {
  private buffer = '';
  private onLine: (line: string) => void;

  constructor(onLine: (line: string) => void) {
    super();
    this.onLine = onLine;
  }

  _write(chunk: Buffer, _encoding: string, callback: (error?: Error | null) => void): void {
    this.buffer += chunk.toString('utf8');
    const lines = this.buffer.split(/\r?\n/);
    this.buffer = lines.pop() || '';
    for (const line of lines) {
      this.onLine(line);
    }
    callback();
  }

  _final(callback: (error?: Error | null) => void): void {
    if (this.buffer) {
      this.onLine(this.buffer);
    }
    callback();
  }
}

/**
 * Registers the runner agent with the API server.
 */
async function registerRunner(): Promise<void> {
  console.log(`🤖 [Runner] Registering with API Server at ${SERVER_URL}/api/v1/runners/register...`);

  const response = await fetch(`${SERVER_URL}/api/v1/runners/register`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${RUNNER_SHARED_SECRET}`,
    },
    body: JSON.stringify({
      name: RUNNER_NAME,
      labels: ['ubuntu', 'docker', 'node'],
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Registration failed with status ${response.status}: ${errorText}`);
  }

  const result = (await response.json()) as RegisterResponse;
  runnerId = result.data.runnerId;
  authToken = result.data.token;

  console.log(`🤖 [Runner] Registered successfully! Runner ID: ${runnerId}`);
}

/**
 * Sends a heartbeat to the API server to maintain active status.
 */
async function sendHeartbeat(): Promise<void> {
  if (!authToken) {
    console.error('❌ [Runner] Heartbeat aborted: Auth token is missing.');
    return;
  }

  try {
    const response = await fetch(`${SERVER_URL}/api/v1/runners/heartbeat`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${authToken}`,
      },
    });

    if (!response.ok) {
      console.error(`❌ [Runner] Heartbeat failed with status ${response.status}`);
      return;
    }

    const result = (await response.json()) as HeartbeatResponse;
    console.log(`💓 [Runner] Heartbeat acknowledged: ${result.message}`);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`❌ [Runner] Heartbeat failed to connect:`, message);
  }
}

/**
 * Updates step execution status, duration, and exit code on the API server.
 */
async function updateStepStatus(
  jobId: string,
  stepId: string,
  status: 'pending' | 'running' | 'success' | 'failed',
  exitCode?: number,
  durationMs?: number
): Promise<void> {
  if (!authToken) return;
  try {
    await fetch(`${SERVER_URL}/api/v1/jobs/${jobId}/steps/${stepId}/status`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${authToken}`,
      },
      body: JSON.stringify({ status, exitCode, durationMs }),
    });
  } catch (error: unknown) {
    console.error('❌ [Runner] Failed to update step status:', error instanceof Error ? error.message : String(error));
  }
}

/**
 * Updates the job status and final exit code on the API server.
 */
async function updateJobStatus(
  jobId: string,
  status: 'running' | 'success' | 'failed' | 'cancelled' | 'timeout',
  exitCode?: number
): Promise<void> {
  if (!authToken) return;
  try {
    await fetch(`${SERVER_URL}/api/v1/jobs/${jobId}/status`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${authToken}`,
      },
      body: JSON.stringify({ status, exitCode }),
    });
  } catch (error: unknown) {
    console.error('❌ [Runner] Failed to update job status:', error instanceof Error ? error.message : String(error));
  }
}

/**
 * Sends a single log line to the API server for database persistence.
 */
async function postLog(jobId: string, stepId: string, lineNo: number, content: string): Promise<void> {
  if (!authToken) return;
  try {
    await fetch(`${SERVER_URL}/api/v1/jobs/${jobId}/logs`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${authToken}`,
      },
      body: JSON.stringify({ stepId, lineNo, content }),
    });
  } catch (error: unknown) {
    console.error('❌ [Runner] Failed to post log line:', error instanceof Error ? error.message : String(error));
  }
}

/**
 * Replaces occurrences of `${{ secrets.KEY }}` and `__SECRET:KEY__` with decrypted values.
 */
function resolveSecrets(command: string, secrets: Record<string, string>): string {
  let resolved = command;
  for (const [key, value] of Object.entries(secrets)) {
    const regex = new RegExp(`\\$\\{\\{\\s*secrets\\.${key}\\s*\\}\\}`, 'gi');
    resolved = resolved.replace(regex, value);
    resolved = resolved.replace(new RegExp(`__SECRET:${key}__`, 'g'), value);
  }
  return resolved;
}

/**
 * Evaluates whether a step should execute based on its condition and the previous steps state.
 */
function shouldRunStep(condition: string | null, previousStepStatus: 'success' | 'failed'): boolean {
  if (!condition) {
    return previousStepStatus === 'success';
  }
  const normalized = condition.trim().toLowerCase();
  if (normalized === 'success()') {
    return previousStepStatus === 'success';
  }
  if (normalized === 'failure()') {
    return previousStepStatus === 'failed';
  }
  if (normalized === 'always()') {
    return true;
  }
  return previousStepStatus === 'success';
}

/**
 * Ensures the target Docker image is present locally, pulling it if necessary.
 */
async function ensureImageExists(imageName: string): Promise<void> {
  console.log(`🐳 [Docker] Checking local availability of '${imageName}'...`);
  try {
    await docker.getImage(imageName).inspect();
    console.log(`🐳 [Docker] Image '${imageName}' is already available locally.`);
  } catch {
    console.log(`🐳 [Docker] Image '${imageName}' not found. Pulling...`);
    await new Promise<void>((resolve, reject) => {
      docker.pull(imageName, {}, (err, stream) => {
        if (err) return reject(err);
        if (!stream) return reject(new Error('No stream returned from docker pull'));
        docker.modem.followProgress(stream, (finishedErr) => {
          if (finishedErr) return reject(finishedErr);
          resolve();
        });
      });
    });
    console.log(`🐳 [Docker] Image '${imageName}' pulled successfully.`);
  }
}

/**
 * Dispatches step commands inside the container.
 */
async function executeStep(container: Docker.Container, step: Step, jobId: string, secrets: Record<string, string>): Promise<void> {
  console.log(`⚡ [Runner] Starting step: ${step.name}`);
  await updateStepStatus(jobId, step.id, 'running');
  const startTime = Date.now();

  const resolvedRun = resolveSecrets(step.run, secrets);

  const exec = await container.exec({
    Cmd: ['sh', '-c', resolvedRun],
    AttachStdout: true,
    AttachStderr: true,
  });

  const stream = await exec.start({});
  let lineNo = 0;

  const stdoutParser = new LogStream((line) => {
    lineNo++;
    console.log(`[Job ${jobId}][Stdout] ${line}`);
    postLog(jobId, step.id, lineNo, line);
  });

  const stderrParser = new LogStream((line) => {
    lineNo++;
    console.warn(`[Job ${jobId}][Stderr] ${line}`);
    postLog(jobId, step.id, lineNo, `[stderr] ${line}`);
  });

  container.modem.demuxStream(stream, stdoutParser, stderrParser);

  await new Promise<void>((resolve, reject) => {
    stream.on('end', () => resolve());
    stream.on('error', (err) => reject(err));
  });

  const inspectResult = await exec.inspect();
  const exitCode = inspectResult.ExitCode ?? -1;
  const duration = Date.now() - startTime;

  console.log(`⚡ [Runner] Step '${step.name}' finished with exit code: ${exitCode} (${duration}ms)`);

  const finalStatus = exitCode === 0 ? 'success' : 'failed';
  await updateStepStatus(jobId, step.id, finalStatus, exitCode, duration);

  if (exitCode !== 0) {
    throw new Error(`Step '${step.name}' failed with exit code ${exitCode}`);
  }
}

/**
 * Handles container creation, setup, sequential step execution, and cleanup.
 */
async function executeJob(job: Job): Promise<void> {
  await updateJobStatus(job.jobId, 'running');

  // Normalize image name (fallback to ubuntu if ubuntu-latest is supplied)
  const normalizedImage = job.image === 'ubuntu-latest' ? 'ubuntu:latest' : job.image;

  let container: Docker.Container | null = null;
  try {
    await ensureImageExists(normalizedImage);

    // Build environment variable bindings
    const envArray = [
      ...Object.entries(job.env).map(([k, v]) => `${k}=${v}`),
      ...Object.entries(job.secrets).map(([k, v]) => `${k}=${v}`),
      'CI=true',
    ];

    console.log(`🐳 [Docker] Creating container using image: ${normalizedImage}...`);
    container = await docker.createContainer({
      Image: normalizedImage,
      Cmd: ['sleep', 'infinity'],
      Env: envArray,
      HostConfig: {
        Memory: 512 * 1024 * 1024,
        CpuPeriod: 100000,
        CpuQuota: 100000,
        NetworkMode: 'bridge',
        Binds: ['/var/run/docker.sock:/var/run/docker.sock'],
      },
      WorkingDir: '/workspace',
    });

    await container.start();
    console.log(`🐳 [Docker] Container started successfully.`);

    let previousStepStatus: 'success' | 'failed' = 'success';

    for (const step of job.steps) {
      if (shouldRunStep(step.condition, previousStepStatus)) {
        try {
          await executeStep(container, step, job.jobId, job.secrets);
          previousStepStatus = 'success';
        } catch {
          previousStepStatus = 'failed';
        }
      } else {
        console.log(`⏭️ [Runner] Skipping step: ${step.name} due to condition block.`);
        await updateStepStatus(job.jobId, step.id, 'pending'); // Leave pending/skipped
      }
    }

    const finalStatus = previousStepStatus === 'success' ? 'success' : 'failed';
    await updateJobStatus(job.jobId, finalStatus, previousStepStatus === 'success' ? 0 : 1);
    console.log(`🏁 [Runner] Job '${job.jobId}' finished with status: ${finalStatus}`);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`❌ [Runner] Job execution crashed:`, message);
    await updateJobStatus(job.jobId, 'failed', 1);
  } finally {
    if (container) {
      console.log(`🐳 [Docker] Stopping and removing container...`);
      try {
        await container.stop();
      } catch {
        // Safe to ignore if already stopped
      }
      try {
        await container.remove({ force: true });
      } catch (err: unknown) {
        console.error('❌ [Docker] Failed to remove container:', err instanceof Error ? err.message : String(err));
      }
      console.log(`🐳 [Docker] Container cleanup completed.`);
    }
  }
}

/**
 * Periodically requests queued jobs from the API server using atomic locking (SKIP LOCKED).
 */
async function claimLoop(): Promise<void> {
  if (isExecuting || !authToken) return;

  try {
    const response = await fetch(`${SERVER_URL}/api/v1/runners/claim`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${authToken}`,
      },
    });

    if (response.status === 204) {
      setTimeout(claimLoop, 5000);
      return;
    }

    if (!response.ok) {
      console.error(`❌ [Runner] Job claim failed with status ${response.status}`);
      setTimeout(claimLoop, 5000);
      return;
    }

    const result = (await response.json()) as ClaimResponse;
    const job = result.data;

    isExecuting = true;
    console.log(`\n📥 [Runner] Claimed Job: '${job.jobId}'`);

    await executeJob(job);

    isExecuting = false;
    setTimeout(claimLoop, 1000);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`❌ [Runner] Claim request failed to connect:`, message);
    setTimeout(claimLoop, 5000);
  }
}

/**
 * Runner Agent Bootstrap entry point.
 */
async function start(): Promise<void> {
  console.log(`🤖 GitHub Actions Clone Runner [${RUNNER_NAME}] booting up...`);

  await registerRunner();

  console.log('📡 Starting heartbeat pulse (every 30s)...');
  await sendHeartbeat();
  heartbeatInterval = setInterval(sendHeartbeat, 30000);

  console.log('📡 Starting job claim loop (polling every 5s when idle)...');
  claimLoop();
}

// Handle termination gracefully
function shutdown(): void {
  console.log('🤖 Shutting down runner gracefully...');
  if (heartbeatInterval) {
    clearInterval(heartbeatInterval);
  }
  process.exit(0);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

start().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error('❌ Runner crashed during startup:', message);
  process.exit(1);
});
