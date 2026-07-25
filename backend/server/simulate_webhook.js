const { Client } = require('pg');
const crypto = require('crypto');
const axios = require('axios');

// Load env configuration from workspace
require('dotenv').config({ path: 'd:/Github-Actions-Clone/.env' });

const REPO_URL = 'https://github.com/agrim08/github-actions-clone';

async function run() {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    console.error('❌ DATABASE_URL is not defined in .env');
    process.exit(1);
  }

  console.log('📡 Connecting to local PostgreSQL database to retrieve webhook secret...');
  const client = new Client({ connectionString: dbUrl });
  
  try {
    await client.connect();
    
    // 1. Fetch the registered repository
    const res = await client.query('SELECT * FROM repos WHERE github_repo_url = $1', [REPO_URL]);
    const repo = res.rows[0];
    
    if (!repo) {
      console.log(`\n⚠️  Repository '${REPO_URL}' is not registered yet.`);
      console.log(`Please register it first by sending a POST request to:`);
      console.log(`POST http://localhost:3000/api/v1/repos`);
      console.log(`Body: { "github_repo_url": "${REPO_URL}" }\n`);
      process.exit(1);
    }
    
    const secret = repo.webhook_secret;
    console.log(`✅ Webhook secret retrieved: ${secret}`);
    
    // 2. Prepare mock GitHub Push webhook payload
    // Note: We use a commit SHA that exists or is dummy
    const payload = {
      ref: 'refs/heads/main',
      after: 'f5468b3b44ba0f84b23b9e8660896d08600a8277',
      repository: {
        html_url: REPO_URL
      }
    };
    
    const rawBody = JSON.stringify(payload);
    
    // 3. Compute HMAC-SHA256 signature
    const signature = 'sha256=' + crypto
      .createHmac('sha256', secret)
      .update(rawBody)
      .digest('hex');
      
    console.log(`🔑 Computed HMAC Signature: ${signature}`);
    
    // 4. Send POST request to local API server
    const port = process.env.PORT || 3000;
    console.log(`🚀 Sending simulated GitHub webhook push event to /webhook/github on port ${port}...`);
    const response = await axios.post(`http://localhost:${port}/webhook/github`, payload, {
      headers: {
        'x-hub-signature-256': signature,
        'x-github-event': 'push',
        'content-type': 'application/json'
      }
    });
    
    console.log('\n📥 Response Received:');
    console.log(`Status Code: ${response.status} ${response.statusText}`);
    console.log('Body:', JSON.stringify(response.data, null, 2));
    console.log('\n🎉 Simulation successful! Check server logs to verify queueing.');
    
  } catch (error) {
    if (error.response) {
      console.error('\n❌ Webhook rejected by server:');
      console.error(`Status Code: ${error.response.status}`);
      console.error('Body:', JSON.stringify(error.response.data, null, 2));
    } else {
      console.error('❌ Error executing simulation:', error.message);
    }
  } finally {
    await client.end();
  }
}

run();
