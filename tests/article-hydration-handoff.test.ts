// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  adoptStaticFallbackIntoRoot,
  afterRootCrossfade,
  pendingArticleSlug,
  isStaticArticleReadyForTakeover,
  removeOwnedStaticSnapshot,
  shouldKeepStaticFallbackOutsideRoot,
  shouldAdoptStaticFallbackIntoRoot,
  staticArticleFallbackRouteKey,
} from '@/services/staticFallbackHandoff';
import {
  __resetStaticArticleFallback,
  hasStaticArticleFallback,
  isStaticArticleFallbackInDocument,
  stashStaticArticleFallback,
} from '@/services/staticArticleFallback';
import { judgeStaticHandoff, type HandoffRecord, type HandoffState } from './helpers/staticHandoffProbe';

const ARTICLE_HTML = `
  <div id="root"><div class="ft-hdr-reserve"></div></div>
  <main class="seo-static-content">
    <article class="ft-blog-article">
      <h1>Articolo statico</h1>
      <p>Corpo statico visibile.</p>
    </article>
  </main>
  <div id="footer-root"></div>`;

describe('static article hydration handoff', () => {
  beforeEach(() => {
    document.body.innerHTML = ARTICLE_HTML;
  });

  it('keeps an unresolved article outside #root from the first handoff decision', () => {
    const root = document.getElementById('root')!;
    const fallback = document.querySelector<HTMLElement>('main.seo-static-content')!;
    const route = { activeTab: 'blog' as const, blogSlug: 'articolo-statico' };

    expect(pendingArticleSlug(route)).toEqual({ section: 'frontaliere', slug: 'articolo-statico' });
    expect(shouldKeepStaticFallbackOutsideRoot(route, 'article', true)).toBe(true);
    expect(staticArticleFallbackRouteKey(route, 'it')).toBe('frontaliere:articolo-statico:it');

    const shouldAdopt = shouldAdoptStaticFallbackIntoRoot(route, false, 'article', true);
    if (shouldAdopt) adoptStaticFallbackIntoRoot(root, fallback);

    expect(shouldAdopt).toBe(false);
    expect(document.querySelector('main.seo-static-content article.ft-blog-article')).not.toBeNull();
    expect(root.contains(fallback)).toBe(false);
  });

  it('keeps a known article static until the SPA signals readiness', () => {
    const route = { activeTab: 'blog' as const, blogArticle: 'articolo-noto' };

    expect(pendingArticleSlug(route)).toBeNull();
    expect(shouldKeepStaticFallbackOutsideRoot(route, 'article', true)).toBe(true);
    expect(shouldAdoptStaticFallbackIntoRoot(route, false, 'article', true)).toBe(false);
  });

  it('leaves the fallback available when adoption is not safe', () => {
    const route = { activeTab: 'blog' as const, blogSlug: 'articolo-statico' };

    expect(shouldAdoptStaticFallbackIntoRoot(route, false, 'article', false)).toBe(true);
    expect(shouldAdoptStaticFallbackIntoRoot(route, true, 'article', true)).toBe(false);
    expect(shouldAdoptStaticFallbackIntoRoot({ activeTab: 'blog', staticOverlay: true }, false, 'generic', true)).toBe(false);
  });

  it('does not release the static article when the SPA view never becomes renderable', () => {
    const base = {
      deferUntilReady: true,
      blogReady: true,
      bodyReady: true,
      articlePresent: true,
      title: 'Titolo articolo',
      titleKey: 'blog.article.noto.title',
    };

    expect(isStaticArticleReadyForTakeover({ ...base, bodySegmentCount: 0 })).toBe(false);
    expect(isStaticArticleReadyForTakeover({ ...base, title: base.titleKey, bodySegmentCount: 1 })).toBe(false);
    expect(isStaticArticleReadyForTakeover({ ...base, bodySegmentCount: 1 })).toBe(true);
  });

  it('keeps a canton topic snapshot outside #root, like an article snapshot', () => {
    const root = document.getElementById('root')!;
    const fallback = document.querySelector<HTMLElement>('main.seo-static-content')!;
    const route = { activeTab: 'blog' as const, blogSection: 'canton-ti' as const, cantonTopic: 'fisco' };

    expect(shouldKeepStaticFallbackOutsideRoot(route, 'canton-topic', true)).toBe(true);
    expect(shouldAdoptStaticFallbackIntoRoot(route, false, 'canton-topic', true)).toBe(false);
    expect(root.contains(fallback)).toBe(false);
  });

  it('keeps ordinary SPA takeover routes on the existing adoption path', () => {
    const root = document.getElementById('root')!;
    const fallback = document.querySelector<HTMLElement>('main.seo-static-content')!;
    const route = { activeTab: 'job-board' as const };

    expect(shouldAdoptStaticFallbackIntoRoot(route, false)).toBe(true);
    adoptStaticFallbackIntoRoot(root, fallback);

    expect(root.contains(fallback)).toBe(true);
    expect(root.querySelector('article.ft-blog-article')).not.toBeNull();
  });
});

