export type StatusType = 'running' | 'success' | 'failed' | 'queued' | 'pending' | 'cancelled' | 'timeout';

interface StatusBadgeProps {
  status: StatusType;
  failedStepName?: string | null;
}

export default function StatusBadge({ status, failedStepName }: StatusBadgeProps) {
  const getSymbol = (s: StatusType): string => {
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

  const getColorClass = (s: StatusType): string => {
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

  return (
    <span className={`inline-flex items-center gap-1.5 font-bold ${getColorClass(status)}`}>
      <span className="text-[14px] leading-none">{getSymbol(status)}</span>
      <span className="uppercase text-[11px] tracking-wide select-none">
        {status}
        {status === 'failed' && failedStepName && (
          <span className="text-text-muted font-normal normal-case pl-1">
            — {failedStepName}
          </span>
        )}
      </span>
    </span>
  );
}
