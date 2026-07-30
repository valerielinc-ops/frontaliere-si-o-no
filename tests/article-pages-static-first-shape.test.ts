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

  it('the bare article indexes opt into the sibling-main shape', () => {
    const source = read('build-plugins/staticPagesPlugin.ts');
    expect(source).toContain('isBareArticleIndex');
    expect(source).toMatch(
      /isBareArticleIndex[\s\S]{0,200}?<main class="seo-static-content">\$\{rootHtml\}<\/main>/,
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
