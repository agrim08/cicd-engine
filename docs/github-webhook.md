### 1. The Webhook Request-Response Cycle
When a developer pushes code to GitHub, GitHub sends an HTTP POST request containing commit details to our /webhook/github endpoint. GitHub expects a quick response (usually within 10 seconds).

If our server tries to fetch files from GitHub and execute database transactions before responding, the connection could time out or hang.

To solve this:

Validate First (Synchronous): We verify the HMAC-SHA256 signature immediately. If it is invalid, we reject it with 401 Unauthorized.
Acknowledge Immediately: If valid, we trigger handleWebhookAsync in the background without waiting for it to finish (meaning we do not use await).
Respond 202 Accepted: We instantly return a 202 Accepted status code back to GitHub. GitHub is happy and closes the connection.

```
GitHub Push ──▶ [POST /webhook/github]
                      │
            1. Verify Signature (HMAC)
                      │
            2. Trigger handleWebhookAsync()  ──┐ (Asynchronous background task)
                      │                        │
            3. Respond 202 Accepted ◄──────────┘
                      │
               (GitHub disconnects)
```

---

### 2. The Background Worker (handleWebhookAsync)
While GitHub is already disconnected, our server continues executing the following steps in the background:

Parse Repository URL: Extracts the owner and repo names (e.g. octocat and hello-world) from the repository URL.
Fetch Pipeline YAML: Calls the GitHub API (via Octokit) to read the contents of the .cicd/pipeline.yaml file at the exact commit sha that triggered the push.
Persist Data: Saves the YAML content and registers a new pipeline run.

---

### 3. Why a "Single Database Transaction"?
Once the server has successfully fetched the .cicd/pipeline.yaml text, it needs to perform two database operations:

Upsert Workflow: Update the cached YAML content in the workflows table (or insert it if it's the first time).
Create Run: Insert a new run row in the runs table with status: 'pending' so it can be picked up by our job queue later.
If we run these as separate, independent queries:

What happens if the workflow updates successfully, but the database connection drops right before we insert the run?
Result: The database becomes inconsistent. The workflow is updated, but the run is lost, and the user's pipeline never starts.


``` typescript
await db.transaction(async (trx) => {
  // 1. Upsert workflow using the transaction client (trx)
  const [workflow] = await trx('workflows')
    .insert({ repo_id, name, yaml_content })
    .onConflict(['repo_id', 'name'])
    .merge()
    .returning('*');
  // 2. Insert run linked to the workflow
  await trx('runs').insert({
    workflow_id: workflow.id,
    sha,
    branch,
    status: 'pending',
    trigger: 'push'
  });
});
```


### The Transaction Guarantee (ACID):
All-or-Nothing: Either both operations succeed, or both are rolled back (cancelled) as if nothing ever happened.
This ensures the database is never left in a corrupted or half-saved state.