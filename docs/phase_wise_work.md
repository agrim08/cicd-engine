# GitHub Actions Clone — Detailed Implementation Phases

**Stack:** Node.js · TypeScript · Express · BullMQ · PostgreSQL · Redis · Docker · Cloudflare R2 · React  
**API:** REST (Express.js)  
**Storage:** Cloudflare R2 (S3-compatible, free egress, $0.015/GB/month — cheaper than S3)  
**Deployment:** AWS EC2 / GCP Compute Engine (TBD)  
**YAML Path:** `.cicd/pipeline.yaml` (custom path, avoids triggering native GitHub Actions)

---

## Quick Architecture Recap

```
git push
  │
  ▼
POST /webhook/github  (Express, HMAC verified)
  │
  ▼
Fetch .cicd/pipeline.yaml  (GitHub API)
  │
  ▼
YAML Parser  →  expand matrix  →  build job list
  │
  ▼
BullMQ Queue  (Upstash Redis)
  │
  ▼
Runner Agent  (Node.js worker, polls REST)
  │
  ▼
Docker Container  (one per job, isolated)
  ├── git clone repo
  ├── run steps (npm install, npm test, aws deploy, ssh, etc.)
  ├── stream logs  →  Redis pub/sub  →  WebSocket  →  Dashboard
  └── upload artifacts  →  Cloudflare R2
  │
  ▼
PostgreSQL  (all state: runs, jobs, steps, logs, secrets)
GitHub API  (post commit status check ✅ / ❌)
```

---

## Why `.cicd/pipeline.yaml` instead of `.github/workflows/`?

If you use `.github/workflows/`, GitHub will also try to run your workflow on their own runners — both systems fire on the same push event. To keep it clean:

- Your clone watches `.cicd/pipeline.yaml` (configurable per repo)
- GitHub Actions stays disabled on the demo repo (Settings → Actions → Disable)
- Makes it obvious in demos that **your** platform is doing the work
- You can still support `.github/workflows/` as an option — just document it

---

## Why Cloudflare R2 over AWS S3?

| | Cloudflare R2 | AWS S3 |
|---|---|---|
| Storage | $0.015/GB/month | $0.023/GB/month |
| Egress (download) | **Free** | $0.09/GB |
| API calls | $0.36/million | $0.40/million |
| S3-compatible API | ✅ Yes | ✅ Native |
| Free tier | 10GB storage, 1M requests/month | 5GB, 20k GET / 2k PUT |

R2 is S3-compatible so your code barely changes — just swap the endpoint URL. For a project with frequent artifact downloads (demo, portfolio), free egress is a big deal.

---

## Deployment Options (TBD)

| Option | Pros | Cons |
|---|---|---|
| AWS EC2 (t2.micro) | Free tier 12 months, familiar, easy IAM | Expires after 1 year |
| GCP Compute Engine (e2-micro) | **Always free** (us-central1/us-east1/us-west1), 30GB disk | Slightly less RAM (1GB) |
| AWS EC2 + GCP mix | API on GCP (always free), heavy jobs on EC2 | More complexity |

**Recommendation:** GCP e2-micro for always-free server. Run both API and runner agent on the same VM for simplicity during demo phase. Split later if needed.

Docker will run on the VM directly — the runner agent spawns containers on the host Docker daemon.

---

---

# Phase 1 — Project Scaffold & Database Foundation

> **Goal:** Repo exists, server boots, database is set up, nothing is wired yet but the skeleton is solid.

### 1.1 Monorepo Structure

Set up the project as a monorepo with three packages:

```
github-actions-clone/
├── server/          # Express API + BullMQ + all backend logic
├── runner/          # Runner agent (separate Node.js process)
├── client/          # React dashboard
├── docker-compose.yml
├── .env.example
└── README.md
```

Use `npm workspaces` or just keep them as independent `package.json` projects. TypeScript in all three.

### 1.2 Express Server Scaffold

```
server/src/
├── routes/          # empty files created, not wired yet
├── middleware/
│   ├── auth.ts      # Bearer token validation
│   └── errors.ts    # Global error handler
├── config/
│   └── env.ts       # Typed env var loading (zod or dotenv)
└── server.ts        # Express app + listen
```

Install core deps: `express`, `typescript`, `ts-node`, `nodemon`, `zod`, `pg`, `ioredis`, `bullmq`, `cors`, `helmet`.

Set up `tsconfig.json`, `nodemon.json`, basic `server.ts` that boots and returns 200 on `/health`.

### 1.3 PostgreSQL Schema

Write all migrations in `/server/src/storage/migrations/`. Run them in order on boot (or use a tool like `node-pg-migrate`).

