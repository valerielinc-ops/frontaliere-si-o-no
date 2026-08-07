/**
 * The runtime SEO pass must not run inside the initial load window.
 *
 * `runtimeSeoEnabled` was built for that job but does not do it: consent is
 * granted silently at App module-eval (`setDefaultConsent()`, App.tsx), so
 * `useUIState`'s mount effect sees `isAnalyticsGranted() === true` and calls
 * `enableRuntimeSeo()` synchronously during mount. The gate therefore only
 * blocks the synchronous mount pass. On an article URL the SEO key is not
 * known at mount — `resolvePendingArticle` resolves the slug asynchronously —
 * so the update that matters re-runs *after* the gate is open, still inside the
 * load window, pulling `seoService` + eight `seo-blog*` shards (~1.1 MB of
 * transfer measured inside a Lighthouse trace of a production article page).
 *
 * Every "is withheld" assertion below fails against the pre-fix
 * `hooks/seoHelpers.ts`, where `import('@/services/seoService')` fires on the
 * same tick as the call.
 *
 * Deferral, not suppression: the prerendered head and the runtime head are NOT
 * identical on article pages (title, description, keywords, og:image size,
 * article:section, article:modified_time and the NewsArticle JSON-LD all
 * differ, plus the live SERP title experiment), so dropping the pass would
 * change the indexed head on the site's main organic surface. The "still runs"
 * assertions are the half that guarantees no tag is lost.
 *
 * One call into `seoService` per test on purpose: two `import()` of the same
 * mocked module in the same tick race inside the vitest module runner and one
 * of them resolves the real module. That is a harness artifact, not product
 * behaviour — production has no mock to race with.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as helpers from '@/hooks/seoHelpers';

const seoUpdateMetaTags = vi.fn();
const seoTrackSectionView = vi.fn();
const preloadBlogData = vi.fn(async (..._args: unknown[]) => undefined);
const loadBlogMeta = vi.fn(async (..._args: unknown[]) => undefined);

vi.mock('@/services/seoService', () => ({
  updateMetaTags: (...args: unknown[]) => seoUpdateMetaTags(...args),
  trackSectionView: (...args: unknown[]) => seoTrackSectionView(...args),
  applyNotFoundSeo: vi.fn(),
}));

vi.mock('@/services/router', () => ({
  parsePath: () => ({ locale: 'it', route: { activeTab: 'blog' } }),
  preloadBlogData: (...args: unknown[]) => preloadBlogData(...args),
}));

vi.mock('@/services/i18n', () => ({
  setLocale: vi.fn(),
  loadBlogMeta: (...args: unknown[]) => loadBlogMeta(...args),
}));

vi.mock('@/services/errorReporter', () => ({ reportCaughtError: vi.fn() }));

const ARTICLE_SECTION = 'blog-stipendio-netto-frontaliere-2026';

let idleCallbacks: Array<() => void> = [];

/** Fire `load`, then drain the idle queue the module registered. */
function fireLoadAndIdle(): void {
  window.dispatchEvent(new Event('load'));
  idleCallbacks.splice(0).forEach((cb) => cb());
}

beforeEach(() => {
  seoUpdateMetaTags.mockClear();
  seoTrackSectionView.mockClear();
  preloadBlogData.mockClear();
  loadBlogMeta.mockClear();
  idleCallbacks = [];
  (window as unknown as { requestIdleCallback: unknown }).requestIdleCallback =
    (cb: () => void) => { idleCallbacks.push(cb); return idleCallbacks.length; };
  // The document is still loading, exactly as it is when the SPA boots.
  Object.defineProperty(document, 'readyState', { configurable: true, get: () => 'loading' });
  helpers._resetRuntimeSeoForTests();
  helpers.enableRuntimeSeo();
});

afterEach(() => {
  vi.useRealTimers();
  delete (window as unknown as { requestIdleCallback?: unknown }).requestIdleCallback;
});

