import React from 'react';
import { BrowserRouter, Routes, Route, Link, useLocation } from 'react-router-dom';
import Sidebar from './components/Sidebar';
import Dashboard from './views/Dashboard';
import AddRepo from './views/AddRepo';
import RepoDetail from './views/RepoDetail';
import LogViewer from './views/LogViewer';
import Settings from './views/Settings';
import { ToastProvider } from './context/ToastContext';
import './App.css';

function AppShell() {
  const location = useLocation();

  const getBreadcrumbs = () => {
    const paths = location.pathname.split('/').filter(Boolean);
    if (paths.length === 0) return <span>Repositories</span>;

    const breadcrumbs: React.ReactNode[] = [
      <Link key="root" to="/" className="hover:text-text-accent">Repositories</Link>
    ];

    if (paths[0] === 'repos') {
      if (paths[1] === 'new') {
        breadcrumbs.push(<span key="separator-new" className="select-none"> / </span>);
        breadcrumbs.push(<span key="new" className="text-text-primary">Add Repository</span>);
      } else if (paths[1]) {
        breadcrumbs.push(<span key={`separator-${paths[1]}`} className="select-none"> / </span>);

        if (paths[2] === 'runs' && paths[3]) {
          const displayRunSha = paths[3].includes('manual') 
            ? paths[3].split('-')[0]
            : paths[3].substring(0, 7);

          breadcrumbs.push(
            <Link key={paths[1]} to={`/repos/${paths[1]}`} className="hover:text-text-accent">
              {paths[1].substring(0, 8)}...
            </Link>
          );
          breadcrumbs.push(<span key="separator-runs" className="select-none"> / </span>);
          breadcrumbs.push(<span key="run" className="text-text-muted">runs</span>);
          breadcrumbs.push(<span key="separator-runId" className="select-none"> / </span>);
          breadcrumbs.push(<span key="runId" className="text-text-primary">#{displayRunSha}</span>);
        } else {
          breadcrumbs.push(<span key={paths[1]} className="text-text-primary">{paths[1].substring(0, 8)}...</span>);
        }
      }
    } else if (paths[0] === 'settings') {
      return <span className="text-text-primary">Settings</span>;
    }

    return breadcrumbs;
  };

  return (
    <div className="flex h-screen w-screen overflow-hidden text-text-primary font-mono text-[13px] bg-bg-base">
      {/* LEFT PANEL: COLLAPSIBLE SIDEBAR TREE */}
      <Sidebar />

      {/* RIGHT PANEL: MAIN WORKSPACE */}
      <div className="flex-1 flex flex-col h-full overflow-hidden">
        {/* TOP BAR */}
        <div className="h-[48px] flex-shrink-0 border-b border-border-default px-6 flex items-center justify-between bg-bg-surface select-none">
          <div className="flex items-center gap-2 text-text-muted font-bold">
            {getBreadcrumbs()}
          </div>
          <div />
        </div>

        {/* WORKSPACE CONTENT */}
        <div className="flex-1 overflow-y-auto p-6 bg-bg-base">
          <Routes>
            <Route path="/" element={<Dashboard />} />
            <Route path="/repos/new" element={<AddRepo />} />
            <Route path="/repos/:id" element={<RepoDetail />} />
            <Route path="/repos/:id/runs/:runId" element={<LogViewer />} />
            <Route path="/settings" element={<Settings />} />
          </Routes>
        </div>
      </div>
    </div>
  );
}

export default function App() {
  return (
    <ToastProvider>
      <BrowserRouter>
        <Routes>
          <Route path="*" element={<AppShell />} />
        </Routes>
      </BrowserRouter>
    </ToastProvider>
  );
}
