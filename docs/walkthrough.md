# Walkthrough — Phase 3, Phase 4 Part 1 & Phase 4 Part 2

We have successfully completed all core requirements for **Phase 3 (YAML Parser & Queue Ingestion)**, **Phase 4 Part 1 (Runner Registry, Authentication, and Heartbeat Recovery System)**, and now **Phase 4 Part 2 (Docker Execution & Status/Log Sync)**.

---

## 🛠️ Phase 3 Accomplishments (YAML Parser & Queue Ingestion)

### Changes Made
*   **[NEW] [redis.ts](file:///d:/Github-Actions-Clone/backend/server/src/storage/redis.ts)**: Setup type-safe connection to the Redis server.
*   **[NEW] [manager.ts](file:///d:/Github-Actions-Clone/backend/server/src/queue/manager.ts)**: Configured the BullMQ `jobQueue` using the latest `Queue` constructor with strict type parameters.
*   **[NEW] [processor.ts](file:///d:/Github-Actions-Clone/backend/server/src/queue/processor.ts)**: Setup the main BullMQ worker logic to process job executions.
*   **[MODIFY] [server.ts](file:///d:/Github-Actions-Clone/backend/server/src/server.ts)**: Configured Content Security Policy overrides for `helmet` to allow rendering of visual assets, and mounted the **BullBoard** dashboard under the Express route `/admin/queues`.
*   **[MODIFY] [webhook.ts](file:///d:/Github-Actions-Clone/backend/server/src/routes/webhook.ts)**: Integrated trigger matching checks, YAML parsing, transactional database insertions of Runs, Jobs, and Steps, and final BullMQ enqueuing.

---

## 🔑 Phase 4 Part 1 Accomplishments (Runner Registry & Heartbeats)

### Changes Made

#### Component: API Server (Authentication & Recovery)
*   **[NEW] [runnerAuth.ts](file:///d:/Github-Actions-Clone/backend/server/src/middleware/runnerAuth.ts)**: Implement JWT-less authentication middleware. Generates cryptographically secure random bytes on the client, and hashes them using `SHA-256` before matching in database context.
*   **[NEW] [runners.ts](file:///d:/Github-Actions-Clone/backend/server/src/routes/runners.ts)**: Creates the controller router defining:
    *   `POST /api/v1/runners/register` (verifies the registration shared secret, generates/hashes the unique auth token, and registers/upserts the runner record).
    *   `POST /api/v1/runners/heartbeat` (updates `last_heartbeat` to current timestamp and sets status back to `idle`).
*   **[MODIFY] [manager.ts](file:///d:/Github-Actions-Clone/backend/server/src/queue/manager.ts)**: Defines a strict `QueueJobData` discriminated union supporting both execution jobs and cron cleanup scheduling. Implements `registerSchedulerJobs()` to configure the cron scheduler using BullMQ's latest **`Job Schedulers`** API (`upsertJobScheduler`).
*   **[MODIFY] [processor.ts](file:///d:/Github-Actions-Clone/backend/server/src/queue/processor.ts)**: Integrated the recovery logic. When the `cleanup-runners` job fires:
    1. Finds dead runners (heartbeat older than 2 minutes and status not `offline`).
    2. Updates their status to `offline`.
    3. Transactionally resets their active running jobs back to `status = 'queued'`, clearing `runner_id` and `started_at` so other runners can pick them up.
*   **[MODIFY] [server.ts](file:///d:/Github-Actions-Clone/backend/server/src/server.ts)**: Mounts the runners router at `/api/v1/runners` and runs `registerSchedulerJobs()` on boot.

#### Component: Runner Client Agent
*   **[MODIFY] [agent.ts](file:///d:/Github-Actions-Clone/backend/runner/src/agent.ts)**: Implements the active runner daemon. Connects to the server, triggers registration on start, launches a 30s heartbeat interval, and hooks termination events (`SIGINT`/`SIGTERM`) to gracefully exit.

---

## 🐳 Phase 4 Part 2 Accomplishments (Docker Execution & Status/Log Sync)

### Changes Made

#### Component: API Server
*   **[NEW] [jobs.ts](file:///d:/Github-Actions-Clone/backend/server/src/routes/jobs.ts)**: Implements router endpoints for:
    *   `POST /api/v1/jobs/:jobId/status` to atomically update job status (e.g., transition runner state to `idle`, check all sibling jobs for sibling-dependency status completion, and mark the parent run status as successful/failed).
    *   `POST /api/v1/jobs/:jobId/steps/:stepId/status` to update individual step status, durations, and exit codes.
    *   `POST /api/v1/jobs/:jobId/logs` to append container stdout/stderr log output sequentially to the database.
    *   All endpoints are documented with OpenAPI Swagger specifications.
*   **[MODIFY] [server.ts](file:///d:/Github-Actions-Clone/backend/server/src/server.ts)**: Registers the new `jobsRouter` under `/api/v1/jobs`.

#### Component: Runner Client Agent
*   **[MODIFY] [agent.ts](file:///d:/Github-Actions-Clone/backend/runner/src/agent.ts)**: Integrates `dockerode` to handle actual container execution:
    *   Ensures target Docker images exist locally, pulling them if necessary.
    *   Spins a container for each job and executes step commands sequentially.
    *   Includes custom log streaming buffer parser to demux stdout/stderr lines safely.
    *   Supports step condition evaluations (`success()`, `failure()`, `always()`).
    *   Updates step execution progress, logs output, and final job state live to the API Server.
    *   Cleans up Docker containers in a `finally` block to prevent resource leaks.

---

## 📊 Verification & Build Results

### Compilation
Both backend folders compile cleanly with strict typings and zero errors (no `any` types used).

**Server Build:**
```bash
npm run build --prefix backend/server
```
**Runner Build:**
```bash
npm run build --prefix backend/runner
```