```sql
-- 001_repos.sql
CREATE TABLE repos (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  github_repo_url TEXT NOT NULL UNIQUE,
  webhook_secret TEXT NOT NULL,         -- HMAC secret for this repo
  github_token TEXT,                    -- optional: PAT to fetch private repo YAML
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 002_workflows.sql
CREATE TABLE workflows (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  repo_id UUID REFERENCES repos(id),
  name TEXT NOT NULL,
  yaml_path TEXT DEFAULT '.cicd/pipeline.yaml',
  yaml_content TEXT,                    -- cached last-fetched YAML
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 003_runs.sql
CREATE TABLE runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_id UUID REFERENCES workflows(id),
  sha TEXT NOT NULL,
  branch TEXT NOT NULL,
  trigger TEXT NOT NULL,               -- push | pull_request | manual
  status TEXT DEFAULT 'pending',       -- pending | running | success | failed | cancelled
  created_at TIMESTAMPTZ DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  UNIQUE(workflow_id, sha)             -- prevent duplicate runs for same commit
);

-- 004_jobs.sql
CREATE TABLE jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id UUID REFERENCES runs(id),
  name TEXT NOT NULL,
  status TEXT DEFAULT 'queued',        -- queued | running | success | failed | timeout | cancelled
  exit_code INT,
  runner_id UUID,
  matrix_value JSONB,                  -- e.g. {"node-version": "18"}
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ
);

-- 005_steps.sql
CREATE TABLE steps (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id UUID REFERENCES jobs(id),
  name TEXT NOT NULL,
  status TEXT DEFAULT 'pending',
  exit_code INT,
  duration_ms INT,
  step_order INT NOT NULL
);

-- 006_logs.sql
CREATE TABLE logs (
  id BIGSERIAL PRIMARY KEY,
  job_id UUID REFERENCES jobs(id),
  step_id UUID REFERENCES steps(id),
  line_no INT NOT NULL,
  content TEXT NOT NULL,
  timestamp TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_logs_job_id ON logs(job_id);

-- 007_artifacts.sql
CREATE TABLE artifacts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id UUID REFERENCES runs(id),
  job_id UUID REFERENCES jobs(id),
  name TEXT NOT NULL,
  r2_key TEXT NOT NULL,               -- Cloudflare R2 object key
  size_bytes BIGINT,
  content_type TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 008_runners.sql
CREATE TABLE runners (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL UNIQUE,
  labels JSONB DEFAULT '[]',          -- e.g. ["ubuntu", "docker", "node"]
  auth_token_hash TEXT NOT NULL,      -- bcrypt hash of auth token
  last_heartbeat TIMESTAMPTZ,
  status TEXT DEFAULT 'idle',         -- idle | busy | offline
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 009_secrets.sql
CREATE TABLE secrets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  repo_id UUID REFERENCES repos(id),
  name TEXT NOT NULL,
  encrypted_value TEXT NOT NULL,      -- AES-256-GCM encrypted
  iv TEXT NOT NULL,                   -- initialization vector for AES
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(repo_id, name)
);
```

### 1.4 Local Dev Setup

Write `docker-compose.yml` for local development:

```yaml
services:
  postgres:
    image: postgres:16
    environment:
      POSTGRES_DB: cicd
      POSTGRES_USER: cicd
      POSTGRES_PASSWORD: cicd
    ports:
      - "5432:5432"

  redis:
    image: redis:7-alpine
    ports:
      - "6379:6379"
```

Write `.env.example`:
```
DATABASE_URL=postgresql://cicd:cicd@localhost:5432/cicd
REDIS_URL=redis://localhost:6379
GITHUB_WEBHOOK_SECRET=your_webhook_secret
GITHUB_TOKEN=ghp_your_pat
ENCRYPTION_KEY=32_byte_hex_key_for_aes256
RUNNER_JWT_SECRET=your_jwt_secret
R2_ACCOUNT_ID=
R2_ACCESS_KEY_ID=
R2_SECRET_ACCESS_KEY=
R2_BUCKET_NAME=cicd-artifacts
```

**Phase 1 Checkpoint:** `npm run dev` → server boots on port 3000 → `GET /health` returns `{ status: "ok" }` → PostgreSQL tables exist ✅

---

# Phase 2 — Webhook Receiver & GitHub Integration

> **Goal:** Push to GitHub → your server receives it, validates it, fetches the YAML, stores the run. No execution yet.

### 2.1 Webhook Endpoint

`POST /webhook/github`

Steps inside this handler:
1. Read raw body (important: use `express.raw()` not `express.json()` for HMAC validation)
2. Validate `X-Hub-Signature-256` header using HMAC-SHA256 with the repo's webhook secret
3. Parse JSON body
4. Check event type — only handle `push` and `pull_request` for now, return 200 for others
5. Extract: `sha`, `branch`, `repo full name`, `sender`
6. Look up repo in DB by `github_repo_url`
7. If repo not registered, return 404

```typescript
// Signature validation
import crypto from 'crypto';

export function verifyGitHubSignature(payload: Buffer, signature: string, secret: string): boolean {
  const expected = `sha256=${crypto
    .createHmac('sha256', secret)
    .update(payload)
    .digest('hex')}`;
  // timing-safe comparison — prevents timing attacks
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
}
```

