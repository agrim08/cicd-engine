import { axiosInstance } from './axiosInstance';

export interface Secret {
  name: string;
}

export async function listSecrets(repoId: string): Promise<Secret[]> {
  const res = await axiosInstance.get<{ data: Secret[] }>(`/api/v1/repos/${repoId}/secrets`);
  return res.data.data;
}

export async function saveSecret(repoId: string, payload: { name: string; value: string }): Promise<void> {
  await axiosInstance.post(`/api/v1/repos/${repoId}/secrets`, payload);
}

export async function deleteSecret(repoId: string, name: string): Promise<void> {
  await axiosInstance.delete(`/api/v1/repos/${repoId}/secrets/${name}`);
}
