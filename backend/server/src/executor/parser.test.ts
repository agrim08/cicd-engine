import { parseWorkflow } from './parser';
import { isTriggerMatched } from './trigger';

const sampleYaml = `
name: Build and Test Workflow
on:
  push:
    branches:
      - main
      - 'releases/*'
  pull_request:
    branches:
      - develop

env:
  GLOBAL_VAR: "global_value"

jobs:
  lint:
    runs-on: ubuntu-latest
    steps:
      - name: Run Linter
        run: npm run lint

  test:
    needs: lint
    runs-on: ubuntu-latest
    strategy:
      matrix:
        node: [18, 20]
        os: [ubuntu, macos]
    env:
      JOB_ENV_VAR: "matrix_node_\${{ matrix.node }}"
    steps:
      - name: Setup Node
        run: setup-node --version \${{ matrix.node }}
      - name: Run Tests on \${{ matrix.os }}
        run: npm test
        env:
          TARGET_OS: "\${{ matrix.os }}"
`;

function assertThrows(yamlStr: string, expectedErrorPart: string) {
  try {
    parseWorkflow(yamlStr);
    throw new Error(`Expected error containing "${expectedErrorPart}", but parsing succeeded.`);
  } catch (err: any) {
    if (!err.message.includes(expectedErrorPart)) {
      throw new Error(`Expected error containing "${expectedErrorPart}", but got: "${err.message}"`);
    }
    console.log(`   └─ ✅ Caught expected validation error: "${err.message}"`);
  }
}

