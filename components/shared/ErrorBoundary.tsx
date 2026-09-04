import React, { Component, ErrorInfo, ReactNode } from 'react';
import { Analytics, decodeReactError } from '../../services/analytics';
import { isOriginRedactedThirdPartyStack } from '../../services/benignErrorPatterns';
import { AlertTriangle, RefreshCw, Copy, Check } from 'lucide-react';
import { t } from '../../services/i18n';
import {
  isVersionSkewError,
  recoverFromStaleChunk,
  bustAssetHttpCache,
  isChunkLoadError,
  isModuleParseError,
} from '../../services/resilientImport';
import { fetchBuildId, fetchCommitHash } from '../../services/buildInfo';
import { AD_SLOTS } from '../../services/adsenseSlots';
import { useRailGridCollapse, RAIL_GRID_CLASS_X, RAIL_ASIDE_CLASS_X } from './useRailGridCollapse';

// Lazy: this file sits in the critical entry chunk (top-level ErrorBoundary
// wraps the whole app), so pulling GPT/AdSense code in eagerly would bloat
// every page load — even the near-totality of loads that never error. Each
// is wrapped in SilentErrorBoundary + Suspense below: if one of these chunks
// itself fails to load (a second stale-deploy hit on top of the one that
// brought the user here), the ad slot silently disappears instead of
// re-throwing — nothing exists above this top-level boundary to catch that.
const DesktopTopBanner = React.lazy(() => import('./DesktopTopBanner'));
const ArticleRailAd = React.lazy(() => import('./ArticleRailAd'));
const AdSenseBanner = React.lazy(() => import('./AdSenseBanner'));

interface Props {
 children: ReactNode;
}

interface State {
 hasError: boolean;
 errorDigest: string;
 errorHint: string;
 errorName: string;
 errorMessage: string;
 // Full stack — errorMessage above is capped to 300 chars for the one-line
 // code block; this backs the "mostra stack trace" disclosure and the
 // copy-debug-info bundle below.
 errorStack: string;
 // Snapshot captured at the exact frame the error fired, BEFORE any
 // subsequent history.replaceState() / location.replace() can rewrite the
 // address bar (legacy redirect bridges, canonical normalisation). Without
 // this, a Clarity replay shows the stale rewritten URL instead of where
 // the error actually happened.
 snapshotUrl: string;
 snapshotReferrer: string;
 snapshotSessionRedirect: string;
 // Captured alongside the URL/referrer snapshot for the same reason: a
 // consistent point-in-time picture of what the user's browser saw.
 crashTimestamp: string;
 // Fetched async post-catch (services/buildInfo.ts) — empty until resolved.
 // Lets a bug report identify WHICH deploy without the reporter needing
 // devtools; useful for the cross-chunk version-skew class this page most
 // commonly renders for.
 buildId: string;
 commitHash: string;
 copyState: 'idle' | 'copied' | 'error';
}

/**
 * Wraps the crash card in the same collapsing 2-tier rail grid as
 * JobBoard/JobOrphanView/JobExpiredView/BlogArticles (issue 4830) — a small
 * function component because `useRailGridCollapse` (a hook) can't be called
 * inside `ErrorBoundary`'s class `render()`. Single `ArticleRailAd` panel per
 * side (not the Stack): the crash card is short/non-scrolling, so no sticky/
 * ResizeObserver machinery is needed — `ArticleRailAd`'s own `onEmptyChange`
 * plugs directly into the shared hook's per-side handlers.
 */
