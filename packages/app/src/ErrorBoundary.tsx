import { Component, type ErrorInfo, type ReactNode } from 'react';
import { downloadProjectFile } from './fileio.js';
import { prepareAutosaveDownload } from './lib/errorRecovery.js';

interface Props {
  children: ReactNode;
}

type DownloadState = 'idle' | 'loading' | 'success' | 'no-snapshot' | 'error';

interface State {
  hasError: boolean;
  error: Error | null;
  downloadState: DownloadState;
}

/**
 * Top-level boundary catching render-phase exceptions anywhere in the app.
 * Renders a recovery panel offering (1) reload the page and (2) download
 * the last autosave snapshot so a render bug doesn't strand the user with
 * unsaved work.
 *
 * Closes audit finding C-13 (AUDIT_2026-05-25.md).
 *
 * Out of scope:
 * - Per-panel error boundaries — a stray inspector throw still collapses
 *   to this top-level fallback. Acceptable for v1; finer-grained recovery
 *   is a v1.1 follow-up.
 * - Remote error reporting (no analytics endpoint exists by design —
 *   Caladia is local-first).
 * - React 19's functional ErrorBoundary API (not yet stable in the
 *   React 18 baseline this app targets).
 */
export class ErrorBoundary extends Component<Props, State> {
  override state: State = {
    hasError: false,
    error: null,
    downloadState: 'idle',
  };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { hasError: true, error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // Surface to DevTools so the stack is reachable even though the user
    // sees only the recovery panel. No remote reporting — local-first.
    console.error('Caladia top-level error:', error, info);
  }

  private handleReload = (): void => {
    window.location.reload();
  };

  private handleDownload = async (): Promise<void> => {
    this.setState({ downloadState: 'loading' });
    const result = await prepareAutosaveDownload();
    if (result.kind === 'ready') {
      downloadProjectFile(result.project);
      this.setState({ downloadState: 'success' });
    } else if (result.kind === 'no-snapshot') {
      this.setState({ downloadState: 'no-snapshot' });
    } else {
      this.setState({ downloadState: 'error' });
    }
  };

  override render(): ReactNode {
    if (!this.state.hasError) return this.props.children;

    const { error, downloadState } = this.state;

    return (
      <div
        role="alert"
        className="min-h-screen flex items-center justify-center p-6 bg-gray-50 dark:bg-gray-950 text-gray-900 dark:text-gray-100"
      >
        <div className="max-w-xl w-full rounded-xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 shadow-lg p-6">
          <h1 className="text-lg font-semibold mb-1">Caladia hit an unexpected error.</h1>
          <p className="text-sm text-gray-600 dark:text-gray-400 mb-5">
            The page can&apos;t continue. Reload to start fresh, or download the last autosaved
            snapshot so nothing is lost.
          </p>

          <div className="flex flex-wrap gap-2 mb-4">
            <button
              type="button"
              onClick={this.handleReload}
              className="inline-flex items-center gap-1.5 rounded-md bg-emerald-600 hover:bg-emerald-700 text-white text-sm font-medium px-3.5 py-2 transition-colors"
            >
              Reload Caladia
            </button>
            <button
              type="button"
              onClick={() => {
                void this.handleDownload();
              }}
              disabled={downloadState === 'loading'}
              className="inline-flex items-center gap-1.5 rounded-md border border-gray-300 dark:border-gray-700 hover:bg-gray-100 dark:hover:bg-gray-800 text-gray-900 dark:text-gray-100 text-sm font-medium px-3.5 py-2 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {downloadState === 'loading' ? 'Preparing…' : 'Download autosave snapshot (.cala)'}
            </button>
          </div>

          {downloadState === 'success' && (
            <p className="text-sm text-emerald-700 dark:text-emerald-400 mb-4">
              Saved. Reload when you&apos;re ready.
            </p>
          )}
          {downloadState === 'no-snapshot' && (
            <p className="text-sm text-gray-600 dark:text-gray-400 mb-4">
              No autosave found. Reload to start fresh — if you had unsaved work, it&apos;s lost.
            </p>
          )}
          {downloadState === 'error' && (
            <p className="text-sm text-rose-700 dark:text-rose-400 mb-4">
              Couldn&apos;t read the autosave. Try reloading — the snapshot may still be intact.
            </p>
          )}

          {error && (
            <details className="text-xs">
              <summary className="cursor-pointer text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-100 select-none">
                Error details
              </summary>
              <pre className="mt-2 p-3 rounded bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-300 overflow-x-auto whitespace-pre-wrap break-words">
                {error.name}: {error.message}
                {error.stack ? `\n\n${error.stack}` : ''}
              </pre>
            </details>
          )}
        </div>
      </div>
    );
  }
}
