/**
 * Issue #5352 — the rename/redirect path for ARTICLE pages.
 *
 * The premise worth stating up front, because it changes what these tests need
 * to prove: the site is not missing a redirect mechanism for renamed articles.
 * `legacyRedirectsPlugin` has emitted article rename bridges in production for
 * months (verified live 2026-08-10: `/articoli-frontaliere/tassa-transito-svizzera-2023/`
 * and `/en/cross-border-articles/transit-fee-switzerland-2023/` both answer 200
 * `noindex,follow` with the canonical pointing at their 2026 replacements).
 * What was missing was a data entry point — `data/article-redirects.json` had
 * no reader at all — and a writer that produced valid keys.
 *
 * So these tests do NOT re-litigate the bridge HTML shape (owner decision
 * #2996, already covered where it is built). They cover the three ways a
 * data-driven redirect map fails silently in production:
 *
 *   1. an entry that is syntactically wrong (wrong prefix, cross-locale,
 *      self-map, chain) — invisible until someone checks the old URL by hand;
 *   2. a bridge pointing at a target that does not exist — a redirect to a 404;
 *   3. the old slug and the new slug BOTH live — two indexable pages competing,
 *      which is the defect the `piastrellista` group already produced and that
 *      `swiss-article-canonical-overrides.json` had to clean up afterwards.
 *
 * (3) is the interesting one, because a rename is not atomic across the two
 * repos: the slug lives in the corpus (`nanakokyobashi-rgb/frontaliere-articles`),
 * the redirect lives here, and the site's copy of the registries is refreshed
 * by `pull-articles-api.mjs` on a cron. So an entry is legitimately in one of
 * two states, and illegitimately in two others:
 *
 *   from live | to live | verdict
 *   ----------+---------+-------------------------------------------------
 *   yes       | no      | OK  — rename pending upstream, bridge dormant
 *   no        | yes     | OK  — rename landed, bridge active
 *   no        | no      | FAIL — bridge points at a page that does not exist
 *   yes       | yes     | FAIL — old and new both indexable, in competition
 *
 * The dormant state is safe by construction and not by promise: the plugin
 * refuses to overwrite an `index.html` another plugin already wrote, so while
 * `from` is still a published article the bridge is simply not emitted.
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  ARTICLE_LOCALES,
  ARTICLE_REDIRECTS_FILE,
  articleSectionPrefixes,
  loadArticleRedirects,
  parseArticlePath,
  parseArticleRedirects,
  readPublishedArticlePaths,
  withTrailingSlash,
} from '../build-plugins/shared/articleRedirects.mjs';

const ROOT = resolve(__dirname, '..');
const REDIRECTS_ABS = resolve(ROOT, ARTICLE_REDIRECTS_FILE);
const PLUGIN_ABS = resolve(ROOT, 'build-plugins/legacyRedirectsPlugin.ts');

/**
 * The `from` keys of the plugin's hand-authored map, read from its SOURCE text
 * rather than by importing it.
 *
 * Importing `legacyRedirectsPlugin` pulls in `constants.ts` and
 * `searchConsoleCompat.ts`, which `import` five files under `data/` and
 * `public/assets/` at module scope — none of which exist in a sparse worktree
 * (CLAUDE.md), so the import turns this whole file red locally while staying
 * green in CI. That asymmetry is worse than a source scan: the scan is exact
 * about what it reads (single-quoted `'/path/': '/path/'` pairs at the top of
 * the literal) and runs identically everywhere.
 */
function hardcodedRedirectSources(): Set<string> {
  const src = readFileSync(PLUGIN_ABS, 'utf-8');
  const out = new Set<string>();
  for (const m of src.matchAll(/^\s*'(\/[^']*)':\s*'\/[^']*',/gm)) out.add(withTrailingSlash(m[1]));
  return out;
}

