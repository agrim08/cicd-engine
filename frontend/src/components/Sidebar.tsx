import React, { useState, useEffect } from 'react';
import { useNavigate, useLocation, Link } from 'react-router-dom';
import { listRepos, getRuns, type RepoListItem, type Run } from '../services/repoService';

export default function Sidebar() {
  const navigate = useNavigate();
  const location = useLocation();

  const [repos, setRepos] = useState<RepoListItem[]>([]);
  const [expandedRepos, setExpandedRepos] = useState<Record<string, boolean>>({});
  const [runsCache, setRunsCache] = useState<Record<string, Run[]>>({});

  useEffect(() => {
    async function loadRepos() {
      try {
        const data = await listRepos();
        setRepos(data);
      } catch (err) {
        console.error('Failed to load repositories in sidebar:', err);
      }
    }
    loadRepos();
  }, [location.pathname]);

  const toggleExpand = async (repoId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    const willExpand = !expandedRepos[repoId];
    setExpandedRepos(prev => ({ ...prev, [repoId]: willExpand }));

    if (willExpand && !runsCache[repoId]) {
      try {
        const runs = await getRuns(repoId);
        setRunsCache(prev => ({ ...prev, [repoId]: runs }));
      } catch (err) {
        console.error(`Failed to load runs for repo ${repoId}:`, err);
      }
    }
  };

  const getSymbol = (s: Run['status']): string => {
    switch (s) {
      case 'running': return '●';
      case 'success': return '●';
      case 'failed': return '✕';
      case 'queued': return '○';
    }
  };

  const getColorClass = (s: Run['status']): string => {
    switch (s) {
      case 'running': return 'text-status-running';
      case 'success': return 'text-status-success';
      case 'failed': return 'text-status-failed';
      case 'queued': return 'text-status-queued';
    }
  };

  return (
    <div className="w-[240px] flex-shrink-0 bg-bg-surface border-r border-border-default flex flex-col justify-between h-full">
      <div className="flex flex-col overflow-y-auto">
        {/* Plain Text Logo */}
        <div className="h-[48px] flex-shrink-0 flex items-center px-4 text-text-accent font-bold select-none tracking-wider border-b border-border-default">
          [ piperunner ]
        </div>

        {/* Section Header */}
        <div className="px-4 pt-4 pb-2 text-[10px] text-text-muted font-bold tracking-wider uppercase select-none">
          REPOSITORIES
        </div>

        {/* Navigation Tree */}
        <div className="flex flex-col">
          {repos.map(repo => {
            const isRepoActive = location.pathname.startsWith(`/repos/${repo.id}`);
            const isExpanded = !!expandedRepos[repo.id];
            const repoName = repo.github_repo_url.split('/').pop() || repo.github_repo_url;
            const runs = runsCache[repo.id] || [];

            return (
              <div key={repo.id} className="flex flex-col">
                {/* Repo Node */}
                <div
                  onClick={() => navigate(`/repos/${repo.id}`)}
                  className={`flex items-center justify-between px-3 py-1.5 cursor-pointer border-l-2 select-none ${
                    isRepoActive
                      ? 'bg-bg-hover border-text-accent text-text-primary'
                      : 'border-transparent text-text-muted hover:bg-bg-hover hover:text-text-primary'
                  }`}
                >
                  <div className="flex items-center gap-1.5 truncate">
                    {/* Collapsible toggle */}
                    <span
                      onClick={(e) => toggleExpand(repo.id, e)}
                      className="w-4 h-4 flex items-center justify-center text-text-muted hover:text-text-primary text-[10px]"
                    >
                      {isExpanded ? '▼' : '▸'}
                    </span>
                    <span className="truncate">{repoName}</span>
                  </div>
                </div>

                {/* Run Nodes under Repo */}
                {isExpanded && (
                  <div className="flex flex-col pl-6 border-l border-border-default ml-5 mb-1 mt-0.5">
                    {runs.length === 0 ? (
                      <span className="text-[11px] text-text-muted py-1 px-3 select-none">No runs yet</span>
                    ) : (
                      runs.map(run => {
                        const isRunActive = location.pathname === `/repos/${repo.id}/runs/${run.id}`;
                        const displaySha = run.sha.includes('manual') 
                          ? run.sha.split('-')[0]
                          : run.sha.substring(0, 7);

                        return (
                          <Link
                            key={run.id}
                            to={`/repos/${repo.id}/runs/${run.id}`}
                            className={`flex items-center gap-2 py-1 px-3 border-l ${
                              isRunActive
                                ? 'border-text-accent text-text-primary bg-bg-hover'
                                : 'border-transparent text-text-muted hover:text-text-primary hover:bg-bg-hover'
                            }`}
                          >
                            <span className={getColorClass(run.status)}>
                              {getSymbol(run.status)}
                            </span>
                            <span className="truncate">Run #{displaySha}</span>
                          </Link>
                        );
                      })
                    )}
                  </div>
                )}
              </div>
            );
          })}
          {repos.length === 0 && (
            <div className="px-4 py-2 text-[12px] text-text-muted italic select-none">
              No repos registered
            </div>
          )}
        </div>
      </div>

      {/* Sidebar Footer Operations */}
      <div className="p-3 border-t border-border-default flex flex-col gap-2 bg-bg-base">
        <Link
          to="/repos/new"
          className="text-text-accent hover:underline flex items-center gap-1 text-[12px]"
        >
          + Add Repository
        </Link>
        <Link
          to="/settings"
          className={`text-text-muted hover:text-text-primary text-[12px] ${
            location.pathname === '/settings' ? 'text-text-accent font-bold' : ''
          }`}
        >
          ⚙ Settings
        </Link>
      </div>
    </div>
  );
}
