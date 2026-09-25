/**
 * Centralized Error Reporter
 *
 * Lightweight utility for reporting caught errors to Firebase Analytics (GA4).
 * Wraps Analytics.trackAppError() so any catch block can report errors with
 * one line instead of silently swallowing them.
 *
 * Usage:
 * import { reportCaughtError } from '@/services/errorReporter';
 *
 * try { await fetchSomething(); }
 * catch (e) { reportCaughtError(e, 'exchangeRate.fetchTwelveData'); }
 *
 * The `context` string should identify WHERE the error happened
 * (e.g. 'exchangeRate.firestoreRead', 'auth.googleSignIn', 'newsletter.subscribe').
 *
 * Deduplication: errors with the same context + message are throttled
 * to at most 1 report per 60 seconds to avoid flooding GA4.
 */

import { Analytics } from '@/services/analytics';
import { isBenignErrorMessage, isOriginRedactedThirdPartyStack } from '@/services/benignErrorPatterns';
import { isNewsletterAutologinInFlight } from '@/services/newsletterAutologinSignal';
import { isVersionSkewError, recoverFromStaleChunk } from '@/services/resilientImport';

type ErrorType =
 | 'api_error'
 | 'error_boundary'
 | 'chunk_load'
 | 'unhandled_error'
 | 'unhandled_rejection'
 | 'page_404'
 | 'resource_load'
 | 'sw_cache_stale'
 | 'cross_origin_script';

const THROTTLE_MS = 60_000;
const recentlyReported = new Map<string, number>();

// Per-page-load cap. Protects GA4 against runaway floods (e.g. a render loop
// firing the same handler hundreds of times per session). The April 2026 trend
// showed a 760-error spike on a single day — this cap is the safety belt.
const MAX_REPORTS_PER_SESSION = 25;
let reportsThisSession = 0;

// Benign-noise deny-list lives in `services/benignErrorPatterns.ts` — the
// single source of truth shared with the global error handlers in
// `services/analytics.ts` so the two app_error pipelines cannot drift.
// Errors matching any pattern there are dropped at the reporter so they never
// reach GA4 / PostHog.

/** @internal — only for use in tests to clear shared module-level state. */
export function _resetThrottleMapForTests(): void {
 recentlyReported.clear();
 reportsThisSession = 0;
}

function extractMessage(error: unknown): string {
 if (error instanceof Error) return error.message;
 if (typeof error === 'string') return error;
 try { return JSON.stringify(error); } catch { return String(error); }
}

function extractStack(error: unknown): string {
 if (error instanceof Error && error.stack) return error.stack;
 return '';
}

type ReportCaughtErrorOptions = {
 type?: ErrorType;
 apiEndpoint?: string;
 statusCode?: number;
 apiMethod?: string;
 fatal?: boolean;
};

/**
 * Report a caught error to GA4 Analytics.
 *
 * Safe to call anywhere — if analytics is not initialized yet, the call
 * is silently skipped (no throw, no recursion). Guaranteed never to throw:
 * some callers sit in fail-closed catch blocks (e.g.
 * services/newsletterSubscribers.ts's isNewsletterOptedOut) where this call
 * must not be able to pre-empt the fail-closed `return true` that follows it.
 *
 * @param error The caught error value (Error | string | unknown)
 * @param context A short dot-notation identifier for the call site
 * @param options Optional overrides (error type, API endpoint, status code)
 */
export function reportCaughtError(
 error: unknown,
 context: string,
 options: ReportCaughtErrorOptions = {}
): void {
 try {
 reportCaughtErrorUnsafe(error, context, options);
 } catch {
 // Never propagate — a throw here must never be able to interrupt a
 // caller's own control flow (see the fail-closed note above).
 }
}

