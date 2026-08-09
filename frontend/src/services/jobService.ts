import { axiosInstance } from './axiosInstance';

export interface Step {
  id: string;
  job_id: string;
  name: string;
  status: 'pending' | 'running' | 'success' | 'failed';
  exit_code: number | null;
  duration_ms: number | null;
  step_order: number;
}

export interface Job {
  id: string;
  run_id: string;
  name: string;
  status: 'queued' | 'running' | 'success' | 'failed' | 'timeout' | 'cancelled';
  exit_code: number | null;
  runner_id: string | null;
  matrix_value: Record<string, string> | null;
  started_at: string | null;
  completed_at: string | null;
  steps: Step[];
}

export interface LogLine {
  lineNo: number;
  content: string;
  timestamp: string;
  stepId: string | null;
}

export interface GroupedLogs {
  stepLogs: Record<string, LogLine[]>;
  globalLogs: LogLine[];
}

export async function getRunJobs(runId: string): Promise<Job[]> {
  const res = await axiosInstance.get<{ data: Job[] }>(`/api/v1/jobs/runs/${runId}`);
  return res.data.data;
}

export async function getJobLogs(jobId: string, grouped: boolean = true): Promise<GroupedLogs> {
  const res = await axiosInstance.get<{ data: GroupedLogs }>(`/api/v1/jobs/${jobId}/logs?grouped=${grouped}`);
  return res.data.data;
}
