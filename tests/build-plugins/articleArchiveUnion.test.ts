import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as np from 'node:path';
import {
  readArticleArchiveUnionSlugs,
  countArticleArchivePages,
  readSvizzeraArticleUnionSlugs,
  countSvizzeraArticleArchivePages,
  readFrontaliereArticleUnionSlugs,
  countFrontaliereArticleArchivePages,
} from '../../build-plugins/shared/articleArchiveUnion';
import { ARTICLES_PAGE_SIZE } from '../../build-plugins/seoHubsData';
import { ARTICLE_SECTIONS, type ArticleSection } from '../../services/articleSections';

// Repo root (two levels up from tests/build-plugins/).
const rootDir = np.resolve(__dirname, '..', '..');

/**
 * Issue #1497 (svizzera) + #1486 / reviewer follow-up (frontaliere/master): the
 * `/{hub}/tutti/page-N/` navigator (staticPagesPlugin.ts) and the page emitter
 * (seoHubsPlugin.ts — `renderArticleHubPagesCore`, one call per section since
 * #4881 consolidated the former `emitHub` `articles` branch / standalone
 * `emitSvizzeraArticlesHub`) must agree on the page count. Both now derive it from THIS shared, section-
 * parameterized union helper, so the two cannot drift — and neither can the two
 * sections drift from each other. These tests lock the union contract that the
 * helper reproduces from each section's emitter.
 */

function metaOnlySlugs(section: ArticleSection): Set<string> {
  const cfg = ARTICLE_SECTIONS[section];
  const src = fs.readFileSync(
    np.resolve(rootDir, 'services/locales', `${cfg.metaPrefix}-it.ts`),
    'utf-8',
  );
  const out = new Set<string>();
  const rx = /'blog\.article\.([^']+?)\.title':\s*'(?:[^'\\]|\\.)*'/g;
  let m: RegExpExecArray | null;
  while ((m = rx.exec(src)) !== null) out.add(m[1]);
  return out;
}

function slugMapKeys(section: ArticleSection): Set<string> {
  const cfg = ARTICLE_SECTIONS[section];
  const src = fs.readFileSync(np.resolve(rootDir, cfg.slugDataFile), 'utf-8');
  const block = src.match(new RegExp(`const ${cfg.slugConst}[\\s\\S]*?\\n\\};`, 'm'))?.[0] ?? '';
  const out = new Set<string>();
  const rx =
    /'([^']+)':\s*\{\s*it:\s*'([^']+)',\s*en:\s*'([^']+)',\s*de:\s*'([^']+)',\s*fr:\s*'([^']+)'/g;
  let m: RegExpExecArray | null;
  while ((m = rx.exec(block)) !== null) out.add(m[1]);
  return out;
}

describe.each<ArticleSection>(['svizzera', 'frontaliere'])(
  'articleArchiveUnion · single source of truth · %s',
  (section) => {
    it('union = meta title-keys ∪ slug-map keys (exact set)', () => {
      const expected = new Set<string>([...metaOnlySlugs(section), ...slugMapKeys(section)]);
      const actual = readArticleArchiveUnionSlugs(fs, np, rootDir, section);
      expect([...actual].sort()).toEqual([...expected].sort());
    });

    it('union is never smaller than the meta-only count (orphan-guard)', () => {
      // The original bug: the navigator counted from meta keys ONLY, which can
      // under-count the emitter's union → trailing /tutti/page-N/ pages orphaned.
      const union = readArticleArchiveUnionSlugs(fs, np, rootDir, section).size;
      const metaOnly = metaOnlySlugs(section).size;
      expect(union).toBeGreaterThanOrEqual(metaOnly);
    });

    it('page count = ceil(unionSize / ARTICLES_PAGE_SIZE), floored at 1', () => {
      const union = readArticleArchiveUnionSlugs(fs, np, rootDir, section).size;
      const expectedPages = Math.max(1, Math.ceil(union / ARTICLES_PAGE_SIZE));
      expect(countArticleArchivePages(fs, np, rootDir, section)).toBe(expectedPages);
    });

    it('emits a single archive page when the registry is empty (max(1, …))', () => {
      const emptyFs = {
        existsSync: () => false,
        readFileSync: () => '',
      } as unknown as typeof fs;
      expect(readArticleArchiveUnionSlugs(emptyFs, np, rootDir, section).size).toBe(0);
      expect(countArticleArchivePages(emptyFs, np, rootDir, section)).toBe(1);
    });
  },
);

describe('articleArchiveUnion · section convenience wrappers', () => {
  it('svizzera wrappers delegate to the generic helper', () => {
    expect([...readSvizzeraArticleUnionSlugs(fs, np, rootDir)].sort()).toEqual(
      [...readArticleArchiveUnionSlugs(fs, np, rootDir, 'svizzera')].sort(),
    );
    expect(countSvizzeraArticleArchivePages(fs, np, rootDir)).toBe(
      countArticleArchivePages(fs, np, rootDir, 'svizzera'),
    );
  });

  it('frontaliere wrappers delegate to the generic helper', () => {
    expect([...readFrontaliereArticleUnionSlugs(fs, np, rootDir)].sort()).toEqual(
      [...readArticleArchiveUnionSlugs(fs, np, rootDir, 'frontaliere')].sort(),
    );
    expect(countFrontaliereArticleArchivePages(fs, np, rootDir)).toBe(
      countArticleArchivePages(fs, np, rootDir, 'frontaliere'),
    );
  });

  it('frontaliere/master union strictly EXCEEDS meta-only today (live drift)', () => {
    // The reviewer 🔴: BLOG_SLUGS carries entries with no meta title
    // (iniziativa-salari-ticino, cantieri-traffico-a9-ticino) → the meta-only
    // navigator count under-counts the emitter union. This asserts the drift is
    // real (not hypothetical) so the union-based navigator is load-bearing.
    const union = readFrontaliereArticleUnionSlugs(fs, np, rootDir).size;
    const metaOnly = metaOnlySlugs('frontaliere').size;
    expect(union).toBeGreaterThan(metaOnly);
  });
});
