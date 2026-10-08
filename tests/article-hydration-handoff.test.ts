// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import {
  adoptStaticFallbackIntoRoot,
 pendingArticleSlug,
 isStaticArticleReadyForTakeover,
 shouldKeepStaticFallbackOutsideRoot,
  shouldAdoptStaticFallbackIntoRoot,
 staticArticleFallbackRouteKey,
} from '@/services/staticFallbackHandoff';

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