describe('articleSectionPrefixes — derived, not hand-copied', () => {
  it('covers both sections in all four locales with the real URL prefixes', () => {
    const prefixes = [...articleSectionPrefixes().keys()].sort();
    expect(prefixes).toEqual([
      '/articoli-frontaliere/',
      '/articoli-svizzera/',
      '/de/grenzgaenger-artikel/',
      '/de/schweiz-artikel/',
      '/en/cross-border-articles/',
      '/en/swiss-articles/',
      '/fr/articles-frontalier/',
      '/fr/articles-suisse/',
    ]);
  });

  it('has one entry per section per locale', () => {
    expect(articleSectionPrefixes().size).toBe(2 * ARTICLE_LOCALES.length);
  });

  /**
   * The bug this replaces: addRedirectMapping built `/{loc}/articoli-frontaliere/`
   * for all four locales. Three of those four are URLs that never existed.
   */
  it('never builds the IT hub slug under a non-IT locale prefix', () => {
    const prefixes = new Set(articleSectionPrefixes().keys());
    for (const locale of ['en', 'de', 'fr']) {
      expect(prefixes.has(`/${locale}/articoli-frontaliere/`)).toBe(false);
      expect(prefixes.has(`/${locale}/articoli-svizzera/`)).toBe(false);
    }
  });
});

describe('parseArticlePath', () => {
  it.each([
    ['/articoli-frontaliere/gaggiolo-traffico/', 'it', 'frontaliere'],
    ['/en/cross-border-articles/gaggiolo-traffic/', 'en', 'frontaliere'],
    ['/de/grenzgaenger-artikel/gaggiolo-verkehr/', 'de', 'frontaliere'],
    ['/fr/articles-frontalier/gaggiolo-traffic/', 'fr', 'frontaliere'],
    ['/en/swiss-articles/terzo-pilastro-3a/', 'en', 'svizzera'],
  ])('parses %s as %s/%s', (path, locale, section) => {
    const parsed = parseArticlePath(path);
    expect(parsed).not.toBeNull();
    expect(parsed!.locale).toBe(locale);
    expect(parsed!.section).toBe(section);
  });

  it('normalizes a missing trailing slash', () => {
    expect(parseArticlePath('/en/cross-border-articles/x-y')!.path)
      .toBe('/en/cross-border-articles/x-y/');
  });

  it.each([
    ['a section hub', '/articoli-frontaliere/'],
    ['a non-article page', '/guida-frontaliere/permessi-di-lavoro/'],
    ['a job page', '/cerca-lavoro-ticino/qualcosa/'],
    ['a nested path under the hub', '/articoli-frontaliere/a/b/'],
    ['an absolute URL', 'https://frontaliereticino.ch/articoli-frontaliere/x/'],
    ['a relative path', 'articoli-frontaliere/x/'],
    ['a query string', '/articoli-frontaliere/x/?utm=1'],
    ['an uppercase slug', '/articoli-frontaliere/Gaggiolo/'],
    ['a non-string', 42],
  ])('rejects %s', (_label, value) => {
    expect(parseArticlePath(value as string)).toBeNull();
  });
});

describe('parseArticleRedirects — fail-closed validation', () => {
  it('accepts a well-formed within-locale rename and normalizes both sides', () => {
    expect(parseArticleRedirects({
      '/en/cross-border-articles/slug-old': '/en/cross-border-articles/new',
    })).toEqual({
      '/en/cross-border-articles/slug-old/': '/en/cross-border-articles/new/',
    });
  });

  it('allows a cross-section rename within one locale (consolidation)', () => {
    expect(parseArticleRedirects({
      '/en/swiss-articles/a/': '/en/cross-border-articles/b/',
    })).toEqual({ '/en/swiss-articles/a/': '/en/cross-border-articles/b/' });
  });

  it.each([
    ['a key that is not an article URL', { '/guida-frontaliere/x/': '/articoli-frontaliere/y/' }],
    ['a value that is not an article URL', { '/articoli-frontaliere/x/': '/guida-frontaliere/y/' }],
    ['a value that is a section hub', { '/articoli-frontaliere/x/': '/articoli-frontaliere/' }],
    ['a non-string value', { '/articoli-frontaliere/x/': 3 }],
    ['a self-map', { '/articoli-frontaliere/x/': '/articoli-frontaliere/x' }],
    ['an array', ['/articoli-frontaliere/x/']],
    ['null', null],
  ])('throws on %s', (_label, raw) => {
    expect(() => parseArticleRedirects(raw)).toThrow();
  });

  /**
   * hreflang is per-article-cluster: bridging /en/… to /it/… tells Google the
   * EN page's canonical is an IT page, which drops the EN article from the
   * cluster instead of moving it.
   */
  it('throws on a cross-locale pair', () => {
    expect(() => parseArticleRedirects({
      '/en/cross-border-articles/x/': '/articoli-frontaliere/y/',
    })).toThrow(/attraversa i locali/);
  });

  /** Googlebot follows one hop of a canonical+noindex bridge, not two. */
  it('throws on a chain a → b → c', () => {
    expect(() => parseArticleRedirects({
      '/articoli-frontaliere/a/': '/articoli-frontaliere/b/',
      '/articoli-frontaliere/b/': '/articoli-frontaliere/c/',
    })).toThrow(/catena di redirect/);
  });

  it('throws when the same key is declared with and without the trailing slash', () => {
    expect(() => parseArticleRedirects({
      '/articoli-frontaliere/a': '/articoli-frontaliere/b/',
      '/articoli-frontaliere/a/': '/articoli-frontaliere/c/',
    })).toThrow(/due volte/);
  });
});

