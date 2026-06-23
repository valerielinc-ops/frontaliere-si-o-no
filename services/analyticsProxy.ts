/**
 * analyticsProxy — lightweight lazy proxy for Analytics.
 *
 * All Analytics calls are fire-and-forget; no return values are used.
 * The proxy defers the actual import('@/services/analytics') until the
 * first user interaction (or consent grant), keeping Firebase out of the
 * critical bundle path and reducing TBT.
 *
 * Usage:
 * import { Analytics } from '@/services/analyticsProxy';
 * Analytics.trackPageView('/foo'); // safe to call immediately
 */
export const Analytics: Record<string, (...a: unknown[]) => void> = new Proxy(
 {} as Record<string, (...a: unknown[]) => void>,
 {
 get: (_t, method: string) =>
 (...args: unknown[]) => {
 // Guard + catch like the sibling lazy helpers below (lines 28, 37): a
 // stale-deploy chunk can resolve the dynamic import to a module whose
 // `Analytics` export is undefined, so `m.Analytics[method]` throws and —
 // with no `.catch()` — surfaces as an unhandledrejection captured by the
 // handler in analytics.ts. That is the site's #1 runtime exception:
 // Safari phrases it `undefined is not an object (evaluating 't.Analytics[i]')`,
 // V8 `Cannot read properties of undefined (reading 'trackFunnelStep')` —
 // same null-deref, different engine wording. Analytics is fire-and-forget,
 // so swallow both the missing-export case and any throw inside the call.
 import('@/services/analytics')
 .then((m) => {
 const fn = (m.Analytics as any)?.[method];
 if (typeof fn === 'function') fn(...args);
 })
 .catch(() => {});
 },
 },
);

/**
 * Lazy unlockAchievement — keeps gamificationService out of the critical bundle.
 * Fire-and-forget; failures are silently ignored.
 */
export const unlockAchievement = (id: string): void => {
 import('@/services/gamificationService').then(m => m.unlockAchievement(id)).catch(() => {});
};

/**
 * Lazy `fireCalcEntryIfNeeded` — emits `funnel_step:entry` (funnel=calculator)
 * once per session when the user is on any calc URL (canonical or SEO variant).
 * Safe to call on every route change; the helper deduplicates via sessionStorage.
 */
export const fireCalcEntryIfNeeded = (path: string): void => {
 import('@/services/analytics').then(m => m.fireCalcEntryIfNeeded(path)).catch(() => {});
};
