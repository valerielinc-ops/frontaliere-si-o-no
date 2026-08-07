/**
 * SEO helper functions shared across hooks.
 *
 * These were previously module-level in App.tsx. They are lazy-loaded
 * and gated behind `runtimeSeoEnabled` to avoid SEO updates during
 * Lighthouse's observation window.
 *
 * ## Why there is a second gate (the first-paint deferral)
 *
 * `runtimeSeoEnabled` alone does not keep the SEO runtime out of the initial
 * load window, and the article pages are the proof. Consent is granted
 * silently at App module-eval (`setDefaultConsent()` in App.tsx writes the
 * granted state to localStorage), so `useUIState`'s mount effect sees
 * `isAnalyticsGranted() === true` and calls `enableRuntimeSeo()` synchronously
 * during mount. The gate therefore only ever blocks the *synchronous* mount
 * pass; anything that re-runs afterwards finds it open.
 *
 * On an article URL the SEO key is not known at mount: `parsePath` yields a
 * `blogSlug`, `useNavigationState` skips the update while the slug is pending,
 * and `resolvePendingArticle` resolves it asynchronously. The resulting
 * `setBlogArticle` re-runs the blog SEO effect with the gate already open,
 * still inside the load window — which is why an article cold load pulls
 * `seoService` + all eight `seo-blog*` shards (~0.9 MB over the wire, ~9 MB
 * parsed) while the hub and the static landings pull none of it. Measured on
 * production 2026-08-07: the article page requested seoService.js and
 * seo-blog{,-2..-7,-ch}.js; /articoli-frontaliere/ and /prezzi-diesel/<c>/oggi/
 * requested neither.
 *
 * So the work is deferred, not skipped. Skipping is not available here: the
 * prerendered head and the runtime head are NOT the same on article pages
 * (title, description, keywords, og:image dimensions, article:section,
 * article:modified_time and the NewsArticle JSON-LD all differ, and the
 * live `SEO_SERP_EXPERIMENT_*` title variant only exists at runtime).
 * Dropping the runtime pass would silently change the indexed head on the
 * site's main organic surface. Deferring it cannot lose a tag: the
 * prerendered HTML already carries a complete head, and the deferred pass is
 * guaranteed to run — on `load`, or on a hard deadline if `load` never fires.
 */
import { parsePath } from '@/services/router';
import { setLocale } from '@/services/i18n';
import { reportCaughtError } from '@/services/errorReporter';

let runtimeSeoEnabled = false;

/** Enable runtime SEO updates. Called on first user interaction or navigation. */
export const enableRuntimeSeo = () => { runtimeSeoEnabled = true; };

/** Check if runtime SEO is enabled. */
export const isRuntimeSeoEnabled = () => runtimeSeoEnabled;

// ── First-paint deferral ────────────────────────────────────────────────────

/** Idle deadline once the load window has closed. */
const IDLE_TIMEOUT_MS = 2000;
/** Hard deadline in case `load` never fires (a hung ad iframe, a stalled image). */
const LOAD_DEADLINE_MS = 8000;

/** Open until the initial load window closes; while open, SEO work is queued. */
let firstPaintWindowOpen = true;
// One slot each: the section resolved last is the one the page is actually on,
// so an earlier queued section is superseded rather than replayed. Kept apart
// so a mismatched pair can never stamp the head with the tracker's section.
let queuedMetaSection: string | null = null;
let queuedTrackSection: string | null = null;
let deadlineTimer: ReturnType<typeof setTimeout> | null = null;

const applyMetaTags = (section: string) => {
 const runUpdate = () => import('@/services/seoService').then(m => m.updateMetaTags(section)).catch(err => reportCaughtError(err, 'seo.updateMetaTags'));
 if (section === 'blog' || section.startsWith('blog-')) {
  const metaReady = import('@/services/i18n')
   .then(m => m.loadBlogMeta())
   .catch(err => reportCaughtError(err, 'seo.loadBlogMeta'));
  // Pair the slug map with blog meta (#3528/#3532): it no longer preloads
  // unconditionally at App mount, and canonical/article URLs built for
  // blog sections need BLOG_SLUGS populated to emit localized slugs.
  const slugsReady = import('@/services/router')
   .then(m => m.preloadBlogData())
   .catch(err => reportCaughtError(err, 'seo.preloadBlogData'));
  Promise.all([metaReady, slugsReady]).finally(runUpdate);
  return;
 }
 runUpdate();
};

const applyTrackSectionView = (section: string) => {
 import('@/services/seoService').then(m => m.trackSectionView(section)).catch(err => reportCaughtError(err, 'seo.trackSectionView'));
};