### 2.2 Fetch YAML from GitHub API

After signature validation, use Octokit to fetch the workflow file:

```typescript
import { Octokit } from '@octokit/rest';

const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN });

const { data } = await octokit.repos.getContent({
  owner,
  repo,
  path: '.cicd/pipeline.yaml',
  ref: sha,   // fetch the exact version at this commit
});

const yaml = Buffer.from(data.content, 'base64').toString('utf-8');
```

Fetching at the exact `sha` is important — you want the YAML version from this specific commit, not the latest on main.

### 2.3 Store Event

```typescript
// In a single transaction:
const run = await db.transaction(async (trx) => {
  // upsert workflow
  const workflow = await trx('workflows')
    .insert({ repo_id, name, yaml_content: yaml })
    .onConflict(['repo_id', 'name'])
    .merge(['yaml_content', 'updated_at'])
    .returning('*');

  // create run
  const run = await trx('runs')
    .insert({ workflow_id: workflow.id, sha, branch, trigger: 'push' })
    .returning('*');

  return run;
});
```

Return `202 Accepted` immediately — actual execution is async.

### 2.4 Repo Registration API

```
POST /api/v1/repos
Body: { github_repo_url, github_token? }
Response: { id, webhook_url, webhook_secret }
```

When a user registers a repo, generate a unique `webhook_secret` (random 32 bytes, hex). Return the webhook URL they should paste into GitHub Settings → Webhooks. Optionally auto-create the webhook via GitHub API if they provide a token.

### 2.5 Secrets API

```
POST /api/v1/repos/:repoId/secrets
Body: { name, value }
```

Encrypt before storing:

```typescript
import crypto from 'crypto';

const ENCRYPTION_KEY = Buffer.from(process.env.ENCRYPTION_KEY, 'hex'); // 32 bytes

export function encrypt(plaintext: string): { encrypted: string; iv: string } {
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-gcm', ENCRYPTION_KEY, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    encrypted: Buffer.concat([encrypted, tag]).toString('base64'),
    iv: iv.toString('hex'),
  };
}

export function decrypt(encrypted: string, iv: string): string {
  const data = Buffer.from(encrypted, 'base64');
  const tag = data.slice(-16);
  const ciphertext = data.slice(0, -16);
  const decipher = crypto.createDecipheriv('aes-256-gcm', ENCRYPTION_KEY, Buffer.from(iv, 'hex'));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf-8');
}
```

**Phase 2 Checkpoint:** Push to GitHub → ngrok tunnel → server receives webhook → YAML fetched → run row in PostgreSQL ✅

---

# Phase 3 — YAML Parser & Job Queue

> **Goal:** Stored YAML becomes a structured list of queued jobs in BullMQ. No execution yet.

### 3.1 YAML Parser

Support this subset of syntax (covers ~80% of real-world workflows):

```yaml
name: Build and Deploy

on:
  push:
    branches: [main, develop]
    paths:
      - 'src/**'
      - 'package.json'
  pull_request:
    branches: [main]

env:
  NODE_ENV: production
  APP_NAME: my-app

jobs:
  test:
    runs-on: ubuntu-latest
    strategy:
      matrix:
        node-version: [18, 20]
    steps:
      - name: Checkout
        run: git clone https://x-access-token:${{ secrets.GITHUB_TOKEN }}@github.com/${{ env.REPO }} .

      - name: Install
        run: npm ci

      - name: Test
        run: npm test
        if: success()

  deploy:
    runs-on: ubuntu-latest
    needs: test           # only runs if test passes
    steps:
      - name: Deploy to EC2
        run: |
          echo "${{ secrets.EC2_PEM_KEY }}" > /tmp/deploy.pem
          chmod 600 /tmp/deploy.pem
          ssh -i /tmp/deploy.pem ec2-user@${{ secrets.EC2_IP }} "cd /app && docker-compose pull && docker-compose up -d"
```

Parser output (internal representation):

```typescript
interface ParsedWorkflow {
  name: string;
  triggers: { event: string; branches?: string[]; paths?: string[] }[];
  globalEnv: Record<string, string>;
  jobs: ParsedJob[];
}

interface ParsedJob {
  name: string;
  image: string;                    // ubuntu-latest → ubuntu:latest
  needs: string[];                  // dependency job names
  steps: ParsedStep[];
  matrixExpansions: Record<string, string>[];  // one per matrix combo
}

interface ParsedStep {
  name: string;
  run: string;                      // shell command
  condition: string | null;         // if: expression
  env: Record<string, string>;
}
```

### 3.2 Matrix Expansion

