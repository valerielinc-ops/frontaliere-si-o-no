import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as np from 'node:path';
import {
  readSvizzeraArticleUnionSlugs,
  countSvizzeraArticleArchivePages,
} from '../../build-plugins/shared/svizzeraArticleUnion';
import { ARTICLES_PAGE_SIZE } from '../../build-plugins/seoHubsData';

// Repo root (two levels up from tests/build-plugins/).
const rootDir = np.resolve(__dirname, '..', '..');

/**
 * Issue #1497: the `/articoli-svizzera/tutti/page-N/` navigator
 * (staticPagesPlugin.ts) and the page emitter (seoHubsPlugin.ts
 * `emitSvizzeraArticlesHub`) must agree on the page count. Both now derive it
 * from THIS shared union helper, so the two cannot drift. These tests lock the
 * union contract that the helper reproduces from the emitter.
 */
describe('svizzeraArticleUnion · single source of truth (#1497)', () => {
  function metaOnlySlugs(): Set<string> {
    const src = fs.readFileSync(
      np.resolve(rootDir, 'services/locales/blog-meta-ch-it.ts'),
      'utf-8',
    );
    const out = new Set<string>();
    const rx = /'blog\.article\.([^']+?)\.title':\s*'(?:[^'\\]|\\.)*'/g;
    let m: RegExpExecArray | null;
    while ((m = rx.exec(src)) !== null) out.add(m[1]);
    return out;
  }

  function swissSlugKeys(): Set<string> {
    const src = fs.readFileSync(np.resolve(rootDir, 'services/routerSwissData.ts'), 'utf-8');
    const block = src.match(/const SWISS_SLUGS[\s\S]*?\n\};/m)?.[0] ?? '';
    const out = new Set<string>();
    const rx =
      /'([^']+)':\s*\{\s*it:\s*'([^']+)',\s*en:\s*'([^']+)',\s*de:\s*'([^']+)',\s*fr:\s*'([^']+)'/g;
    let m: RegExpExecArray | null;
    while ((m = rx.exec(block)) !== null) out.add(m[1]);
    return out;
  }

  it('union = meta title-keys ∪ SWISS_SLUGS keys (exact set)', () => {
    const expected = new Set<string>([...metaOnlySlugs(), ...swissSlugKeys()]);
    const actual = readSvizzeraArticleUnionSlugs(fs, np, rootDir);
    expect([...actual].sort()).toEqual([...expected].sort());
  });

  it('union is never smaller than the meta-only count (orphan-guard)', () => {
    // The original bug: the navigator counted from meta keys ONLY, which can
    // under-count the emitter's union → trailing /tutti/page-N/ pages orphaned.
    const union = readSvizzeraArticleUnionSlugs(fs, np, rootDir).size;
    const metaOnly = metaOnlySlugs().size;
    expect(union).toBeGreaterThanOrEqual(metaOnly);
  });

  it('page count = ceil(unionSize / ARTICLES_PAGE_SIZE), floored at 1', () => {
    const union = readSvizzeraArticleUnionSlugs(fs, np, rootDir).size;
    const expectedPages = Math.max(1, Math.ceil(union / ARTICLES_PAGE_SIZE));
    expect(countSvizzeraArticleArchivePages(fs, np, rootDir)).toBe(expectedPages);
  });

  it('emits a single archive page when the registry is empty (max(1, …))', () => {
    const emptyFs = {
      existsSync: () => false,
      readFileSync: () => '',
    } as unknown as typeof fs;
    expect(readSvizzeraArticleUnionSlugs(emptyFs, np, rootDir).size).toBe(0);
    expect(countSvizzeraArticleArchivePages(emptyFs, np, rootDir)).toBe(1);
  });
});
