import React, { Component, ErrorInfo, ReactNode } from 'react';
import { Analytics, decodeReactError } from '../../services/analytics';
import { AlertTriangle, RefreshCw } from 'lucide-react';
import { t } from '../../services/i18n';

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
  errorDigest: string;
  errorHint: string;
}

export class ErrorBoundary extends Component<Props, State> {
  /** Prevents duplicate error_page_view events on re-renders */
  private errorPageTracked = false;

  public state: State = {
    hasError: false,
    errorDigest: '',
    errorHint: '',
  };

  /** Simple hash for error fingerprinting (correlation across events). */
  private static fingerprint(error: Error): string {
    const raw = `${error.name}:${error.message}`.slice(0, 120);
    let h = 0;
    for (let i = 0; i < raw.length; i++) {
      h = ((h << 5) - h + raw.charCodeAt(i)) | 0;
    }
    return (h >>> 0).toString(36);
  }

  public static getDerivedStateFromError(error: Error): State {
    const msg = error?.message || '';
    // Decode React minified errors for human-readable hints
    const decoded = decodeReactError(msg);
    const isDecoded = decoded !== msg;
    const hint = msg.includes('dynamically imported module') || msg.includes('Loading chunk') || error?.name === 'ChunkLoadError'
      ? 'chunk'
      : msg.includes('fetch') || msg.includes('Network')
        ? 'network'
        : isDecoded
          ? decoded.slice(0, 90)
          : `${(error?.name || 'Error').slice(0, 30)}:${msg.slice(0, 60)}`;
    return { hasError: true, errorDigest: ErrorBoundary.fingerprint(error), errorHint: hint };
  }

  public componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error('Uncaught error:', error, errorInfo);

    // Extract the first React component name from componentStack
    // Format: "\n    at ComponentName (url)" or "\n    at ComponentName"
    let crashedComponent = 'Unknown';
    if (errorInfo.componentStack) {
      const match = errorInfo.componentStack.match(/^\s*at\s+([A-Z][A-Za-z0-9_$]*)/m);
      if (match) crashedComponent = match[1];
    }

    // Chunk errors are handled by lazyRetry (clear caches + retry import).
    // If we reach ErrorBoundary, lazyRetry already exhausted its retry.
    // Do NOT auto-reload — it creates a double-retry loop.
    // Just show the error UI with a manual refresh button.
    const msg = error?.message || '';
    const isChunkError =
      msg.includes('dynamically imported module') ||
      msg.includes('Loading chunk') ||
      msg.includes('Loading CSS chunk') ||
      error?.name === 'ChunkLoadError';

    if (isChunkError) {
      Analytics.trackAppError('chunk_load', {
        message: `[ErrorBoundary:${crashedComponent}] ${error.name}: ${msg.slice(0, 120)}`,
        stack: error.stack?.slice(0, 500) || '',
        pagePath: window.location.pathname + window.location.search,
        fatal: true,
      });
      // Fall through to show error UI — user can manually refresh
    }

    const fp = ErrorBoundary.fingerprint(error);

    // Rich error tracking to Firebase Analytics
    Analytics.trackAppError('error_boundary', {
      message: `[ErrorBoundary:${crashedComponent}] ${error.name}: ${error.message}`,
      stack: error.stack?.slice(0, 500) || '',
      componentStack: errorInfo.componentStack?.slice(0, 300) || '',
      pagePath: window.location.pathname + window.location.search,
      pageTitle: document.title,
      fatal: true,
      errorFingerprint: fp,
    });
  }

  public render() {
    if (this.state.hasError) {
      // Track the error page being SHOWN to the user (health metric).
      // Fires once per ErrorBoundary instance to avoid duplicates on re-renders.
      if (!this.errorPageTracked) {
        this.errorPageTracked = true;
        Analytics.trackErrorPageView(this.state.errorDigest);
      }
      return (
        <div className="min-h-[50vh] flex flex-col items-center justify-center p-4 sm:p-6 text-center">
          <div className="bg-red-50 dark:bg-red-900/20 p-4 rounded-full mb-4">
             <AlertTriangle size={48} className="text-red-500" />
          </div>
          <h2 className="text-2xl font-bold text-slate-800 dark:text-slate-100 mb-2">{t('error.title')}</h2>
          <p className="text-muted max-w-md mb-6">
            {t('error.message')}
          </p>
          {this.state.errorDigest && (
            <p className="text-sm text-muted mb-4 font-mono">
              REF: {this.state.errorDigest}{this.state.errorHint && this.state.errorHint !== 'chunk' && this.state.errorHint !== 'network' ? ` — ${this.state.errorHint}` : ''}
            </p>
          )}
          <button
            onClick={() => {
              Analytics.trackForceReload({
                source: 'user_click',
                reason: 'error_page_manual_reload',
                pagePath: window.location.pathname + window.location.search,
                blocked: false,
              });
              window.location.reload();
            }}
            className="flex items-center gap-2 px-6 py-3 bg-indigo-600 hover:bg-indigo-700 text-white rounded-xl font-bold transition-colors"
          >
            <RefreshCw size={18} /> {t('error.reload')}
          </button>
        </div>
      );
    }

    return (this as React.Component<Props, State>).props.children;
  }
}