import { createContext, useContext, useState, type ReactNode } from 'react';

interface ToastContextType {
  showToast: (message: string) => void;
}

const ToastContext = createContext<ToastContextType | undefined>(undefined);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [message, setMessage] = useState<string | null>(null);

  const showToast = (msg: string) => {
    setMessage(msg);
    // Auto-dismiss after 3000ms (3 seconds)
    setTimeout(() => {
      setMessage(prev => (prev === msg ? null : prev));
    }, 3000);
  };

  return (
    <ToastContext.Provider value={{ showToast }}>
      {children}
      {message && (
        <div className="fixed top-0 left-0 right-0 bg-bg-surface border-b border-border-default h-[48px] flex items-center justify-between px-6 z-50 font-mono text-[13px] text-text-accent">
          <div className="flex items-center gap-2">
            <span>ℹ</span>
            <span>{message}</span>
          </div>
          <button
            onClick={() => setMessage(null)}
            className="text-text-muted hover:text-text-primary cursor-pointer select-none"
          >
            ✕
          </button>
        </div>
      )}
    </ToastContext.Provider>
  );
}

export function useToast() {
  const context = useContext(ToastContext);
  if (!context) {
    throw new Error('useToast must be used within a ToastProvider');
  }
  return context;
}
