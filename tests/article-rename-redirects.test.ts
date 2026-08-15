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
  assertNoCrossSourceChains,
  assertNoInternalChains,
  findCrossSourceChains,
  findInternalChains,
  loadArticleRedirects,
  parseArticlePath,
  parseArticleRedirects,
  readHardcodedRedirects,
  readPublishedArticlePaths,
  withTrailingSlash,
} from '../build-plugins/shared/articleRedirects.mjs';

const ROOT = resolve(__dirname, '..');
const REDIRECTS_ABS = resolve(ROOT, ARTICLE_REDIRECTS_FILE);

/**
 * The plugin's hand-authored map, read from its SOURCE text rather than by
 * importing it — see `readHardcodedRedirects`'s doc for why importing it turns
 * this file red in a sparse worktree and green in CI.
 */
const HARDCODED = readHardcodedRedirects(ROOT);

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
    ['path traversal', '/articoli-frontaliere/../x/'],
    ['an empty slug', '/articoli-frontaliere//'],
    ['a non-string', 42],
  ])('rejects %s', (_label, value) => {
    expect(parseArticlePath(value as string)).toBeNull();
  });

  /**
   * Review round 1, adversarial check: an alphabet allowlist here is not a
   * safe default, it is a landmine. `loadArticleRedirects` throws by design, so
   * a slug shape it fails to anticipate does not skip one redirect — it kills
   * the production build. These four are REAL published slugs that the first
   * `^[a-z0-9][a-z0-9-]*$` version rejected.
   */
  it.each([
    ['an accented DE slug', '/de/grenzgaenger-artikel/naspi-ehemalige-grenzgänger-2026/'],
    ['an accented FR slug', '/fr/articles-frontalier/ristournes-gelées-tessin-italie/'],
    ['an underscored EN slug', '/en/cross-border-articles/coop_calls_back_cheese_salmonella/'],
    ['a slug with an uppercase letter', '/de/grenzgaenger-artikel/san-gottardo-Code-good-friday/'],
  ])('accepts %s, which is live in the corpus today', (_label, value) => {
    expect(parseArticlePath(value)).not.toBeNull();
  });
});

/**
 * The durable version of the check above: the rule cannot drift away from the
 * corpus, because the corpus itself is the fixture. 15.356 paths today.
 */
describe('parseArticlePath accepts every published article path', () => {
  it('parses all of them', () => {
    const published = readPublishedArticlePaths(ROOT);
    expect(published.missing).toEqual([]);
    expect(published.paths.size).toBeGreaterThan(10000);
    const rejected = [...published.paths].filter((p) => parseArticlePath(p) === null);
    expect(
      rejected.slice(0, 10),
      `${rejected.length} published article paths would be refused by parseArticlePath — ` +
      'since loadArticleRedirects throws, that is a build-killer the day one of them is renamed',
    ).toEqual([]);
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
    const hardcoded = new Set(Object.keys(HARDCODED));
    // Guard against the scan silently matching nothing and passing vacuously.
    expect(hardcoded.size, 'source scan of legacyRedirectsPlugin.ts found no entries').toBeGreaterThan(50);
    const duplicates = Object.keys(loadArticleRedirects(ROOT)).filter((from) => hardcoded.has(from));
    expect(duplicates, 'declare each redirect once, in one of the two places').toEqual([]);
  });

  it('forms no redirect chain across the two sources', () => {
    expect(() => assertNoCrossSourceChains(HARDCODED, loadArticleRedirects(ROOT))).not.toThrow();
  });
});

/**
 * Review round 1 on PR #5537. `parseArticleRedirects` forbids chains INSIDE the
 * data file, but the two maps are merged into one before anything is emitted,
 * and a chain forms just as well across the seam. It is not a hypothetical
 * shape: 46 of the 168 hardcoded pairs are article → article, i.e. 46 targets a
 * future rename can move, and four of those targets have three sources each
 * (the `frontalieri-ticino-*-2025` group, in all four locales).
 *
 * The reason this is worse here than a chain of 301s: these bridges are 200
 * pages with `noindex` + canonical. A canonical pointing at a noindex page does
 * not forward the signal, it drops it — the oldest URL stops consolidating onto
 * anything at all. A 301 → 301 at least arrives.
 */