```typescript
function expandMatrix(job: RawJob): ParsedJob[] {
  const matrix = job.strategy?.matrix ?? {};
  const keys = Object.keys(matrix);

  if (keys.length === 0) return [{ ...job, matrixExpansions: {} }];

  // cartesian product of all matrix values
  const combinations = keys.reduce((acc, key) => {
    return acc.flatMap(combo =>
      matrix[key].map(value => ({ ...combo, [key]: value }))
    );
  }, [{}]);

  // one job per combination
  return combinations.map(combo => ({
    ...job,
    name: `${job.name} (${Object.values(combo).join(', ')})`,
    matrixExpansions: combo,
  }));
}
```

### 3.3 Trigger Matching

Before queueing, check if this push event matches the workflow triggers:

```typescript
function shouldRun(triggers: ParsedTrigger[], event: WebhookEvent): boolean {
  for (const trigger of triggers) {
    if (trigger.event !== event.type) continue;
    if (trigger.branches && !trigger.branches.includes(event.branch)) continue;
    if (trigger.paths && !event.changedFiles.some(f => matchesGlob(f, trigger.paths))) continue;
    return true;
  }
  return false;
}
```

### 3.4 Secret Interpolation Plan

Do NOT interpolate secrets at parse time. Instead, pass secret names through and resolve them at execution time inside the runner. This way secrets are never stored in the queue payload.

Replace `${{ secrets.EC2_PEM_KEY }}` with a placeholder like `__SECRET:EC2_PEM_KEY__` in parsed steps. Runner resolves these just before container creation.

### 3.5 BullMQ Queue Setup

```typescript
import { Queue, Worker } from 'bullmq';
import { redis } from './redis';

export const jobQueue = new Queue('ci-jobs', {
  connection: redis,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 5000 },
    removeOnComplete: 100,
    removeOnFail: 200,
  },
});
```

### 3.6 Enqueue Jobs (Transactional)

```typescript
async function enqueueRun(run: Run, parsedWorkflow: ParsedWorkflow) {
  await db.transaction(async (trx) => {
    for (const parsedJob of parsedWorkflow.jobs) {
      const expandedJobs = expandMatrix(parsedJob);

      for (const job of expandedJobs) {
        // 1. Insert job row in DB
        const dbJob = await trx('jobs').insert({
          run_id: run.id,
          name: job.name,
          status: 'queued',
          matrix_value: job.matrixExpansions,
        }).returning('*');

        // 2. Insert step rows
        for (const [i, step] of job.steps.entries()) {
          await trx('steps').insert({
            job_id: dbJob.id,
            name: step.name,
            step_order: i,
          });
        }

        // 3. Add to BullMQ
        await jobQueue.add('execute-job', {
          jobId: dbJob.id,
          runId: run.id,
          repoId: run.repoId,
          image: job.image,
          steps: job.steps,
          env: { ...parsedWorkflow.globalEnv, ...job.matrixExpansions },
          secretNames: job.requiredSecrets,
        });
      }
    }
  });
}
```

**Phase 3 Checkpoint:** Push → YAML parsed → 3 jobs (from matrix) appear in BullMQ + PostgreSQL with status `queued` ✅

---

# Phase 4 — Runner Agent & Docker Execution

> **Goal:** Runner claims jobs, executes steps in Docker containers, exit codes saved. The core of the whole system.

### 4.1 Runner Registration

Runner calls on startup:

```
POST /api/v1/runners/register
Body: { name: "runner-1", labels: ["ubuntu", "docker"] }
Headers: Authorization: Bearer <RUNNER_SHARED_SECRET>
Response: { runnerId, authToken }   ← runner stores this token
```

Server generates a unique JWT for this runner, stores `bcrypt(token)` in DB.

### 4.2 Job Claiming (Atomic)

Runner polls every 5 seconds:

```
POST /api/v1/runners/claim
Headers: Authorization: Bearer <runner-auth-token>
Response: job payload or 204 No Content
```

Server-side claim logic using `SELECT FOR UPDATE SKIP LOCKED` — prevents two runners grabbing the same job:

```typescript
async function claimNextJob(runnerId: string) {
  return db.transaction(async (trx) => {
    const job = await trx.raw(`
      SELECT * FROM jobs
      WHERE status = 'queued'
      ORDER BY created_at ASC
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    `).then(r => r.rows[0]);

    if (!job) return null;

    await trx('jobs').where({ id: job.id }).update({
      status: 'running',
      runner_id: runnerId,
      started_at: new Date(),
    });

    // fetch steps, secrets (decrypted), env vars
    const steps = await trx('steps').where({ job_id: job.id }).orderBy('step_order');
    const secrets = await fetchAndDecryptSecrets(job.run_id, trx);

    return { ...job, steps, secrets };
  });
}
```

### 4.3 Docker Container Lifecycle