const ErrorPageRailGrid: React.FC<{ children: ReactNode }> = ({ children }) => {
 const { onLeftEmptyResolved, onRightEmptyResolved, style: railStyle } = useRailGridCollapse();
 return (
 <div className={RAIL_GRID_CLASS_X} style={railStyle}>
 <aside className={RAIL_ASIDE_CLASS_X}>
 <SilentErrorBoundary boundary="error-page-rail-left">
 <React.Suspense fallback={null}>
 <ArticleRailAd side="left" onEmptyChange={onLeftEmptyResolved} />
 </React.Suspense>
 </SilentErrorBoundary>
 </aside>
 {children}
 <aside className={RAIL_ASIDE_CLASS_X}>
 <SilentErrorBoundary boundary="error-page-rail-right">
 <React.Suspense fallback={null}>
 <ArticleRailAd side="right" onEmptyChange={onRightEmptyResolved} />
 </React.Suspense>
 </SilentErrorBoundary>
 </aside>
 </div>
 );
};

export class ErrorBoundary extends Component<Props, State> {
 /** Prevents duplicate error_page_view events on re-renders */
 private errorPageTracked = false;

 public state: State = {
 hasError: false,
 errorDigest: '',
 errorHint: '',
 errorName: '',
 errorMessage: '',
 errorStack: '',
 snapshotUrl: '',
 snapshotReferrer: '',
 snapshotSessionRedirect: '',
 crashTimestamp: '',
 buildId: '',
 commitHash: '',
 copyState: 'idle',
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
 const timestamp = new Date().toISOString();
 if (typeof window === 'undefined') {
 return { url: '(ssr)', referrer: '(ssr)', sessionRedirect: '(ssr)', timestamp };
 }
 let sessionRedirect = '(none)';
 try {
 sessionRedirect = sessionStorage.getItem('redirect') || '(consumed)';
 } catch { /* private mode / disabled storage */ }
 return {
 url: window.location.href,
 referrer: document.referrer || '(direct)',
 sessionRedirect,
 timestamp,
 };
 }

 public static getDerivedStateFromError(error: Error): State {
 const msg = error?.message || '';
 // Decode React minified errors for human-readable hints
 const decoded = decodeReactError(msg);
 const isDecoded = decoded !== msg;
 // Shared isChunkLoadError predicate (resilientImport.ts) instead of a
 // hand-copied substring list — this file used to carry its own literal
 // copy that had drifted from resilientImport.ts's (issue #3216 item 1;
 // AGENTS.md §Non-Negotiables #6).
 const hint = isChunkLoadError(error)
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
 errorStack: (error?.stack || '').slice(0, 2000),
 snapshotUrl: env.url,
 snapshotReferrer: env.referrer,
 snapshotSessionRedirect: env.sessionRedirect,
 crashTimestamp: env.timestamp,
 // Reset per new crash — componentDidCatch below re-fetches for THIS crash
 // rather than reusing a stale value from a previous error on the same page.
 buildId: '',
 commitHash: '',
 copyState: 'idle',
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
 // Shared isChunkLoadError predicate (resilientImport.ts) — see the
 // getDerivedStateFromError comment above for the drift this replaced.
 const isChunkError = isChunkLoadError(error);

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

 // Cross-chunk version skew (stable filenames + re-lettered minified exports
 // after a deploy): a successfully-loaded but mismatched chunk throws a
 // TypeError at call time (e.g. "ls(...).then is not a function"). React
 // catches it here, NOT resilientImport's import() wrapper. Self-heal with the
 // same cache-clear + one-reload-per-session recovery: post-propagation the
 // browser refetches a consistent chunk set and the error is gone. The guard
 // caps it at one reload, so a genuine bug with the same message reloads once
 // then falls through to the error UI below.
 if (!isChunkError && isVersionSkewError(error)) {
 Analytics.trackAppError('chunk_load', {
 message: `[ErrorBoundary:${crashedComponent}] version_skew ${error.name}: ${msg.slice(0, 120)}`,
 stack: error.stack?.slice(0, 500) || '',
 pagePath: snapUrl,
 fatal: true,
 referrer: snapReferrer,
 sessionRedirect: snapSessionRedirect,
 });
 // Fire-and-forget: schedules at most one reload. If the guard blocks it,
 // the error UI below stays visible with a manual refresh button.
 void recoverFromStaleChunk(`version_skew:${msg.slice(0, 80)}`);
 }

 const fp = ErrorBoundary.fingerprint(error);

 // Rich error tracking to Firebase Analytics.
 // A stack whose frames ALL had their source URL redacted by the engine is
 // third-party cross-origin code throwing inside our tree, not a bug of ours
 // — same classification the global handlers apply (issue #4173). The
 // boundary context stays in the message; only the type/fatality change.
 const boundaryStack = error.stack?.slice(0, 500) || '';
 const boundaryThirdParty = isOriginRedactedThirdPartyStack(boundaryStack);
 Analytics.trackAppError(boundaryThirdParty ? 'cross_origin_script' : 'error_boundary', {
 message: `[ErrorBoundary:${crashedComponent}] ${error.name}: ${error.message}`,
 stack: boundaryStack,
 componentStack: errorInfo.componentStack?.slice(0, 300) || '',
 pagePath: snapUrl,
 pageTitle: document.title,
 fatal: !boundaryThirdParty,
 errorFingerprint: fp,
 referrer: snapReferrer,
 sessionRedirect: snapSessionRedirect,
 });

 // Best-effort debug metadata for the details panel below — never blocks
 // showing the error UI. A bug report copied via "Copia info debug" then
 // identifies WHICH deploy without the reporter needing devtools.
 const self = this as React.Component<Props, State>;
 void fetchBuildId().then((buildId) => { if (buildId) self.setState({ buildId }); });
 void fetchCommitHash().then((commitHash) => { if (commitHash) self.setState({ commitHash }); });
 }

