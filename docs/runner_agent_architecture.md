# Runner Agent Architecture & Workflow

The Runner Agent (`agent.ts`) is a background worker daemon that claims and executes pipeline jobs inside isolated Docker containers. Here is a step-by-step, logical breakdown of how it works.

```
┌─────────────────┐      📡 Auth secret
│ 1. Registration │──────────────────────▶  [Express Server]
└────────┬────────┘                             │
         │                                      ▼
         │                             [Generate Auth Token]
         ▼                                      │
┌─────────────────┐      💓 "I am alive"        │
│  2. Heartbeat   │◀────────────────────────────┘ (every 30s)
└────────┬────────┘
         │
         │ Polls for work (every 5s)
         ▼
┌─────────────────┐      📥 Request job
│ 3. Job Claiming │──────────────────────▶  [Atomic Lock Job]
└────────┬────────┘                             │
         │                                      ▼
         │                               [Fetch Payload]
         ▼                                      │
┌─────────────────┐                             │
│4. Container Prep│◀────────────────────────────┘ (Target image + env/secrets)
└────────┬────────┘
         │
         │ Spins up isolated Docker container
         ▼
┌─────────────────┐
│ 5. Step Exec    │ ──▶ Resolve secrets, evaluate if: success()/failure()
└────────┬────────┘
         │
         │ Streams console logs line-by-line
         ▼
┌─────────────────┐      📊 Statuses & Logs
│ 6. Server Sync  │──────────────────────▶  [PostgreSQL DB]
└────────┬────────┘
         │
         │ Stops & removes container
         ▼
┌─────────────────┐
│   7. Cleanup    │
└─────────────────┘
```

---

### Step 1: Runner Registration (On Startup)
When the runner boots up, it contacts the central API server. It presents a shared registration secret (defined in configuration) to prove its identity. In response, the server generates a unique runner ID and a secure, temporary authentication token. The runner stores this token in memory and uses it for all future communications.

### Step 2: Heartbeat Loop (Continuous)
Every 30 seconds, the runner sends a quick "heartbeat" message to the server saying, *"I am alive and ready."* If a runner goes silent for more than 2 minutes (e.g., due to a crash or network outage), the server automatically notices, marks the runner offline, and resets any active jobs back to the queue so other runners can pick them up.

### Step 3: Job Polling & Claiming (Polling Loop)
Every 5 seconds, if the runner is not busy, it asks the server: *"Do you have any queued jobs for me?"* 
The server uses an atomic database lock (meaning only one runner can touch a row at a time) to select the oldest queued job. It marks the job as `running` and assigns it to this runner. The runner receives the execution payload containing the Docker image name, environment variables, step commands, and decrypted secrets.

### Step 4: Docker Container Preparation
Before running any commands, the runner checks if the requested Docker image (e.g. `ubuntu:latest` or `node:20`) is available locally on the system. If it isn't, the runner pulls the image from Docker Hub. Once the image is ready, the runner creates and starts an isolated container with specific safety limits (like limiting memory to 512MB and CPU usage to 1 core).

### Step 5: Step Execution & Condition Checking
The runner executes each step defined in the workflow sequentially inside the running container:
*   **Condition Check**: It checks the step's condition (e.g. run only if the previous step succeeded or failed). If the condition is not met, the step is skipped.
*   **Secret Masking & Resolution**: It replaces secret placeholders (like `${{ secrets.MY_TOKEN }}`) with the actual decrypted values just before running the command.
*   **Execution**: It starts a shell command (via `sh -c`) inside the container.

### Step 6: Logs and Status Synchronization
As commands execute, the runner captures the container's output (stdout and stderr) stream. It parses the stream line-by-line and sends the logs back to the API server to be saved in the database. When a step finishes, the runner measures its duration and posts the final status (`success` or `failed`) and exit code back to the server.

### Step 7: Graceful Container Cleanup
Once all steps have run (or if a step fails and aborts the execution), the runner reports the final status of the overall job to the server (`success` or `failed`). Regardless of whether the job succeeded or crashed, the runner ensures that the Docker container is stopped and completely removed to clean up disk space and system memory.
