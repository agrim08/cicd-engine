import React, { useState, useEffect } from 'react';
import { useParams, Link, useSearchParams } from 'react-router-dom';
import { getRepo, getRuns, getRepoConfig, triggerRun, type RepoDetail as RepoType, type Run, type ConfigData } from '../services/repoService';
import { listSecrets, saveSecret, deleteSecret, type Secret } from '../services/secretService';
import { useToast } from '../context/ToastContext';
import StatusBadge from '../components/StatusBadge';

function formatDuration(startedAt: string | null, completedAt: string | null): string {
  if (!startedAt) return '-';
  const start = new Date(startedAt).getTime();
  const end = completedAt ? new Date(completedAt).getTime() : Date.now();
  const diffMs = end - start;
  const diffSecs = Math.floor(diffMs / 1000);

  if (diffSecs < 60) return `${diffSecs}s`;
  const mins = Math.floor(diffSecs / 60);
  const secs = diffSecs % 60;
  return `${mins}m ${secs}s`;
}

function formatStartedAt(dateString: string | null): string {
  if (!dateString) return '-';
  const date = new Date(dateString);
  return date.toLocaleString();
}

export default function RepoDetail() {
  const { id } = useParams<{ id: string }>();
  const [searchParams, setSearchParams] = useSearchParams();
  const { showToast } = useToast();

  const [repo, setRepo] = useState<RepoType | null>(null);
  const [runs, setRuns] = useState<Run[]>([]);
  const [secrets, setSecrets] = useState<Secret[]>([]);
  const [config, setConfig] = useState<ConfigData | null>(null);

  const [loading, setLoading] = useState(true);
  const [triggering, setTriggering] = useState(false);

  // Tab State
  const initialTab = (searchParams.get('tab') as 'runs' | 'secrets' | 'config') || 'runs';
  const [activeTab, setActiveTab] = useState<'runs' | 'secrets' | 'config'>(initialTab);

  // Secrets Input States
  const [secretKey, setSecretKey] = useState('');
  const [secretValue, setSecretValue] = useState('');
  const [isEditing, setIsEditing] = useState(false);
  const [saveSuccess, setSaveSuccess] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null);

  useEffect(() => {
    async function loadData() {
      if (!id) return;
      setLoading(true);
      try {
        const repoData = await getRepo(id);
        setRepo(repoData);

        const runsData = await getRuns(id);
        setRuns(runsData);

        const secretsData = await listSecrets(id);
        setSecrets(secretsData);

        const configData = await getRepoConfig(id);
        setConfig(configData);
      } catch (err) {
        console.error('Failed to load repository details:', err);
      } finally {
        setLoading(false);
      }
    }
    loadData();
  }, [id]);

  // Synchronize Tab parameter
  const selectTab = (tab: 'runs' | 'secrets' | 'config') => {
    setActiveTab(tab);
    setSearchParams({ tab });
  };

  const handleTriggerRun = async () => {
    if (!id || triggering) return;
    setTriggering(true);
    try {
      await triggerRun(id);
      showToast('Pipeline execution run triggered successfully');
      // Refresh runs list
      const updatedRuns = await getRuns(id);
      setRuns(updatedRuns);
    } catch (err: any) {
      showToast(err.message || 'Failed to trigger pipeline run');
    } finally {
      setTriggering(false);
    }
  };

  const handleSaveSecret = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!id || !secretKey.trim() || !secretValue.trim()) return;

    try {
      await saveSecret(id, {
        name: secretKey.trim().toUpperCase(),
        value: secretValue.trim(),
      });

      setSecretKey('');
      setSecretValue('');
      setIsEditing(false);
      setSaveSuccess(true);
      showToast('Secret saved successfully');

      setTimeout(() => {
        setSaveSuccess(false);
      }, 2000);

      const updatedSecrets = await listSecrets(id);
      setSecrets(updatedSecrets);
    } catch (err: any) {
      showToast(err.message || 'Failed to save secret');
    }
  };

  const handleDeleteSecret = async (name: string) => {
    if (!id) return;
    try {
      await deleteSecret(id, name);
      setDeleteConfirm(null);
      showToast(`Secret '${name}' deleted successfully`);
      const updatedSecrets = await listSecrets(id);
      setSecrets(updatedSecrets);
    } catch (err: any) {
      showToast(err.message || 'Failed to delete secret');
    }
  };

  if (loading) {
    return <div className="p-4 text-text-muted italic select-none">Loading repository details...</div>;
  }

  if (!repo) {
    return <div className="p-4 text-status-failed select-none">Repository not found.</div>;
  }

  return (
    <div className="flex flex-col gap-6">
      {/* Header section with Trigger Run button */}
      <div className="flex justify-between items-center border-b border-border-default pb-4">
        <div>
          <h1 className="text-[16px] font-bold text-text-primary mb-1">
            {repo.github_repo_url.replace('https://github.com/', '')}
          </h1>
          <p className="text-text-muted select-none text-[11px]">
            Created: {new Date(repo.created_at).toLocaleDateString()} | Webhook URL: {repo.webhook_url}
          </p>
        </div>

        {activeTab === 'runs' && (
          <button
            onClick={handleTriggerRun}
            disabled={triggering}
            className="h-[36px] flex items-center justify-center text-text-accent hover:bg-bg-hover px-4 border border-border-default bg-bg-surface select-none cursor-pointer font-bold disabled:opacity-50"
          >
            {triggering ? 'Triggering...' : '▶ Trigger Run'}
          </button>
        )}
      </div>

      {/* Tabs Menu */}
      <div className="flex gap-6 border-b border-border-default select-none">
        {(['runs', 'secrets', 'config'] as const).map(tab => (
          <button
            key={tab}
            onClick={() => selectTab(tab)}
            className={`pb-2 px-1 text-[13px] capitalize font-bold cursor-pointer transition-all duration-100 ${
              activeTab === tab
                ? 'border-b-2 border-text-accent text-text-primary'
                : 'text-text-muted hover:text-text-primary'
            }`}
          >
            {tab}
          </button>
        ))}
      </div>

      {/* Tab Panels */}
      <div className="flex flex-col">
        {/* PANEL 1: RUNS LIST */}
        {activeTab === 'runs' && (
          <div className="border border-border-default bg-bg-surface">
            <div className="overflow-x-auto">
              {runs.length === 0 ? (
                <div className="p-4 text-text-muted italic select-none">No execution runs yet.</div>
              ) : (
                <table className="w-full text-left border-collapse">
                  <thead>
                    <tr className="border-b border-border-default text-text-muted bg-bg-surface/50 text-[11px] uppercase select-none">
                      <th className="p-3 font-bold">Run #</th>
                      <th className="p-3 font-bold">Trigger</th>
                      <th className="p-3 font-bold">Branch</th>
                      <th className="p-3 font-bold">Status</th>
                      <th className="p-3 font-bold">Duration</th>
                      <th className="p-3 font-bold">Started</th>
                      <th className="p-3 font-bold">Action</th>
                    </tr>
                  </thead>
                  <tbody>
                    {runs.map(run => {
                      const displaySha = run.sha.includes('manual') 
                        ? run.sha.split('-')[0] 
                        : run.sha.substring(0, 7);

                      return (
                        <tr
                          key={run.id}
                          className="border-b border-border-default hover:bg-bg-hover"
                        >
                          <td className="p-3 font-bold text-text-accent">
                            <Link to={`/repos/${repo.id}/runs/${run.id}`} className="hover:underline">
                              #{displaySha}
                            </Link>
                          </td>
                          <td className="p-3 uppercase text-[10px] tracking-wider text-text-muted font-bold select-none">
                            {run.trigger}
                          </td>
                          <td className="p-3">{run.branch}</td>
                          <td className="p-3">
                            <StatusBadge status={run.status} failedStepName={run.failed_step_name} />
                          </td>
                          <td className="p-3">{formatDuration(run.created_at, run.completed_at)}</td>
                          <td className="p-3 text-text-muted">{formatStartedAt(run.created_at)}</td>
                          <td className="p-3">
                            <Link
                              to={`/repos/${repo.id}/runs/${run.id}`}
                              className="text-text-accent hover:underline font-bold"
                            >
                              View Logs
                            </Link>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        )}

        {/* PANEL 2: SECRETS MANAGER */}
        {activeTab === 'secrets' && (
          <div className="flex flex-col gap-6">
            <div className="border border-border-default bg-bg-surface">
              <div className="p-3 border-b border-border-default text-text-muted uppercase text-[11px] font-bold bg-bg-base select-none">
                Repository Secrets
              </div>
              <div className="flex flex-col">
                {secrets.length === 0 ? (
                  <div className="p-4 text-text-muted italic select-none">No secrets configured.</div>
                ) : (
                  secrets.map(secret => {
                    const isConfirming = deleteConfirm === secret.name;
                    return (
                      <div
                        key={secret.name}
                        className="flex justify-between items-center p-3 border-b border-border-default/50 hover:bg-bg-hover/50"
                      >
                        <div className="flex gap-12 items-center">
                          <span className="font-bold">{secret.name}</span>
                          <span className="text-text-muted font-mono tracking-widest select-none">••••••••</span>
                        </div>
                        <div className="flex items-center gap-3">
                          {isConfirming ? (
                            <div className="flex gap-2 items-center text-[12px] bg-bg-base px-2 py-1 border border-border-default">
                              <span className="text-text-muted select-none">Confirm delete?</span>
                              <button
                                onClick={() => handleDeleteSecret(secret.name)}
                                className="text-status-failed hover:underline font-bold cursor-pointer"
                              >
                                Yes
                              </button>
                              <span className="text-text-muted">/</span>
                              <button
                                onClick={() => setDeleteConfirm(null)}
                                className="text-text-muted hover:underline cursor-pointer"
                              >
                                Cancel
                              </button>
                            </div>
                          ) : (
                            <>
                              <button
                                onClick={() => {
                                  setSecretKey(secret.name);
                                  setIsEditing(true);
                                }}
                                className="text-text-accent hover:underline cursor-pointer select-none"
                              >
                                Edit
                              </button>
                              <span className="text-text-muted select-none">/</span>
                              <button
                                onClick={() => setDeleteConfirm(secret.name)}
                                className="text-status-failed hover:underline cursor-pointer select-none"
                              >
                                Delete
                              </button>
                            </>
                          )}
                        </div>
                      </div>
                    );
                  })
                )}
              </div>
            </div>

            {/* In-line form to add secrets */}
            <form onSubmit={handleSaveSecret} className="border border-border-default bg-bg-surface p-4 flex flex-col gap-4 max-w-md">
              <div className="text-[11px] text-text-muted font-bold uppercase select-none">
                {isEditing ? 'EDIT SECRET' : 'ADD NEW SECRET'}
              </div>
              <div className="flex flex-col gap-1.5">
                <label className="text-text-muted select-none text-[11px] font-bold uppercase">
                  Secret Name
                </label>
                <input
                  type="text"
                  required
                  disabled={isEditing}
                  value={secretKey}
                  onChange={(e) => setSecretKey(e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, ''))}
                  placeholder="E.G. DOCKER_PASSWORD"
                  className="bg-bg-base border border-border-default px-3 py-1.5 text-text-primary focus:outline-none focus:ring-1 focus:ring-text-accent uppercase disabled:opacity-50"
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <label className="text-text-muted select-none text-[11px] font-bold uppercase">
                  Secret Value
                </label>
                <input
                  type="password"
                  required
                  value={secretValue}
                  onChange={(e) => setSecretValue(e.target.value)}
                  placeholder="••••••••"
                  className="bg-bg-base border border-border-default px-3 py-1.5 text-text-primary focus:outline-none focus:ring-1 focus:ring-text-accent"
                />
              </div>
              <div className="flex items-center gap-3 pt-2">
                <button
                  type="submit"
                  className="px-3 py-1.5 border border-border-default bg-bg-base text-text-accent hover:bg-bg-hover cursor-pointer font-bold select-none"
                >
                  Save Secret
                </button>
                {isEditing && (
                  <button
                    type="button"
                    onClick={() => {
                      setSecretKey('');
                      setSecretValue('');
                      setIsEditing(false);
                    }}
                    className="px-3 py-1.5 border border-transparent text-text-muted hover:underline cursor-pointer select-none"
                  >
                    Cancel
                  </button>
                )}
                {saveSuccess && (
                  <span className="text-status-success font-bold select-none text-[12px]">
                    Saved.
                  </span>
                )}
              </div>
            </form>
          </div>
        )}

        {/* PANEL 3: CONFIG PANEL */}
        {activeTab === 'config' && (
          <div className="flex flex-col">
            {config?.yaml_content ? (
              <pre className="bg-bg-surface border border-border-default p-4 overflow-x-auto text-[12px] leading-relaxed font-mono whitespace-pre text-text-primary">
                {config.yaml_content}
              </pre>
            ) : (
              <div className="border border-dashed border-border-default bg-bg-surface/30 p-8 text-center text-text-muted italic select-none">
                No pipeline config detected in this repository.
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
