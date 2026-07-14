import { ParsedWorkflow } from './types';

/**
 * Checks if a branch name matches a wildcard branch pattern.
 * Supports simple wildcards:
 *   - '*' matches any sequence of characters except path separators (/)
 *   - '**' matches any sequence of characters including path separators
 *
 * Examples:
 *   - pattern: 'releases/*' matches 'releases/v1' but NOT 'releases/v1/beta'
 *   - pattern: 'feature/**' matches 'feature/login' and 'feature/login/oauth'
 */
export function matchBranchPattern(pattern: string, branch: string): boolean {
  // Escape standard regex characters except '*'
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  
  // Replace '**' with '.*' and '*' with '[^/]*'
  const regexStr = '^' + escaped
    .replace(/\*\*/g, '.*')
    .replace(/\*/g, '[^/]*') + '$';
    
  const regex = new RegExp(regexStr);
  return regex.test(branch);
}

/**
 * Validates if an incoming webhook event and branch should trigger the workflow.
 *
 * @param workflow The parsed workflow containing trigger configuration
 * @param event The event type ('push' or 'pull_request')
 * @param branch The target branch from the webhook payload (e.g., 'main')
 * @returns boolean indicating if the trigger is a match
 */
export function isTriggerMatched(
  workflow: ParsedWorkflow,
  event: 'push' | 'pull_request',
  branch: string
): boolean {
  const triggerConfig = workflow.on[event];

  // 1. If the event is not defined in the 'on' block, it should not trigger
  if (!triggerConfig) {
    return false;
  }

  // 2. If 'branches' filter is not defined, it defaults to matching all branches
  if (!triggerConfig.branches || triggerConfig.branches.length === 0) {
    return true;
  }

  // 3. Match the branch against defined patterns (exact or wildcard patterns)
  for (const pattern of triggerConfig.branches) {
    if (matchBranchPattern(pattern, branch)) {
      return true;
    }
  }

  return false;
}
