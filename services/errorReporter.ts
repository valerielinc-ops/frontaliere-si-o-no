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
 fatal?: boolean;
 } = {}
): void {
 const message = extractMessage(error);

 // ── Dev console visibility ──
 console.warn(`[${context}]`, error);

 // ── Throttle duplicate reports ──
 const dedupeKey = `${context}::${message.slice(0, 80)}`;
 const now = Date.now();
 const lastReported = recentlyReported.get(dedupeKey);
 if (lastReported && now - lastReported < THROTTLE_MS) return;
 recentlyReported.set(dedupeKey, now);

 // Cleanup old entries every ~50 reports
 if (recentlyReported.size > 50) {
 for (const [key, ts] of recentlyReported) {
 if (now - ts > THROTTLE_MS) recentlyReported.delete(key);
 }
 }

 // ── Report to GA4 ──
 try {
 Analytics.trackAppError(options.type || 'api_error', {
 message: `[${context}] ${message}`,
 stack: extractStack(error),
 apiEndpoint: options.apiEndpoint,
 statusCode: options.statusCode,
 fatal: options.fatal ?? false,
 });
 } catch {
 // Analytics not initialized — the console.warn above is our fallback
 }
}