describe('runtime SEO stays out of the initial load window', () => {
  it('withholds seoService and the blog side-loads while the window is open', async () => {
    // Exactly what useNavigationState does once resolvePendingArticle lands.
    helpers.updateMetaTags(ARTICLE_SECTION);
    helpers.trackSectionView(ARTICLE_SECTION);

    // Drain every microtask a dynamic import could have queued.
    await Promise.resolve();
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(seoUpdateMetaTags).not.toHaveBeenCalled();
    expect(seoTrackSectionView).not.toHaveBeenCalled();
    // The blog side-loads must stay out too — they are what pairs seoService
    // with the shards and the blog-meta chunk.
    expect(loadBlogMeta).not.toHaveBeenCalled();
    expect(preloadBlogData).not.toHaveBeenCalled();
  });

  it('applies the queued meta section after load + idle, so no tag is lost', async () => {
    helpers.updateMetaTags(ARTICLE_SECTION);

    fireLoadAndIdle();

    await vi.waitFor(() => expect(seoUpdateMetaTags).toHaveBeenCalledWith(ARTICLE_SECTION));
    expect(loadBlogMeta).toHaveBeenCalled();
    expect(preloadBlogData).toHaveBeenCalled();
  });

  it('applies the queued section view after load + idle', async () => {
    helpers.trackSectionView(ARTICLE_SECTION);

    fireLoadAndIdle();

    await vi.waitFor(() => expect(seoTrackSectionView).toHaveBeenCalledWith(ARTICLE_SECTION));
  });

  it('applies only the last section requested while the window was open', async () => {
    // The hub key the effect emits while the slug is still unresolved, then the
    // real article key once resolvePendingArticle adopts it.
    helpers.updateMetaTags('blog');
    helpers.updateMetaTags('blog-lamal-vs-cmi-frontaliere');

    fireLoadAndIdle();

    await vi.waitFor(() => expect(seoUpdateMetaTags).toHaveBeenCalledTimes(1));
    expect(seoUpdateMetaTags).toHaveBeenCalledWith('blog-lamal-vs-cmi-frontaliere');
  });

  it('runs immediately once the window has closed (client-side navigation)', async () => {
    fireLoadAndIdle();
    await vi.waitFor(() => expect(helpers._isFirstPaintWindowOpen()).toBe(false));

    helpers.updateMetaTags('guida');

    // No further idle tick is granted — a tab change must retitle now.
    expect(idleCallbacks).toHaveLength(0);
    await vi.waitFor(() => expect(seoUpdateMetaTags).toHaveBeenCalledWith('guida'));
  });

  it('closes the window on a deliberate interaction, so a pre-load SPA nav retitles at once', async () => {
    helpers.updateMetaTags(ARTICLE_SECTION);
    expect(helpers._isFirstPaintWindowOpen()).toBe(true);

    window.dispatchEvent(new Event('pointerdown'));

    expect(helpers._isFirstPaintWindowOpen()).toBe(false);
    await vi.waitFor(() => expect(seoUpdateMetaTags).toHaveBeenCalledWith(ARTICLE_SECTION));
  });

  it('does not let a scroll close the window', async () => {
    helpers.updateMetaTags(ARTICLE_SECTION);

    window.dispatchEvent(new Event('scroll'));
    window.dispatchEvent(new Event('touchstart'));

    expect(helpers._isFirstPaintWindowOpen()).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(seoUpdateMetaTags).not.toHaveBeenCalled();
  });

  it('flushes on the hard deadline when `load` never fires', async () => {
    vi.useFakeTimers();
    helpers.updateMetaTags('guida');

    await vi.advanceTimersByTimeAsync(7_000);
    expect(helpers._isFirstPaintWindowOpen()).toBe(true);
    expect(seoUpdateMetaTags).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(2_000);
    expect(helpers._isFirstPaintWindowOpen()).toBe(false);
    for (let i = 0; i < 6; i += 1) await Promise.resolve();
    expect(seoUpdateMetaTags).toHaveBeenCalledWith('guida');
  });

  it('stays inert while runtime SEO is disabled', async () => {
    helpers._resetRuntimeSeoForTests(); // leaves runtimeSeoEnabled false

    helpers.updateMetaTags('blog-primo-giorno-lavoro-svizzera');
    fireLoadAndIdle();

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(seoUpdateMetaTags).not.toHaveBeenCalled();
  });
});
