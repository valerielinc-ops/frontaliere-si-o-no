/**
 * Prefetch on Intent — preloads lazy chunks on hover/focus before click.
 *
 * When a user hovers over a tab button, the corresponding lazy component
 * chunk is speculatively loaded. By the time they click, the component
 * is already in the browser cache → near-instant navigation.
 *
 * Uses requestIdleCallback where available, otherwise setTimeout(0).
 */

type PrefetchFn = () => Promise<any>;

const prefetched = new Set<string>();

/**
 * Prefetch a dynamic import during idle time.
 * No-op if already prefetched or if the module is already cached.
 */
export function prefetchOnIdle(key: string, loader: PrefetchFn) {
 if (prefetched.has(key)) return;
 prefetched.add(key);

 const run = () => {
 loader().catch(() => {
 // Network error — allow retry later
 prefetched.delete(key);
 });
 };

 if ('requestIdleCallback' in window) {
 (window as any).requestIdleCallback(run, { timeout: 3000 });
 } else {
 setTimeout(run, 100);
 }
}

// ─── Tab-specific prefetch maps ─────────────────────────────

const TAB_LOADERS: Record<string, PrefetchFn[]> = {
 confronti: [
 () => import('@/components/comparators/CurrencyExchange'),
 () => import('@/components/comparators/HealthInsurance'),
 () => import('@/components/comparators/BankComparison'),
 ],
 calculator: [
 () => import('@/components/calculator/InputCard'),
 () => import('@/services/calculationService'),
 ],
 guida: [
 () => import('@/components/guide/FrontierGuide'),
 ],
 fisco: [
 () => import('@/components/fisco/PensionPlanner'),
 () => import('@/components/fisco/TaxCalendar'),
 ],
 stats: [
 () => import('@/components/pages/StatsView'),
 ],
 vita: [
 () => import('@/components/comparators/CostOfLiving'),
 ],
 blog: [
 () => import('@/components/community/BlogArticles'),
 ],
 faq: [
 () => import('@/components/pages/FaqSection'),
 ],
 glossary: [
 () => import('@/components/pages/Glossary'),
 ],
};

/**
 * Call on mouseenter/focus of a tab button to prefetch its primary chunks.
 */
export function prefetchTab(tabName: string) {
 // Avoid kicking off many real dynamic imports in Vitest, which can leave
 // pending module fetches during worker teardown and produce flaky unhandled rejections.
 if (typeof process !== 'undefined' && (process as any).env?.VITEST) return;

 const loaders = TAB_LOADERS[tabName];
 if (!loaders) return;
 for (const loader of loaders) {
 prefetchOnIdle(`tab:${tabName}:${loaders.indexOf(loader)}`, loader);
 }
}