 private handleCopyDebugInfo = (): void => {
 const self = this as React.Component<Props, State>;
 const { state } = this;
 const lines = [
 `Errore: ${state.errorName}${state.errorMessage ? `: ${state.errorMessage}` : ''}`,
 `REF: ${state.errorDigest}`,
 `Timestamp: ${state.crashTimestamp}`,
 `URL: ${state.snapshotUrl}`,
 `Referrer: ${state.snapshotReferrer}`,
 `Bridge sessionStorage: ${state.snapshotSessionRedirect}`,
 `Build ID: ${state.buildId || '(sconosciuto)'}`,
 `Commit: ${state.commitHash || '(sconosciuto)'}`,
 `User agent: ${typeof navigator !== 'undefined' ? navigator.userAgent : '(n/a)'}`,
 `Viewport: ${typeof window !== 'undefined' ? `${window.innerWidth}x${window.innerHeight}` : '(n/a)'}`,
 `Stack:\n${state.errorStack || '(non disponibile)'}`,
 ];
 const text = lines.join('\n');

 const onCopied = () => {
 self.setState({ copyState: 'copied' });
 setTimeout(() => self.setState({ copyState: 'idle' }), 2500);
 };
 const onFailed = () => {
 self.setState({ copyState: 'error' });
 setTimeout(() => self.setState({ copyState: 'idle' }), 2500);
 };

 if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
 navigator.clipboard.writeText(text).then(onCopied, onFailed);
 return;
 }
 // Fallback for browsers/contexts without the async Clipboard API.
 try {
 const ta = document.createElement('textarea');
 ta.value = text;
 ta.style.position = 'fixed';
 ta.style.left = '-9999px';
 document.body.appendChild(ta);
 ta.select();
 document.execCommand('copy');
 document.body.removeChild(ta);
 onCopied();
 } catch {
 onFailed();
 }
 };

 public render() {
 if (this.state.hasError) {
 // Track the error page being SHOWN to the user (health metric).
 // Fires once per ErrorBoundary instance to avoid duplicates on re-renders.
 if (!this.errorPageTracked) {
 this.errorPageTracked = true;
 Analytics.trackErrorPageView(this.state.errorDigest);
 }
 return (
 <div className="space-y-5">
 {/* Top banner — same self-contained DesktopTopBanner used across the site
 (CalcolatoreTabContent, etc.). SilentErrorBoundary + Suspense: nothing
 exists above this top-level boundary to catch a chunk failure in the
 ad component itself, so it must fail silently rather than re-throw. */}
 <SilentErrorBoundary boundary="error-page-top-banner">
 <React.Suspense fallback={null}>
 <DesktopTopBanner />
 </React.Suspense>
 </SilentErrorBoundary>

 {/* 3-column rail grid — collapses to 0 on an all-empty side (issue 4830),
 same shared hook/classes as JobBoard/JobOrphanView/JobExpiredView/
 BlogArticles. Single ArticleRailAd panel rather than ArticleRailAdStack:
 the crash card is short and non-scrolling, so it doesn't need the
 Stack's sticky/ResizeObserver machinery built for long scrollable
 content. */}
 <ErrorPageRailGrid>
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
 <div>
 <p className="text-[10px] uppercase tracking-wider text-muted font-semibold mb-1">
 Build
 </p>
 <code className="block text-xs text-body font-mono break-all select-all">
 {this.state.buildId || '(sconosciuto)'} — {this.state.commitHash || '(sconosciuto)'}
 </code>
 </div>
 {this.state.errorStack && (
 <details>
 <summary className="text-[10px] uppercase tracking-wider text-muted font-semibold cursor-pointer select-none">
 Stack trace
 </summary>
 <code className="block mt-1 text-xs text-body font-mono whitespace-pre-wrap break-all select-all max-h-40 overflow-y-auto">
 {this.state.errorStack}
 </code>
 </details>
 )}
 </div>
 <div className="flex flex-wrap items-center justify-center gap-3">
 <button
 onClick={() => {
 Analytics.trackForceReload({
 source: 'user_click',
 reason: 'error_page_manual_reload',
 pagePath: this.state.snapshotUrl || window.location.pathname + window.location.search,
 blocked: false,
 });
 // Bust the HTTP cache (not just CacheStorage) before reloading. If the user
 // landed here via a version-skew (#3097), a plain reload re-serves the same
 // stale chunk and leaves them stuck; cache:'reload' refetches a fresh set.
 void bustAssetHttpCache().finally(() => window.location.reload());
 }}
 className="flex items-center gap-2 px-6 py-3 bg-accent hover:bg-accent-hover text-on-accent rounded-xl font-bold transition-colors"
 >
 <RefreshCw size={18} /> {t('error.reload')}
 </button>
 <button
 onClick={this.handleCopyDebugInfo}
 className="flex items-center gap-2 px-6 py-3 bg-surface-alt hover:bg-surface-raised border border-edge text-body rounded-xl font-bold transition-colors"
 >
 {this.state.copyState === 'copied' ? <Check size={18} /> : <Copy size={18} />}
 {this.state.copyState === 'copied' ? t('error.debugCopied') : this.state.copyState === 'error' ? t('error.debugCopyFailed') : t('error.copyDebugInfo')}
 </button>
 </div>
 </div>
 </ErrorPageRailGrid>

 {/* Bottom banner — SSG_END_MULTIPLEX: the generic cross-family
 end-of-content multiplex slot, since this fallback can replace
 ANY page type. */}
 <SilentErrorBoundary boundary="error-page-bottom-banner">
 <React.Suspense fallback={null}>
 {AD_SLOTS.SSG_END_MULTIPLEX.slot && (
 <AdSenseBanner
 adSlot={AD_SLOTS.SSG_END_MULTIPLEX.slot}
 adFormat={AD_SLOTS.SSG_END_MULTIPLEX.format}
 fullWidthResponsive={AD_SLOTS.SSG_END_MULTIPLEX.fullWidthResponsive}
 className="mt-4 mb-2"
 />
 )}
 </React.Suspense>
 </SilentErrorBoundary>
 </div>
 );
 }

 return (this as React.Component<Props, State>).props.children;
 }
}