```typescript
import Docker from 'dockerode';
const docker = new Docker(); // connects to /var/run/docker.sock

async function executeJob(job: JobPayload) {
  // resolve secret placeholders in step commands
  const resolvedSteps = resolveSecrets(job.steps, job.secrets);

  // build env array for Docker
  const envArray = [
    ...Object.entries(job.env).map(([k, v]) => `${k}=${v}`),
    ...Object.entries(job.secrets).map(([k, v]) => `${k}=${v}`),
    `CI=true`,
    `GITHUB_SHA=${job.sha}`,
    `GITHUB_REF=${job.branch}`,
  ];

  const container = await docker.createContainer({
    Image: job.image,           // e.g. "ubuntu:latest" or "node:18"
    Cmd: ['sleep', 'infinity'], // keep alive while we exec steps
    Env: envArray,
    HostConfig: {
      Memory: 512 * 1024 * 1024,    // 512MB RAM limit
      CpuPeriod: 100000,
      CpuQuota: 100000,             // 1 CPU core
      NetworkMode: 'bridge',        // full internet access
      Binds: ['/var/run/docker.sock:/var/run/docker.sock'], // docker-in-docker
    },
    WorkingDir: '/workspace',
  });

  await container.start();

  try {
    for (const step of resolvedSteps) {
      await executeStep(container, step, job.jobId);
      // if step fails and next step has if: success() → skip
      // if step fails and next step has if: failure() → run
    }
    await markJobComplete(job.jobId, 'success');
  } catch (err) {
    await markJobComplete(job.jobId, 'failed');
  } finally {
    await container.stop();
    await container.remove({ force: true }); // always clean up
  }
}
```

### 4.4 Step Execution

Each step runs as a shell exec inside the running container:

```typescript
async function executeStep(container: Docker.Container, step: ParsedStep, jobId: string) {
  await updateStepStatus(step.id, 'running');
  const startTime = Date.now();

  const exec = await container.exec({
    Cmd: ['sh', '-c', step.run],
    AttachStdout: true,
    AttachStderr: true,
  });

  const stream = await exec.start({});
  let lineNo = 0;

  await new Promise<void>((resolve, reject) => {
    container.modem.demuxStream(stream, 
      // stdout
      new LineStream(async (line) => {
        lineNo++;
        await postLog(jobId, step.id, lineNo, line);
      }),
      // stderr (same handler, maybe prefix with [stderr])
      new LineStream(async (line) => {
        lineNo++;
        await postLog(jobId, step.id, lineNo, `[stderr] ${line}`);
      })
    );
    stream.on('end', resolve);
    stream.on('error', reject);
  });

  const { ExitCode } = await exec.inspect();
  const duration = Date.now() - startTime;

  await updateStepStatus(step.id, ExitCode === 0 ? 'success' : 'failed', ExitCode, duration);

  if (ExitCode !== 0) throw new Error(`Step "${step.name}" failed with exit code ${ExitCode}`);
}
```

### 4.5 Heartbeat

Runner sends every 30 seconds regardless of job state:

```
POST /api/v1/runners/heartbeat
Headers: Authorization: Bearer <runner-auth-token>
```

Server-side cron (runs every 60s):

```typescript
// Find jobs assigned to dead runners and re-queue them
cron.schedule('*/60 * * * * *', async () => {
  const deadRunners = await db('runners')
    .where('last_heartbeat', '<', new Date(Date.now() - 2 * 60 * 1000))
    .where('status', 'busy');

  for (const runner of deadRunners) {
    await db('jobs')
      .where({ runner_id: runner.id, status: 'running' })
      .update({ status: 'queued', runner_id: null, started_at: null });

    await db('runners').where({ id: runner.id }).update({ status: 'offline' });
  }
});
```

### 4.6 Conditional Step Evaluation

```typescript
function shouldRunStep(step: ParsedStep, previousStepStatus: 'success' | 'failed'): boolean {
  if (!step.condition) return previousStepStatus === 'success'; // default behaviour
  switch (step.condition) {
    case 'success()': return previousStepStatus === 'success';
    case 'failure()': return previousStepStatus === 'failed';
    case 'always()':  return true;
    default:          return true;
  }
}
```

**Phase 4 Checkpoint:** Push → job claimed by runner → Docker container runs → steps execute → exit codes in DB → container cleaned up ✅

---

# Phase 5 — Real-time Log Streaming

> **Goal:** Logs appear in the browser as the job runs. Sub-500ms from container stdout to screen.

### 5.1 Log Pipeline

```
Container stdout
  │
  ▼
Runner POSTs each line → POST /api/v1/jobs/:jobId/logs
  │
  ▼
Express handler
  ├── INSERT into PostgreSQL logs table (for history)
  └── PUBLISH to Redis channel: `job:<jobId>:logs`
          │
          ▼
    Socket.IO adapter subscribes to Redis channel
          │
          ▼
    Emit to all browser clients subscribed to this job
          │
          ▼
    React LogViewer renders line
```

### 5.2 Server: Log Endpoint + Redis Publish

