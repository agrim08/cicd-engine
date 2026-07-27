<div align="center">

<img src="https://raw.githubusercontent.com/agrim08/cicd-engine/main/docs/assets/banner.png" alt="cicd-engine banner" width="100%" />

# ⚡ cicd-engine

**A self-hosted, GitHub Actions-inspired CI/CD platform built for engineers who want to understand what happens under the hood.**

Distributed Docker runners · BullMQ job scheduling · Real-time log streaming · React dashboard

<br/>

[![Node.js](https://img.shields.io/badge/Node.js-20.x-339933?style=flat-square&logo=node.js&logoColor=white)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178C6?style=flat-square&logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![PostgreSQL](https://img.shields.io/badge/PostgreSQL-15-4169E1?style=flat-square&logo=postgresql&logoColor=white)](https://www.postgresql.org)
[![Redis](https://img.shields.io/badge/Redis-7-DC382D?style=flat-square&logo=redis&logoColor=white)](https://redis.io)
[![Docker](https://img.shields.io/badge/Docker-24-2496ED?style=flat-square&logo=docker&logoColor=white)](https://www.docker.com)
[![React](https://img.shields.io/badge/React-18-61DAFB?style=flat-square&logo=react&logoColor=black)](https://react.dev)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg?style=flat-square)](./LICENSE)

<br/>

[**Live Demo**](https://cicd-engine.vercel.app) · [**Walkthrough**](./docs/walkthrough.md) · [**PRD**](./docs/PRD.md) · [**Architecture**](./docs/architectural_assessment.md) · [**Report a Bug**](https://github.com/agrim08/cicd-engine/issues)

**Docs:** [Webhook Flow](./docs/github-webhook.md) · [YAML Parsing](./docs/yaml_parsing.md) · [Matrix & Triggers](./docs/matrix_and_triggers.md) · [Encryption Strategy](./docs/encryption_strategy.md) · [Phase Plan](./docs/phase_wise_work.md)

</div>

---

## 📋 Table of Contents

- [What Is This?](#-what-is-this)
- [Architecture](#-architecture)
- [Features](#-features)
- [Tech Stack](#-tech-stack)
- [Project Structure](#-project-structure)
- [Database Schema](#-database-schema)
- [REST API Reference](#-rest-api-reference)
- [Getting Started](#-getting-started)
  - [Prerequisites](#prerequisites)
  - [Local Setup](#local-setup)
  - [Environment Variables](#environment-variables)
- [Workflow YAML Format](#-workflow-yaml-format)
- [How It Works](#-how-it-works-end-to-end)
- [Security Model](#-security-model)
- [Deployment](#-deployment-free-tier)
- [Roadmap](#-roadmap)
- [Key Technical Decisions](#-key-technical-decisions)
- [Contributing](#-contributing)
- [License](#-license)

---

## 🚀 What Is This?

**cicd-engine** is a production-grade clone of GitHub Actions built from scratch to demonstrate how distributed CI/CD infrastructure actually works — not as a theoretical exercise, but as a fully functional, deployable platform.

Developers register their GitHub repositories, define workflows in YAML, and the platform executes them in isolated Docker containers. Every run is observable in real-time through a live log-streaming React dashboard.

**Why build this?**

Most CI/CD tutorials stop at the surface. This project goes deeper:

- How does a webhook translate into a queued, parallelized job graph?
- How do you prevent two workers from claiming the same job atomically?
- How do you stream 10,000 log lines per minute without melting your database?
- How do you store secrets without ever writing them to disk or logs?

This project answers all of those questions with working code.

---

## 🏗️ Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│                        GitHub Repository                         │
│                     (push / PR / dispatch)                       │
└───────────────────────────────┬──────────────────────────────────┘
                                │ HMAC-signed webhook POST
                                ▼
┌──────────────────────────────────────────────────────────────────┐
│                    Webhook Receiver (Express)                     │
│      Validates HMAC-SHA256 · Fetches .cicd/pipeline.yaml         │
│               via GitHub API (Octokit) · Caches in PG            │
└───────────────────────────────┬──────────────────────────────────┘
                                │
                                ▼
┌──────────────────────────────────────────────────────────────────┐
│                         YAML Parser                              │
│   Expands matrix strategy · Resolves job dependencies (needs:)   │
│         Builds step DAG · Validates conditionals (if:)           │
└───────────────────────────────┬──────────────────────────────────┘
                                │
                                ▼
┌──────────────────────────────────────────────────────────────────┐
│                    BullMQ Queue  (Redis)                          │
│        One queue entry per job · Priority · Retry policy         │
└────────────┬──────────────────────────────────────┬─────────────┘
             │                                      │
             ▼                                      ▼
┌────────────────────────┐             ┌────────────────────────┐
│    Runner Agent #1     │             │    Runner Agent #2     │
│  Poll /claim every 5s  │             │  Poll /claim every 5s  │
│  SELECT FOR UPDATE     │             │  SELECT FOR UPDATE     │
│    SKIP LOCKED         │             │    SKIP LOCKED         │
└────────────┬───────────┘             └────────────┬───────────┘
             │                                      │
             ▼                                      ▼
┌────────────────────────┐             ┌────────────────────────┐
│   Docker Container     │             │   Docker Container     │
│  Resource-limited      │             │  Resource-limited      │
│  512MB RAM · 1 CPU     │             │  512MB RAM · 1 CPU     │
│  Secrets injected      │             │  Secrets injected      │
│  as env vars (AES-256) │             │  as env vars (AES-256) │
└──────┬────────┬────────┘             └──────┬────────┬────────┘
       │        │                             │        │
  stdout/    artifacts                   stdout/    artifacts
  stderr                                 stderr
       │        │                             │        │
       ▼        ▼                             ▼        ▼
┌─────────────────┐  ┌──────────┐   ┌─────────────────┐
│  REST API       │  │  AWS S3  │   │  REST API       │
│  /jobs/:id/logs │  │(artifacts│   │  /jobs/:id/logs │
└────────┬────────┘  └──────────┘   └────────┬────────┘
         │                                   │
         ▼                                   ▼
┌──────────────────────────────────────────────────────┐
│                 Redis Pub/Sub                         │
│            channel: job:<id>:logs                    │
└──────────────────────────┬───────────────────────────┘
                           │
                           ▼
┌──────────────────────────────────────────────────────┐
│              Socket.IO  (WebSocket)                   │
└──────────────────────────┬───────────────────────────┘
                           │
                           ▼
┌──────────────────────────────────────────────────────┐
│              React Dashboard                          │
│   Live log viewer · Run history · Artifact browser   │
│      Runner registry · Cancel / Retry controls       │
└──────────────────────────────────────────────────────┘
         │
         ▼ (on job complete)
┌──────────────────────────────────────────────────────┐
│             GitHub Commit Status API                  │
│      POST /repos/:owner/:repo/statuses/:sha           │
│              ✅ success  /  ❌ failure                │
└──────────────────────────────────────────────────────┘
```

---

## ✨ Features

### Core Pipeline Engine
- **YAML-driven workflows** — define triggers, jobs, steps, and environment variables in a single `.cicd/pipeline.yaml` file
- **Matrix strategy expansion** — `node-version: [16, 18, 20]` automatically fans out into 3 parallel, independent jobs
- **Job dependency graph** — `needs:` field enforces execution order; downstream jobs only start when upstream jobs succeed
- **Conditional step execution** — `if: success()` / `if: failure()` / `if: always()` control step behavior at runtime
- **HMAC-SHA256 webhook verification** — every incoming GitHub event is cryptographically validated before processing

### Distributed Runner System
- **Atomic job claiming** — `SELECT ... FOR UPDATE SKIP LOCKED` prevents two runners from ever claiming the same job
- **Crash recovery** — runners heartbeat every 30s; server-side cron re-queues jobs from runners that go silent for > 2 minutes (max 3 retries before dead-letter)
- **Resource isolation** — each job runs in its own Docker container with enforced 512MB RAM and 1 CPU limits
- **Graceful cleanup** — containers are always removed in a `finally` block regardless of exit code

### Real-time Observability
- **Live log streaming** — Docker stdout/stderr → REST API → Redis Pub/Sub → Socket.IO → browser in < 200ms
- **Batched persistence** — logs buffered in-memory and bulk-written to PostgreSQL on job completion (avoids per-line DB writes)
- **ANSI color support** — terminal-style log rendering in the React dashboard

### Security
- **AES-256 encrypted secrets** — stored encrypted in PostgreSQL, decrypted in memory at job start, injected as Docker env vars, never logged
- **Non-root containers** — all runner containers execute as non-root users by default
- **No socket exposure** — the Docker socket is never mounted inside guest containers

### Storage & Artifacts
- **AWS S3 artifact storage** — runners upload build artifacts directly to S3 via pre-signed upload URLs
- **Pre-signed download URLs** — 1-hour expiry signed URLs served via the REST API (never proxied through the server)
- **Cloudflare R2 compatible** — zero egress fee alternative to S3; swap via a single env var change

### GitHub Integration
- **Commit status checks** — posts ✅/❌ back to GitHub after every job completes (visible on PRs)
- **`paths:` trigger filter** — only run workflows when specific files or directories change
- **`workflow_dispatch`** — manual trigger support via the dashboard or GitHub UI

---

## 🛠️ Tech Stack

| Layer | Technology | Why |
|---|---|---|
| **API Server** | Node.js + TypeScript + Express | Type-safe, fast, excellent ecosystem for async I/O |
| **Job Queue** | BullMQ | Built on Redis; native retries, dead-letter queues, priorities, BullBoard UI |
| **Database** | PostgreSQL 15 | ACID compliance for job state; `SELECT FOR UPDATE SKIP LOCKED` for atomic claims |
| **Cache / Pub-Sub** | Redis 7 (Upstash) | BullMQ backend + real-time log channel fan-out |
| **Container Runtime** | Docker + dockerode | Isolated execution with resource limits; no VM overhead |
| **WebSocket** | Socket.IO | Reliable, reconnection-aware real-time transport to browser clients |
| **Artifact Storage** | AWS S3 / Cloudflare R2 | Durable file storage; R2 eliminates egress costs |
| **Frontend** | React 18 + TypeScript | Component-based UI; Socket.IO client for live log rendering |
| **GitHub API** | Octokit | Fetch YAML files, post commit statuses, verify webhook signatures |
| **Secrets** | AES-256-GCM (Node.js crypto) | Symmetric encryption; keys stored in env vars, never in DB |

---

## 📁 Project Structure

```
cicd-engine/
│
├── .cicd/                             # This repo's own CI pipeline (dogfooding)
│
├── backend/
│   ├── runner/                        # Runner agent — the process that claims and executes jobs
│   │   ├── src/
│   │   │   ├── agent.ts              # Poll /claim every 5s, dispatch to docker executor
│   │   │   ├── docker.ts             # Container lifecycle: create, start, attach, remove (dockerode)
│   │   │   └── uploader.ts           # Buffered log streaming + S3 direct artifact upload
│   │   ├── nodemon.json
│   │   ├── package.json
│   │   └── tsconfig.json
│   │
│   └── server/                        # API server — webhook ingestion, job orchestration, pub/sub
│       ├── src/
│       │   ├── routes/
│       │   │   ├── webhook.ts        # POST /webhook/github — HMAC validation, YAML fetch, enqueue
│       │   │   ├── workflows.ts      # CRUD for registered workflows
│       │   │   ├── runs.ts           # Run list, run detail, cancel, retry
│       │   │   ├── jobs.ts           # Job detail, logs, artifacts
│       │   │   └── runners.ts        # Runner registration, heartbeat, claim, status updates
│       │   │
│       │   ├── queue/
│       │   │   ├── manager.ts        # BullMQ queue init + BullBoard setup
│       │   │   └── processor.ts      # Job lifecycle event handlers (active, completed, failed)
│       │   │
│       │   ├── executor/
│       │   │   ├── parser.ts         # YAML → typed JobDefinition[]
│       │   │   └── matrix.ts         # Matrix strategy expansion + dependency graph resolution
│       │   │
│       │   ├── storage/
│       │   │   ├── db.ts             # PostgreSQL connection pool (pg)
│       │   │   ├── s3.ts             # AWS S3 / R2 client + pre-signed URL generation
│       │   │   └── migrations/       # SQL migration files (sequential)
│       │   │
│       │   ├── pubsub/
│       │   │   └── logs.ts           # Redis pub/sub: publish log lines, subscribe for Socket.IO
│       │   │
│       │   ├── github/
│       │   │   ├── verify.ts         # HMAC-SHA256 signature verification middleware
│       │   │   └── api.ts            # Octokit: fetch YAML, post commit status
│       │   │
│       │   ├── utils/
│       │   │   └── crypto.ts         # AES-256-GCM encrypt / decrypt for secrets
│       │   │
│       │   └── server.ts             # App entry: Express + Socket.IO + cron jobs
│       │
│       ├── simulate_webhook.js        # Dev utility — fire a fake GitHub push event locally
│       ├── nodemon.json
│       ├── package.json
│       └── tsconfig.json
│
├── docs/                              # Architecture and design documentation
│   ├── architectural_assessment.md   # Stack evaluation, roadblocks, security boundaries
│   ├── encryption_strategy.md        # AES-256 secret storage and injection design
│   ├── github-webhook.md             # Webhook flow, HMAC verification, event handling
│   ├── matrix_and_triggers.md        # Matrix expansion logic and YAML trigger parsing
│   ├── phase_wise_work.md            # Development phases and milestone checkpoints
│   ├── PRD.md                        # Full product requirements document
│   ├── walkthrough.md                # Step-by-step end-to-end system walkthrough
│   └── yaml_parsing.md               # YAML schema, parser design, step DAG construction
│
├── docker-compose.yml                 # Local dev: PostgreSQL 15 + Redis 7
├── .env.example                       # All required environment variables documented
├── package.json                       # Root workspace config
└── README.md
```

---

## 🗄️ Database Schema

```sql
-- Registered GitHub repositories
CREATE TABLE repos (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    github_repo_url  TEXT NOT NULL UNIQUE,
    webhook_secret   TEXT NOT NULL,
    created_at  TIMESTAMPTZ DEFAULT now()
);

-- Workflow definitions cached from .cicd/pipeline.yaml
CREATE TABLE workflows (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    repo_id     UUID REFERENCES repos(id) ON DELETE CASCADE,
    name        TEXT NOT NULL,
    yaml_content TEXT NOT NULL,
    updated_at  TIMESTAMPTZ DEFAULT now()
);

-- A run = one pipeline execution triggered by a push/dispatch event
CREATE TABLE runs (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workflow_id UUID REFERENCES workflows(id),
    sha         TEXT NOT NULL,           -- git commit SHA
    branch      TEXT NOT NULL,
    trigger     TEXT NOT NULL,           -- push | pull_request | workflow_dispatch
    status      TEXT NOT NULL DEFAULT 'pending',  -- pending | running | success | failure | cancelled
    created_at  TIMESTAMPTZ DEFAULT now(),
    completed_at TIMESTAMPTZ
);

-- A job = one node in the workflow DAG (one matrix expansion = one job)
CREATE TABLE jobs (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    run_id      UUID REFERENCES runs(id) ON DELETE CASCADE,
    name        TEXT NOT NULL,
    status      TEXT NOT NULL DEFAULT 'queued',
    exit_code   INTEGER,
    runner_id   UUID REFERENCES runners(id),
    started_at  TIMESTAMPTZ,
    completed_at TIMESTAMPTZ
);

-- Steps within a job, executed sequentially
CREATE TABLE steps (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    job_id      UUID REFERENCES jobs(id) ON DELETE CASCADE,
    name        TEXT NOT NULL,
    status      TEXT NOT NULL DEFAULT 'pending',
    duration_ms INTEGER,
    exit_code   INTEGER
);

-- Persisted log lines (written in bulk on job completion)
CREATE TABLE logs (
    id          BIGSERIAL PRIMARY KEY,
    job_id      UUID REFERENCES jobs(id) ON DELETE CASCADE,
    line_no     INTEGER NOT NULL,
    content     TEXT NOT NULL,
    timestamp   TIMESTAMPTZ DEFAULT now()
);

-- Build artifacts stored in S3/R2
CREATE TABLE artifacts (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    run_id      UUID REFERENCES runs(id),
    job_id      UUID REFERENCES jobs(id),
    name        TEXT NOT NULL,
    s3_key      TEXT NOT NULL,
    size_bytes  BIGINT,
    created_at  TIMESTAMPTZ DEFAULT now()
);

-- Self-hosted runner processes
CREATE TABLE runners (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name            TEXT NOT NULL,
    labels          JSONB DEFAULT '[]',     -- e.g. ["ubuntu", "docker", "node-20"]
    auth_token_hash TEXT NOT NULL,          -- bcrypt hash of the runner's auth token
    last_heartbeat  TIMESTAMPTZ,
    status          TEXT DEFAULT 'idle'     -- idle | busy | offline
);

-- AES-256 encrypted repository secrets
CREATE TABLE secrets (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    repo_id         UUID REFERENCES repos(id) ON DELETE CASCADE,
    name            TEXT NOT NULL,          -- e.g. "NPM_TOKEN"
    encrypted_value TEXT NOT NULL,
    UNIQUE(repo_id, name)
);
```

---

## 📡 REST API Reference

All endpoints are prefixed `/api/v1/`. Authentication: `Authorization: Bearer <JWT>`.

### Webhooks

| Method | Endpoint | Description |
|---|---|---|
| `POST` | `/webhook/github` | Receive GitHub event, validate HMAC-SHA256, fetch YAML, enqueue jobs |

### Workflows & Runs

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/v1/workflows` | List all registered workflows |
| `POST` | `/api/v1/workflows` | Register a new workflow (link a GitHub repo) |
| `GET` | `/api/v1/runs` | List runs — paginated, filterable by `status`, `branch`, `workflow_id` |
| `GET` | `/api/v1/runs/:runId` | Run detail with nested jobs and steps |
| `POST` | `/api/v1/runs/:runId/cancel` | Cancel all pending and running jobs in a run |
| `POST` | `/api/v1/runs/:runId/retry` | Re-queue all failed jobs in a run |

### Jobs & Artifacts

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/v1/jobs/:jobId` | Job detail including step list and timing |
| `GET` | `/api/v1/jobs/:jobId/logs` | Persisted log lines (available after job completion) |
| `GET` | `/api/v1/jobs/:jobId/artifacts` | List artifacts with pre-signed S3 download URLs |
| `GET` | `/api/v1/artifacts/:id/download` | Redirect to S3 signed URL (1-hour expiry) |

### Runner Agent (Internal)

> These endpoints are authenticated with a runner-specific `auth_token` returned at registration, not a user JWT.

| Method | Endpoint | Description |
|---|---|---|
| `POST` | `/api/v1/runners/register` | Register a runner process — returns `auth_token` |
| `POST` | `/api/v1/runners/heartbeat` | Update `last_heartbeat` timestamp (called every 30s) |
| `POST` | `/api/v1/runners/claim` | Atomically claim the next available job — returns job payload or `204` |
| `POST` | `/api/v1/jobs/:jobId/logs` | Append a batch of log lines — server publishes to Redis channel |
| `POST` | `/api/v1/jobs/:jobId/status` | Update job status and exit code |
| `POST` | `/api/v1/jobs/:jobId/artifacts` | Store artifact S3 reference after runner direct-upload |

---

## ⚡ Getting Started

### Prerequisites

| Tool | Version | Notes |
|---|---|---|
| Node.js | 20.x+ | LTS recommended |
| Docker | 24.x+ | Required for running jobs locally |
| PostgreSQL | 15+ | Or use the included `docker-compose.yml` |
| Redis | 7+ | Or use the included `docker-compose.yml` |

### Local Setup

**1. Clone the repository**

```bash
git clone https://github.com/agrim08/cicd-engine.git
cd cicd-engine
```

**2. Start infrastructure (PostgreSQL + Redis)**

```bash
docker-compose up -d
```

**3. Install dependencies**

```bash
npm install                     # root workspace
cd backend && npm install
cd ../runner && npm install
cd ../client && npm install
```

**4. Configure environment variables**

```bash
cp .env.example .env
# Fill in values — see Environment Variables section below
```

**5. Run database migrations**

```bash
cd backend
npm run migrate
```

**6. Start the development servers**

```bash
# Terminal 1 — API server
cd backend && npm run dev

# Terminal 2 — Runner agent
cd runner && npm run dev

# Terminal 3 — React dashboard
cd client && npm run dev
```

**7. Expose your webhook endpoint (for GitHub to reach your local server)**

```bash
ngrok http 3000
# Copy the HTTPS forwarding URL
# Add it as a webhook in your GitHub repo settings:
# Settings → Webhooks → Add webhook
# Payload URL: https://<your-ngrok-url>/webhook/github
# Content type: application/json
# Secret: <your WEBHOOK_SECRET from .env>
# Events: Just the push event (to start)
```

---

### Environment Variables

```bash
# ── Database ─────────────────────────────────────────────────
DATABASE_URL=postgresql://user:password@localhost:5432/cicdengine

# ── Redis ────────────────────────────────────────────────────
REDIS_URL=redis://localhost:6379

# ── GitHub ───────────────────────────────────────────────────
GITHUB_WEBHOOK_SECRET=your_webhook_secret_here
GITHUB_PAT=ghp_your_personal_access_token

# ── JWT Auth ─────────────────────────────────────────────────
JWT_SECRET=a_long_random_string_at_least_32_chars

# ── Secrets Encryption ───────────────────────────────────────
ENCRYPTION_KEY=32_byte_hex_key_for_aes256_encryption

# ── AWS S3 / Cloudflare R2 ───────────────────────────────────
S3_BUCKET_NAME=cicd-engine-artifacts
S3_REGION=us-east-1
AWS_ACCESS_KEY_ID=your_access_key_id
AWS_SECRET_ACCESS_KEY=your_secret_access_key
# For Cloudflare R2, also set:
# S3_ENDPOINT=https://<account_id>.r2.cloudflarestorage.com

# ── Server ───────────────────────────────────────────────────
PORT=3000
NODE_ENV=development
```

---

## 📄 Workflow YAML Format

Place your pipeline definition at `.cicd/pipeline.yaml` in your repository root.

```yaml
name: Test & Build

on:
  push:
    branches: [main, dev]
    paths:
      - "src/**"
      - "package.json"
  workflow_dispatch: {}      # Enable manual trigger from dashboard

jobs:
  test:
    runs-on: ubuntu-latest
    strategy:
      matrix:
        node-version: [18, 20, 22]    # Expands into 3 parallel jobs
    steps:
      - name: Checkout
        run: git clone https://github.com/${{ github.repository }} .

      - name: Setup Node ${{ matrix.node-version }}
        run: |
          nvm install ${{ matrix.node-version }}
          nvm use ${{ matrix.node-version }}

      - name: Install dependencies
        run: npm ci

      - name: Run tests
        run: npm test

      - name: Upload coverage report
        if: success()
        run: |
          tar -czf coverage-node${{ matrix.node-version }}.tar.gz coverage/
        artifact: coverage-node${{ matrix.node-version }}.tar.gz

  build:
    runs-on: ubuntu-latest
    needs: [test]             # Only runs if ALL test matrix jobs succeed
    steps:
      - name: Checkout
        run: git clone https://github.com/${{ github.repository }} .

      - name: Install & Build
        run: |
          npm ci
          npm run build

      - name: Upload build artifact
        if: success()
        run: echo "build complete"
        artifact: dist/

env:
  NODE_ENV: test
  NPM_TOKEN: ${{ secrets.NPM_TOKEN }}    # Injected from encrypted secrets store
```

---

## 🔄 How It Works — End to End

```
1. TRIGGER
   Developer pushes to main branch.
   GitHub fires a signed POST to /webhook/github.

2. VALIDATION
   Server verifies HMAC-SHA256 signature using the repo's webhook_secret.
   Invalid signature → 401. Valid → proceed.

3. YAML FETCH
   Server calls GitHub API (Octokit) to fetch .cicd/pipeline.yaml at the pushed SHA.
   Parsed YAML is cached in the workflows table keyed by repo + SHA.

4. JOB GRAPH CONSTRUCTION
   YAML parser expands matrix strategies (3 node versions → 3 job rows).
   Dependency resolver builds a DAG from needs: fields.
   All jobs inserted into PostgreSQL in a single atomic transaction.
   Independent jobs are enqueued to BullMQ immediately.
   Dependent jobs wait in queued state until their dependencies complete.

5. JOB CLAIM (RUNNER SIDE)
   Runner agent polls POST /api/v1/runners/claim every 5 seconds.
   Server executes: SELECT id FROM jobs WHERE status='queued' FOR UPDATE SKIP LOCKED LIMIT 1
   First runner to acquire the row lock wins. Others skip and retry.
   Runner receives the full job payload: steps, env vars, decrypted secrets.

6. CONTAINER EXECUTION
   Runner creates a Docker container (dockerode) with:
   - Resource limits: 512MB RAM, 1 CPU
   - Env vars + decrypted secrets injected
   - Working directory mounted
   Runner executes steps sequentially, respecting if: conditions.

7. LOG STREAMING
   stdout/stderr from Docker attached via stream.
   Every line POSTed to /api/v1/jobs/:id/logs in batches (every 5s or 50 lines).
   Server publishes each batch to Redis channel: job:<id>:logs
   Socket.IO server subscribed to channel, emits to browser clients.
   React LogViewer renders lines in real-time with ANSI color support.

8. COMPLETION
   Runner POSTs exit code to /api/v1/jobs/:id/status.
   Server updates job status, bulk-writes buffered logs to PostgreSQL.
   Runner uploads any declared artifacts directly to S3, POSTs metadata.
   Container removed (always, in finally block).
   Server checks if all jobs in the run are terminal → updates run status.
   Server calls GitHub Commit Status API: POST /repos/:owner/:repo/statuses/:sha

9. CRASH RECOVERY
   Runner sends heartbeat every 30s.
   Server cron (every 60s) finds runners with last_heartbeat > 2 min.
   Any job claimed by an offline runner is re-queued (max 3 retries).
```

---

## 🔐 Security Model

### Webhook Verification
Every incoming webhook is validated with `crypto.timingSafeEqual` against the HMAC-SHA256 signature GitHub attaches to all requests. Requests with invalid or missing signatures are rejected with `401` before any processing occurs.

### Secret Storage
Repository secrets are encrypted with AES-256-GCM before writing to PostgreSQL. The encryption key lives exclusively in the server's environment variables — never in the database. Secrets are decrypted in memory immediately before job dispatch and injected as Docker environment variables. They are never written to log output.

### Container Isolation
Each job runs in a dedicated Docker container with enforced CPU and memory limits to prevent denial-of-service on the host. Containers run as non-root users. The Docker daemon socket (`/var/run/docker.sock`) is **never** mounted inside a guest container.

### Runner Authentication
Runners authenticate with a unique `auth_token` issued at registration time. The raw token is returned once and never stored — only its bcrypt hash is persisted. All runner-facing endpoints validate this token on every request.

---

## ☁️ Deployment (Free Tier)

This platform runs entirely on free-tier infrastructure at **$0/month**.

| Component | Provider | Free Limits |
|---|---|---|
| API server | Render (Web Service) | 750 hrs/month, 512MB RAM |
| Runner agent | Render (Background Worker) | Always-on worker process |
| PostgreSQL | Render (Managed PG) | 1GB storage |
| Redis | Upstash | 10,000 req/day, 256MB |
| Artifact storage | AWS S3 | 5GB, 20k GET / 2k PUT per month |
| Frontend | Vercel | Unlimited hobby tier, global CDN |

> **Note:** Render free tier web services sleep after 15 minutes of inactivity (~30s cold start). Use [UptimeRobot](https://uptimerobot.com) (free) to send a ping every 10 minutes during demos.

### Deploy Steps

```bash
# 1. Push to GitHub

# 2. Create a Render Web Service
#    Root dir: backend/
#    Build: npm install && npm run build
#    Start: npm start

# 3. Create a Render Background Worker
#    Root dir: runner/
#    Build: npm install && npm run build
#    Start: npm start

# 4. Add all environment variables to Render's dashboard

# 5. Deploy frontend to Vercel
vercel --cwd client

# 6. Point your GitHub repo webhook to: https://<your-render-url>/webhook/github
```

---

## 🗺️ Roadmap

### ✅ Implemented (Phases 1–6)

- [x] Express server + TypeScript scaffold
- [x] PostgreSQL schema + migrations
- [x] GitHub HMAC-SHA256 webhook verification
- [x] YAML parser with matrix expansion
- [x] Conditional step execution (`if: success/failure/always`)
- [x] BullMQ job queue with retry policy
- [x] Atomic job claiming (`SELECT FOR UPDATE SKIP LOCKED`)
- [x] Docker container execution with resource limits
- [x] Real-time log streaming (Redis Pub/Sub → Socket.IO)
- [x] AES-256 secret encryption
- [x] AWS S3 artifact storage with pre-signed URLs
- [x] GitHub commit status check posting
- [x] React dashboard (workflows, run detail, live logs, artifacts)
- [x] Runner registry and heartbeat crash recovery

### 🚧 In Progress

- [ ] `workflow_dispatch` manual trigger from dashboard
- [ ] `paths:` filter support in YAML triggers
- [ ] Log line search and filtering in the dashboard

### 📋 Planned

- [ ] `needs:` output passing between jobs
- [ ] Slack / Discord notification step
- [ ] YAML validation endpoint (dry-run without executing)
- [ ] Multi-runner label matching (`runs-on: node-20`)

### ⏭️ Out of Scope (by design)

- Custom Action plugins (`uses: actions/checkout@v3`) — requires dynamic plugin resolution
- Runner autoscaling (Kubernetes / EC2 ASG) — single runner sufficient for demo scale
- OIDC token federation (AWS/GCP) — enterprise feature beyond project scope

---

## 🧠 Key Technical Decisions

**Why BullMQ over Kafka?**
BullMQ runs on Redis, which is already required for pub/sub log streaming. Kafka adds a separate broker, ZooKeeper dependency, and significant operational overhead. BullMQ provides retries, dead-letter queues, job priorities, rate limiting, and BullBoard UI out of the box — everything needed at this scale.

**Why REST over WebSocket for runner ↔ server communication?**
Runners are stateless pollers — they claim work, execute it, and POST results. REST is simpler, stateless, and trivial to debug with curl. WebSocket would add persistent connection management, reconnection logic, and back-pressure handling with no meaningful benefit. Only the browser log streaming benefits from WebSocket.

**Why `SELECT FOR UPDATE SKIP LOCKED` instead of BullMQ's built-in claim?**
BullMQ handles queue-level atomicity. The `SKIP LOCKED` pattern handles database-level job state transitions, ensuring the PostgreSQL `jobs` table is always the source of truth for job ownership — not just the queue. This also allows the server's cron to perform crash recovery queries directly in SQL.

**Why Redis Pub/Sub for log streaming instead of direct WebSocket from the runner?**
The runner has no knowledge of browser clients. Pub/Sub decouples producers from consumers: multiple browser tabs can subscribe to the same log stream, and the channel persists across runner restarts. This also makes the system horizontally scalable — a second server process can subscribe to the same Redis channel without any coordination.

**Why Cloudflare R2 over AWS S3 for artifacts?**
R2's S3-compatible API means zero code changes. The critical difference: R2 has $0 egress fees. S3 charges per-GB for data leaving AWS — artifact downloads are the highest-volume egress pattern in a CI/CD system.

---

## 🤝 Contributing

Contributions are welcome. Please open an issue first to discuss significant changes.

```bash
# Fork and clone
git clone https://github.com/<your-username>/cicd-engine.git

# Create a feature branch
git checkout -b feat/your-feature-name

# Make your changes, then:
npm run lint
npm run test

# Commit with conventional commit format
git commit -m "feat: add workflow_dispatch manual trigger"

# Open a pull request against main
```

**Commit message format:** `type(scope): description`
Types: `feat` · `fix` · `docs` · `refactor` · `test` · `chore`

---

## 📜 License

MIT © [Agrim](https://github.com/agrim08)

---

<div align="center">

Built by [Agrim](https://github.com/agrim08) — B.Tech CS @ JSSATE Noida · Core Member, Google Developer Group

**If this helped you understand how CI/CD works under the hood, consider starring ⭐ the repo.**

</div>
