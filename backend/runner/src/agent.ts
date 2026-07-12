import * as path from 'path';
import * as dotenv from 'dotenv';

// Load environment variables from the root .env file
dotenv.config({ path: path.resolve(__dirname, '../../../../.env') });

const RUNNER_NAME = process.env.RUNNER_NAME || 'runner-local-scaffold';

/**
 * Runner Agent Bootstrap entry point.
 * Scaffolds the background daemon which will poll the server and execute jobs in Phase 3.
 */
async function start() {
  console.log(`🤖 GitHub Actions Clone Runner [${RUNNER_NAME}] booting up...`);
  console.log(`📡 Connecting to API Server at ${process.env.DATABASE_URL ? 'configured database' : 'local env'}`);

  // Dummy polling heartbeat loop for Phase 1 scaffold
  let loopCount = 0;
  setInterval(() => {
    loopCount++;
    console.log(`💓 [Heartbeat #${loopCount}] Runner agent is idle. Ready to claim jobs.`);
  }, 10000); // heartbeats every 10s
}

// Handle termination gracefully
process.on('SIGTERM', () => {
  console.log('🤖 Shutting down runner gracefully...');
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('🤖 Runner interrupted. Exiting...');
  process.exit(0);
});

start().catch((err) => {
  console.error('❌ Runner crashed during startup:', err);
  process.exit(1);
});
