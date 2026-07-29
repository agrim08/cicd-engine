const { Client } = require('pg');
require('dotenv').config({ path: 'd:/Github-Actions-Clone/.env' });

async function run() {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();

  console.log('--- Runs ---');
  const runs = await client.query('SELECT id, status, completed_at FROM runs ORDER BY created_at DESC LIMIT 3');
  console.table(runs.rows);

  console.log('--- Jobs ---');
  const jobs = await client.query('SELECT id, name, status, exit_code, started_at, completed_at FROM jobs ORDER BY started_at DESC LIMIT 5');
  console.table(jobs.rows);

  console.log('--- Steps ---');
  const steps = await client.query('SELECT id, name, status, exit_code, duration_ms FROM steps ORDER BY step_order LIMIT 5');
  console.table(steps.rows);

  console.log('--- Logs ---');
  const logs = await client.query('SELECT line_no, content, timestamp FROM logs ORDER BY timestamp DESC, line_no ASC LIMIT 10');
  console.table(logs.rows);

  await client.end();
}

run();