describe('loadArticleRedirects', () => {
  it('warns and returns {} when the file is absent, instead of throwing', () => {
    const warnings: string[] = [];
    const loaded = loadArticleRedirects('/nowhere', {
      existsSync: () => false,
      warn: (m: string) => warnings.push(m),
    });
    expect(loaded).toEqual({});
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(ARTICLE_REDIRECTS_FILE);
  });

  it('throws on malformed JSON rather than silently emitting nothing', () => {
    expect(() => loadArticleRedirects(ROOT, {
      existsSync: () => true,
      readFileSync: () => '{ not json',
    })).toThrow(/JSON non valido/);
  });
});

describe(`${ARTICLE_REDIRECTS_FILE} — the real file`, () => {
  /**
   * The file's presence is asserted HERE, not in the loader: the loader must
   * tolerate its absence (sparse worktrees have no `data/`), and this test runs
   * on a full checkout. Without this assertion "no file" would read as "no
   * redirects" everywhere and nothing would ever say otherwise.
   */
  it('exists and is tracked', () => {
    expect(existsSync(REDIRECTS_ABS), `${ARTICLE_REDIRECTS_FILE} must exist`).toBe(true);
  });

  it('passes the same validator the build reads it with', () => {
    expect(() => parseArticleRedirects(JSON.parse(readFileSync(REDIRECTS_ABS, 'utf-8')))).not.toThrow();
  });

  it('is no longer inert (issue #5352: it stayed {} from 2026-05-27 because nothing read it)', () => {
    const entries = Object.entries(loadArticleRedirects(ROOT));
    expect(entries.length).toBeGreaterThan(0);
  });

  it('declares no redirect the plugin already hardcodes', () => {
    const hardcoded = hardcodedRedirectSources();
    // Guard against the scan silently matching nothing and passing vacuously.
    expect(hardcoded.size, 'source scan of legacyRedirectsPlugin.ts found no entries').toBeGreaterThan(50);
    const duplicates = Object.keys(loadArticleRedirects(ROOT)).filter((from) => hardcoded.has(from));
    expect(duplicates, 'declare each redirect once, in one of the two places').toEqual([]);
  });
});

describe('every entry is in a valid phase of a rename (see the truth table above)', () => {
  const redirects = existsSync(REDIRECTS_ABS) ? loadArticleRedirects(ROOT) : {};
  const published = readPublishedArticlePaths(ROOT);
  const entries = Object.entries(redirects);

  it('reads the published slugs from both section registries', () => {
    // These live under packages/articles/content/ and are present in EVERY
    // worktree (unlike public/ and data/), which is what makes the assertions
    // below satisfiable rather than vacuous.
    expect(published.missing, `registries not readable: ${published.missing.join(', ')}`).toEqual([]);
    expect(published.paths.size).toBeGreaterThan(100);
  });

  it.each(entries)('%s → %s is not a bridge to a page that does not exist', (from, to) => {
    if (published.paths.has(from)) return; // rename still pending upstream
    expect(
      published.paths.has(to),
      `${from} no longer exists, so its bridge target ${to} must — otherwise the bridge is a redirect to a 404`,
    ).toBe(true);
  });

  it.each(entries)('%s → %s does not leave two competing indexable pages', (from, to) => {
    expect(
      published.paths.has(from) && published.paths.has(to),
      `${from} and ${to} are BOTH published: the old URL keeps a self-canonical 200 and shadows the bridge`,
    ).toBe(false);
  });

  /**
   * Not covered by the truth table because it is upstream of it: a bridge whose
   * target still carries the prompt placeholder would just move the problem.
   */
  it.each(entries)('%s → %s does not redirect to another placeholder slug', (_from, to) => {
    expect(to).not.toMatch(/\/slug-[^/]+\/$/);
  });
});