describe('cross-source redirect chains (PR #5537 review round 1)', () => {
  it('finds nothing when the two maps do not touch', () => {
    expect(findCrossSourceChains(
      { '/articoli-frontaliere/a/': '/articoli-frontaliere/b/' },
      { '/articoli-frontaliere/c/': '/articoli-frontaliere/d/' },
    )).toEqual([]);
  });

  it('catches hardcoded X → A followed by data A → B', () => {
    const chains = findCrossSourceChains(
      { '/articoli-frontaliere/x/': '/articoli-frontaliere/a/' },
      { '/articoli-frontaliere/a/': '/articoli-frontaliere/b/' },
    );
    expect(chains).toEqual([{
      from: '/articoli-frontaliere/x/',
      via: '/articoli-frontaliere/a/',
      to: '/articoli-frontaliere/b/',
      kind: 'hardcoded-into-data',
    }]);
  });

  it('catches data A → B followed by hardcoded B → C', () => {
    const chains = findCrossSourceChains(
      { '/articoli-frontaliere/b/': '/articoli-frontaliere/c/' },
      { '/articoli-frontaliere/a/': '/articoli-frontaliere/b/' },
    );
    expect(chains).toEqual([{
      from: '/articoli-frontaliere/a/',
      via: '/articoli-frontaliere/b/',
      to: '/articoli-frontaliere/c/',
      kind: 'data-into-hardcoded',
    }]);
  });

  /** One rename of a fan-out target opens every one of its inbound bridges. */
  it('reports every hardcoded source pointing at a renamed target, not just the first', () => {
    const chains = findCrossSourceChains(
      {
        '/articoli-frontaliere/x1/': '/articoli-frontaliere/a/',
        '/articoli-frontaliere/x2/': '/articoli-frontaliere/a/',
        '/articoli-frontaliere/x3/': '/articoli-frontaliere/a/',
      },
      { '/articoli-frontaliere/a/': '/articoli-frontaliere/b/' },
    );
    expect(chains).toHaveLength(3);
    expect(chains.map((c) => c.from).sort()).toEqual([
      '/articoli-frontaliere/x1/',
      '/articoli-frontaliere/x2/',
      '/articoli-frontaliere/x3/',
    ]);
  });

  it('normalizes the trailing slash on both sides before comparing', () => {
    expect(findCrossSourceChains(
      { '/articoli-frontaliere/x': '/articoli-frontaliere/a' },
      { '/articoli-frontaliere/a/': '/articoli-frontaliere/b/' },
    )).toHaveLength(1);
  });

  // ── The reproduction, against the REAL hardcoded map ──────────────────────
  // Not a fixture: these are entries that exist in legacyRedirectsPlugin.ts
  // today, so if the map is ever cleaned up these tests fail loudly instead of
  // quietly testing nothing.

  it('the real map still contains the article targets this guards (else the repro is stale)', () => {
    expect(HARDCODED['/articoli-frontaliere/naspi-disoccupazione-frontalieri/'])
      .toBe('/articoli-frontaliere/naspi-ex-frontalieri-2026/');
    const fanout = Object.entries(HARDCODED)
      .filter(([, to]) => to === '/articoli-frontaliere/frontalieri-ticino-dati-calo-fine-2025/');
    expect(fanout.length, 'the frontalieri-ticino group should still fan in').toBe(3);
  });

  it('rejects renaming naspi-ex-frontalieri-2026, which a hardcoded bridge points at', () => {
    expect(() => assertNoCrossSourceChains(HARDCODED, {
      '/articoli-frontaliere/naspi-ex-frontalieri-2026/': '/articoli-frontaliere/naspi-2027/',
    })).toThrow(/catena\/e di redirect attraverso le due fonti/);
  });

  it('names every affected hardcoded entry when a fan-out target is renamed', () => {
    let message = '';
    try {
      assertNoCrossSourceChains(HARDCODED, {
        '/articoli-frontaliere/frontalieri-ticino-dati-calo-fine-2025/':
          '/articoli-frontaliere/frontalieri-ticino-dati-2026/',
      });
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message, 'a rename of this target must not pass').not.toBe('');
    expect(message).toContain('3 catena/e');
    for (const from of ['frontalieri-ticino-calo-dati-2025', 'frontalieri-ticino-dati-calo-q4-2025', 'frontalieri-ticino-calo-dati-q4-2025']) {
      expect(message, `${from} points at the renamed target and must be listed`).toContain(from);
    }
    // The message has to carry the fix, not just the diagnosis.
    expect(message).toContain(
      "'/articoli-frontaliere/frontalieri-ticino-calo-dati-2025/': '/articoli-frontaliere/frontalieri-ticino-dati-2026/',",
    );
  });

  it('rejects a data entry landing on a URL a hardcoded bridge already redirects away', () => {
    expect(() => assertNoCrossSourceChains(HARDCODED, {
      '/articoli-frontaliere/qualcosa-di-vecchio/': '/articoli-frontaliere/naspi-disoccupazione-frontalieri/',
    })).toThrow(/naspi-ex-frontalieri-2026/);
  });

  it('fails loudly if the source scan stops matching, instead of passing vacuously', () => {
    expect(() => readHardcodedRedirects(ROOT, {
      readFileSync: (() => 'const redirects = {};') as never,
    })).toThrow(/lo scan ha trovato 0 coppie/);
  });

  /**
   * Review round 1, adversarial check: the "more than 50" canary only catches a
   * scan that broke completely, not one that silently skips the entries someone
   * reformatted. Those would drop out of the chain check without a word — the
   * exact failure shape this whole PR is about. So a key line the parser cannot
   * read is now an error, not an absence.
   */
  it('refuses to under-count: a re-quoted entry is an error, not a silent skip', () => {
    const source = [
      "const redirects: Record<string, string> = {",
      ...Array.from({ length: 60 }, (_, i) => ` '/articoli-frontaliere/a${i}/': '/articoli-frontaliere/b${i}/',`),
      ' "/articoli-frontaliere/re-quoted/": "/articoli-frontaliere/target/",',
      '};',
    ].join('\n');
    expect(() => readHardcodedRedirects(ROOT, { readFileSync: (() => source) as never }))
      .toThrow(/re-quoted/);
  });

  it('tolerates the one computed entry (a job path, which no article can collide with)', () => {
    const source = [
      "const redirects: Record<string, string> = {",
      ...Array.from({ length: 60 }, (_, i) => ` '/articoli-frontaliere/a${i}/': '/articoli-frontaliere/b${i}/',`),
      " '/job-board/': `/${resolveCantonSection('it', '_AGGREGATE_')}/`,",
      '};',
    ].join('\n');
    const parsed = readHardcodedRedirects(ROOT, { readFileSync: (() => source) as never });
    expect(Object.keys(parsed)).toHaveLength(60);
    expect(parsed['/job-board/']).toBeUndefined();
  });

  it('reads the real map without hitting either guard', () => {
    expect(Object.keys(HARDCODED).length).toBe(168);
  });
});

