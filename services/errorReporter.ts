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
import { isBenignErrorMessage } from '@/services/benignErrorPatterns';

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

/**
 * Report a caught error to GA4 Analytics.
 *
 * Safe to call anywhere — if analytics is not initialized yet, the call
 * is silently skipped (no throw, no recursion).
 *
 * @param error The caught error value (Error | string | unknown)
 * @param context A short dot-notation identifier for the call site
 * @param options Optional overrides (error type, API endpoint, status code)
 */
export function reportCaughtError(
 error: unknown,
 context: string,
 options: {
 type?: ErrorType;
 apiEndpoint?: string;
 statusCode?: number;
 apiMethod?: string;
 fatal?: boolean;
 } = {}
): void {
 const message = extractMessage(error);

 // ── Dev console visibility ──
 console.warn(`[${context}]`, error);

 // ── Drop benign environmental noise (adblock, browser quirks, offline) ──
 // Console.warn above still runs so devs can see it locally; GA4 doesn't.
 //
 // Also check the "Name: message" form so patterns like /^AbortError:/ match
 // errors caught via try/catch (where extractMessage() returns only error.message
 // without the name). The unhandledrejection handler uses `${reason.name}: …`
 // naturally; caught errors must replicate that form here.
 // Read the name directly from the object so DOMException (which may not be
 // instanceof Error in older environments) is still handled correctly.
 const errorName = (error as any)?.name;
 const prefixedMessage = errorName && errorName !== 'Error'
   ? `${errorName}: ${message}`
   : message;
 if (isBenignErrorMessage(message) || isBenignErrorMessage(prefixedMessage)) return;

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
 const resolvedType = options.type || 'api_error';
 const resolvedEndpoint = options.apiEndpoint || context;
 const resolvedStatus = options.statusCode ?? 0;
 Analytics.trackAppError(resolvedType, {
 message: `[${context}] ${message}`,
 stack: extractStack(error),
 apiEndpoint: resolvedEndpoint,
 statusCode: resolvedStatus,
 apiMethod: options.apiMethod,
 fatal: options.fatal ?? false,
 });
 } catch {
 // Analytics not initialized — the console.warn above is our fallback
 }
}