// ─── SilentErrorBoundary ─────────────────────────────────────────────
// Granular boundary for non-essential UI clusters (e.g. homepage widgets).
// Catches a render error and replaces only the wrapped subtree with the
// supplied fallback (default: nothing) instead of crashing the whole page.
// Reports the error to Analytics so we still get visibility on React #31
// and similar "objects rendered as children" failures, plus a label that
// identifies WHICH cluster failed (header, news-feed, home-job-cta, etc.).
//
// Used around homepage button rows / widgets where a React #31 from a
// transiently-malformed value (e.g. translation chunk arriving mid-render
// with an unexpected shape) would otherwise blank the entire page for the
// user. The top-level ErrorBoundary still wraps the app for unrecoverable
// failures.

interface SilentBoundaryProps {
 children: ReactNode;
 /** Stable label (no PII) — appears in Analytics so we can pinpoint the
  *  failing cluster from telemetry. */
 boundary: string;
 /** Optional fallback rendered when the subtree errors. Default: null. */
 fallback?: ReactNode;
}

interface SilentBoundaryState {
 hasError: boolean;
}

export class SilentErrorBoundary extends Component<SilentBoundaryProps, SilentBoundaryState> {
 public state: SilentBoundaryState = { hasError: false };

 public static getDerivedStateFromError(): SilentBoundaryState {
 return { hasError: true };
 }

