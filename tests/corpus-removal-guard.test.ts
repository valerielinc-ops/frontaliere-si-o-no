/**
 * Regression test for the corpus-sync registry gate.
 *
 * THE INCIDENT IT PINS (2026-08-07, all times UTC)
 *   04:43  the site's own `generate-article.yml` writes
 *          `rimborsi-730-sostituti-imposta` into THIS repo (commit faa48840d).
 *          nanako, which has owned the corpus since the cutover, never had it.
 *   07:10  `sync-articles-sitemaps.yml` mirrors nanako over the site
 *          (commit 10c8c8178). `mirrorTree` deletes the article — from
 *          `SWISS_SLUGS`, from the meta files, from the bodies. The only guard
 *          was a file COUNT, and the same commit added three other articles, so
 *          the counts netted out and it never fired.
 *   ——     the shard keeps serving all four locale URLs 200, and
 *          `sitemap-news.xml` keeps announcing the slug (correctly — it is
 *          inside the 48h Google News window). A sitemap now names a slug no
 *          registry knows: `tests/blog-slugs-sitemap-sync.test.ts` goes red on
 *          `main` and blocks seven PRs.
 *   08:32  a human restores it upstream by hand (nanako PR #20).
 *
 * So the removal did NOT self-heal. Nothing in the automation restores an
 * article the corpus never had — the corpus is what it syncs from.
 *
 * THE CRITERION. A withdrawal is legitimate when a human recorded it in the
 * `redirects` table of `build-plugins/legacyRedirectsPlugin.ts` — the bridge
 * that keeps a retired URL from becoming a bare 404 (PR #5299, four articles,
 * 16 URLs). No entry there = nobody decided = refuse.
 *
 * Hermetic by construction: pure functions over fixture strings, plus two
 * assertions against the real checked-in files so a format change on either
 * side surfaces here instead of silently blinding the guard.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

import {
  ARTICLE_PATH_BASE,
  ARTICLE_REGISTRY_FILES,
  articlePathsFor,
  countRegistryRows,
  parseSlugRegistry,
} from '@/scripts/lib/article-slug-registry.mjs';
import {
  MIN_PARSED_REGISTRY_ENTRIES,
  evaluateCorpusRemoval,
  parseRedirectSources,
} from '@/scripts/lib/corpus-removal-guard.mjs';

const ROOT = path.resolve(__dirname, '..');

/** Enough entries to clear MIN_PARSED_REGISTRY_ENTRIES without writing 100 by hand. */
function padRegistry(base: Record<string, Record<string, string>>, n = 150) {
  const out: Record<string, Record<string, string>> = { ...base };
  for (let i = 0; i < n; i++) {
    out[`filler-${i}`] = { it: `f-${i}`, en: `f-${i}-en`, de: `f-${i}-de`, fr: `f-${i}-fr` };
  }
  return out;
}

const LOST = {
  'rimborsi-730-sostituti-imposta': {
    it: 'rimborsi-730-sostituti-imposta',
    en: 'tax-refunds-730-substitute-taxes',
    de: 'steuerrueckerstattungen-730-ersatzsteuern',
    fr: 'remboursements-730-impots-substitutifs',
  },
};

const emptyLedger = new Set<string>();