/** Close the window and run whatever was queued. Idempotent. */
const closeFirstPaintWindow = () => {
 if (!firstPaintWindowOpen) return;
 firstPaintWindowOpen = false;
 if (deadlineTimer !== null) { clearTimeout(deadlineTimer); deadlineTimer = null; }
 const metaSection = queuedMetaSection;
 const trackSection = queuedTrackSection;
 queuedMetaSection = null;
 queuedTrackSection = null;
 if (metaSection !== null) applyMetaTags(metaSection);
 if (trackSection !== null) applyTrackSectionView(trackSection);
};

/**
 * Close the window after `load` + one idle slice.
 *
 * Same idiom as GptAdSlot.tsx / NewsFeed.tsx / App.tsx: `requestIdleCallback`
 * with a timeout so a busy main thread cannot postpone it indefinitely, plus a
 * `setTimeout` fallback for browsers without it. The extra `load` wait is what
 * moves the work past the FCP/LCP window — `requestIdleCallback` on its own
 * fires in the idle slices *between* boot tasks, i.e. still inside it.
 *
 * Armed at module evaluation (App.tsx imports this eagerly), so the window is
 * bounded by the document's own load, not by whether anything happened to be
 * queued. A section requested after the flush runs immediately: an SPA tab
 * change must retitle the document now, not on the next idle slice.
 */
const armFirstPaintWindowClose = () => {
 if (typeof window === 'undefined' || typeof document === 'undefined') {
  closeFirstPaintWindow();
  return;
 }
 const idle = () => {
  const ric = (window as unknown as { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number }).requestIdleCallback;
  if (typeof ric === 'function') ric(closeFirstPaintWindow, { timeout: IDLE_TIMEOUT_MS });
  else window.setTimeout(closeFirstPaintWindow, 0);
 };
 if (document.readyState === 'complete') {
  idle();
  return;
 }
 window.addEventListener('load', idle, { once: true });
};

/**
 * `load` can be held open indefinitely by a third-party iframe, and a queued
 * head must still land. Armed only once something is actually queued, so the
 * common case leaves no pending timer behind.
 */
const armQueueDeadline = () => {
 if (deadlineTimer !== null || typeof window === 'undefined') return;
 deadlineTimer = window.setTimeout(closeFirstPaintWindow, LOAD_DEADLINE_MS) as unknown as ReturnType<typeof setTimeout>;
};

/** @internal — reset module state between tests (isolate: false workers share one registry). */
export const _resetRuntimeSeoForTests = () => {
 runtimeSeoEnabled = false;
 firstPaintWindowOpen = true;
 queuedMetaSection = null;
 queuedTrackSection = null;
 if (deadlineTimer !== null) { clearTimeout(deadlineTimer); deadlineTimer = null; }
 // Re-arm: reopening the window without re-arming would leave it open for the
 // rest of the file, which is the one state the production module never has.
 armFirstPaintWindowClose();
};

/** @internal — test seam: is the initial-load deferral window still open? */
export const _isFirstPaintWindowOpen = () => firstPaintWindowOpen;

/**
 * Update meta tags for a given SEO section key.
 * Lazy-loads seoService. For blog pages, ensures blog-meta translations
 * are loaded first.
 *
 * During the initial load window the call is queued rather than executed, so
 * `seoService` and the `seo-blog*` shards stay out of the first-paint window.
 * The queue holds one entry — the most recent section — and is flushed once,
 * after `load`, on the first idle slice.
 */
export const updateMetaTags = (section: string) => {
 if (!runtimeSeoEnabled) return;
 // Locale sync stays synchronous: it is cheap (parsePath + a setter, no chunk
 // download) and downstream state — <html lang>, the language switcher, the
 // canonical builder — reads it long before the deferred pass runs.
 const { locale: pathLocale } = parsePath(window.location.pathname);
 setLocale(pathLocale);
 if (firstPaintWindowOpen) {
  queuedMetaSection = section;
  armQueueDeadline();
  return;
 }
 applyMetaTags(section);
};

/**
 * Track a section view for analytics purposes (lazy-loaded).
 *
 * Deferred alongside `updateMetaTags` during the initial load window — it
 * imports the same `seoService` chunk, so leaving it eager would defeat the
 * deferral entirely.
 */
export const trackSectionView = (section: string) => {
 if (!runtimeSeoEnabled) return;
 if (firstPaintWindowOpen) {
  queuedTrackSection = section;
  armQueueDeadline();
  return;
 }
 applyTrackSectionView(section);
};

// Bounded by the document's load, not by traffic through this module.
armFirstPaintWindowClose();
