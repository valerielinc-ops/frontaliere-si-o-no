/**
 * SPA-takeover handoff of a body-level crawler fallback into `#root` (CLS).
 *
 * SPA-owned routes (router `staticOverlay` falsy — job detail, search, and
 * legacy job-board HTML…) ship their crawler-facing `<main
 * class="seo-static-content">` (or `main.cluster-seo-prose`) OUTSIDE `#root`,
 * usually wrapped in the build-time `.ft-rail-grid`. index.tsx moves it INTO
 * `#root` right before `createRoot().render()`, so React replaces it in place
 * under the reserved height instead of App.tsx collapsing it from outside.
 * The current job-board generator emits its static main inside `#root` and
 * therefore does not need this runtime move.
 *
 * Legacy generic hub fallbacks can also emit the static hub sub-nav
 * `nav.seo-hub-subnav` as a BODY-DIRECT sibling BETWEEN `#root` and the
 * fallback. Moving only the fallback reorders the document:
 * the fallback jumps above the sub-nav, and the 100px sub-nav is thrown from
 * just under the header to below the whole listing — a 0.106 layout shift on
 * desktop measured with Playwright attribution against production (#8868).
 * Adopting the sub-nav together with the fallback, in its original order,
 * keeps both exactly where they were painted; React then clears `#root` and
 * renders its own interactive SubTabNav in the same place.
 *
 * Pure DOM, no React: index.tsx owns the timing (after App has loaded, before
 * the crossfade reserve is measured).
 */
import type { AppRoute } from '@/services/router';
import type { ArticleSection } from '@/services/articleSections';

export type StaticFallbackKind = 'article' | 'canton-topic' | 'generic';

/** Return the unresolved article identity carried by a route, if any. */
export function pendingArticleSlug(route: AppRoute): { section: ArticleSection; slug: string } | null {
  if (route.activeTab !== 'blog') return null;
  if (route.blogSection === 'svizzera') {
    return route.swissSlug && !route.swissArticle
      ? { section: 'svizzera', slug: route.swissSlug }
      : null;
  }
  if (route.blogSection?.startsWith('canton-')) {
    return route.cantonSlug && !route.cantonArticle
      ? { section: route.blogSection, slug: route.cantonSlug }
      : null;
  }
  return route.blogSlug && !route.blogArticle
    ? { section: 'frontaliere', slug: route.blogSlug }
    : null;
}

function isArticleDetailRoute(route: AppRoute): boolean {
  return route.activeTab === 'blog'
    && Boolean(
      route.blogSlug
      || route.blogArticle
      || route.swissSlug
      || route.swissArticle
      || route.cantonSlug
      || route.cantonArticle,
    );
}

/**
 * Single ownership decision for static fallbacks that must survive the first
 * React render. The caller supplies presence because this function is pure.
 */
export function shouldKeepStaticFallbackOutsideRoot(
  route: AppRoute,
  kind: StaticFallbackKind,
  fallbackPresent: boolean,
): boolean {
  if (!fallbackPresent) return false;
  if (kind === 'article') return isArticleDetailRoute(route);
  if (kind === 'canton-topic') return route.activeTab === 'blog' && !!route.cantonTopic && !route.staticOverlay;
  return false;
}

/** Stable identity used to pair readiness with one article URL. */
export function staticArticleFallbackKey(section: string, article: string, locale: string): string {
  return `${section}:${article}:${locale}`;
}

/** Build the readiness key for an article route, including unresolved slugs. */
export function staticArticleFallbackRouteKey(route: AppRoute, locale: string): string | null {
  if (!isArticleDetailRoute(route)) return null;
  const article = route.blogArticle
    || route.blogSlug
    || route.swissArticle
    || route.swissSlug
    || route.cantonArticle
    || route.cantonSlug;
  if (!article) return null;
  return staticArticleFallbackKey(route.blogSection || 'frontaliere', article, locale);
}

export interface StaticArticleReadiness {
  deferUntilReady: boolean;
  blogReady: boolean;
  bodyReady: boolean;
  articlePresent: boolean;
  title: string;
  titleKey: string;
  bodySegmentCount: number;
}

/** The exact payload required before the SPA may replace a static article. */
export function isStaticArticleReadyForTakeover(input: StaticArticleReadiness): boolean {
  return input.deferUntilReady
    && input.blogReady
    && input.bodyReady
    && input.articlePresent
    && input.title.trim().length > 0
    && input.title !== input.titleKey
    && input.bodySegmentCount > 0;
}

/**
 * Marks a static snapshot the SPA left OUTSIDE `#root` to own the body until
 * its own view is ready. App.tsx sets it; it is never in the served HTML.
 */
export const STATIC_SNAPSHOT_OWNER_ATTR = 'data-ft-snapshot-owner';

/**
 * Take a body-owning snapshot out of the document for good, with the
 * build-time rail grid it may sit in.
 *
 * Removed, not hidden. Hidden it would stay in the DOM as a second copy of the
 * page (two `<h1>` for a crawler that renders), its rail grid would stay in the
 * flow as an empty band after the footer, and the next client-side move would
 * find it and show it as the content of whatever page came next.
 */
