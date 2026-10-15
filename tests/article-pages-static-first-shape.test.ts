import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const read = (rel: string) => readFileSync(resolve(__dirname, '..', rel), 'utf-8');

/**
 * #4959 — article pages must emit their SEO body OUTSIDE `#root`.
 *
 * Emitted inside `#root` the server-rendered article is destroyed by React on
 * mount, so any bundle that fails to render leaves a blank page instead of the
 * content the shard already contains. That is exactly what users saw when an
 * out-of-band registry publish stranded the SPA: `/articoli-frontaliere/` and
 * every detail URL showed only a loading skeleton, while
 * `/articoli-frontaliere/tutti/` — which has always emitted
 * `<main class="seo-static-content">` as a sibling of `#root` — rendered fully
 * from the same broken deploy.
 *
 * Keeping the body outside `#root` is also what lets a shard stay readable
 * without the app bundle, the premise of the two-repo split.
 */
const ROOT_NESTED_MAIN = '<div id="root"><main id="main-content">';

describe('article pages emit a static-first body (#4959)', () => {
  it('article detail pages do not nest the SEO body inside #root', () => {
    const source = read('packages/articles/engine/ogPagesPlugin.ts');
    expect(source).not.toContain(ROOT_NESTED_MAIN);
    expect(source).toContain('<main class="seo-static-content">');
  });

  it('article detail pages still ship an SPA mount point', () => {
    const source = read('packages/articles/engine/ogPagesPlugin.ts');
    expect(source).toContain('articleRootShell(true)');
    expect(source).toContain('articleRootShell(false)');
  });

  /**
   * #4828 — the sibling-main shape above is only HALF of the staticOverlay
   * shell contract. `build-plugins/htmlTemplate.ts` emits `#root`, then the
   * `<main class="seo-static-content">`, then `<div id="footer-root"></div>`;
   * App.tsx portals the footer into that last node on staticOverlay routes.
   * #4959 mirrored the `#root` half here and dropped the footer half, so every
   * article page opted into the contract while violating it — 3608 offenders
   * in `audit:footer-root-presence` (post-deploy validation run 30974294824),
   * up from 23. Every other `seo-static-content` emitter in the repo reaches
   * this shape through `buildSeoPageHtml`; this file is the only hand-rolled
   * one, so it is the only one that can drift.
   */
  it('every seo-static-content <main> is followed by the #footer-root portal target', () => {
    const source = read('packages/articles/engine/ogPagesPlugin.ts');

    const isComment = (line: string): boolean => {
      const t = line.trimStart();
      return t.startsWith('//') || t.startsWith('*') || t.startsWith('/*');
    };
    const emitted = source
      .split('\n')
      .filter((line) => !isComment(line))
      .filter((line) => line.includes('<main class="seo-static-content'));

    expect(emitted.length, 'expected at least one emitted seo-static-content <main>').toBeGreaterThan(0);
    for (const line of emitted) {
      expect(
        line,
        'a seo-static-content <main> emitted without the ${ARTICLE_FOOTER_ROOT} portal target — ' +
          'App.tsx would fall back to an inline footer inside #root, above the article body',
      ).toContain('</main>${ARTICLE_FOOTER_ROOT}');
    }

    expect(source).toContain("const ARTICLE_FOOTER_ROOT = '<div id=\"footer-root\"></div>'");
  });

  it('the bare article indexes opt into the sibling-main shape', () => {
    const source = read('build-plugins/staticPagesPlugin.ts');
    expect(source).toContain('isBareArticleIndex');
    expect(source).toMatch(
      /isBareArticleIndex[\s\S]{0,400}?<main class="seo-static-content">\$\{rootHtml\}<\/main>/,
    );
    // The main must stay inside the side-rail gutters: those are the
    // #rail-left-root / #rail-right-root portal targets App.tsx mounts
    // <ArticleRailAdStack> into. Emitting it bare would silently drop an ad
    // surface (see tests/build-plugins/handrolled-emitters-rail-gutters.test.ts).
    expect(source).toMatch(
      /\$\{railGridOpen\}\s*\n\s*<main class="seo-static-content">\$\{rootHtml\}<\/main>\$\{railGridClose\}/,
    );
  });

  it('the index predicates share one hoisted regex per family', () => {
    const source = read('build-plugins/staticPagesPlugin.ts');
    // A literal copied per call site is how these drift; assert each family's
    // pattern appears exactly once, in its module-scope constant.
    expect(source.match(/articoli-frontaliere\|frontier-articles/g) ?? []).toHaveLength(1);
    expect(source.match(/articoli-svizzera\|swiss-articles/g) ?? []).toHaveLength(1);
    expect(source).toContain('ARTICLES_INDEX_RX.test(canonicalPath)');
    expect(source).toContain('SVIZZERA_ARTICLES_INDEX_RX.test(canonicalPath)');
  });
});