function reportCaughtErrorUnsafe(
 error: unknown,
 context: string,
 options: ReportCaughtErrorOptions
): void {
 const message = extractMessage(error);

 // ── Cross-chunk version skew: self-heal, independent of the report gating below ──
 // ErrorBoundary.componentDidCatch (components/shared/ErrorBoundary.tsx) already
 // self-heals render-time skew; every dynamic import().catch(reportCaughtError)
 // call site (hooks/seoHelpers.ts, App.tsx's loadUserProfile, etc.) previously only
 // reported the error and left the user stuck on stale chunks with no recovery
 // attempt. Same `version_skew:<message>` signature as ErrorBoundary so both paths
 // share one reload budget for the same underlying stale chunk regardless of which
 // caught it first.
 // Suppress the reload while a newsletter autologin exchange is in flight —
 // same guard `promptOneTap()`/auth gates use (services/authService.ts:1412):
 // forcing a reload mid-exchange would abort the sign-in the user is already
 // mid-way through (e.g. App.tsx's `app.newsletterAutologin` catch).
 if (isVersionSkewError(error) && !isNewsletterAutologinInFlight()) {
 void recoverFromStaleChunk(`version_skew:${message.slice(0, 80)}`);
 }

 // ── Dev console visibility ──
 console.warn(`[${context}]`, error);

 // ── Drop benign environmental noise (adblock, browser quirks, offline) ──
 // Console.warn above still runs so devs can see it locally; GA4 doesn't.
 //
 // Also check the "Name: message" form so patterns like /AbortError: …/ match
 // errors caught via try/catch (where extractMessage() returns only error.message
 // without the name). The unhandledrejection handler uses `${reason.name}: …`
 // naturally; caught errors must replicate that form here.
 const prefixedMessage = error instanceof Error && error.name && error.name !== 'Error'
   ? `${error.name}: ${message}`
   : message;
 if (isBenignErrorMessage(message) || isBenignErrorMessage(prefixedMessage)) return;

 // ── Re-classify errors whose whole stack had its source URLs redacted (#4173) ──
 // Parity with the two global handlers in services/analytics.ts: a stack in
 // which not one frame carries a source is a cross-origin third-party script,
 // never our own modules. Shared predicate so the three pipelines can't drift.
 const originRedactedThirdParty = isOriginRedactedThirdPartyStack(extractStack(error));

 // ── Per-page-load cap to prevent flood storms ──
 if (reportsThisSession >= MAX_REPORTS_PER_SESSION) return;

 // ── Throttle duplicate reports ──
 const dedupeKey = `${context}::${message.slice(0, 80)}`;
 const now = Date.now();
 const lastReported = recentlyReported.get(dedupeKey);
 if (lastReported && now - lastReported < THROTTLE_MS) return;
 recentlyReported.set(dedupeKey, now);
 reportsThisSession++;

 // Cleanup old entries every ~50 reports
 if (recentlyReported.size > 50) {
 for (const [key, ts] of recentlyReported) {
 if (now - ts > THROTTLE_MS) recentlyReported.delete(key);
 }
 }

 // ── Report to GA4 ──
 // For api_error events, PostHog dashboards require `endpoint` and `status`
 // to be non-null. `context` (e.g. "exchangeRate.fetchTwelveData") is always
 // supplied by the caller and is used as the endpoint fallback when the
 // caller did not provide an explicit `apiEndpoint`.
 try {
 const resolvedType = originRedactedThirdParty ? 'cross_origin_script' : (options.type || 'api_error');
 const resolvedEndpoint = options.apiEndpoint || context;
 const resolvedStatus = options.statusCode ?? 0;
 Analytics.trackAppError(resolvedType, {
 message: `[${context}] ${message}`,
 stack: extractStack(error),
 apiEndpoint: resolvedEndpoint,
 statusCode: resolvedStatus,
 apiMethod: options.apiMethod,
 fatal: originRedactedThirdParty ? false : (options.fatal ?? false),
 });
 } catch {
 // Analytics not initialized — the console.warn above is our fallback
 }
}
