export interface RawStep {
  name?: string;
  run: string;
  if?: string;
  env?: Record<string, string>;
}

export type MatrixValueType = string | number | boolean;

export interface RawJob {
  name?: string;
  'runs-on'?: string;
  needs: string[];
  strategy?: {
    matrix: Record<string, MatrixValueType[]>;
  };
  steps: RawStep[];
  env?: Record<string, string>;
}

export interface ParsedStep {
  name: string;
  run: string;
  condition: string | null; // From 'if' keyword
  env: Record<string, string>;
}

export interface ParsedJob {
  name: string;          // Display name (e.g. "build (18, ubuntu)")
  originalName: string;  // Original key (e.g. "build")
  image: string;         // Mapped from runs-on
  needs: string[];       // Prerequisite jobs
  steps: ParsedStep[];
  matrixValue: Record<string, MatrixValueType> | null; // Specific matrix settings
  env: Record<string, string>;            // Merged job-level + matrix envs
}

export interface ParsedWorkflow {
  name: string;
  on: {
    push?: {
      branches?: string[];
    };
    pull_request?: {
      branches?: string[];
    };
  };
  env: Record<string, string>; // Global environment variables
  jobs: ParsedJob[];           // List of all jobs (after matrix expansion)
}

// --- Loose YAML Interfaces for Validation & Parsing ---

export interface YamlStep {
  name?: string;
  run?: unknown;
  if?: string;
  env?: Record<string, unknown>;
}

export interface YamlJob {
  name?: string;
  'runs-on'?: string;
  needs?: unknown;
  strategy?: {
    matrix?: Record<string, unknown>;
  };
  steps?: unknown;
  env?: Record<string, unknown>;
}

export interface YamlWorkflow {
  name?: string;
  on?: unknown;
  env?: Record<string, unknown>;
  jobs?: Record<string, unknown>;
}