describe('article slug registry parser', () => {
  it('reads both emit shapes the generator produces', () => {
    // Multi-line for the hand-written head of the file, one-line with a SINGLE
    // leading space for everything the generator appends. An earlier draft of
    // this parser anchored on two spaces and saw 2 of 636 entries.
    const src = [
      "export const SWISS_SLUGS: Record<string, Record<ArticleLocale, string>> = {",
      "  'costo-vita-svizzera-2026': {",
      "    it: 'costo-vita-svizzera-2026',",
      "    en: 'cost-of-living-switzerland-2026',",
      "    de: 'lebenshaltungskosten-schweiz-2026',",
      "    fr: 'cout-vie-suisse-2026',",
      '  },',
      " 'lavoro-forzato-catene-svizzere': { it: 'lavoro-forzato-catene-svizzere', en: 'forced-labour-swiss-supply-chains', de: 'zwangsarbeit-schweizer-lieferketten', fr: 'travail-force-chaines-approvisionnement-suisse' },",
      '};',
      'export const REVERSE_SWISS = {};',
    ].join('\n');

    const parsed = parseSlugRegistry(src, 'SWISS_SLUGS');
    expect(Object.keys(parsed)).toEqual([
      'costo-vita-svizzera-2026',
      'lavoro-forzato-catene-svizzere',
    ]);
    expect(parsed['lavoro-forzato-catene-svizzere'].en).toBe('forced-labour-swiss-supply-chains');
  });

  it('reads a row whose locale keys are reordered or split across lines', () => {
    // The emit order is not a contract the parse can rest on. It used to be
    // pinned as `it, en, de, fr` on one line, so a generator that reordered the
    // keys — or wrapped a long row — produced an EMPTY registry, and an empty
    // registry is exactly what the removal guard fails open on.
    const src = [
      "export const SWISS_SLUGS: Record<string, Record<ArticleLocale, string>> = {",
      " 'permuted': { fr: 'fr-slug', it: 'it-slug', de: 'de-slug', en: 'en-slug' },",
      "  'wrapped': {",
      "    en: 'en-wrapped', it: 'it-wrapped',",
      "    fr: 'fr-wrapped', de: 'de-wrapped' },",
      "  'partial': { it: 'it-only', en: 'en-only' },",
      '};',
    ].join('\n');

    const parsed = parseSlugRegistry(src, 'SWISS_SLUGS');
    expect(parsed.permuted).toEqual({
      it: 'it-slug', en: 'en-slug', de: 'de-slug', fr: 'fr-slug',
    });
    expect(parsed.wrapped).toEqual({
      it: 'it-wrapped', en: 'en-wrapped', de: 'de-wrapped', fr: 'fr-wrapped',
    });
    // A row missing locales is NOT absorbed: it stays out of the registry and
    // shows up as the parsed/rows shortfall the guard now refuses on.
    expect(parsed.partial).toBeUndefined();
    expect(countRegistryRows(src, 'SWISS_SLUGS')).toBe(3);
  });

  it('parses the real registries completely, so the guard is never blind', () => {
    for (const [section, { file, constName }] of Object.entries(ARTICLE_REGISTRY_FILES)) {
      const src = fs.readFileSync(path.join(ROOT, file), 'utf-8');
      const parsed = parseSlugRegistry(src, constName);
      const rows = countRegistryRows(src, constName);
      // Measured against the file, not against a constant: `> 100` on a
      // 3789-row registry stayed green with 97% of the rows unread.
      expect(
        Object.keys(parsed).length,
        `${section}: ${file} parsed to ${Object.keys(parsed).length} of ${rows} rows — the ` +
          "generator's emit shape changed and the parser did not follow",
      ).toBe(rows);
      expect(rows, `${section}: ${file} carries ${rows} rows`).toBeGreaterThan(
        MIN_PARSED_REGISTRY_ENTRIES,
      );
    }
  });

  it('derives the hub path bases from the canonical section core', () => {
    // Not re-typed anywhere: these come from ARTICLE_SECTION_CORE.indexSlug.
    // Pinned here because one of them is a trap — the FR frontaliere hub is
    // `articles-frontalier`, singular, and the plural spelling exists in the
    // legacy redirect table as an old indexed variant.
    expect(ARTICLE_PATH_BASE).toEqual({
      frontaliere: {
        it: '/articoli-frontaliere/',
        en: '/en/cross-border-articles/',
        de: '/de/grenzgaenger-artikel/',
        fr: '/fr/articles-frontalier/',
      },
      svizzera: {
        it: '/articoli-svizzera/',
        en: '/en/swiss-articles/',
        de: '/de/schweiz-artikel/',
        fr: '/fr/articles-suisse/',
      },
    });
  });

  it('builds the four locale paths an article occupies', () => {
    expect(articlePathsFor('svizzera', LOST['rimborsi-730-sostituti-imposta'])).toEqual([
      '/articoli-svizzera/rimborsi-730-sostituti-imposta/',
      '/en/swiss-articles/tax-refunds-730-substitute-taxes/',
      '/de/schweiz-artikel/steuerrueckerstattungen-730-ersatzsteuern/',
      '/fr/articles-suisse/remboursements-730-impots-substitutifs/',
    ]);
  });
});