```typescript
// POST /api/v1/jobs/:jobId/logs
app.post('/api/v1/jobs/:jobId/logs', authenticateRunner, async (req, res) => {
  const { jobId } = req.params;
  const { stepId, lineNo, content } = req.body;

  // mask secrets before storing
  const masked = maskSecrets(content, req.job.secretValues);

  // persist to PostgreSQL
  await db('logs').insert({ job_id: jobId, step_id: stepId, line_no: lineNo, content: masked });

  // publish to Redis pub/sub
  await redis.publish(`job:${jobId}:logs`, JSON.stringify({
    lineNo,
    content: masked,
    timestamp: new Date().toISOString(),
  }));

  res.status(204).send();
});
```

### 5.3 Server: Socket.IO + Redis Subscriber

```typescript
import { Server } from 'socket.io';
import { createClient } from 'redis';

const io = new Server(server, { cors: { origin: process.env.CLIENT_URL } });
const subscriber = createClient({ url: process.env.REDIS_URL });
await subscriber.connect();

io.on('connection', (socket) => {
  socket.on('subscribe:logs', async (jobId: string) => {
    // send existing logs first (for page refresh)
    const existing = await db('logs')
      .where({ job_id: jobId })
      .orderBy('line_no')
      .select('line_no', 'content', 'timestamp');
    socket.emit('logs:history', existing);

    // subscribe to live channel
    const channel = `job:${jobId}:logs`;
    await subscriber.subscribe(channel, (message) => {
      socket.emit('logs:line', JSON.parse(message));
    });

    socket.on('disconnect', () => {
      subscriber.unsubscribe(channel);
    });
  });
});
```

### 5.4 Secret Masking

```typescript
function maskSecrets(line: string, secretValues: string[]): string {
  let masked = line;
  for (const value of secretValues) {
    if (value.length < 4) continue; // don't mask very short values
    masked = masked.replaceAll(value, '***');
  }
  return masked;
}
```

### 5.5 React LogViewer Component

```typescript
function LogViewer({ jobId }: { jobId: string }) {
  const [logs, setLogs] = useState<LogLine[]>([]);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const socket = io(API_URL);
    socket.emit('subscribe:logs', jobId);

    socket.on('logs:history', (history) => setLogs(history));
    socket.on('logs:line', (line) => setLogs(prev => [...prev, line]));

    return () => { socket.disconnect(); };
  }, [jobId]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [logs]);

  return (
    <div className="bg-gray-950 text-green-400 font-mono text-sm p-4 h-96 overflow-y-auto">
      {logs.map((log, i) => (
        <div key={i} className="flex gap-3">
          <span className="text-gray-500 select-none">{String(log.lineNo).padStart(4, ' ')}</span>
          <span>{log.content}</span>
        </div>
      ))}
      <div ref={bottomRef} />
    </div>
  );
}
```

**Phase 5 Checkpoint:** Job running → browser shows logs streaming live → refresh page → historical logs load → secrets masked ✅

---

# Phase 6 — Cloudflare R2 Artifact Storage

> **Goal:** Build outputs uploaded to R2. Dashboard shows download links. Cache layer for repeated builds.

### 6.1 Why R2 Works Like S3

Cloudflare R2 is S3-compatible. You use the AWS SDK but point it at R2's endpoint:

```typescript
import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

export const r2 = new S3Client({
  region: 'auto',
  endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
});
```

That's the only difference from S3. All upload/download/presign code is identical.

### 6.2 Artifact Upload Flow

The runner uploads artifacts **directly to R2** (not via your server — avoids bandwidth bottleneck):

```
Runner executes "upload artifact" step
  │
  ├── POST /api/v1/jobs/:jobId/artifacts/presign
  │     Body: { name, contentType, size }
  │     Response: { uploadUrl, r2Key }   ← presigned PUT URL
  │
  ├── Runner PUTs file directly to R2 via presigned URL
  │
  └── POST /api/v1/jobs/:jobId/artifacts
        Body: { name, r2Key, size, contentType }
        → Server stores metadata in PostgreSQL
```

Server generates presigned URL:

```typescript
async function getUploadPresignedUrl(key: string, contentType: string) {
  const command = new PutObjectCommand({
    Bucket: process.env.R2_BUCKET_NAME,
    Key: key,
    ContentType: contentType,
  });
  return getSignedUrl(r2, command, { expiresIn: 3600 }); // 1hr to upload
}
```

### 6.3 Artifact Download

```typescript
// GET /api/v1/artifacts/:artifactId/download
app.get('/api/v1/artifacts/:artifactId/download', async (req, res) => {
  const artifact = await db('artifacts').where({ id: req.params.artifactId }).first();
  if (!artifact) return res.status(404).send();

  const command = new GetObjectCommand({
    Bucket: process.env.R2_BUCKET_NAME,
    Key: artifact.r2_key,
  });

  const url = await getSignedUrl(r2, command, { expiresIn: 3600 });
  res.redirect(url); // browser downloads directly from R2
});
```

