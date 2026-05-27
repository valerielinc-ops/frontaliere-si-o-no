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
 import('@/services/analytics').then(m => (m.Analytics as any)[method](...args));
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