export function removeOwnedStaticSnapshot(snapshot: Element): void {
  (snapshot.closest('.ft-rail-grid') ?? snapshot).remove();
}

/** How long {@link afterRootCrossfade} waits for `#root` before releasing anyway. */
export const ROOT_CROSSFADE_WAIT_MS = 10_000;

export interface RootCrossfadeEnv {
  root?: HTMLElement | null;
  /** Run a callback on the next frame. */
  schedule?: (callback: () => void) => unknown;
  now?: () => number;
  waitMs?: number;
}

/**
 * Run `release` once `#root` is opaque again.
 *
 * The mount fades `#root` out and back in around the first render
 * ({@link hideRootForCrossfade}). A snapshot kept OUTSIDE `#root` is not part of
 * that fade: releasing it while `#root` is still transparent would swap an
 * article a reader can see for one they cannot. It takes warm caches for the
 * SPA view to be ready that early, which is exactly a returning reader.
 *
 * Synchronous when no fade is in progress — the ordinary case, and the one
 * that keeps the swap inside the commit that drew the SPA view. Bounded, so a
 * `#root` that never comes back cannot hold the snapshot for the session.
 */
export function afterRootCrossfade(release: () => void, env: RootCrossfadeEnv = {}): void {
  const root = env.root !== undefined ? env.root : document.getElementById('root');
  const opaque = () => !root || !root.isConnected
    || Number.parseFloat(window.getComputedStyle(root).opacity || '1') >= 0.99;
  if (opaque()) {
    release();
    return;
  }
  const schedule = env.schedule ?? ((callback: () => void) => window.requestAnimationFrame(callback));
  const now = env.now ?? (() => performance.now());
  const deadline = now() + (env.waitMs ?? ROOT_CROSSFADE_WAIT_MS);
  const check = () => {
    if (opaque() || now() >= deadline) release();
    else schedule(check);
  };
  schedule(check);
}

/**
 * Whether the entry should perform the existing body-level fallback adoption.
 *
 * This is deliberately extracted before the article-specific ownership rule is
 * added: the entry point and its tests must share the same gate, while the
 * generic SPA takeover behavior remains unchanged.
 */
export function shouldAdoptStaticFallbackIntoRoot(
  route: AppRoute,
  hasPlateAuctionFallback: boolean,
  kind: StaticFallbackKind = 'generic',
  fallbackPresent = false,
): boolean {
  return !route.staticOverlay
    && !hasPlateAuctionFallback
    && !shouldKeepStaticFallbackOutsideRoot(route, kind, fallbackPresent);
}

export interface StaticFallbackAdoption {
  /** The static sub-nav that was moved along with the fallback, if any. */
  subnav: HTMLElement | null;
  /** The build-time rail wrapper that was hidden, if any. */
  railWrap: HTMLElement | null;
}

const isBetween = (before: Node, node: Node, after: Node): boolean =>
  Boolean(before.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING)
  && Boolean(node.compareDocumentPosition(after) & Node.DOCUMENT_POSITION_FOLLOWING);

/**
 * Move an outside-`#root` `fallback` (and the body-level static hub sub-nav
 * painted above it) to the end of `root`, preserving their visual order, and
 * hide the now-empty `.ft-rail-grid` wrapper the fallback came from. Static
 * hubs emitted inside `#root` are already adopted and remain in place.
 */
export function adoptStaticFallbackIntoRoot(
  root: HTMLElement,
  fallback: HTMLElement,
): StaticFallbackAdoption {
  if (root.contains(fallback)) return { subnav: null, railWrap: null };

  const doc = root.ownerDocument;
  const railWrap = fallback.closest<HTMLElement>('.ft-rail-grid');
  const anchor = railWrap ?? fallback;

  // Only a sub-nav that is a direct child of <body> and sits between #root and
  // the fallback belongs to this handoff; any other nav is left untouched.
  let subnav: HTMLElement | null = null;
  for (const el of Array.from(doc.body.children)) {
    if (el.tagName === 'NAV'
      && el.classList.contains('seo-hub-subnav')
      && isBetween(root, el, anchor)) {
      subnav = el as HTMLElement;
      break;
    }
  }

  fallback.style.removeProperty('display');
  if (subnav) root.appendChild(subnav);
  root.appendChild(fallback);
  if (railWrap) railWrap.style.display = 'none';
  return { subnav, railWrap };
}

/**
 * User-timing mark set right before `#root` (the static HTML, after the
 * adoption above) goes to `opacity: 0` for the crossfade. The Lighthouse CI
 * check `scripts/ci/lighthouse-first-paint-order.mjs` reads it from the LHR
 * `user-timings` audit and compares it with the observed first contentful
 * paint: the static HTML must have painted BEFORE this mark.
 */
export const STATIC_HANDOFF_HIDE_MARK = 'ft:static-handoff-hide';

