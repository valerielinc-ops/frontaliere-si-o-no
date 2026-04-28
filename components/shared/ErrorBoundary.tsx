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
 errorName: string;
 errorMessage: string;
 // Snapshot captured at the exact frame the error fired, BEFORE any
 // subsequent history.replaceState() / location.replace() can rewrite the
 // address bar (legacy redirect bridges, canonical normalisation). Without
 // this, a Clarity replay shows the stale rewritten URL instead of where
 // the error actually happened.
 snapshotUrl: string;
 snapshotReferrer: string;
 snapshotSessionRedirect: string;
}

export class ErrorBoundary extends Component<Props, State> {
 /** Prevents duplicate error_page_view events on re-renders */
 private errorPageTracked = false;

 public state: State = {
 hasError: false,
 errorDigest: '',
 errorHint: '',
 errorName: '',
 errorMessage: '',
 snapshotUrl: '',
 snapshotReferrer: '',
 snapshotSessionRedirect: '',
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

 private static snapshotEnv() {
 if (typeof window === 'undefined') {
 return { url: '(ssr)', referrer: '(ssr)', sessionRedirect: '(ssr)' };
 }
 let sessionRedirect = '(none)';
 try {
 sessionRedirect = sessionStorage.getItem('redirect') || '(consumed)';
 } catch { /* private mode / disabled storage */ }
 return {
 url: window.location.href,
 referrer: document.referrer || '(direct)',
 sessionRedirect,
 };
 }

 public static getDerivedStateFromError(error: Error): State {
 const msg = error?.message || '';
 // Decode React minified errors for human-readable hints
 const decoded = decodeReactError(msg);
 const isDecoded = decoded !== msg;
 const hint = msg.includes('dynamically imported module') || msg.includes('Importing a module script') || msg.includes('Loading chunk') || error?.name === 'ChunkLoadError'
 ? 'chunk'
 : msg.includes('fetch') || msg.includes('Network')
 ? 'network'
 : isDecoded
 ? decoded.slice(0, 90)
 : `${(error?.name || 'Error').slice(0, 30)}:${msg.slice(0, 60)}`;
 const env = ErrorBoundary.snapshotEnv();
 return {
 hasError: true,
 errorDigest: ErrorBoundary.fingerprint(error),
 errorHint: hint,
 errorName: (error?.name || 'Error').slice(0, 50),
 errorMessage: (isDecoded ? decoded : msg).slice(0, 300),
 snapshotUrl: env.url,
 snapshotReferrer: env.referrer,
 snapshotSessionRedirect: env.sessionRedirect,
 };
 }

 public componentDidCatch(error: Error, errorInfo: ErrorInfo) {
 console.error('Uncaught error:', error, errorInfo);

 // Extract the first React component name from componentStack
 // Format:"\n at ComponentName (url)" or"\n at ComponentName"
 let crashedComponent = 'Unknown';
 if (errorInfo.componentStack) {
 const match = errorInfo.componentStack.match(/^\s*at\s+([A-Z][A-Za-z0-9_$]*)/m);
 if (match) crashedComponent = match[1];
 }

 // Chunk errors: lazyRetry clears caches, retries twice, then auto-reloads
 // the page (once per session via sessionStorage guard). If we reach
 // ErrorBoundary, the auto-reload already happened or was blocked by the
 // guard. Show error UI with a manual refresh button.
 const msg = error?.message || '';
 const isChunkError =
 msg.includes('dynamically imported module') ||
 msg.includes('Importing a module script') ||
 msg.includes('Loading chunk') ||
 msg.includes('Loading CSS chunk') ||
 error?.name === 'ChunkLoadError';

 // Use the snapshot from getDerivedStateFromError — by now any post-mount
 // history.replaceState may have already rewritten location.
 const snapUrl = this.state.snapshotUrl || (typeof window !== 'undefined' ? window.location.href : '');
 const snapReferrer = this.state.snapshotReferrer || (typeof document !== 'undefined' ? (document.referrer || '(direct)') : '');
 const snapSessionRedirect = this.state.snapshotSessionRedirect || '(unknown)';

 if (isChunkError) {
 Analytics.trackAppError('chunk_load', {
 message: `[ErrorBoundary:${crashedComponent}] ${error.name}: ${msg.slice(0, 120)}`,
 stack: error.stack?.slice(0, 500) || '',
 pagePath: snapUrl,
 fatal: true,
 referrer: snapReferrer,
 sessionRedirect: snapSessionRedirect,
 });
 // Fall through to show error UI — user can manually refresh
 }

 const fp = ErrorBoundary.fingerprint(error);

 // Rich error tracking to Firebase Analytics
 Analytics.trackAppError('error_boundary', {
 message: `[ErrorBoundary:${crashedComponent}] ${error.name}: ${error.message}`,
 stack: error.stack?.slice(0, 500) || '',
 componentStack: errorInfo.componentStack?.slice(0, 300) || '',
 pagePath: snapUrl,
 pageTitle: document.title,
 fatal: true,
 errorFingerprint: fp,
 referrer: snapReferrer,
 sessionRedirect: snapSessionRedirect,
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
 <div className="bg-danger-subtle p-4 rounded-full mb-4">
 <AlertTriangle size={48} className="text-danger" />
 </div>
 <h2 className="text-2xl font-bold font-display text-strong mb-2">{t('error.title')}</h2>
 <p className="text-muted max-w-md mb-6">
 {t('error.message')}
 </p>
 {this.state.errorDigest && (
 <p className="text-sm text-muted mb-4 font-mono">
 REF: {this.state.errorDigest}{this.state.errorHint && this.state.errorHint !== 'chunk' && this.state.errorHint !== 'network' ? ` — ${this.state.errorHint}` : ''}
 </p>
 )}
 <div
 data-testid="error-boundary-details"
 className="w-full max-w-xl text-left bg-surface-alt border border-edge rounded-lg px-3 py-2 mb-6 space-y-1.5"
 >
 <div>
 <p className="text-[10px] uppercase tracking-wider text-muted font-semibold mb-1">
 Errore
 </p>
 <code className="block text-xs text-body font-mono break-all select-all">
 {this.state.errorName}{this.state.errorMessage ? `: ${this.state.errorMessage}` : ''}
 </code>
 </div>
 <div>
 <p className="text-[10px] uppercase tracking-wider text-muted font-semibold mb-1">
 URL al crash
 </p>
 <code className="block text-xs text-body font-mono break-all select-all">
 {this.state.snapshotUrl || (typeof window !== 'undefined' ? window.location.href : '')}
 </code>
 </div>
 <div>
 <p className="text-[10px] uppercase tracking-wider text-muted font-semibold mb-1">
 Provenienza (referrer)
 </p>
 <code className="block text-xs text-body font-mono break-all select-all">
 {this.state.snapshotReferrer || '(direct)'}
 </code>
 </div>
 <div>
 <p className="text-[10px] uppercase tracking-wider text-muted font-semibold mb-1">
 Bridge sessionStorage
 </p>
 <code className="block text-xs text-body font-mono break-all select-all">
 {this.state.snapshotSessionRedirect || '(unknown)'}
 </code>
 </div>
 </div>
 <button
 onClick={() => {
 Analytics.trackForceReload({
 source: 'user_click',
 reason: 'error_page_manual_reload',
 pagePath: this.state.snapshotUrl || window.location.pathname + window.location.search,
 blocked: false,
 });
 window.location.reload();
 }}
 className="flex items-center gap-2 px-6 py-3 bg-accent hover:bg-accent-hover text-on-accent rounded-xl font-bold transition-colors"
 >
 <RefreshCw size={18} /> {t('error.reload')}
 </button>
 </div>
 );
 }

 return (this as React.Component<Props, State>).props.children;
 }
}