describe('retirement ledger', () => {
  it('finds the four PR #5299 retirements in the real redirect table', () => {
    const src = fs.readFileSync(
      path.join(ROOT, 'build-plugins', 'legacyRedirectsPlugin.ts'),
      'utf-8',
    );
    const sources = parseRedirectSources(src);
    // One canonical IT URL per retired article. If the table moves or changes
    // shape this fails here rather than turning every future removal into a
    // false refusal in production.
    for (const p of [
      '/articoli-frontaliere/prezzi-proprieta-svizzera-aumentano/',
      '/articoli-frontaliere/caldo-torrido-lavoro-ticino/',
      '/articoli-svizzera/lavoro-forzato-catene-svizzere/',
      '/articoli-frontaliere/vivere-maslianico-lavorare-ticino-frontaliere/',
    ]) {
      expect(sources.has(p), `${p} missing from the parsed redirect table`).toBe(true);
    }
    expect(sources.size).toBeGreaterThan(100);
  });

  it('ignores the plugin\'s other object literals', () => {
    const src = [
      'const somethingElse: Record<string, string> = {',
      "  '/not-a-redirect/': '/nope/',",
      '};',
      'export function legacyRedirectsPlugin(rootDir: string): Plugin {',
      ' const redirects: Record<string, string> = {',
      "  '/old/': '/new/',",
      ' };',
      '}',
    ].join('\n');
    expect([...parseRedirectSources(src)]).toEqual(['/old/']);
  });
});

