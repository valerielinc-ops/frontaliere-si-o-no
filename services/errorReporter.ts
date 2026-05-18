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

// Per-page-load cap. Protects GA4 against runaway floods (e.g. a render loop
// firing the same handler hundreds of times per session). The April 2026 trend
// showed a 760-error spike on a single day — this cap is the safety belt.
const MAX_REPORTS_PER_SESSION = 25;
let reportsThisSession = 0;

// Benign-noise deny-list. Errors matching any pattern below are dropped at the
// reporter so they never reach GA4. Rationale per pattern is documented inline;
// each entry was chosen from the May 2026 GA4 audit (3,543 errors / 30d, of
// which ~58% were environmental noise with no actionable stack trace).
const NOISE_PATTERNS: ReadonlyArray<RegExp> = [
 // Adblockers/privacy extensions block accounts.google.com/gsi/client.
 // We already degrade gracefully (One Tap simply doesn't show); reporting
 // is pure noise. (181/3543 in May 2026 audit.)
 /Failed to load Google Identity Services/i,
 // Browser-internal layout signal — not a bug, not actionable. Chrome/Safari
 // emit this when a ResizeObserver callback queues a mutation that resizes
 // observed elements. (22+ in audit.)
 /ResizeObserver loop/i,
 // Cross-origin script errors with no stack — opaque by design (browser CORS).
 // We can't fix what we can't see. (1,783 in audit — single biggest bucket.)
 /^Script error\.?$/i,
 // Firebase/Firestore offline state during tab suspension on iOS Safari.
 // Recoverable; the SDK retries automatically. (20+ in audit.)
 /Failed to get document because the client is offline/i,
 // Module preload failure on flaky networks. The SW recovery path
 // (sw_cache_stale) handles the visible cases; bare rejections without
 // a recovery hook are noise. (16+ in audit.)
 /Importing a module script failed/i,
 // ── 2026-05-18 PostHog triage additions ──
 // Microsoft Office in-app browser bridge postMessage noise. 363 events /
 // 30d across 5 Id buckets — pure host-app noise.
 /Object Not Found Matching Id:\d+, MethodName:update, ParamCount:4/i,
 // Firebase Installations/RemoteConfig offline — SDK retries automatically.
 // 65+53+32+29+21+25 = ~225 events / 30d, all environmental.
 /Installations:.*Application offline\b/i,
 /Remote Config:.*Original error:.*(Failed to fetch|Load failed|aborted|Database deleted|client is offline)/i,
 // IndexedDB lifecycle noise from iOS tab suspension / user clearing site
 // data. Already auto-recovered by `recoverFromIndexedDbLoss()`; reporting
 // is duplicate noise. 252+128+33+25 = ~440 events / 30d.
 /Connection to Indexed Database server lost/i,
 /Failed to execute 'transaction' on 'IDBDatabase'/i,
 /UnknownError.*IDBDatabase/i,
 /Database deleted by request of the user/i,
 // Safari generic transport failure with no actionable source. 69+18 events
 // / 30d in unhandled_rejection bucket alone.
 /^TypeError: Load failed$/i,
 // Twelve Data CHF/EUR exchange-rate fetch flakes ~140 events / 30d. Caller
 // has full Firebase RC fallback, so this is recoverable noise.
 // TODO(2026-05-18): if Firestore fallback also fails we lose CHF/EUR
 // display — add a sentinel event for double-failure instead of dropping
 // both. Tracked via `endpoint=config/exchange_rate` slice.
 /\[exchangeRate\.twelveDataFetch\]/i,
];

function isNoise(message: string): boolean {
 return NOISE_PATTERNS.some((re) => re.test(message));
}

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
 if (isNoise(message)) return;

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