### 6.4 Cache Layer

Caching allows repeated builds to skip `npm install` etc. by restoring a previous artifact:

```yaml
steps:
  - name: Restore cache
    cache:
      key: node-modules-${{ hashFiles('package-lock.json') }}
      path: node_modules/

  - name: Install
    run: npm ci

  - name: Save cache
    cache:
      key: node-modules-${{ hashFiles('package-lock.json') }}
      path: node_modules/
```

Cache implementation:

- Cache key stored in R2 as `cache/<repoId>/<key>.tar.gz`
- On restore: check if key exists in R2 → download + extract into container
- On save: tar the path → upload to R2 under the key
- R2 lifecycle rules: auto-delete cache objects older than 7 days

### 6.5 R2 Key Structure

```
artifacts/
  <run-id>/
    <job-id>/
      build.zip
      test-report.html

cache/
  <repo-id>/
    node-modules-abc123.tar.gz
    docker-layer-xyz789.tar.gz
```

**Phase 6 Checkpoint:** Step produces file → uploaded to R2 → artifact appears in dashboard with download link → repeated build uses cache, skips install ✅

---

# Phase 7 — React Dashboard

> **Goal:** A usable, clean UI that makes the demo impressive.

### 7.1 Pages & Routes

```
/                        → redirect to /workflows
/workflows               → list of registered repos + workflows
/workflows/:id           → workflow detail + run history
/runs/:runId             → run detail (job list, status overview)
/runs/:runId/jobs/:jobId → job detail (live logs, steps, artifacts)
/runners                 → registered runners, heartbeat status
/repos/:repoId/secrets   → manage secrets for a repo
```

### 7.2 Key Components

**WorkflowList** — shows all workflows, last run status, branch, triggered by  
**RunDetail** — shows all jobs in the run, their statuses, matrix values, duration  
**JobDetail** — the main page: step list on left, log viewer on right  
**LogViewer** — terminal-style log renderer (Socket.IO, auto-scroll, line numbers, monospace)  
**StatusBadge** — color-coded pill: queued (gray), running (blue+pulse), success (green), failed (red)  
**ArtifactList** — name, size, download button (calls `/artifacts/:id/download`)  
**RunnerRegistry** — table of runners, last heartbeat, status, labels  

### 7.3 API Layer

```typescript
// client/src/api/index.ts
const api = axios.create({ baseURL: import.meta.env.VITE_API_URL });

export const workflows = {
  list: () => api.get('/api/v1/workflows').then(r => r.data),
  get: (id: string) => api.get(`/api/v1/workflows/${id}`).then(r => r.data),
};

export const runs = {
  list: (workflowId: string) => api.get(`/api/v1/runs?workflowId=${workflowId}`).then(r => r.data),
  get: (runId: string) => api.get(`/api/v1/runs/${runId}`).then(r => r.data),
  cancel: (runId: string) => api.post(`/api/v1/runs/${runId}/cancel`),
  retry: (runId: string) => api.post(`/api/v1/runs/${runId}/retry`),
};

export const jobs = {
  get: (jobId: string) => api.get(`/api/v1/jobs/${jobId}`).then(r => r.data),
  artifacts: (jobId: string) => api.get(`/api/v1/jobs/${jobId}/artifacts`).then(r => r.data),
};
```

### 7.4 React Query Setup

```typescript
// auto-refetch run status every 3s while running
const { data: run } = useQuery({
  queryKey: ['run', runId],
  queryFn: () => runs.get(runId),
  refetchInterval: (data) => 
    data?.status === 'running' || data?.status === 'pending' ? 3000 : false,
});
```

**Phase 7 Checkpoint:** Full dashboard navigable. Live logs work. Cancel/retry work. Download links work. ✅

---

# Phase 8 — Deployment & Demo Readiness

> **Goal:** Live URL, zero downtime demo, everything working on real infra.

### 8.1 Server Options

**Option A: GCP e2-micro (Always Free)**
- Region: us-central1, us-east1, or us-west1 only
- 1 vCPU, 1GB RAM, 30GB disk
- Always free, no expiry
- Run API server + runner agent on the same VM

**Option B: AWS EC2 t2.micro (12 months free)**
- 1 vCPU, 1GB RAM
- Free for first 12 months

**Option C: Both**
- GCP for API server (always free)
- AWS EC2 for runner (more RAM, good for Docker jobs)

### 8.2 VM Setup (GCP or AWS)

```bash
# Install Docker
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER

# Install Node.js 20
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs

# Install PM2 (process manager)
npm install -g pm2

# Clone repo
git clone https://github.com/you/github-actions-clone.git
cd github-actions-clone

# Setup env vars
cp .env.example .env
nano .env   # fill in all values

# Run DB migrations
cd server && npm install && npm run migrate

# Start API server
pm2 start npm --name "api" -- run start
pm2 start npm --name "runner" -- run start --prefix ../runner

# Auto-restart on reboot
pm2 startup && pm2 save
```

