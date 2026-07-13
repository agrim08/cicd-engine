import { Octokit } from '@octokit/rest';
import { env } from '../config/env';

/**
 * Parses a GitHub HTML repository URL to extract the owner and repository names.
 * Supports standard URLs such as https://github.com/owner/repo and trailing .git extensions.
 *
 * @param url The GitHub repository URL
 * @returns An object containing owner and repo strings
 */
export function parseGitHubUrl(url: string): { owner: string; repo: string } {
  // Remove trailing .git and whitespace
  const cleanUrl = url.replace(/\.git$/, '').trim();

  // Matches "github.com/owner/repo"
  const regex = /github\.com\/([^/]+)\/([^/]+)/i;
  const match = cleanUrl.match(regex);

  if (!match || match.length < 3) {
    throw new Error(`Invalid GitHub repository URL: ${url}`);
  }

  return {
    owner: match[1],
    repo: match[2],
  };
}

/**
 * Creates and returns an instance of the Octokit REST API client.
 * Prioritizes the repository-specific token if provided, falling back to the global GITHUB_TOKEN.
 *
 * @param token Optional repository-specific GitHub access token
 * @returns An authenticated Octokit instance
 */
export function getOctokit(token?: string | null): Octokit {
  const authToken = token || env.GITHUB_TOKEN;
  return new Octokit({ auth: authToken });
}

/**
 * Checks whether the `.cicd/pipeline.yaml` file exists in the repository root (or custom path).
 * Returns true if the file exists, false if it returns a 404, or throws for other API errors.
 *
 * @param owner Repository owner name
 * @param repo Repository name
 * @param token Optional repository-specific token
 * @returns Promise<boolean> indicating file existence
 */
export async function checkPipelineFileExists(
  owner: string,
  repo: string,
  token?: string | null
): Promise<boolean> {
  const octokit = getOctokit(token);
  try {
    await octokit.repos.getContent({
      owner,
      repo,
      path: '.cicd/pipeline.yaml',
    });
    return true;
  } catch (error: any) {
    if (error.status === 404) {
      return false;
    }
    // Re-throw other authentication/rate-limit errors
    throw error;
  }
}

/**
 * Fetches the `.cicd/pipeline.yaml` file content at the specific commit SHA.
 * Decodes the returned Base64 string into a UTF-8 string.
 *
 * @param owner Repository owner name
 * @param repo Repository name
 * @param sha The exact commit SHA reference
 * @param token Optional repository-specific token
 * @returns Promise<string> containing the YAML content
 */
export async function fetchPipelineYaml(
  owner: string,
  repo: string,
  sha: string,
  token?: string | null
): Promise<string> {
  const octokit = getOctokit(token);

  const response = await octokit.repos.getContent({
    owner,
    repo,
    path: '.cicd/pipeline.yaml',
    ref: sha, // Fetch the file version at the exact commit ref
  });

  // Handle case where GitHub returns an array of files instead of a single file (should not happen for a file path)
  if (Array.isArray(response.data) || !('content' in response.data)) {
    throw new Error('Retrieved path is a directory, not a file.');
  }

  // Decode Base64 content to UTF-8 string
  const fileContent = Buffer.from(response.data.content, 'base64').toString('utf-8');
  return fileContent;
}
