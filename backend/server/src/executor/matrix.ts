import { RawJob, ParsedJob, ParsedStep, MatrixValueType } from './types';

/**
 * Computes the Cartesian Product of a matrix configuration.
 * Generates all possible permutations of matrix keys and their value arrays.
 *
 * Example:
 *   matrix: { "node": [18, 20], "os": ["ubuntu", "macos"] }
 * Returns:
 *   [
 *     { "node": 18, "os": "ubuntu" },
 *     { "node": 18, "os": "macos" },
 *     { "node": 20, "os": "ubuntu" },
 *     { "node": 20, "os": "macos" }
 *   ]
 */
export function computeCartesianProduct(matrix: Record<string, MatrixValueType[]>): Record<string, MatrixValueType>[] {
  const keys = Object.keys(matrix);
  if (keys.length === 0) return [{}];

  let combinations: Record<string, MatrixValueType>[] = [{}];

  for (const key of keys) {
    const values = matrix[key];
    const temp: Record<string, MatrixValueType>[] = [];

    for (const combo of combinations) {
      for (const val of values) {
        temp.push({
          ...combo,
          [key]: val,
        });
      }
    }
    combinations = temp;
  }

  return combinations;
}

/**
 * Helper to interpolate matrix placeholders in the form `${{ matrix.key }}`
 * inside a target string with their actual combination values.
 */
export function interpolateMatrixPlaceholders(str: string, matrixValue: Record<string, MatrixValueType>): string {
  let result = str;
  for (const [key, value] of Object.entries(matrixValue)) {
    const regex = new RegExp(`\\$\\{\\{\\s*matrix\\.${key}\\s*\\}\\}`, 'g');
    result = result.replace(regex, String(value));
  }
  return result;
}

/**
 * Expands a RawJob using its strategy matrix configuration.
 * Resolves matrix placeholders, merges environment variables, and generates parallel jobs.
 *
 * @param jobKey The original job ID key in the YAML (e.g. 'test')
 * @param rawJob The raw parsed job object
 * @returns Array of ParsedJob objects representing the expanded parallel jobs
 */
export function expandJobMatrix(jobKey: string, rawJob: RawJob): ParsedJob[] {
  const matrix = rawJob.strategy?.matrix;
  
  // If there is no matrix configuration, return the single job without expansion
  if (!matrix || Object.keys(matrix).length === 0) {
    const parsedSteps: ParsedStep[] = rawJob.steps.map((step) => ({
      name: step.name || '',
      run: step.run,
      condition: step.if || null,
      env: step.env || {},
    }));

    return [{
      name: rawJob.name || jobKey,
      originalName: jobKey,
      image: rawJob['runs-on'] || 'ubuntu-latest',
      needs: rawJob.needs || [],
      steps: parsedSteps,
      matrixValue: null,
      env: rawJob.env || {},
    }];
  }

  const combinations = computeCartesianProduct(matrix);
  const expandedJobs: ParsedJob[] = [];

  for (const combo of combinations) {
    // Generate distinct job suffix: e.g. "18, ubuntu"
    const suffix = Object.values(combo).join(', ');
    const displayName = rawJob.name 
      ? `${rawJob.name} (${suffix})` 
      : `${jobKey} (${suffix})`;

    // 1. Interpolate and merge job environment variables
    const jobEnv: Record<string, string> = {};
    if (rawJob.env) {
      for (const [key, value] of Object.entries(rawJob.env)) {
        jobEnv[key] = interpolateMatrixPlaceholders(value, combo);
      }
    }
    // Inject matrix values as env variables directly: e.g. env.NODE_VERSION = "18"
    for (const [key, value] of Object.entries(combo)) {
      jobEnv[key] = String(value);
    }

    // 2. Interpolate steps name, run, and env values
    const parsedSteps: ParsedStep[] = rawJob.steps.map((step) => {
      const stepEnv: Record<string, string> = {};
      if (step.env) {
        for (const [k, v] of Object.entries(step.env)) {
          stepEnv[k] = interpolateMatrixPlaceholders(v, combo);
        }
      }

      return {
        name: interpolateMatrixPlaceholders(step.name || '', combo),
        run: interpolateMatrixPlaceholders(step.run, combo),
        condition: step.if ? interpolateMatrixPlaceholders(step.if, combo) : null,
        env: stepEnv,
      };
    });

    expandedJobs.push({
      name: displayName,
      originalName: jobKey,
      image: rawJob['runs-on'] || 'ubuntu-latest',
      needs: rawJob.needs || [],
      steps: parsedSteps,
      matrixValue: combo,
      env: jobEnv,
    });
  }

  return expandedJobs;
}
