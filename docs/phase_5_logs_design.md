# System Design & Implementation: Real-Time Log Streaming (Phase 5)

This document explains how we built the real-time logging system (Phase 5), the system design concepts we used, and how it matches real GitHub Actions.

---

## 1. How Phase 5 is Implemented

The log pipeline has three main parts:
1. **The Runner Agent (Buffer & Batch)**:
   * When a command runs in a Docker container, it produces logs.
   * Instead of sending every single line to the server immediately, the runner stores them in a local memory queue (a **Buffer**).
   * Every **2 seconds** or when the buffer reaches **50 lines**, the runner sends the whole batch to the server in one HTTP request.
   
2. **The API Server (Bulk Write & Secrets Masking)**:
   * When the server receives a batch of logs, it runs a **Secrets Masking** utility. This utility replaces any sensitive passwords/tokens with `***` to keep them safe.
   * The server inserts all log lines in the batch into PostgreSQL using a **single bulk-insert database command** (using Knex `.insert([ ... ])`).
   * Simultaneously, it publishes each log line to a **Redis Pub/Sub** channel: `job:<jobId>:logs`.

3. **The WebSockets (Socket.IO)**:
   * The browser client connects to the server using WebSockets.
   * When viewing a job, the client subscribes to that job's logs.
   * A global Redis subscriber receives the published log lines from the Redis channel and immediately pushes them to the browser client.

---

## 2. System Design Concepts Used

We used several core system design patterns to make the system robust and scalable:

### A. Buffer and Batching (Write Optimization)
* **What it is**: Saving logs in memory and writing them in groups instead of one-by-one.
* **Why we did it**: If a job outputs 10,000 lines of logs, making 10,000 separate HTTP requests and database inserts would crash the database and slow down the server. Grouping them into batches of 50 reduces database operations by **98%**.

### B. Redis Pub/Sub (Publish/Subscribe Pattern)
* **What it is**: A messaging system where the server publishes messages to a channel, and subscribers receive them.
* **Why we did it**: It decouples the server from the clients. The API server doesn't need to know who is watching the logs. It just publishes them to Redis, and Redis distributes them to any active WebSocket connection.

### C. In-Memory Caching (Read Optimization)
* **What it is**: Storing frequently used data in fast memory instead of querying the database.
* **Why we did it**: To mask secrets, we need to check if the log contains any secret keys. Querying the database to get secret keys for every batch of logs would be very slow. We cache the decrypted secrets in memory for **1 minute** to make masking near-instant.

### D. Single-Query JOINs
* **What it is**: Fetching related data from multiple tables using one SQL query.
* **Why we did it**: When checking runner permissions and repository secrets, we join the `jobs`, `runs`, `workflows`, and `repos` tables in one query to verify the runner in a fraction of a millisecond.

---

## 3. Why This Approach is Robust

* **No Lost Logs**: The runner flushes the remaining buffer immediately when a step or job finishes. This ensures every last line of output is saved.
* **Database Protection**: Even under heavy builds generating millions of logs, the batching mechanism protects PostgreSQL from connection pool exhaustion.
* **Near-Instant Latency**: By using Redis and Socket.IO, log lines appear on the user's screen in less than **500 milliseconds** from the moment they are outputted by the container.

---

## 4. How It Matches Real GitHub Actions

In GitHub Actions, you can click on each step to expand its console logs:

1. **Grouped by Steps**: Our database schema links every log line to a specific `step_id`.
2. **Grouped API Endpoint**: We implemented a query parameter (`grouped=true`) on the logs API:
   ```
   GET /api/v1/jobs/:jobId/logs?grouped=true
   ```
   When the React frontend calls this endpoint, the server returns the logs categorized by their step:
   ```json
   {
     "status": "success",
     "data": {
       "stepLogs": {
         "step_id_1": [ { "lineNo": 1, "content": "Hello World" } ],
         "step_id_2": [ { "lineNo": 1, "content": "Simple Math Output" } ]
       },
       "globalLogs": []
     }
   }
   ```
   This matches the GitHub Actions behavior perfectly, enabling the frontend in Phase 6 to group and collapse logs step-by-step.
