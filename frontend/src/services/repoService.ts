import { axiosInstance } from './axiosInstance';

export interface RepoListItem {
  id: string;
  github_repo_url: string;
  created_at: string;
  last_run_id: string | null;
  last_run_status: 'running' | 'success' | 'failed' | 'queued' | null;
  last_run_branch: string | null;
  last_run_created_at: string | null;
  last_run_trigger: string | null;
}

export interface RepoDetail {
  id: string;
  github_repo_url: string;
  webhook_url: string;
  created_at: string;
}

export interface Run {
  id: string;
  sha: string;
  branch: string;
  trigger: string;
  status: 'running' | 'success' | 'failed' | 'queued';
  created_at: string;
  completed_at: string | null;
  failed_step_name: string | null;
}

export interface ConfigData {
  yaml_content: string | null;
}

export async function listRepos(): Promise<RepoListItem[]> {
  const res = await axiosInstance.get<{ data: RepoListItem[] }>('/api/v1/repos');
  return res.data.data;
}

export async function getRepo(id: string): Promise<RepoDetail> {
  const res = await axiosInstance.get<{ data: RepoDetail }>(`/api/v1/repos/${id}`);
  return res.data.data;
}

export async function registerRepo(payload: { github_repo_url: string; github_token?: string }): Promise<RepoDetail> {
  const res = await axiosInstance.post<{ data: RepoDetail }>('/api/v1/repos', payload);
  return res.data.data;
}

export async function getRuns(repoId: string): Promise<Run[]> {
  const res = await axiosInstance.get<{ data: Run[] }>(`/api/v1/repos/${repoId}/runs`);
  return res.data.data;
}

export async function getRepoConfig(repoId: string): Promise<ConfigData> {
  const res = await axiosInstance.get<{ data: ConfigData }>(`/api/v1/repos/${repoId}/config`);
  return res.data.data;
}

export async function triggerRun(repoId: string, branch?: string): Promise<{ run_id: string }> {
  const res = await axiosInstance.post<{ data: { run_id: string } }>(`/api/v1/repos/${repoId}/runs`, { branch });
  return res.data.data;
}
