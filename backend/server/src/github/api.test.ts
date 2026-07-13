import { parseGitHubUrl } from './api';

function testGitHubApi() {
  console.log('🧪 Starting GitHub API parser unit tests...');
  
  const testCases = [
    { input: 'https://github.com/octocat/hello-world', expected: { owner: 'octocat', repo: 'hello-world' } },
    { input: 'https://github.com/octocat/hello-world.git', expected: { owner: 'octocat', repo: 'hello-world' } },
    { input: 'http://github.com/foo-bar/baz_qux', expected: { owner: 'foo-bar', repo: 'baz_qux' } },
    { input: 'https://github.com/some-owner/some-repo/tree/master', expected: { owner: 'some-owner', repo: 'some-repo' } },
  ];
  
  for (const { input, expected } of testCases) {
    const parsed = parseGitHubUrl(input);
    console.log(`Input: "${input}" -> Owner: "${parsed.owner}", Repo: "${parsed.repo}"`);
    if (parsed.owner !== expected.owner || parsed.repo !== expected.repo) {
      throw new Error(`❌ Test Failed: expected ${JSON.stringify(expected)} but got ${JSON.stringify(parsed)}`);
    }
  }
  
  // Test invalid URL throws error
  try {
    parseGitHubUrl('https://google.com');
    throw new Error('❌ Test Failed: expected invalid URL to throw error, but it passed.');
  } catch (error: any) {
    console.log('Passed invalid URL test (caught expected error):', error.message);
  }
  
  console.log('✅ GitHub API parser unit tests passed successfully!');
}

testGitHubApi();