describe('evaluateCorpusRemoval', () => {
  const base = {
    frontaliere: padRegistry({}),
    svizzera: padRegistry(LOST),
  };

  it('refuses the 2026-08-07 removal: live article, nothing retired it', () => {
    const incoming = { frontaliere: base.frontaliere, svizzera: padRegistry({}) };
    const v = evaluateCorpusRemoval({ local: base, incoming, retiredPaths: emptyLedger });

    expect(v.ok).toBe(false);
    expect(v.unledgered.map((r) => r.id)).toEqual(['rimborsi-730-sostituti-imposta']);
    // The operator needs the live URLs, not just the id — those are what stay
    // 200 on the shard after the registry forgets them.
    expect(v.unledgered[0].paths).toHaveLength(4);
    expect(v.unledgered[0].section).toBe('svizzera');
  });

  it('allows the same removal once the retirement ledger carries its bridge', () => {
    const incoming = { frontaliere: base.frontaliere, svizzera: padRegistry({}) };
    const v = evaluateCorpusRemoval({
      local: base,
      incoming,
      retiredPaths: new Set(articlePathsFor('svizzera', LOST['rimborsi-730-sostituti-imposta'])),
    });

    expect(v.ok).toBe(true);
    expect(v.removals).toHaveLength(1);
    expect(v.removals[0].ledgered).toBe(true);
    expect(v.removals[0].unbridgedLocalePaths).toEqual([]);
  });

  it('allows an IT-only bridge but names the locale URLs left to 404', () => {
    const incoming = { frontaliere: base.frontaliere, svizzera: padRegistry({}) };
    const v = evaluateCorpusRemoval({
      local: base,
      incoming,
      retiredPaths: new Set(['/articoli-svizzera/rimborsi-730-sostituti-imposta/']),
    });

    expect(v.ok).toBe(true);
    expect(v.removals[0].unbridgedLocalePaths).toEqual([
      '/en/swiss-articles/tax-refunds-730-substitute-taxes/',
      '/de/schweiz-artikel/steuerrueckerstattungen-730-ersatzsteuern/',
      '/fr/articles-suisse/remboursements-730-impots-substitutifs/',
    ]);
  });

  it('passes a pure addition — the shape of every normal sync', () => {
    const incoming = {
      frontaliere: padRegistry({}),
      svizzera: padRegistry({
        ...LOST,
        'casse-di-disoccupazione-superati-i-problemi-tecnici': {
          it: 'casse-di-disoccupazione-superati-i-problemi-tecnici',
          en: 'unemployment-funds-technical-problems-solved',
          de: 'arbeitslosenkassen-technische-probleme-geloest',
          fr: 'caisses-chomage-problemes-techniques-resolus',
        },
      }),
    };
    const v = evaluateCorpusRemoval({ local: base, incoming, retiredPaths: emptyLedger });

    expect(v.ok).toBe(true);
    expect(v.removals).toEqual([]);
    expect(v.additions.svizzera).toBe(1);
  });

  it('refuses a tree that is behind the counts the manifest already publishes', () => {
    const v = evaluateCorpusRemoval({
      local: base,
      incoming: base,
      retiredPaths: emptyLedger,
      manifestCounts: { articles: 3105, swissArticles: 636 },
    });

    expect(v.ok).toBe(false);
    expect(v.shortfalls.map((s) => s.section).sort()).toEqual(['frontaliere', 'svizzera']);
    expect(v.manifestChecked).toBe(true);
  });

  it('skips the count gate when the manifest could not be read', () => {
    const v = evaluateCorpusRemoval({
      local: base,
      incoming: base,
      retiredPaths: emptyLedger,
      manifestCounts: null,
    });

    expect(v.ok).toBe(true);
    expect(v.manifestChecked).toBe(false);
  });

  it('fails CLOSED when a registry parses to nothing', () => {
    // The dangerous direction: an empty parse makes every id look absent from
    // BOTH sides, so no removal is ever detected and the guard waves the sync
    // through. Treat it as a failure, never as an empty corpus.
    const v = evaluateCorpusRemoval({
      local: { frontaliere: {}, svizzera: {} },
      incoming: { frontaliere: {}, svizzera: {} },
      retiredPaths: emptyLedger,
    });

    expect(v.ok).toBe(false);
    expect(v.parseFailures).toHaveLength(4);
  });

  it('fails CLOSED when a registry parses to only PART of the rows in its file', () => {
    // The failure the absolute floor cannot see: 3789 rows in the file, 200
    // parsed. That is well over MIN_PARSED_REGISTRY_ENTRIES, so the old check
    // read it as a corpus — and the 3589 unread ids look like removals nobody
    // declared, or, on both sides at once, like no removal at all.
    const big = (n: number) =>
      Object.fromEntries(
        Array.from({ length: n }, (_, i) => [
          `id-${i}`,
          { it: `it-${i}`, en: `en-${i}`, de: `de-${i}`, fr: `fr-${i}` },
        ]),
      );
    const trees = { frontaliere: big(200), svizzera: big(200) };

    const v = evaluateCorpusRemoval({
      local: trees,
      incoming: trees,
      retiredPaths: emptyLedger,
      rowCounts: { local: { frontaliere: 3789, svizzera: 200 }, incoming: { frontaliere: 3789, svizzera: 200 } },
    });

    expect(v.ok).toBe(false);
    // Only the frontaliere side is short; svizzera parsed every row it had.
    expect(v.parseFailures.map((f) => `${f.side}/${f.section}`)).toEqual([
      'local/frontaliere',
      'incoming/frontaliere',
    ]);
    expect(v.parseFailures[0]).toMatchObject({ size: 200, rows: 3789 });
  });
});
