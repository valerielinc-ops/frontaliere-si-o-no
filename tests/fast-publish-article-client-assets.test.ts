import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const workflow = readFileSync(
  resolve(__dirname, '..', '.github/workflows/fast-publish-article.yml'),
  'utf-8',
);

/**
 * #4959 — fast-publish must never republish the Rollup-owned client modules.
 *
 * data/blog-articles-data.ts is imported both statically and dynamically by the
 * app, so Rollup emits the chunk with a generated namespace export and rewrites
 * the dynamic site to `.then(m => m.blogArticlesData)`. A standalone esbuild
 * build of the same source carries only `ARTICLES`; publishing it over the Vite
 * chunk made that pick resolve to `undefined` and stranded every article page on
 * its loading skeleton until the next full deploy.
 *
 * The news-ticker payload is exempt: plain JSON on a stable, hand-authored
 * contract, so `--ticker-only` stays wired.
 */
describe('fast-publish article workflow', () => {
  const invocations = [...workflow.matchAll(/publish-article-chunks\.mjs(?<args>[^\n]*)/g)];

  it('never publishes a standalone client registry outside the Vite build', () => {
    for (const match of invocations) {
      expect(match.groups?.args ?? '').toContain('--ticker-only');
    }
  });

  it('still refreshes the news-ticker payload per article', () => {
    expect(invocations).toHaveLength(1);
    expect(workflow).toContain('scripts/publish-article-chunks.mjs --ticker-only');
  });
});