 public componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
 const decoded = decodeReactError(error?.message || '');
 const stack = errorInfo.componentStack?.slice(0, 300) || '';
 const props = (this as React.Component<SilentBoundaryProps, SilentBoundaryState>).props;
 try {
 const silentStack = error.stack?.slice(0, 500) || '';
 Analytics.trackAppError(
 isOriginRedactedThirdPartyStack(silentStack) ? 'cross_origin_script' : 'error_boundary', {
 message: `[SilentBoundary:${props.boundary}] ${error.name}: ${decoded.slice(0, 160)}`,
 stack: silentStack,
 componentStack: stack,
 pagePath: typeof window !== 'undefined' ? window.location.pathname + window.location.search : '',
 pageTitle: typeof document !== 'undefined' ? document.title : '',
 fatal: false,
 },
 );
 } catch {
 /* analytics may be unavailable */
 }

 // Chunk-load / version-skew recovery (#4590): this boundary wraps
 // non-critical widget clusters (nav-actions, ai-chatbot via SafeLazy,
 // home-widgets-*) and deliberately never forces window.location.reload()
 // — a forced reload from one of these widgets previously disrupted an
 // in-progress newsletter autologin (ref cwji52). But leaving the stale
 // chunk unhandled meant the browser's HTTP disk cache kept re-serving
 // the same bad bytes for the rest of the session (and to the next page
 // load), unlike the top-level ErrorBoundary which busts the cache before
 // its manual-reload button. Bust the HTTP cache only — no reload — so a
 // future fetch (this session or the next) picks up the fresh chunk
 // without disrupting whatever the user is doing right now.
 //
 // isModuleParseError included (#5531/#6778): a stale SafeLazy widget chunk
 // can resolve as SPA-fallback HTML parsed as a module ("Unexpected
 // identifier '<word>'") the same way a primary lazyRetry()-wrapped chunk
 // can — see resilientImport.ts. Unlike the isVersionSkewError widening the
 // top-level ErrorBoundary/ChunkLoadErrorBoundary deliberately don't take
 // (by construction, PR #5535: those paths RELOAD the page on a match, so a
 // generic SyntaxError there could mask a genuine bug under a reload), this
 // boundary's action is a background cache-bust only — no reload, no change
 // to what's rendered — so the same false-positive costs nothing beyond a
 // redundant fetch, while a true positive stops the widget from re-throwing
 // the identical parse error on every subsequent SPA navigation this session.
 if (isChunkLoadError(error) || isVersionSkewError(error) || isModuleParseError(error)) {
 void bustAssetHttpCache();
 }
 }

 public render(): ReactNode {
 const props = (this as React.Component<SilentBoundaryProps, SilentBoundaryState>).props;
 if (this.state.hasError) {
 return props.fallback ?? null;
 }
 return props.children;
 }
}