/**
 * Upper bound on how long the mount waits for the static HTML's first
 * contentful paint. The slow Lighthouse runner observed on issue 11666
 * produced that paint 1.3–2.35 s after navigation on
 * /cerca-lavoro-ticino/, so the bound leaves measured headroom while keeping
 * a page with no paint from holding the SPA handoff forever.
 */
export const STATIC_FIRST_PAINT_TIMEOUT_MS = 3000;

export interface StaticFirstPaintEnv {
  doc?: Pick<Document, 'visibilityState'>;
  /** Paint entries already recorded (`performance.getEntriesByType('paint')`). */
  paintEntries?: () => ReadonlyArray<{ name: string }>;
  /** Subscribe to the next paint entry; returns an unsubscribe function. */
  observePaint?: (onPaint: () => void) => () => void;
  setTimer?: (cb: () => void, ms: number) => unknown;
  timeoutMs?: number;
}

const defaultPaintEntries = (): ReadonlyArray<{ name: string }> => {
  try {
    return typeof performance === 'undefined' ? [] : performance.getEntriesByType('paint');
  } catch {
    return [];
  }
};

const defaultObservePaint = (onPaint: () => void): (() => void) => {
  if (typeof PerformanceObserver === 'undefined') return () => {};
  try {
    const observer = new PerformanceObserver(() => onPaint());
    observer.observe({ type: 'paint', buffered: true });
    return () => observer.disconnect();
  } catch {
    return () => {};
  }
};

const hasFirstContentfulPaint = (entries: ReadonlyArray<{ name: string }>): boolean =>
  entries.some((entry) => entry.name === 'first-contentful-paint');

/**
 * Resolve once the browser has PAINTED content from the static HTML (a
 * `first-contentful-paint` entry exists), or after `timeoutMs`.
 *
 * Why: the SPA mount hides the static HTML (`opacity: 0` on `#root`, see
 * {@link hideRootForCrossfade}). On the Lighthouse runner the browser defers
 * its first main frame until ~1.3 s after navigation on /cerca-lavoro-ticino/
 * while the mount hides #root at ~1.0 s, so the first frame paints an
 * invisible page and the first contentful paint waits for the React fade-in
 * at ~2.3 s: simulated mobile FCP 8.7-9.1 s on 5/5 loads (issue 11666). An
 * animation-frame wait does not help: animation frames are deferred with the
 * main frame, so a short timeout would hide before the paint anyway. The
 * A `first-paint` entry is not enough here: the hub shell deliberately starts
 * with an empty header-height reserve in `#root`, so that first frame can be
 * non-contentful while the crawler-facing HTML is still waiting to paint.
 * `first-contentful-paint` is the signal that something useful reached the
 * screen before the handoff.
 *
 * Bounded: a hidden document (background tab, speculation-rules prerender)
 * does not paint, so it does not wait at all; a visible one waits at most
 * `timeoutMs` and then proceeds exactly as before.
 */
export function waitForStaticFirstPaint(env: StaticFirstPaintEnv = {}): Promise<void> {
  const doc = env.doc ?? document;
  if (doc.visibilityState !== 'visible') return Promise.resolve();
  const paintEntries = env.paintEntries ?? defaultPaintEntries;
  const hasPaintedContent = () => hasFirstContentfulPaint(paintEntries());
  if (hasPaintedContent()) return Promise.resolve();
  const observePaint = env.observePaint ?? defaultObservePaint;
  const setTimer = env.setTimer ?? ((cb: () => void, ms: number) => window.setTimeout(cb, ms));
  const timeoutMs = env.timeoutMs ?? STATIC_FIRST_PAINT_TIMEOUT_MS;
  return new Promise<void>((resolve) => {
    let done = false;
    let unsubscribe: () => void = () => {};
    const finish = () => {
      if (done) return;
      done = true;
      unsubscribe();
      resolve();
    };
    const finishIfContentfulPainted = () => {
      if (hasPaintedContent()) finish();
    };
    unsubscribe = observePaint(finishIfContentfulPainted);
    // Close the small race where FCP is recorded between the initial check and
    // PerformanceObserver registration (the observer's buffered delivery is
    // asynchronous in Chromium).
    finishIfContentfulPainted();
    if (done) unsubscribe();
    setTimer(finish, timeoutMs);
  });
}

/**
 * Start the static → React crossfade: reserve `#root`'s painted height as a
 * min-height floor (CLS #886/#855 — createRoot().render() empties #root for a
 * moment), mark {@link STATIC_HANDOFF_HIDE_MARK}, then fade `#root` out.
 * Call only after {@link waitForStaticFirstPaint}.
 */
export function hideRootForCrossfade(
  root: HTMLElement,
  perf: Pick<Performance, 'mark'> | undefined = typeof performance === 'undefined' ? undefined : performance,
): void {
  const reservedRootHeight = root.offsetHeight;
  if (reservedRootHeight > 0) root.style.minHeight = `${reservedRootHeight}px`;
  try {
    perf?.mark(STATIC_HANDOFF_HIDE_MARK);
  } catch {
    /* user timing unavailable — the mark is diagnostics only */
  }
  root.style.transition = 'opacity 80ms ease-out';
  root.style.opacity = '0';
}
