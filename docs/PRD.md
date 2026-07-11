# GitHub Actions Clone — PRD

**Stack:** Node.js · TypeScript · Express · BullMQ · PostgreSQL · Redis · Docker · AWS S3 · React  
**API:** REST (Express.js)  
**Infra:** Free tier (Render + Vercel + Upstash + AWS S3)  
**Complexity:** Medium path

---

## What Is This?

A self-hosted GitHub Actions clone. Developers register their repos, define workflows in YAML, and your platform executes them in isolated Docker containers — with real-time log streaming, artifact storage, and a React dashboard.

**The user flow:**
1. Developer adds a webhook URL (your server) to their GitHub repo settings
2. They push code → GitHub fires a POST to your webhook
3. Your server fetches their `.github/workflows/*.yaml`, parses it, queues jobs
4. A runner agent claims jobs, executes steps in Docker containers
5. Logs stream live to the dashboard. Artifacts go to S3.

---

## Architecture Overview

```
GitHub Push
    │
    ▼
Webhook Receiver (Express)
    │  validates HMAC, fetches YAML via GitHub API
    ▼
YAML Parser
    │  expands matrix, validates steps, builds job list
    ▼
BullMQ Queue (Redis)
    │
    ▼
Runner Agent (Node.js worker)
    │  polls REST API → claims job → spins Docker container
    ▼
Docker Container (isolated, resource-limited)
    │  executes steps, streams logs
    ▼
┌─────────────────────────┐
│  stdout/stderr          │──▶  REST API  ──▶  Redis pub/sub  ──▶  WebSocket  ──▶  React Dashboard
│  exit code              │──▶  PostgreSQL (job status, logs)
│  artifacts              │──▶  AWS S3 (files) + PostgreSQL (metadata)
└─────────────────────────┘
    │
    ▼
GitHub API (post commit status check ✅ / ❌)
```

---

## The Role of YAML

The `.github/workflows/deploy.yaml` file is the **contract between intent and execution**.

```yaml
name: Test Suite
on:
  push:
    branches: [main]

jobs:
  test:
    runs-on: ubuntu-latest
    strategy:
      matrix:
        node-version: [16, 18, 20]   # expands into 3 parallel jobs
    steps:
      - name: Install
        run: npm install
      - name: Test
        run: npm test
      - name: Upload coverage
        if: success()
        run: echo "uploading..."
```

Your parser reads this and produces:
- **Trigger config** → when to run
- **Job list** → what to run (matrix × 3 = 3 jobs)
- **Step DAG** → in what order, with what conditions
- **Secrets/env** → what to inject into the container

---

## Free Tier Infrastructure

| Service | Provider | Free Limits |
|---|---|---|
| API server | Render (Web Service) | 750 hrs/month, 512MB RAM |
| Runner worker | Render (Background Worker) | Always-on worker process |
| PostgreSQL | Render (Managed PG) | 1GB storage, 1 DB |
| Redis | Upstash | 10,000 req/day, 256MB |
| Artifact storage | AWS S3 | 5GB, 20k GET / 2k PUT/month |
| Frontend | Vercel | Unlimited hobby, global CDN |
| Webhook tunnel (dev) | ngrok | 1 free tunnel, public HTTPS |

