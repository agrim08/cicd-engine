import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { listRepos, type RepoListItem } from '../services/repoService';
import StatusBadge from '../components/StatusBadge';

function formatRelativeTime(dateString: string | null): { relative: string; absolute: string } {
  if (!dateString) return { relative: '-', absolute: '-' };
  const date = new Date(dateString);
  const absolute = date.toLocaleString();
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffSecs = Math.floor(diffMs / 1000);
  const diffMins = Math.floor(diffSecs / 60);
  const diffHours = Math.floor(diffMins / 60);
  const diffDays = Math.floor(diffHours / 24);

  if (diffSecs < 60) return { relative: 'just now', absolute };
  if (diffMins < 60) return { relative: `${diffMins}m ago`, absolute };
  if (diffHours < 24) return { relative: `${diffHours}h ago`, absolute };
  return { relative: `${diffDays}d ago`, absolute };
}

export default function Dashboard() {
  const navigate = useNavigate();
  const [repos, setRepos] = useState<RepoListItem[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function fetchRepos() {
      try {
        const data = await listRepos();
        setRepos(data);
      } catch (err) {
        console.error('Failed to load dashboard repos:', err);
      } finally {
        setLoading(false);
      }
    }
    fetchRepos();
  }, []);

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-[16px] font-bold text-text-primary border-b border-border-default pb-2 select-none mb-1">
          DASHBOARD
        </h1>
        <p className="text-text-muted select-none">
          Overview of registered pipeline workflows and runner agent status.
        </p>
      </div>

      <div className="grid grid-cols-2 gap-4">
        {/* Status panel */}
        <div className="border border-border-default bg-bg-surface p-4 flex flex-col gap-2">
          <div className="text-text-muted uppercase text-[11px] font-bold border-b border-border-default pb-1 select-none">
            Runner Instances
          </div>
          <div className="flex justify-between items-center py-1">
            <span>runner-local-agent</span>
            <span className="text-status-success bg-status-success/10 px-1.5 py-0.5 border border-status-success/30 font-bold text-[10px] select-none">
              ONLINE
            </span>
          </div>
          <div className="flex justify-between items-center py-1">
            <span>runner-production-01</span>
            <span className="text-text-muted bg-bg-base px-1.5 py-0.5 border border-border-default text-[10px] select-none">
              OFFLINE
            </span>
          </div>
        </div>

        {/* Queue panel */}
        <div className="border border-border-default bg-bg-surface p-4 flex flex-col gap-2">
          <div className="text-text-muted uppercase text-[11px] font-bold border-b border-border-default pb-1 select-none">
            BullMQ Scheduler
          </div>
          <div className="flex justify-between items-center py-1">
            <span>Job queue processing</span>
            <span className="text-text-accent select-none font-bold text-[11px]">ACTIVE</span>
          </div>
          <div className="flex justify-between items-center py-1">
            <span>Pending executions</span>
            <span className="text-text-primary select-none font-bold">0</span>
          </div>
        </div>
      </div>

      {/* Repo Table */}
      <div className="border border-border-default bg-bg-surface">
        <div className="p-3 border-b border-border-default text-text-muted uppercase text-[11px] font-bold bg-bg-base select-none">
          Monitored Pipelines
        </div>
        <div className="overflow-x-auto">
          {loading ? (
            <div className="p-4 text-text-muted italic select-none">Loading pipelines...</div>
          ) : repos.length === 0 ? (
            <div className="p-4 text-text-muted select-none">
              No repositories linked. Add one to get started.
            </div>
          ) : (
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="border-b border-border-default text-text-muted bg-bg-surface/50 text-[11px] uppercase select-none">
                  <th className="p-3 font-bold">Repository</th>
                  <th className="p-3 font-bold">Branch</th>
                  <th className="p-3 font-bold">Last Run</th>
                  <th className="p-3 font-bold">Status</th>
                  <th className="p-3 font-bold">Triggered</th>
                  <th className="p-3 font-bold">Actions</th>
                </tr>
              </thead>
              <tbody>
                {repos.map(repo => {
                  const repoLabel = repo.github_repo_url.replace('https://github.com/', '');
                  const lastRunTime = formatRelativeTime(repo.last_run_created_at);

                  return (
                    <tr
                      key={repo.id}
                      className="border-b border-border-default hover:bg-bg-hover"
                    >
                      <td className="p-3 font-bold text-text-accent truncate max-w-[200px]">
                        <span onClick={() => navigate(`/repos/${repo.id}`)} className="cursor-pointer hover:underline">
                          {repoLabel}
                        </span>
                      </td>
                      <td className="p-3">{repo.last_run_branch || '-'}</td>
                      <td className="p-3" title={lastRunTime.absolute}>
                        {lastRunTime.relative}
                      </td>
                      <td className="p-3">
                        {repo.last_run_status ? (
                          <StatusBadge status={repo.last_run_status} />
                        ) : (
                          <span className="text-text-muted font-bold select-none">—</span>
                        )}
                      </td>
                      <td className="p-3 uppercase text-[10px] tracking-wider text-text-muted font-bold select-none">
                        {repo.last_run_trigger || '-'}
                      </td>
                      <td className="p-3 flex gap-3 text-text-accent">
                        <span onClick={() => navigate(`/repos/${repo.id}`)} className="cursor-pointer hover:underline">
                          View
                        </span>
                        <span className="select-none">|</span>
                        <span onClick={() => navigate(`/repos/${repo.id}?tab=secrets`)} className="cursor-pointer hover:underline">
                          Settings
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}
