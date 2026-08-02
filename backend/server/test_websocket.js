const { io } = require('socket.io-client');
const { Client } = require('pg');
require('dotenv').config({ path: '../../.env' });

async function main() {
  let jobId = process.argv[2];

  if (!jobId) {
    console.log('🔍 No Job ID provided. Fetching the latest job from the database...');
    const client = new Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    const res = await client.query('SELECT id, name FROM jobs ORDER BY started_at DESC LIMIT 1');
    await client.end();

    if (res.rows.length === 0) {
      console.log('❌ No jobs found in the database. Please trigger a webhook run first!');
      process.exit(1);
    }
    jobId = res.rows[0].id;
    console.log(`🔌 Subscribing to the latest job: "${res.rows[0].name}" (ID: ${jobId})`);
  } else {
    console.log(`🔌 Subscribing to Job ID: ${jobId}`);
  }

  // Connect to Socket.IO Server
  console.log('🔌 Connecting to WebSocket server at http://localhost:8080...');
  const socket = io('http://localhost:8080');

  socket.on('connect', () => {
    console.log('✅ Connected successfully! Listening for live logs...');
    socket.emit('subscribe:logs', jobId);
  });

  socket.on('logs:line', (data) => {
    console.log(`📥 [Live Log] Step: ${data.stepId?.substring(0, 8)}.. | Line ${data.lineNo}: ${data.content}`);
  });

  socket.on('disconnect', () => {
    console.log('🔌 Disconnected from WebSocket server.');
  });
}

main().catch(console.error);