describe('a static article that is on the page, and one that is only stashed', () => {
  beforeEach(() => {
    document.body.innerHTML = ARTICLE_HTML;
  });
  afterEach(() => {
    __resetStaticArticleFallback();
    document.body.innerHTML = '';
  });

  it('tells the live node outside #root from the detached clone', () => {
    const fallback = document.querySelector<HTMLElement>('main.seo-static-content')!;
    stashStaticArticleFallback(fallback, window.location.pathname);
    expect(isStaticArticleFallbackInDocument()).toBe(true);

    // Removed on the way out of the page: there is still something to
    // restore, but nothing on screen for the SPA view to wait behind.
    fallback.remove();
    expect(hasStaticArticleFallback()).toBe(true);
    expect(isStaticArticleFallbackInDocument()).toBe(false);
  });

  it('does not count a node React owns, nor the article of another URL', () => {
    const root = document.getElementById('root')!;
    const fallback = document.querySelector<HTMLElement>('main.seo-static-content')!;
    stashStaticArticleFallback(fallback, window.location.pathname);
    expect(isStaticArticleFallbackInDocument('/articoli-frontaliere/un-altro-articolo/')).toBe(false);

    root.appendChild(fallback);
    expect(isStaticArticleFallbackInDocument()).toBe(false);
  });

  it('takes an owned snapshot out with the rail grid it sits in', () => {
    document.body.innerHTML = `
      <div id="root"></div>
      <div class="ft-rail-grid">
        <aside id="rail-left-root"></aside>
        <main class="seo-static-content"><h1>Hub tematico</h1></main>
        <aside id="rail-right-root"></aside>
      </div>
      <div id="footer-root"></div>`;
    removeOwnedStaticSnapshot(document.querySelector('main.seo-static-content')!);
    expect(document.querySelector('.ft-rail-grid')).toBeNull();
    expect(document.getElementById('footer-root')).not.toBeNull();

    document.body.innerHTML = ARTICLE_HTML;
    removeOwnedStaticSnapshot(document.querySelector('main.seo-static-content')!);
    expect(document.querySelector('main.seo-static-content')).toBeNull();
    expect(document.getElementById('root')).not.toBeNull();
  });
});

describe('releasing a snapshot around the mount fade of #root', () => {
  beforeEach(() => {
    document.body.innerHTML = ARTICLE_HTML;
  });

  const frames = () => {
    const queue: Array<() => void> = [];
    return { schedule: (callback: () => void) => { queue.push(callback); }, next: () => queue.shift()?.(), pending: () => queue.length };
  };

  it('releases at once when #root is not fading', () => {
    let released = 0;
    const clock = frames();
    afterRootCrossfade(() => { released += 1; }, { schedule: clock.schedule });
    expect(released).toBe(1);
    expect(clock.pending()).toBe(0);
  });

  it('waits while #root is transparent, and releases on the frame it is opaque again', () => {
    const root = document.getElementById('root')!;
    root.style.opacity = '0';
    let released = 0;
    const clock = frames();
    afterRootCrossfade(() => { released += 1; }, { schedule: clock.schedule, now: () => 0 });
    expect(released).toBe(0);

    clock.next();
    expect(released).toBe(0);

    root.style.opacity = '1';
    clock.next();
    expect(released).toBe(1);
    expect(clock.pending()).toBe(0);
  });

  it('does not hold the snapshot forever behind a #root that never comes back', () => {
    document.getElementById('root')!.style.opacity = '0';
    let released = 0;
    let now = 0;
    const clock = frames();
    afterRootCrossfade(() => { released += 1; }, { schedule: clock.schedule, now: () => now, waitMs: 1000 });
    now = 999;
    clock.next();
    expect(released).toBe(0);
    now = 1000;
    clock.next();
    expect(released).toBe(1);
  });
});

