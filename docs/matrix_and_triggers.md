# System Design: Trigger Branch Matching & Matrix Strategy Expansion

This document explains the concept, inner working, and system design for **Trigger Branch Matching** and **Matrix Strategy Expansion** in the self-hosted GitHub Actions Clone.

---

## 📡 1. Trigger Branch Matching

### Concept
A repository contains many branches (e.g., `main`, `develop`, `feature/login`, `bugfix/issue-4`). 
Developers do not want to run the entire pipeline (especially expensive test suites or deployments) on every single commit to every temporary branch. 

*Trigger Branch Matching* acts as a gatekeeper:
*   **Production Deployment:** Only triggers when code is pushed to `main`.
*   **Integration Tests:** Triggers on pushes to `main` and `develop`.
*   **Feature Branches:** Might be ignored, or run a minimal lint-only pipeline.

By matching the branch name sent in the GitHub Webhook payload against the `on.push.branches` array defined in the YAML, we prevent unnecessary container resource usage.

### How It Works (Webhooks to DB)
1.  GitHub sends a POST request with the header `X-GitHub-Event: push` and the body:
    ```json
    {
      "ref": "refs/heads/develop",
      "after": "18d83a4..."
    }
    ```
2.  The server extracts the branch name: `ref.replace('refs/heads/', '')` -> `develop`.
3.  The server parses the `.cicd/pipeline.yaml` and extracts the triggers:
    ```yaml
    on:
      push:
        branches: [main, develop]
    ```
4.  The server checks if the incoming branch `develop` is present in the `branches` array. If yes, it schedules the run; otherwise, it logs a skip event and returns.

### System Design
```
       GitHub Webhook Event (e.g., branch: 'feature/login')
                                │
                                ▼
                       [Webhook Receiver]
                                │
                      Verify HMAC Signature
                                │
                     Fetch .cicd/pipeline.yaml
                                │
                                ▼
                        [Trigger Matcher]
            Does 'feature/login' match [main, develop]?
                     /                     \
                   YES                      NO
                   /                         \
        [Create Pending Run]           [Skip Execution]
       Save to DB & Queue Job          Log: "Branch skipped"
```

---

## 🧮 2. Matrix Strategy Expansion

### Concept
Developers need to ensure their software is compatible across different environments. For example:
*   Testing a library on **Node.js 18, 20, and 22**.
*   Testing a cross-platform tool on **Ubuntu, macOS, and Windows**.

Writing separate YAML jobs for every permutation (e.g., `test-node18-ubuntu`, `test-node20-ubuntu`, etc.) leads to massive duplication, making maintenance difficult.

*Matrix Strategy Expansion* solves this by allowing developers to define a single job template with multiple parameters:
```yaml
strategy:
  matrix:
    node-version: [18, 20]
    os: [ubuntu, macos]
```
The system automatically multiplies this configuration into parallel execution runs.

### How It Works (Cartesian Product)
The expansion logic calculates the **Cartesian Product** of the matrix inputs. It multiplies every key's array values against all other keys' values:

$$\text{Jobs} = \text{node-version} \times \text{os} = \{18, 20\} \times \{\text{ubuntu}, \text{macos}\}$$

This generates 4 distinct, parallel jobs:
1.  `test (18, ubuntu)`
2.  `test (18, macos)`
3.  `test (20, ubuntu)`
4.  `test (20, macos)`

For each expanded job, the server:
*   Generates a unique name: `JobName (value1, value2)`.
*   Injects the matrix values as environment variables (e.g., `NODE_VERSION=18`, `OS=ubuntu`) into the Docker container.
*   Enqueues each job independently into the BullMQ queue for parallel execution.

### System Design
```
                       Single Job YAML Config
                    - Name: test
                    - Strategy Matrix: { node: [18, 20], os: [ubuntu] }
                                │
                                ▼
                    [Matrix Expansion Engine]
             Computes Cartesian Product permutations
                                │
         ┌──────────────────────┴──────────────────────┐
         ▼                                             ▼
Job 1: test (18, ubuntu)                      Job 2: test (20, ubuntu)
Env: NODE=18, OS=ubuntu                       Env: NODE=20, OS=ubuntu
         │                                             │
         ▼                                             ▼
[Insert DB: status='queued']                  [Insert DB: status='queued']
         │                                             │
         ▼                                             ▼
[Enqueue to BullMQ Queue]                    [Enqueue to BullMQ Queue]
```