> Render free tier sleeps after 15min inactivity (~30s cold start). Use [UptimeRobot](https://uptimerobot.com) (free) to keep it awake during demo.

---

## REST API (Express.js)

All endpoints prefixed `/api/v1/`. Auth: Bearer token (JWT).

### Webhooks
| Method | Endpoint | Description |
|---|---|---|
| POST | `/webhook/github` | Receive GitHub event, validate HMAC, fetch YAML, queue jobs |

### Workflows & Runs
| Method | Endpoint | Description |
|---|---|---|
| GET | `/api/v1/workflows` | List registered workflows |
| POST | `/api/v1/workflows` | Register new workflow (link repo) |
| GET | `/api/v1/runs` | List runs (paginated, filter by status/branch) |
| GET | `/api/v1/runs/:runId` | Run detail with nested jobs + steps |
| POST | `/api/v1/runs/:runId/cancel` | Cancel all pending/running jobs |
| POST | `/api/v1/runs/:runId/retry` | Re-queue failed jobs |

### Jobs & Artifacts
| Method | Endpoint | Description |
|---|---|---|
| GET | `/api/v1/jobs/:jobId` | Job detail + step list |
| GET | `/api/v1/jobs/:jobId/logs` | Persisted logs (after completion) |
| GET | `/api/v1/jobs/:jobId/artifacts` | List artifacts with signed S3 URLs |
| GET | `/api/v1/artifacts/:id/download` | Redirect to S3 signed URL (1hr) |

### Runner Agent (Internal)
| Method | Endpoint | Description |
|---|---|---|
| POST | `/api/v1/runners/register` | Register runner → returns auth_token |
| POST | `/api/v1/runners/heartbeat` | Update last_heartbeat (every 30s) |
| POST | `/api/v1/runners/claim` | Atomic job claim → job or 204 |
| POST | `/api/v1/jobs/:jobId/logs` | Append log line → server publishes to Redis |
| POST | `/api/v1/jobs/:jobId/status` | Update job status |
| POST | `/api/v1/jobs/:jobId/artifacts` | Store artifact reference post-S3 upload |

---

## Database Schema

```sql
repos       (id, github_repo_url, webhook_secret, created_at)
workflows   (id, repo_id, name, yaml_content, updated_at)
runs        (id, workflow_id, sha, branch, trigger, status, created_at, completed_at)
jobs        (id, run_id, name, status, exit_code, runner_id, started_at, completed_at)
steps       (id, job_id, name, status, duration_ms, exit_code)
logs        (id, job_id, line_no, content, timestamp)
artifacts   (id, run_id, job_id, name, s3_key, size_bytes, created_at)
runners     (id, name, labels jsonb, auth_token_hash, last_heartbeat, status)
secrets     (id, repo_id, name, encrypted_value)
```

---

## Project Structure

```
github-actions-clone/
├── server/
│   └── src/
│       ├── routes/
│       │   ├── webhook.ts       # POST /webhook/github
│       │   ├── workflows.ts
│       │   ├── runs.ts
│       │   ├── jobs.ts
│       │   └── runners.ts
│       ├── queue/
│       │   ├── manager.ts       # BullMQ init
│       │   └── processor.ts     # Job event handlers
│       ├── executor/
│       │   ├── parser.ts        # YAML → job list
│       │   └── matrix.ts        # Matrix expansion
│       ├── storage/
│       │   ├── db.ts            # PostgreSQL pool
│       │   ├── s3.ts            # AWS S3 client
│       │   └── migrations/
│       ├── pubsub/
│       │   └── logs.ts          # Redis pub/sub channels
│       ├── github/
│       │   ├── verify.ts        # HMAC validation
│       │   └── api.ts           # Octokit calls
│       ├── utils/
│       │   └── crypto.ts        # AES-256 encrypt/decrypt
│       └── server.ts
│
├── runner/
│   └── src/
│       ├── agent.ts             # Poll /claim, dispatch jobs
│       ├── docker.ts            # Container lifecycle (dockerode)
│       └── uploader.ts          # Log streaming + S3 upload
│
├── client/
│   └── src/
│       ├── api/                 # Axios wrappers
│       ├── pages/               # Workflows, RunDetail, Runners
│       └── components/
│           ├── LogViewer.tsx    # Socket.IO live log renderer
│           ├── JobBadge.tsx
│           └── Artifacts.tsx
│
├── docker-compose.yml           # Local: PostgreSQL + Redis
└── README.md
```

---

## Phases

### Phase 1 — Foundation
> Goal: server boots, webhook fires, event stored in DB

- Express server + TypeScript scaffold
- PostgreSQL schema + migrations
- `POST /webhook/github` endpoint
- GitHub HMAC-SHA256 signature verification
- Fetch `.github/workflows/*.yaml` via GitHub API (Octokit)
- Store raw event + run record in DB

**Checkpoint:** Push to GitHub → run row appears in PostgreSQL ✅

---

### Phase 2 — YAML Parsing & Job Queue
> Goal: workflow YAML becomes queued jobs

- Parse YAML: triggers, jobs, steps, env vars, secrets
- Matrix expansion (`node-version: [16, 18, 20]` → 3 jobs)
- Conditional step parsing (`if: success()`, `if: failure()`)
- BullMQ + Upstash Redis setup
- Insert run + all jobs in one PostgreSQL transaction (idempotent)
- Enqueue each job to BullMQ

**Checkpoint:** YAML with matrix → 3 separate jobs visible in BullBoard ✅

---

### Phase 3 — Runner Agent & Docker Execution
> Goal: jobs actually run in containers

- Runner agent setup (Node.js process on Render worker)
- `POST /api/v1/runners/register` + auth token
- Poll `POST /api/v1/runners/claim` every 5s (atomic claim via `SELECT FOR UPDATE SKIP LOCKED`)
- Spin Docker container per job (`dockerode`)
  - Inject env vars + decrypted secrets
  - Resource limits: 512MB RAM, 1 CPU
- Capture stdout/stderr, POST each line to `/api/v1/jobs/:id/logs`
- On completion: POST exit code to `/api/v1/jobs/:id/status`
- Cleanup: `container.remove()` always in finally block
- Heartbeat every 30s; server cron re-queues jobs from crashed runners

**Checkpoint:** Push → job executes in Docker → exit code saved in DB ✅

---

### Phase 4 — Real-time Logs & Artifact Storage
> Goal: see logs live, download build artifacts

- Server publishes each log line to Redis pub/sub (`job:<id>:logs`)
- Socket.IO adapter subscribes + emits to browser client
- React `LogViewer` component consuming WebSocket (auto-scroll, ANSI color)
- Runner uploads artifacts directly to S3 via AWS SDK
- POST artifact metadata to `/api/v1/jobs/:id/artifacts`
- Server generates pre-signed S3 URL (1hr expiry) for download
- Persist logs to PostgreSQL after job completes (for history)

**Checkpoint:** Live logs stream in browser; artifact appears with download link ✅

---

### Phase 5 — Dashboard UI
> Goal: usable React frontend for the whole platform

- Workflow list page (repos, recent runs, status badges)
- Run detail page (job list, step breakdown, duration, triggered by)
- Live log viewer (Socket.IO, terminal-style, line numbers)
- Artifact browser (name, size, download button)
- Cancel / Retry run buttons (call REST endpoints)
- Runner registry page (registered runners, heartbeat status, labels)
- Error states, empty states, loading skeletons

**Checkpoint:** Full UI navigable with no broken states ✅

---

### Phase 6 — GitHub Integration & Status Checks
> Goal: round-trip with real GitHub

- POST commit status back to GitHub API after job completes (✅ / ❌)
- Show status check on GitHub PR / commit page
- Support `paths:` filter in YAML triggers (only run if certain files changed)
- Manual trigger support (`workflow_dispatch`)

**Checkpoint:** GitHub PR shows green checkmark from your platform ✅

---

### Phase 7 — Deploy & Demo
> Goal: live URL, zero-cost, demo-ready

- Deploy API to Render (Web Service)
- Deploy runner agent to Render (Background Worker)
- Configure Upstash Redis + Render PostgreSQL
- Deploy frontend to Vercel
- Configure AWS S3 bucket + IAM role (S3 read/write only)
- Add UptimeRobot ping to prevent Render sleep
- Set up demo repo with 3 example workflows
- Write README (setup guide + architecture diagram)
- Record 60-second demo video

**Checkpoint:** Push to demo repo → pipeline runs on live infra → logs stream in dashboard ✅

---

## Key Technical Decisions (Interview-Ready)

**Why BullMQ over Kafka?**
BullMQ runs on Redis (already needed for pub/sub). Kafka is overkill for this scale. BullMQ gives retries, dead-letter queues, priorities, and a built-in UI (BullBoard) out of the box.

**Why REST over WebSocket for runner ↔ server?**
Runners are stateless pollers — they claim work and POST results. REST is simpler, stateless, and easier to debug. WebSocket adds connection management complexity with no benefit here. Only the browser log streaming needs WebSocket.

**How do you prevent two runners claiming the same job?**
`SELECT ... FOR UPDATE SKIP LOCKED` inside a transaction. First runner to acquire the row lock wins. BullMQ does this natively at the queue level too.

**How do you handle runner crashes?**
Runner heartbeats every 30s. A server-side cron checks for runners with `last_heartbeat > 2min` and re-queues their active jobs. Max 3 retries per job before dead-lettering.

**Why Redis pub/sub instead of streaming directly to WebSocket?**
Decoupling — the runner doesn't know about browser clients. Multiple dashboard tabs can subscribe to the same log stream. If the runner restarts, the channel persists. Clean separation of concerns.

**How are secrets secured?**
Stored AES-256 encrypted in PostgreSQL. Decrypted in memory at job start, injected as Docker env vars. Never written to logs. Container deleted post-run.

---

## Resume Bullets

- Architected distributed CI/CD platform with BullMQ job queue supporting parallel matrix builds across self-hosted Docker runners
- Implemented real-time log streaming: Docker stdout → REST API → Redis pub/sub → Socket.IO → React dashboard (<200ms latency)
- Built YAML workflow parser with matrix expansion, conditional step execution, and DAG-based dependency resolution
- Integrated AWS S3 for artifact storage with pre-signed URL delivery; PostgreSQL for ACID-compliant job state management
- Designed REST API (Express.js) powering webhook ingestion, atomic job claiming, runner heartbeating, and artifact retrieval
- Deployed full-stack CI/CD platform on free-tier infrastructure (Render + Vercel + Upstash + S3) at zero monthly cost