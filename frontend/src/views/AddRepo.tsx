import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { registerRepo } from '../services/repoService';
import { useToast } from '../context/ToastContext';

export default function AddRepo() {
  const navigate = useNavigate();
  const { showToast } = useToast();

  const [url, setUrl] = useState('');
  const [token, setToken] = useState('');
  const [branch, setBranch] = useState('main');

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!url.trim()) {
      setError('Repository URL is required');
      return;
    }

    setLoading(true);
    setError(null);
    setSuccess(false);

    try {
      await registerRepo({
        github_repo_url: url.trim(),
        github_token: token.trim() || undefined,
      });
      setSuccess(true);
      showToast('Repository registered successfully');
      setTimeout(() => {
        navigate('/');
      }, 1000);
    } catch (err: any) {
      setError(err.message || 'Verification failed');
      showToast('Failed to link repository');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex flex-col gap-6 max-w-lg">
      <div>
        <h1 className="text-[16px] font-bold text-text-primary border-b border-border-default pb-2 select-none mb-1">
          ADD REPOSITORY
        </h1>
        <p className="text-text-muted select-none">
          Register a GitHub repository for CI/CD tracking.
        </p>
      </div>

      <form onSubmit={handleSubmit} className="border border-border-default bg-bg-surface p-6 flex flex-col gap-4">
        <div className="flex flex-col gap-1.5">
          <label className="text-text-muted select-none text-[11px] font-bold uppercase">
            GitHub Repository URL
          </label>
          <input
            type="text"
            required
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://github.com/owner/repo"
            className="w-full bg-bg-base border border-border-default px-3 py-2 text-text-primary focus:outline-none focus:ring-1 focus:ring-text-accent"
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <label className="text-text-muted select-none text-[11px] font-bold uppercase">
            Personal Access Token (optional)
          </label>
          <input
            type="password"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder="ghp_****************"
            className="w-full bg-bg-base border border-border-default px-3 py-2 text-text-primary focus:outline-none focus:ring-1 focus:ring-text-accent"
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <label className="text-text-muted select-none text-[11px] font-bold uppercase">
            Default Branch
          </label>
          <input
            type="text"
            required
            value={branch}
            onChange={(e) => setBranch(e.target.value)}
            placeholder="main"
            className="w-full bg-bg-base border border-border-default px-3 py-2 text-text-primary focus:outline-none focus:ring-1 focus:ring-text-accent"
          />
        </div>

        <div className="text-text-muted text-[11px] border border-border-default p-3 bg-bg-base select-none leading-relaxed">
          Your token is encrypted before storage and never exposed in plaintext.
        </div>

        <div className="flex gap-3 justify-end pt-2">
          <button
            type="button"
            onClick={() => navigate('/')}
            className="px-3 py-1.5 border border-border-default text-text-muted hover:bg-bg-hover cursor-pointer"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={loading}
            className="px-3 py-1.5 border border-border-default bg-bg-base text-text-accent hover:bg-bg-hover cursor-pointer font-bold disabled:opacity-50 disabled:cursor-not-allowed select-none"
          >
            Link Repository
          </button>
        </div>

        {/* Inline Submission Status */}
        {(loading || success || error) && (
          <div className="mt-2 text-[12px] border-t border-border-default/50 pt-3">
            {loading && (
              <span className="text-text-muted animate-ellipsis select-none">
                Verifying repository
              </span>
            )}
            {success && (
              <span className="text-status-success font-bold select-none">
                Repository linked. Redirecting...
              </span>
            )}
            {error && (
              <span className="text-status-failed font-bold">
                ✕ {error}
              </span>
            )}
          </div>
        )}
      </form>
    </div>
  );
}
