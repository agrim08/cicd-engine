import { useState, useEffect } from 'react';
import { useParams } from 'react-router-dom';
import { io } from 'socket.io-client';
import { getRepo, type RepoDetail as RepoType } from '../services/repoService';
import { getRunJobs, getJobLogs, type Job, type LogLine } from '../services/jobService';

const getSymbol = (s: string): string => {
  switch (s) {
    case 'running': return '●';
    case 'success': return '●';
    case 'failed': return '✕';
    case 'queued':
    case 'pending':
      return '○';
    default:
      return '●';
  }
};

const getColorClass = (s: string): string => {
  switch (s) {
    case 'running': return 'text-status-running';
    case 'success': return 'text-status-success';
    case 'failed': return 'text-status-failed';
    case 'queued':
    case 'pending':
      return 'text-status-queued';
    default:
      return 'text-text-muted';
  }
};

export default function LogViewer() {
  const { id, runId } = useParams<{ id: string; runId: string }>();

  const [repo, setRepo] = useState<RepoType | null>(null);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [activeJob, setActiveJob] = useState<Job | null>(null);

  const [stepLogs, setStepLogs] = useState<Record<string, LogLine[]>>({});

  const [loading, setLoading] = useState(true);
  const [collapsedSteps, setCollapsedSteps] = useState<Record<string, boolean>>({});

  // 1. Fetch Repository and Jobs
  useEffect(() => {
    async function loadJobData() {
      if (!id || !runId) return;
      try {
        const repoData = await getRepo(id);
        setRepo(repoData);

        const jobsData = await getRunJobs(runId);
        setJobs(jobsData);
        if (jobsData.length > 0) {
          // Select the first job by default
          setActiveJob(jobsData[0]);
        }
      } catch (err) {
        console.error('Failed to load jobs list:', err);
      } finally {
        setLoading(false);
      }
    }
    loadJobData();
  }, [id, runId]);

  // 2. Fetch log history and setup Socket.IO stream when activeJob changes
  useEffect(() => {
    if (!activeJob) return;

    async function loadLogHistory() {
      try {
        const data = await getJobLogs(activeJob!.id, true);
        setStepLogs(data.stepLogs || {});
      } catch (err) {
        console.error('Failed to fetch historical logs:', err);
      }
    }
    loadLogHistory();

    // Establish WebSocket Connection
    const baseUrl = import.meta.env.VITE_API_BASE_URL || 'http://localhost:8080';
    const socket = io(baseUrl);

    socket.on('connect', () => {
      console.log(`🔌 WebSocket connected. Subscribing to job: ${activeJob!.id}`);
      socket.emit('subscribe:logs', activeJob!.id);
    });

    socket.on('logs:line', (line: LogLine) => {
      if (line.stepId) {
        setStepLogs(prev => {
          const arr = prev[line.stepId!] ? [...prev[line.stepId!]] : [];
          if (arr.some(l => l.lineNo === line.lineNo)) return prev;
          return {
            ...prev,
            [line.stepId!]: [...arr, line],
          };
        });
      }
    });

    return () => {
      console.log(`🔌 Unsubscribing from job: ${activeJob!.id}`);
      socket.emit('unsubscribe:logs', activeJob!.id);
      socket.disconnect();
    };
  }, [activeJob?.id]);

  // 3. Initialize step accordion expand/collapse states
  useEffect(() => {
    if (!activeJob) return;
    const initial: Record<string, boolean> = {};
    activeJob.steps.forEach(step => {
      // Expand running/failed steps, collapse success/pending steps by default
      initial[step.id] = !(step.status === 'running' || step.status === 'failed');
    });
    setCollapsedSteps(initial);
  }, [activeJob?.id]);

  const toggleStep = (stepId: string) => {
    setCollapsedSteps(prev => ({
      ...prev,
      [stepId]: !prev[stepId],
    }));
  };

  if (loading) {
    return <div className="p-4 text-text-muted italic select-none">Loading run execution logs...</div>;
  }

  if (!repo || jobs.length === 0) {
    return <div className="p-4 text-status-failed select-none">No jobs found for this run.</div>;
  }

  return (
    <div className="flex flex-col gap-4 h-full overflow-hidden">
      {/* Run Summary Top Bar */}
      <div className="border border-border-default bg-bg-surface p-3 flex justify-between items-center select-none flex-shrink-0">
        <div className="flex gap-6 items-center">
          <div className="flex items-center gap-1.5 font-bold">
            <span className="text-text-muted select-none">Run Jobs:</span>
            <span>{jobs.length} total</span>
          </div>
          {activeJob && (
            <>
              <div>
                <span className="text-text-muted select-none">Active Job: </span>
                <span className="font-bold">{activeJob.name}</span>
              </div>
              <div>
                <span className="text-text-muted select-none">Runner ID: </span>
                <span className="font-bold text-text-accent">
                  {activeJob.runner_id ? activeJob.runner_id.substring(0, 8) : 'unassigned'}
                </span>
              </div>
            </>
          )}
        </div>
        <div className="text-text-muted text-[11px] select-none">
          Run ID: {runId}
        </div>
      </div>

      <div className="flex-1 flex gap-4 overflow-hidden">
        {/* Left Side: Jobs tab list */}
        <div className="w-[180px] flex-shrink-0 border border-border-default bg-bg-surface flex flex-col overflow-y-auto">
          <div className="p-2 border-b border-border-default text-[10px] text-text-muted font-bold select-none uppercase tracking-wider bg-bg-base">
            Execution Matrix
          </div>
          <div className="flex flex-col">
            {jobs.map(job => {
              const isActive = activeJob?.id === job.id;
              const matrixLabel = job.matrix_value 
                ? ` (${Object.values(job.matrix_value).join(', ')})`
                : '';
              return (
                <div
                  key={job.id}
                  onClick={() => setActiveJob(job)}
                  className={`px-3 py-2 cursor-pointer border-l-2 flex items-center justify-between truncate select-none ${
                    isActive 
                      ? 'border-text-accent bg-bg-hover text-text-primary'
                      : 'border-transparent text-text-muted hover:bg-bg-hover hover:text-text-primary'
                  }`}
                >
                  <span className="truncate text-[12px]">
                    {job.name.split(' ')[0]}{matrixLabel}
                  </span>
                  <span className={getColorClass(job.status)}>
                    {getSymbol(job.status)}
                  </span>
                </div>
              );
            })}
          </div>
        </div>

        {/* Right Side: Accordion Logs Viewer */}
        <div className="flex-1 flex flex-col gap-2 overflow-y-auto pr-1">
          {activeJob?.steps.map((step) => {
            const logs = stepLogs[step.id] || [];
            const isCollapsed = !!collapsedSteps[step.id];

            return (
              <div key={step.id} className="border border-border-default bg-bg-surface flex-shrink-0">
                {/* Accordion Trigger Header */}
                <div
                  onClick={() => toggleStep(step.id)}
                  className="flex justify-between items-center p-2 bg-bg-surface hover:bg-bg-hover select-none cursor-pointer border-b border-border-default/50"
                >
                  <div className="flex items-center gap-2">
                    <span className="text-text-muted text-[10px]">
                      {isCollapsed ? '▸' : '▼'}
                    </span>
                    <span className="font-bold text-[12px]">{step.name}</span>
                  </div>
                  <div className="flex items-center gap-3">
                    <span className="text-text-muted text-[11px]">
                      {step.duration_ms ? `${(step.duration_ms / 1000).toFixed(1)}s` : '-'}
                    </span>
                    <span className={getColorClass(step.status)}>
                      {getSymbol(step.status)}
                    </span>
                  </div>
                </div>

                {/* Log Line Output Terminal Block */}
                {!isCollapsed && (
                  <div className="bg-bg-base p-3 overflow-x-auto text-[12px] leading-relaxed border-t border-border-default/50 font-mono flex flex-col max-h-[300px] overflow-y-auto">
                    {logs.length === 0 ? (
                      <div className="text-text-muted italic select-none pl-12 py-1">
                        {step.status === 'pending' ? 'Step is pending execution...' : 'No logs recorded for this step.'}
                      </div>
                    ) : (
                      logs.map((log) => {
                        const isError = log.content.includes('error') || 
                                        log.content.includes('❌') || 
                                        log.content.includes('ExitCode: 1') || 
                                        log.content.includes('failed');
                        return (
                          <div key={log.lineNo} className="flex gap-4 hover:bg-bg-hover py-0.5">
                            <span className="text-text-muted select-none w-8 text-right flex-shrink-0">
                              {log.lineNo}
                            </span>
                            <pre className={`whitespace-pre-wrap ${isError ? 'text-status-failed' : 'text-text-primary'}`}>
                              {log.content}
                            </pre>
                          </div>
                        );
                      })
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
