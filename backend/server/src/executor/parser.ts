import yaml from 'js-yaml';
import { expandJobMatrix } from './matrix';
import { RawStep, RawJob, ParsedStep, ParsedJob, ParsedWorkflow, YamlWorkflow, YamlJob, YamlStep, MatrixValueType } from './types';

/**
 * Parses and validates a pipeline YAML string.
 * Resolves global variables, validates triggers, and expands job matrices.
 *
 * @param yamlContent The raw workflow YAML configuration string
 * @returns Fully parsed and matrix-expanded workflow structure
 */
export function parseWorkflow(yamlContent: string): ParsedWorkflow {
  let doc: unknown;
  try {
    doc = yaml.load(yamlContent);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`YAML syntax error: ${message}`);
  }

  if (!doc || typeof doc !== 'object') {
    throw new Error('Invalid workflow configuration: YAML root must be an object.');
  }

  const yamlDoc = doc as YamlWorkflow;

  // Validate 'jobs' section exists
  if (yamlDoc.jobs === undefined) {
    throw new Error("Invalid workflow configuration: 'jobs' section is required.");
  }

  // Validate 'jobs' is an object
  if (!yamlDoc.jobs || typeof yamlDoc.jobs !== 'object' || Array.isArray(yamlDoc.jobs)) {
    const actual = yamlDoc.jobs === null ? 'null' : Array.isArray(yamlDoc.jobs) ? 'array' : typeof yamlDoc.jobs;
    throw new Error(`Invalid workflow configuration: 'jobs' section must be an object, got ${actual}`);
  }

  // 1. Resolve Workflow Name (Fallback to default if not defined)
  const name = typeof yamlDoc.name === 'string' ? yamlDoc.name.trim() : 'Workflow';

  // 2. Parse Triggers ('on' block)
  const onBlock: Record<string, unknown> = {};
  if (yamlDoc.on) {
    if (typeof yamlDoc.on === 'string') {
      onBlock[yamlDoc.on] = {};
    } else if (Array.isArray(yamlDoc.on)) {
      for (const event of yamlDoc.on) {
        if (typeof event === 'string') {
          onBlock[event] = {};
        }
      }
    } else if (typeof yamlDoc.on === 'object' && yamlDoc.on !== null) {
      for (const [event, config] of Object.entries(yamlDoc.on)) {
        if (config && typeof config === 'object') {
          onBlock[event] = config;
        } else {
          onBlock[event] = {};
        }
      }
    }
  }

  // Normalize on.push and on.pull_request branches
  const pushConfig = onBlock.push as Record<string, unknown> | undefined;
  const prConfig = onBlock.pull_request as Record<string, unknown> | undefined;

  const pushBranches = pushConfig?.branches;
  const prBranches = prConfig?.branches;

  const normalizedOn: ParsedWorkflow['on'] = {
    push: onBlock.push ? {
      branches: Array.isArray(pushBranches) ? pushBranches.map(String) : undefined,
    } : undefined,
    pull_request: onBlock.pull_request ? {
      branches: Array.isArray(prBranches) ? prBranches.map(String) : undefined,
    } : undefined,
  };

  // 3. Parse Global Env Mappings (Validate env must be an object)
  const globalEnv: Record<string, string> = {};
  if (yamlDoc.env !== undefined) {
    if (typeof yamlDoc.env !== 'object' || yamlDoc.env === null || Array.isArray(yamlDoc.env)) {
      const actual = yamlDoc.env === null ? 'null' : Array.isArray(yamlDoc.env) ? 'array' : typeof yamlDoc.env;
      throw new Error(`Workflow field 'env' is invalid. Expected object, got ${actual}`);
    }
    for (const [key, value] of Object.entries(yamlDoc.env)) {
      globalEnv[key] = String(value);
    }
  }

  const jobKeys = Object.keys(yamlDoc.jobs);
  const parsedJobs: ParsedJob[] = [];

  // 4. Parse & Expand Jobs
  for (const [jobKey, jobVal] of Object.entries(yamlDoc.jobs)) {
    if (!jobVal || typeof jobVal !== 'object' || Array.isArray(jobVal)) {
      const actual = jobVal === null ? 'null' : Array.isArray(jobVal) ? 'array' : typeof jobVal;
      throw new Error(`Job '${jobKey}' is invalid. Expected job configuration object, got ${actual}`);
    }

    const rawJob = jobVal as YamlJob;
    
    // Validate runs-on
    if (!rawJob['runs-on'] || typeof rawJob['runs-on'] !== 'string') {
      const actual = rawJob['runs-on'] === undefined ? 'undefined' : typeof rawJob['runs-on'];
      throw new Error(`Job '${jobKey}' field 'runs-on' is invalid. Expected string, got ${actual}`);
    }

    // Validate needs references existing jobs
    let needs: string[] = [];
    if (rawJob.needs !== undefined) {
      if (typeof rawJob.needs === 'string') {
        needs = [rawJob.needs];
      } else if (Array.isArray(rawJob.needs)) {
        for (const dep of rawJob.needs) {
          if (typeof dep !== 'string') {
            throw new Error(`Job '${jobKey}' field 'needs' contains invalid value. Expected string, got ${typeof dep}`);
          }
          needs.push(dep);
        }
      } else {
        throw new Error(`Job '${jobKey}' field 'needs' is invalid. Expected string or array of strings, got ${typeof rawJob.needs}`);
      }

      // Verify each dependency key exists in workflow jobs list
      for (const dep of needs) {
        if (!jobKeys.includes(dep)) {
          throw new Error(`Job '${jobKey}' field 'needs' references a non-existent job '${dep}'`);
        }
      }
    }

    // Validate strategy & matrix configurations
    let strategyMatrix: Record<string, MatrixValueType[]> | undefined;
    if (rawJob.strategy !== undefined) {
      if (typeof rawJob.strategy !== 'object' || rawJob.strategy === null || Array.isArray(rawJob.strategy)) {
        const actual = rawJob.strategy === null ? 'null' : Array.isArray(rawJob.strategy) ? 'array' : typeof rawJob.strategy;
        throw new Error(`Job '${jobKey}' field 'strategy' is invalid. Expected object, got ${actual}`);
      }

      const matrix = rawJob.strategy.matrix;
      if (!matrix || typeof matrix !== 'object' || Array.isArray(matrix)) {
        const actual = matrix === undefined ? 'undefined' : matrix === null ? 'null' : Array.isArray(matrix) ? 'array' : typeof matrix;
        throw new Error(`Job '${jobKey}' field 'strategy.matrix' is invalid. Expected object, got ${actual}`);
      }

      strategyMatrix = {};
      for (const [k, v] of Object.entries(matrix)) {
        if (!Array.isArray(v)) {
          const actual = v === null ? 'null' : typeof v;
          throw new Error(`Job '${jobKey}' field 'strategy.matrix.${k}' is invalid. Expected array, got ${actual}`);
        }
        if (v.length === 0) {
          throw new Error(`Job '${jobKey}' field 'strategy.matrix.${k}' is invalid. Expected non-empty array, got empty array`);
        }

        // Validate no duplicate values within matrix axis
        const seenValues = new Set<MatrixValueType>();
        const typedVals: MatrixValueType[] = [];
        for (const item of v) {
          let typedItem: MatrixValueType;
          if (typeof item === 'string' || typeof item === 'number' || typeof item === 'boolean') {
            typedItem = item;
          } else {
            typedItem = String(item);
          }

          if (seenValues.has(typedItem)) {
            throw new Error(`Job '${jobKey}' field 'strategy.matrix.${k}' contains duplicate value '${typedItem}'. Expected unique values`);
          }
          seenValues.add(typedItem);
          typedVals.push(typedItem);
        }
        strategyMatrix[k] = typedVals;
      }
    }

    // Validate job-level env (if present)
    if (rawJob.env !== undefined && (typeof rawJob.env !== 'object' || rawJob.env === null || Array.isArray(rawJob.env))) {
      const actual = rawJob.env === null ? 'null' : Array.isArray(rawJob.env) ? 'array' : typeof rawJob.env;
      throw new Error(`Job '${jobKey}' field 'env' is invalid. Expected object, got ${actual}`);
    }

    const rawJobEnv: Record<string, string> = {};
    if (rawJob.env) {
      for (const [k, v] of Object.entries(rawJob.env)) {
        rawJobEnv[k] = String(v);
      }
    }

    // Validate steps is a non-empty array
    if (!rawJob.steps || !Array.isArray(rawJob.steps)) {
      const actual = rawJob.steps === undefined ? 'undefined' : typeof rawJob.steps;
      throw new Error(`Job '${jobKey}' field 'steps' is invalid. Expected array, got ${actual}`);
    }
    if (rawJob.steps.length === 0) {
      throw new Error(`Job '${jobKey}' field 'steps' is invalid. Expected non-empty array, got empty array`);
    }

    // Validate and process individual steps
    const stepsConfig = rawJob.steps.map((stepVal: unknown, index: number): RawStep => {
      if (!stepVal || typeof stepVal !== 'object' || Array.isArray(stepVal)) {
        const actual = stepVal === null ? 'null' : Array.isArray(stepVal) ? 'array' : typeof stepVal;
        throw new Error(`Job '${jobKey}' step at index ${index} is invalid. Expected object, got ${actual}`);
      }
      
      const step = stepVal as YamlStep;

      // Validate step run exists and is string
      if (step.run === undefined || typeof step.run !== 'string') {
        const actual = step.run === undefined ? 'undefined' : typeof step.run;
        throw new Error(`Job '${jobKey}' step at index ${index} field 'run' is invalid. Expected string, got ${actual}`);
      }

      // Validate step env (if present) is an object
      if (step.env !== undefined && (typeof step.env !== 'object' || step.env === null || Array.isArray(step.env))) {
        const actual = step.env === null ? 'null' : Array.isArray(step.env) ? 'array' : typeof step.env;
        throw new Error(`Job '${jobKey}' step at index ${index} field 'env' is invalid. Expected object, got ${actual}`);
      }

      const stepEnv: Record<string, string> = {};
      if (step.env) {
        for (const [k, v] of Object.entries(step.env)) {
          stepEnv[k] = String(v);
        }
      }

      return {
        name: step.name || `Step ${index + 1}`,
        run: step.run,
        if: step.if,
        env: stepEnv,
      };
    });

    const rawJobConfig: RawJob = {
      name: rawJob.name,
      'runs-on': rawJob['runs-on'],
      needs,
      strategy: strategyMatrix ? { matrix: strategyMatrix } : undefined,
      steps: stepsConfig,
      env: rawJobEnv,
    };

    // Expand Strategy Matrix and append to the job list
    const expanded = expandJobMatrix(jobKey, rawJobConfig);
    parsedJobs.push(...expanded);
  }

  // 5. Detect duplicate expanded job names
  const seenJobNames = new Set<string>();
  for (const job of parsedJobs) {
    if (seenJobNames.has(job.name)) {
      throw new Error(`Duplicate expanded job name '${job.name}' detected.`);
    }
    seenJobNames.add(job.name);
  }

  return {
    name,
    on: normalizedOn,
    env: globalEnv,
    jobs: parsedJobs,
  };
}