/**
 * Review round 3. `findCrossSourceChains` looks BETWEEN the two sources and by
 * construction cannot see a chain declared entirely inside one of them — and
 * the hardcoded map had two, both on production URLs, both born the same way:
 * a later batch re-pointed the middle hop and nobody went back to the entry
 * pointing into it.
 *
 * Measured live before the fix (2026-08-10):
 *
 *   /comparatori/traffico-valichi/        200 noindex,follow → canonical /statistiche/traffico-dogane/
 *   /statistiche/traffico-dogane/         200 noindex,follow → canonical /guida-frontaliere/tempi-attesa-dogana/
 *   /guida-frontaliere/tempi-attesa-dogana/  200 index,follow  ← the real page
 *
 * and the FR twin on health-insurance premiums. Same defect this PR describes,
 * already shipped. Disclosing them in the PR body was not repairing them.
 */
describe('internal redirect chains (PR #5537 review round 3)', () => {
  it('finds nothing in a flat map', () => {
    expect(findInternalChains({
      '/a/': '/target/',
      '/b/': '/target/',
    })).toEqual([]);
  });

  it('catches X → A → B declared in one map', () => {
    expect(findInternalChains({
      '/x/': '/a/',
      '/a/': '/b/',
    })).toEqual([{ from: '/x/', via: '/a/', to: '/b/' }]);
  });

  it('normalizes the trailing slash before comparing', () => {
    expect(findInternalChains({ '/x': '/a', '/a/': '/b/' })).toHaveLength(1);
  });

  it('does not treat a self-map as a chain (the emit loop already skips those)', () => {
    expect(findInternalChains({ '/a/': '/a/' })).toEqual([]);
  });

  it('throws with the collapsed line spelled out', () => {
    expect(() => assertNoInternalChains({ '/x/': '/a/', '/a/': '/b/' }))
      .toThrow(/rimedio: '\/x\/': '\/b\/',/);
  });

  // ── The regression guard ────────────────────────────────────────────────
  it('the real hardcoded map declares no chain', () => {
    const chains = findInternalChains(HARDCODED);
    expect(
      chains.map((c) => `${c.from} → ${c.via} → ${c.to}`),
      'a redirect whose target is itself redirected sends the canonical to a noindex page',
    ).toEqual([]);
  });

  /**
   * Pinned by target, not just by "no chains": if someone re-points
   * `/statistiche/traffico-dogane/` again, the chain guard above catches it —
   * but these two assertions say out loud where the collapsed entries are
   * supposed to land, so the fix cannot be quietly undone into a different
   * shape that happens not to chain.
   */
  it.each([
    ['/comparatori/traffico-valichi/', '/guida-frontaliere/tempi-attesa-dogana/'],
    ['/fr/primes-assurance-maladie/ticino/', '/fr/statistiques/primes-assurance-maladie-communes/'],
  ])('%s points straight at the final page', (from, to) => {
    expect(HARDCODED[from]).toBe(to);
    // …and the final page must not itself be a redirect source.
    expect(HARDCODED[to]).toBeUndefined();
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
