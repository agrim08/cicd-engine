

export default function Settings() {
  return (
    <div className="flex flex-col gap-6 max-w-lg">
      <div>
        <h1 className="text-[16px] font-bold text-text-primary border-b border-border-default pb-2 select-none mb-1">
          SETTINGS
        </h1>
        <p className="text-text-muted select-none">
          Global parameters for runner instances and webhook secrets.
        </p>
      </div>

      <div className="border border-border-default bg-bg-surface p-4 flex flex-col gap-2">
        <div className="text-text-muted uppercase text-[11px] font-bold border-b border-border-default pb-1 select-none">
          Runner Credentials
        </div>
        <div className="flex justify-between items-center py-2 border-b border-border-default/50">
          <span className="font-bold">Runner Shared JWT Secret</span>
          <code className="bg-bg-base px-2 py-0.5 border border-border-default text-text-muted select-all font-mono">
            default_jwt_secret_for_testing
          </code>
        </div>
        <div className="flex justify-between items-center py-2">
          <span className="font-bold">Runner Check-in Interval</span>
          <span className="text-text-muted select-none">30s</span>
        </div>
      </div>
    </div>
  );
}