### 8.3 Cloudflare R2 Setup

1. Cloudflare dashboard → R2 → Create bucket: `cicd-artifacts`
2. R2 → Manage API Tokens → Create token (Object Read & Write)
3. Note: Account ID, Access Key ID, Secret Access Key
4. Add to server `.env`
5. Optional: Add custom domain to bucket for public artifact URLs

### 8.4 Upstash Redis Setup

1. upstash.com → Create database → Region closest to your VM
2. Copy `REDIS_URL` (TLS enabled by default)
3. Free tier: 10,000 commands/day — more than enough for demo
4. Enable eviction policy: `allkeys-lru` (keeps BullMQ jobs from filling memory)

### 8.5 Vercel Frontend Deployment

```bash
cd client
npm run build
# push to GitHub → Vercel auto-deploys on push
# Set env var in Vercel: VITE_API_URL=https://your-vm-ip-or-domain
```

### 8.6 Webhook Setup for Demo

For real GitHub webhook to reach your VM:
- If VM has public IP: use it directly as webhook URL
- Nginx reverse proxy on VM → port 3000

```nginx
server {
  listen 80;
  server_name your-domain.com;

  location / {
    proxy_pass http://localhost:3000;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;    # for WebSocket
    proxy_set_header Connection "upgrade";
  }
}
```

### 8.7 Demo Repository

Create `github-actions-clone-demo` repo with:

```yaml
# .cicd/pipeline.yaml
name: Full Demo Pipeline

on:
  push:
    branches: [main]

jobs:
  test:
    runs-on: ubuntu-latest
    strategy:
      matrix:
        node-version: [18, 20]
    steps:
      - name: Setup
        run: echo "Running on Node ${{ matrix.node-version }}"
      - name: Install
        run: npm install
      - name: Test
        run: npm test

  build:
    runs-on: ubuntu-latest
    needs: test
    steps:
      - name: Build
        run: |
          npm run build
          echo "Build complete at $(date)" > build-info.txt
      - name: Upload artifact
        run: echo "Artifact ready"
```

### 8.8 60-Second Demo Script

```
1. "Here's my dashboard. This repo has a pipeline with a matrix build — test on Node 18 and 20, then deploy."

2. Open terminal: git commit -m "trigger demo" && git push

3. Point at dashboard: "Webhook just fired. New run appeared — two test jobs expanding from the matrix."

4. Click into a job: "Watch the logs stream live. This is Redis pub/sub to WebSocket to the browser."

5. Both jobs complete: "Both passed. Build job started — it depends on test passing."

6. Show artifacts tab: "Build artifact uploaded to Cloudflare R2. Download link auto-generated."

7. Show GitHub repo: "Commit shows our status check — green tick, posted back via GitHub API."

8. Wrap: "Full stack: webhook → YAML parser → BullMQ → Docker runner → R2 artifacts → live dashboard. Deployed on GCP free tier."
```

**Phase 8 Checkpoint:** Live push → pipeline runs on real VM → logs stream in deployed dashboard → artifacts downloadable from R2 → green tick on GitHub ✅

---

## Common Pitfalls & How to Avoid Them

| Pitfall | Fix |
|---|---|
| Two runners claim same job | `SELECT FOR UPDATE SKIP LOCKED` in PostgreSQL |
| Docker containers not cleaned up | Always `container.remove()` in `finally` block |
| Secrets appear in logs | Mask all secret values before storing logs |
| Webhook fires twice (GitHub retry) | Unique constraint on `(workflow_id, sha)` in runs table |
| R2 upload URL expires during large upload | Generate presigned URL with 1hr expiry, upload client-side |
| Redis pub/sub loses messages on reconnect | Send log history from PostgreSQL on WebSocket connect |
| GCP VM runs out of disk (Docker images) | Cron to `docker image prune -af` every night |
| Runner hangs on bad step | Job-level timeout: kill container after 1hr |

---

## Resume Bullets

- Architected distributed CI/CD platform with YAML-driven job orchestration, BullMQ queuing, and parallel Docker execution across self-hosted runners
- Implemented real-time log streaming pipeline: container stdout → REST API → Redis pub/sub → Socket.IO → React dashboard (<200ms latency)
- Built YAML parser supporting matrix expansion, conditional steps (`if: success()/failure()`), secret interpolation, and job dependency resolution
- Integrated Cloudflare R2 for artifact storage with presigned URL uploads and direct-download links; zero egress cost vs AWS S3
- Designed atomic job claiming via PostgreSQL `SELECT FOR UPDATE SKIP LOCKED`, preventing race conditions across multiple runner agents
- Deployed full-stack CI/CD platform on GCP free tier (always-on) + Upstash Redis + Cloudflare R2 at zero monthly cost