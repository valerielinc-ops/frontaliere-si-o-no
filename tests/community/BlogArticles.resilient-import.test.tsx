/**
 * Source-level regression for issue #4176.
 *
 * The blog data chunk (data/blog-articles-data.ts → the non-hashed
 * blog-articles-data.js on the CDN) is loaded via a dynamic import() in the
 * mount effect. A plain, unwrapped import() surfaces a transient CDN
 * deploy-window failure ("Failed to fetch dynamically imported module:
 * .../blog-articles-data.js") straight to the user and the error monitor,
 * instead of self-healing. Every other stale-deploy-prone dynamic import in
 * the app is wrapped in resilientImport() (cache-bust + budgeted reload).
 *
 * These assertions guard against the wrapper being removed / regressing back
 * to a bare import().
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const read = (rel: string) => readFileSync(resolve(__dirname, '..', '..', rel), 'utf8');
const SOURCE = read('components/community/BlogArticles.tsx');

// Every CLIENT component that lazy-loads the non-hashed blog-articles-data
// chunk must wrap the import() so a CDN deploy-window failure self-heals
// (#4176 sibling-class fix, AGENTS.md §Non-Negotiables #6). A bare import()
// of this chunk in any of these files is the regression to catch.
const CLIENT_DATA_CHUNK_CONSUMERS = [
  'components/community/BlogArticles.tsx',
  'components/community/JobBoard.tsx',
  'components/shared/SiteSearch.tsx',
];

describe('BlogArticles — data chunk import is stale-deploy resilient (#4176)', () => {
  it('imports the resilientImport helper', () => {
    expect(SOURCE).toMatch(
      /import\s*\{\s*resilientImport\s*\}\s*from\s*['"]@\/services\/resilientImport['"]/,
    );
  });

  it('wraps the blog-articles-data import() in resilientImport with an export guard', () => {
    expect(SOURCE).toMatch(
      /resilientImport\(\s*\(\)\s*=>\s*import\(['"]@\/data\/blog-articles-data['"]\)\s*,\s*[^)]*ARTICLES/,
    );
  });

  it('wraps the swiss-articles-data import() in resilientImport with an export guard', () => {
    expect(SOURCE).toMatch(
      /resilientImport\(\s*\(\)\s*=>\s*import\(['"]@\/data\/swiss-articles-data['"]\)\s*,\s*[^)]*SWISS_ARTICLES/,
    );
  });

  it.each(CLIENT_DATA_CHUNK_CONSUMERS)(
    'does not load the data chunk via a bare, unwrapped import() in %s',
    (rel) => {
      const src = read(rel);
      // A bare `import('@/data/blog-articles-data')` NOT preceded by
      // `resilientImport(() => ` is the regression we are guarding against.
      expect(src).not.toMatch(/(?<!\(\)\s=>\s)\bimport\(['"]@\/data\/blog-articles-data['"]\)/);
      expect(src).not.toMatch(/(?<!\(\)\s=>\s)\bimport\(['"]@\/data\/swiss-articles-data['"]\)/);
    },
  );

  it.each(CLIENT_DATA_CHUNK_CONSUMERS)(
    'imports the resilientImport helper in %s',
    (rel) => {
      expect(read(rel)).toMatch(/resilientImport\b/);
    },
  );
});
