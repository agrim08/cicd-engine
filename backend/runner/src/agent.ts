import * as path from 'path';
import * as dotenv from 'dotenv';

// Load environment variables from the root .env file
dotenv.config({ path: path.resolve(__dirname, '../../../../.env') });

const RUNNER_NAME = process.env.RUNNER_NAME || 'runner-local-agent';
const PORT = process.env.PORT || '8080';
const SERVER_URL = process.env.SERVER_URL || `http://localhost:${PORT}`;
const RUNNER_SHARED_SECRET = process.env.RUNNER_JWT_SECRET || 'default_jwt_secret_for_testing';

let runnerId: string | null = null;
let authToken: string | null = null;
let heartbeatInterval: NodeJS.Timeout | null = null;

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

interface ClaimResponse {
  status: string;
  data: {
    jobId: string;
    runId: string;
    image: string;
    env: Record<string, string>;
    steps: Array<{
      id: string;
      name: string;
      status: string;
      step_order: number;
      run: string;
      env: Record<string, string>;
      condition: string | null;
    }>;
    secrets: Record<string, string>;
  };
}

let isExecuting = false;

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
      // No jobs available, sleep and poll again
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
    console.log(`🐳 Target Docker Image: ${job.image}`);
    console.log(`🔐 Decrypted Secrets:`, Object.keys(job.secrets));
    console.log(`🔧 Environment:`, job.env);
    console.log(`🏃 Steps:`);
    job.steps.forEach((step) => {
      console.log(`   - Step #${step.step_order + 1}: ${step.name}`);
      console.log(`     Command: "${step.run}"`);
      if (step.condition) {
        console.log(`     Condition: "${step.condition}"`);
      }
    });

    // Simulate job execution for Phase 4 Part 2 verification
    console.log('\n⚡ [Runner] Simulating step executions (5s)...');
    setTimeout(() => {
      console.log(`✅ [Runner] Simulation complete for Job '${job.jobId}'. Resuming claim loop.`);
      isExecuting = false;
      claimLoop();
    }, 5000);

  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`❌ [Runner] Claim request failed to connect:`, message);
    setTimeout(claimLoop, 5000);
  }
}

/**
 * Runner Agent Bootstrap entry point.
 */
async function start() {
  console.log(`🤖 GitHub Actions Clone Runner [${RUNNER_NAME}] booting up...`);

  // 1. Register with the server
  await registerRunner();

  // 2. Start periodic heartbeat loop (every 30 seconds)
  console.log('📡 Starting heartbeat pulse (every 30s)...');
  await sendHeartbeat(); // Trigger immediately on start
  heartbeatInterval = setInterval(sendHeartbeat, 30000);

  // 3. Launch job claim polling loop
  console.log('📡 Starting job claim loop (polling every 5s when idle)...');
  claimLoop();
}

// Handle termination gracefully
function shutdown() {
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