function runTests() {
  console.log('🧪 Starting YAML Parser & Matrix Strategy unit tests...\n');

  // 1. Test YAML Parsing & Matrix Expansion
  console.log('1. Parsing sample YAML...');
  const workflow = parseWorkflow(sampleYaml);

  console.log(`- Workflow Name: "${workflow.name}"`);
  console.log(`- Global Env count: ${Object.keys(workflow.env).length}`);
  console.log(`- Total Expanded Jobs: ${workflow.jobs.length}`);

  // Validate Name and Env
  if (workflow.name !== 'Build and Test Workflow') {
    throw new Error('❌ Incorrect workflow name parsed.');
  }
  if (workflow.env.GLOBAL_VAR !== 'global_value') {
    throw new Error('❌ Incorrect global env parsed.');
  }

  // Validate Jobs Expansion
  // We expect 1 lint job + 4 expanded test jobs = 5 total jobs
  if (workflow.jobs.length !== 5) {
    throw new Error(`❌ Expected 5 expanded jobs, but got ${workflow.jobs.length}`);
  }

  const lintJob = workflow.jobs.find(j => j.originalName === 'lint');
  if (!lintJob) {
    throw new Error('❌ lint job not found.');
  }
  console.log('✅ lint job successfully parsed without matrix.');

  const testJobs = workflow.jobs.filter(j => j.originalName === 'test');
  if (testJobs.length !== 4) {
    throw new Error(`❌ Expected 4 expanded test jobs, but got ${testJobs.length}`);
  }
  console.log('✅ test job matrix successfully expanded into 4 parallel jobs.');

  // Validate matrix interpolation on one of the expanded jobs
  const node18UbuntuJob = testJobs.find(
    j => j.matrixValue?.node === 18 && j.matrixValue?.os === 'ubuntu'
  );

  if (!node18UbuntuJob) {
    throw new Error('❌ test (18, ubuntu) job not found.');
  }

  console.log(`- Job name: "${node18UbuntuJob.name}"`);
  console.log(`- Mapped Needs: ${JSON.stringify(node18UbuntuJob.needs)}`);

  // Verify Job-level Env interpolation
  if (node18UbuntuJob.env.JOB_ENV_VAR !== 'matrix_node_18') {
    throw new Error(`❌ Job env interpolation failed. Got: ${node18UbuntuJob.env.JOB_ENV_VAR}`);
  }
  // Verify Matrix variable injection
  if (node18UbuntuJob.env.node !== '18' || node18UbuntuJob.env.os !== 'ubuntu') {
    throw new Error('❌ Matrix variables injection into job env failed.');
  }

  // Verify Step run interpolation
  const setupStep = node18UbuntuJob.steps.find(s => s.name === 'Setup Node');
  if (!setupStep || setupStep.run !== 'setup-node --version 18') {
    throw new Error(`❌ Step run interpolation failed. Got: ${setupStep?.run}`);
  }

  // Verify Step env interpolation
  const testStep = node18UbuntuJob.steps.find(s => s.name === 'Run Tests on ubuntu');
  if (!testStep || testStep.env.TARGET_OS !== 'ubuntu') {
    throw new Error(`❌ Step env interpolation failed. Got: ${JSON.stringify(testStep?.env)}`);
  }

  console.log('✅ Matrix interpolation and environment merging verified successfully.');

  // 2. Test Trigger Matching Logic
  console.log('\n2. Testing Trigger Branch Matching...');

  const pushMatches = [
    { branch: 'main', expected: true },
    { branch: 'releases/v1', expected: true },
    { branch: 'releases/v1.2.3', expected: true },
    { branch: 'develop', expected: false }, // only on pull_request, not push
    { branch: 'feature/login', expected: false },
    { branch: 'releases/v1/beta', expected: false }, // 'releases/*' matches only 1 level
  ];

  for (const { branch, expected } of pushMatches) {
    const isMatched = isTriggerMatched(workflow, 'push', branch);
    console.log(`- Push to "${branch}": matched? ${isMatched} (Expected: ${expected})`);
    if (isMatched !== expected) {
      throw new Error(`❌ Trigger match failed for push to branch "${branch}".`);
    }
  }

  const prMatches = [
    { branch: 'develop', expected: true },
    { branch: 'main', expected: false },
  ];

  for (const { branch, expected } of prMatches) {
    const isMatched = isTriggerMatched(workflow, 'pull_request', branch);
    console.log(`- PR to "${branch}": matched? ${isMatched} (Expected: ${expected})`);
    if (isMatched !== expected) {
      throw new Error(`❌ Trigger match failed for PR to branch "${branch}".`);
    }
  }

  console.log('✅ Trigger branch matching unit tests verified successfully.');

  // 3. Test Validation Logic (New verification checks)
  console.log('\n3. Testing Parser & Matrix Validation Rules...');

  console.log('- Test: Missing jobs section');
  assertThrows(`
name: Invalid Work
on: push
  `, "Invalid workflow configuration: 'jobs' section is required");

  console.log('- Test: Jobs is not an object');
  assertThrows(`
name: Invalid Work
jobs: [1, 2, 3]
  `, "jobs' section must be an object, got array");

  console.log('- Test: Missing runs-on in job');
  assertThrows(`
jobs:
  build:
    steps:
      - run: echo "Hi"
  `, "Job 'build' field 'runs-on' is invalid. Expected string, got undefined");

  console.log('- Test: Invalid strategy configuration');
  assertThrows(`
jobs:
  build:
    runs-on: ubuntu-latest
    strategy: "invalid_string"
    steps:
      - run: echo "Hi"
  `, "Job 'build' field 'strategy' is invalid. Expected object, got string");

  console.log('- Test: Non-array matrix value');
  assertThrows(`
jobs:
  build:
    runs-on: ubuntu-latest
    strategy:
      matrix:
        node: 18
    steps:
      - run: echo "Hi"
  `, "Job 'build' field 'strategy.matrix.node' is invalid. Expected array, got number");

  console.log('- Test: Empty matrix array');
  assertThrows(`
jobs:
  build:
    runs-on: ubuntu-latest
    strategy:
      matrix:
        node: []
    steps:
      - run: echo "Hi"
  `, "Job 'build' field 'strategy.matrix.node' is invalid. Expected non-empty array, got empty array");

  console.log('- Test: Duplicate values in matrix axis');
  assertThrows(`
jobs:
  build:
    runs-on: ubuntu-latest
    strategy:
      matrix:
        node: [18, 18]
    steps:
      - run: echo "Hi"
  `, "Job 'build' field 'strategy.matrix.node' contains duplicate value '18'");

  console.log('- Test: Non-existent needs dependency reference');
  assertThrows(`
jobs:
  build:
    runs-on: ubuntu-latest
    needs: non-existent-job
    steps:
      - run: echo "Hi"
  `, "Job 'build' field 'needs' references a non-existent job 'non-existent-job'");

  console.log('- Test: Empty steps array');
  assertThrows(`
jobs:
  build:
    runs-on: ubuntu-latest
    steps: []
  `, "Job 'build' field 'steps' is invalid. Expected non-empty array, got empty array");

  console.log('- Test: Step missing run command');
  assertThrows(`
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - name: Setup node
  `, "Job 'build' step at index 0 field 'run' is invalid. Expected string, got undefined");

  console.log('- Test: Duplicate expanded job name detection');
  assertThrows(`
jobs:
  build:
    runs-on: ubuntu-latest
    strategy:
      matrix:
        node: [18]
    steps:
      - run: echo "Hi"
  
  build (18):
    runs-on: ubuntu-latest
    steps:
      - run: echo "Hi"
  `, "Duplicate expanded job name 'build (18)' detected");

  console.log('✅ Validation logic unit tests verified successfully.');

  console.log('\n🎉 ALL PHASE 3 DAY 1 UNIT TESTS PASSED SUCCESSFULLY! 🎉');
}

runTests();
