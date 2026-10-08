// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import {
  adoptStaticFallbackIntoRoot,
  shouldAdoptStaticFallbackIntoRoot,
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

    const shouldAdopt = shouldAdoptStaticFallbackIntoRoot(route, false);
    if (shouldAdopt) adoptStaticFallbackIntoRoot(root, fallback);

    expect(shouldAdopt).toBe(false);
    expect(document.querySelector('main.seo-static-content article.ft-blog-article')).not.toBeNull();
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