describe('the verdict of the live handoff probe', () => {
  const state = (t: number, partial: Partial<HandoffState>): HandoffState => ({
    t, snapshot: 'none', snapshotTop: null, spaTop: null, spaMainPainted: false, ...partial,
  });
  const record = (states: HandoffState[], settled = true): HandoffRecord => ({
    states, title: 'Titolo', samples: 100, longestSampleGapMs: 20, settled, endedAt: states[states.length - 1].t + 1500, layoutShift: 0,
  });

  it('passes a snapshot that stays put until the SPA copy replaces it in one frame', () => {
    const verdict = judgeStaticHandoff(record([
      state(400, { snapshot: 'outside-visible', snapshotTop: 120 }),
      state(1500, { snapshot: 'outside-visible', snapshotTop: 121 }),
      state(2800, { snapshot: 'none', spaTop: 495, spaMainPainted: true }),
    ]));
    expect(verdict.violations).toEqual([]);
    expect(verdict).toMatchObject({ firstSnapshotMs: 400, swapMs: 2800, gapMs: 0, bothMs: 0, snapshotShiftPx: 1 });
  });

  it('fails the handoff this guard was written for: adopted into #root, then gone', () => {
    // What production did before the fix. `#root article` matched the adopted
    // static article, which is how the first probe went green on it.
    const verdict = judgeStaticHandoff(record([
      state(800, { snapshot: 'outside-visible', snapshotTop: 120 }),
      state(1100, { snapshot: 'inside-visible', snapshotTop: 120 }),
      state(1180, { snapshot: 'inside-hidden' }),
      state(1230, { snapshot: 'none' }),
      state(1950, { snapshot: 'none', spaTop: 495, spaMainPainted: true }),
    ]));
    expect(verdict.gapMs).toBe(770);
    expect(verdict.violations).toEqual([
      'the static snapshot was moved inside #root, where the first React render replaces it',
      'neither the static snapshot nor the SPA copy was on screen for 770 ms',
    ]);
  });

  it('fails a title that flashes for a frame and disappears again', () => {
    const verdict = judgeStaticHandoff(record([
      state(800, { snapshot: 'outside-visible', snapshotTop: 120 }),
      state(1200, { snapshot: 'none' }),
      state(1600, { snapshot: 'none', spaTop: 170, spaMainPainted: true }),
      state(1620, { snapshot: 'none', spaMainPainted: true }),
      state(1950, { snapshot: 'none', spaTop: 495, spaMainPainted: true }),
    ]));
    expect(verdict.swapMs).toBe(1950);
    expect(verdict.gapMs).toBe(730);
  });

  it('fails the SPA <main> painted above a snapshot it pushed down', () => {
    const verdict = judgeStaticHandoff(record([
      state(475, { snapshot: 'outside-visible', snapshotTop: 121 }),
      state(2302, { snapshot: 'outside-visible', snapshotTop: 229, spaMainPainted: true }),
      state(2788, { snapshot: 'outside-hidden', spaTop: 495, spaMainPainted: true }),
    ]));
    expect(verdict.violations).toEqual([
      'the SPA <main> was painted for 486 ms while the static snapshot owned the page',
      'the static snapshot moved by 108 px while it was on screen',
    ]);
  });

  it('fails both copies on screen at once, a page with no snapshot, and an SPA that never settles', () => {
    expect(judgeStaticHandoff(record([
      state(400, { snapshot: 'outside-visible', snapshotTop: 160 }),
      state(2640, { snapshot: 'outside-visible', snapshotTop: 160, spaTop: 238 }),
      state(2700, { snapshot: 'none', spaTop: 238, spaMainPainted: true }),
    ])).violations).toEqual(['the static snapshot and the SPA copy were both on screen for 60 ms']);

    expect(judgeStaticHandoff(record([
      state(900, { snapshot: 'none', spaTop: 238, spaMainPainted: true }),
    ])).violations).toEqual(['the static snapshot was never on screen: there was nothing to hand off']);

    expect(judgeStaticHandoff(record([
      state(400, { snapshot: 'outside-visible', snapshotTop: 120 }),
    ], false)).violations).toEqual(['the SPA never settled on its own copy within the time limit']);
  });

  it('accepts an opted-in, stable static snapshot when version skew blocks the SPA copy', () => {
    const versionSkewFallback = record([
      state(400, { snapshot: 'outside-visible', snapshotTop: 120 }),
      state(30_000, { snapshot: 'outside-visible', snapshotTop: 121 }),
    ], false);

    expect(judgeStaticHandoff(versionSkewFallback).violations).toEqual([
      'the SPA never settled on its own copy within the time limit',
    ]);
    expect(judgeStaticHandoff(versionSkewFallback, { allowStableSnapshot: true })).toMatchObject({
      swapMs: null,
      gapMs: 0,
      bothMs: 0,
      spaMainOverSnapshotMs: 0,
      snapshotShiftPx: 1,
      violations: [],
    });

    const snapshotReturnedAfterSpa = record([
      state(400, { snapshot: 'outside-visible', snapshotTop: 120 }),
      state(1200, { snapshot: 'none', spaTop: 180, spaMainPainted: true }),
      state(30_000, { snapshot: 'outside-visible', snapshotTop: 121 }),
    ], false);
    expect(judgeStaticHandoff(snapshotReturnedAfterSpa, { allowStableSnapshot: true }).violations).toEqual([
      'the SPA never settled on its own copy within the time limit',
    ]);
  });
});
