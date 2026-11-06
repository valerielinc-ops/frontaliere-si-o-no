/**
 * `legacyRedirectsPlugin` must not emit bridge pages onto a prefix this build
 * does not ship.
 *
 * THE DEFECT THIS PINS
 * ────────────────────
 * Both article sections run with `<SECTION>_BUILD_EMIT_SKIP=true`; deploy.yml
 * then excludes them from the full-replace shard push, and
 * `infra/cloudflare-worker/locale-router.js` routes the whole prefix to the
 * section shard with no apex fallback. The plugin nevertheless wrote ~38
 * bridges under `/articoli-frontaliere/**` and `/articoli-svizzera/**` (and
 * their en/de/fr prefixes) on every build. Those files are deleted by the shard
 * rehydrate and never reach the serving path, so the redirect table described
 * an intention rather than production.
 *
 * Measured live on the bare apex URLs, 2026-08-08: of the 38 entries, 22
 * answered with the bridge (stale shard files pushed before the flag went on),
 * 16 answered with the ORIGINAL retired article, `index, follow` — the bridge
 * inert — and none 404'd. The 16 are exactly the entries added after the
 * cutover, which is the signature of "this build stopped being able to deliver
 * new entries and nothing said so".
 *
 * Hermetic: reads the plugin's exported predicates and its source. No Vite
 * build, no network — same idiom as tests/retired-runaway-articles-redirects.ts.
 */

import fs from 'node:fs';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  isUnshippablePath,
  unshippableSectionPrefixes,
} from '../build-plugins/shared/unshippableSections';
// Named export off a plain JS Worker module: `allowJs` infers its type, so
// unlike the DEFAULT export (see tests/locale-router-edge-pushed-files.test.ts)
// this needs no `@ts-expect-error` — adding one is itself a TS2578 error.
import { SECTION_ROUTES } from '../infra/cloudflare-worker/locale-router.js';

const read = (rel: string): string =>
  fs.readFileSync(path.resolve(__dirname, rel), 'utf-8');

const GATE_SOURCE = read('../build-plugins/shared/unshippableSections.ts');
const REDIRECTS_SOURCE = read('../build-plugins/legacyRedirectsPlugin.ts');
const ALIAS_SOURCE = read('../build-plugins/legacyAliasPlugin.ts');

/** The eight prefixes the Worker routes to the two article shards. */
const ARTICLE_PREFIXES = [
  '/articoli-frontaliere',
  '/en/cross-border-articles',
  '/de/grenzgaenger-artikel',
  '/fr/articles-frontalier',
  '/articoli-svizzera',
  '/en/swiss-articles',
  '/de/schweiz-artikel',
  '/fr/articles-suisse',
];

function stubFlags(frontaliere?: string, svizzera?: string): void {
  vi.stubEnv('ARTICOLIFRONTALIERE_BUILD_EMIT_SKIP', frontaliere as string);
  vi.stubEnv('ARTICOLISVIZZERA_BUILD_EMIT_SKIP', svizzera as string);
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('unshippableSectionPrefixes — the flag decides, strictly', () => {
  it('returns the 8 article-section prefixes when both flags are "true"', () => {
    stubFlags('true', 'true');
    expect(unshippableSectionPrefixes().sort()).toEqual([...ARTICLE_PREFIXES].sort());
  });

  it('returns nothing when the flags are unset — the pre-cutover behaviour is unchanged', () => {
    stubFlags(undefined, undefined);
    expect(unshippableSectionPrefixes()).toEqual([]);
  });

  it('returns nothing for the literal string "false" (strict equality, not truthiness)', () => {
    // The exact footgun tests/build-emit-skip-gate.test.ts pins for the other
    // three gates: a truthy read turns the kill-switch ON for any non-empty
    // value, "false" included, which here would delete 38 working redirects.
    stubFlags('false', 'false');
    expect(unshippableSectionPrefixes()).toEqual([]);
  });

  it('gates the two sections INDEPENDENTLY', () => {
    // A gate that collapsed both sections onto one flag would stop emitting
    // svizzera bridges the moment frontaliere was flipped, while svizzera was
    // still being pushed — silently deleting live redirects.
    stubFlags('true', undefined);
    const only = unshippableSectionPrefixes();
    expect(only.sort()).toEqual(
      ['/articoli-frontaliere', '/en/cross-border-articles', '/de/grenzgaenger-artikel', '/fr/articles-frontalier'].sort(),
    );
    expect(only).not.toContain('/articoli-svizzera');
  });

  it('derives the prefixes from the Worker table rather than restating them', () => {
    // If the edge ever re-routes a section, this gate must move with it. Pin
    // the derivation, not just the current values.
    stubFlags('true', 'true');
    const fromWorker = (SECTION_ROUTES as Array<{ section: string; prefix: string }>)
      .filter((r) => r.section === 'articolifrontaliere' || r.section === 'articolisvizzera')
      .map((r) => r.prefix);
    expect(unshippableSectionPrefixes().sort()).toEqual(fromWorker.sort());
    expect(GATE_SOURCE).toContain("from '../../infra/cloudflare-worker/locale-router.js'");
  });

  it('reads both vars with a strict === \'true\' comparison in the source', () => {
    expect(GATE_SOURCE).toMatch(
      /process\.env\.ARTICOLIFRONTALIERE_BUILD_EMIT_SKIP\s*===\s*'true'/,
    );
    expect(GATE_SOURCE).toMatch(
      /process\.env\.ARTICOLISVIZZERA_BUILD_EMIT_SKIP\s*===\s*'true'/,
    );
  });
});

describe('isUnshippablePath — segment-boundary matching', () => {
  it('matches the section root, its slash form and anything beneath it', () => {
    for (const p of [
      '/articoli-frontaliere',
      '/articoli-frontaliere/',
      '/articoli-frontaliere/tassa-transito-svizzera-2023/',
      '/en/swiss-articles/forced-labour-swiss-supply-chains/',
      '/de/schweiz-artikel/zwangsarbeit-schweizer-lieferketten/',
    ]) {
      expect(isUnshippablePath(p, ARTICLE_PREFIXES), p).toBe(true);
    }
  });

  it('matches the FLAT root `<prefix>.html`, which matchSection also claims', () => {
    // The Worker treats `/articoli-frontaliere.html` as belonging to the
    // section (`locale-router.js` matchSection: `pathname === `${prefix}.html``)
    // and routes it to the shard. A prefix test that sees the directory but
    // misses its flat twin lets a bridge through as "shippable" while the edge
    // still sends it to a shard that never receives it — indexable 404.
    //
    // Same blind spot that produced `dist/<locale>.html`: there, `en.html`
    // matched neither `rel === 'en'` nor `rel.startsWith('en/')`.
    for (const p of [
      '/articoli-frontaliere.html',
      '/articoli-svizzera.html',
      '/en/cross-border-articles.html',
      '/fr/articles-frontalier.html',
    ]) {
      expect(isUnshippablePath(p, ARTICLE_PREFIXES), p).toBe(true);
    }

    // ...and must NOT swallow a look-alike that is not a section root.
    for (const p of [
      '/articoli-frontaliere-extra.html',
      '/fr/articles-frontaliers.html',
    ]) {
      expect(isUnshippablePath(p, ARTICLE_PREFIXES), p).toBe(false);
    }
  });

  it('does NOT match the /fr/articles-frontaliers/ spelling (no trailing "s" prefix exists)', () => {
    // The single most consequential case in this file. Google indexed BOTH the
    // `-frontalier` and `-frontaliers` spellings and the redirect table carries
    // entries for both, but only `-frontalier` has a SECTION_ROUTES entry. The
    // `-s` variant stays on the FR locale shard, which this build DOES ship, so
    // treating it as unshippable would delete four bridges that work today.
    for (const p of [
      '/fr/articles-frontaliers/elections-communales-tessin-2026/',
      '/fr/articles-frontaliers/frontaliers-tessin-baisse-donnees-2025/',
      '/fr/articles-frontaliers/frontaliers-tessin-donnees-baisse-q4-2025/',
      '/fr/articles-frontaliers/frontaliers-tessin-baisse-donnees-q4-2025/',
    ]) {
      expect(isUnshippablePath(p, ARTICLE_PREFIXES), p).toBe(false);
    }
  });

  it('does NOT match a look-alike section', () => {
    expect(isUnshippablePath('/articoli-frontaliere-altro/', ARTICLE_PREFIXES)).toBe(false);
    expect(isUnshippablePath('/articoli-svizzera-vecchio/x/', ARTICLE_PREFIXES)).toBe(false);
  });

  it('matches nothing when the prefix list is empty (flags off ⇒ emit everything)', () => {
    expect(isUnshippablePath('/articoli-frontaliere/qualsiasi/', [])).toBe(false);
  });

  it('leaves unrelated legacy bridges alone', () => {
    for (const p of [
      '/comparatori/lamal-vs-cmi/',
      '/guida-frontaliere/permesso-g/',
      '/cerca-lavoro-ticino/logistiker-in-efz-coop-grigioni/',
      '/stampa/',
    ]) {
      expect(isUnshippablePath(p, ARTICLE_PREFIXES), p).toBe(false);
    }
  });
});

describe('legacyRedirectsPlugin consults the gate in BOTH its emission loops', () => {
  // The static table produced the measured defect, but the Search Console
  // compat loop writes under the same prefixes from a Google-supplied path
  // list, so gating only one leaves the hole half-open.
  it('gates the static-table loop and the compat-paths loop', () => {
    const calls = REDIRECTS_SOURCE.match(/isUnshippablePath\(from, unshippablePrefixes\)/g) ?? [];
    expect(
      calls.length,
      'expected the unshippable gate in BOTH emission loops (static redirects + Search Console compat)',
    ).toBe(2);
  });

  it('computes the prefix set once per build, not per redirect entry', () => {
    expect(REDIRECTS_SOURCE).toContain('const unshippablePrefixes = unshippableSectionPrefixes();');
  });

  it('reports the skip instead of swallowing it', () => {
    // A silent skip is the #5327 failure mode: the emitter stops, the table
    // still lists the URL, and nothing anywhere says the two disagree.
    expect(REDIRECTS_SOURCE).toMatch(/skippedUnshippable > 0/);
    expect(REDIRECTS_SOURCE).toContain('[legacy-redirects]\\x1b[0m Skipped ${skippedUnshippable}');
  });

  it('keeps the retired-article entries in the table (only emission is gated)', () => {
    // tests/retired-runaway-articles-redirects.test.ts pins all 16. The gate
    // must not be "delete the rows" — the moment the section is shipped again
    // (or a Worker-side redirect lands) the table is what carries them.
    expect(REDIRECTS_SOURCE).toContain("'/articoli-svizzera/lavoro-forzato-catene-svizzere/'");
    expect(REDIRECTS_SOURCE).toContain("'/articoli-frontaliere/caldo-torrido-lavoro-ticino/'");
  });
});

describe('legacyAliasPlugin consults the gate — the INDEXABLE case', () => {
  /**
   * The more serious of the two emitters. legacyRedirectsPlugin's output is
   * noindex, which rehydrate-trunk-guard.sh downgrades to a warning; this one
   * emits `robots: 'index,follow'` by explicit never-noindex policy, which the
   * guard classifies as FATAL ("indexable page(s) were built under a prefix
   * this build does not ship to the shard").
   */
  it('gates the alias emission loop', () => {
    expect(ALIAS_SOURCE).toContain(
      'isUnshippablePath(entry.orphanPath, unshippablePrefixes)',
    );
    expect(ALIAS_SOURCE).toContain('const unshippablePrefixes = unshippableSectionPrefixes();');
  });

  it('gates BEFORE the existsSync collision guard', () => {
    // Order matters and the guard cannot substitute for it: with the flags on
    // the real article page is never emitted either, so `fs.existsSync` always
    // passes and the alias always writes.
    const gate = ALIAS_SOURCE.indexOf('isUnshippablePath(entry.orphanPath, unshippablePrefixes)');
    const collision = ALIAS_SOURCE.indexOf('if (fs.existsSync(indexTarget)) { skipped++; continue; }');
    expect(gate).toBeGreaterThan(-1);
    expect(collision).toBeGreaterThan(-1);
    expect(gate).toBeLessThan(collision);
  });

  it('reports the skip instead of swallowing it', () => {
    expect(ALIAS_SOURCE).toMatch(/skippedUnshippable > 0/);
    expect(ALIAS_SOURCE).toContain('[legacy-alias]\\x1b[0m Skipped ${skippedUnshippable}');
  });

  it('still emits aliases that are NOT under an unshippable prefix', () => {
    // The three surviving entries of the 24 are the point of the gate being
    // per-path rather than "skip this plugin when the flags are on".
    stubFlags('true', 'true');
    const prefixes = unshippableSectionPrefixes();
    expect(isUnshippablePath('/lavoro-frontalieri-ticino-2026/', prefixes)).toBe(false);
    expect(isUnshippablePath('/articoli-frontaliere/addiofrontalierelongo/', prefixes)).toBe(true);
  });
});

describe('both emitters share ONE gate implementation', () => {
  // Two copies of this predicate would be two things to keep in step with the
  // Worker's routing table. The measured defect is what a stale copy looks like.
  it('neither plugin re-implements the prefix test', () => {
    for (const [name, source] of [
      ['legacyRedirectsPlugin.ts', REDIRECTS_SOURCE],
      ['legacyAliasPlugin.ts', ALIAS_SOURCE],
    ] as const) {
      expect(source, `${name} should import the shared gate`).toContain(
        "from './shared/unshippableSections'",
      );
      expect(
        source,
        `${name} reads a BUILD_EMIT_SKIP var directly instead of going through the shared gate`,
      ).not.toMatch(/process\.env\.ARTICOLI(FRONTALIERE|SVIZZERA)_BUILD_EMIT_SKIP/);
    }
  });
});

/**
 * `isExternallyServedPath` answers the same question as `isUnshippablePath` —
 * "does this path belong to a section the edge serves from a shard?" — for a
 * different set of callers (`validate-sitemap-pages.mjs`,
 * `validate-sitemap-links.mjs`, `audit-hreflang.mjs`). Both derive from
 * SECTION_ROUTES, so they must agree; when they disagreed, the flat root was
 * the case that slipped.
 */
describe('isExternallyServedPath agrees with isUnshippablePath on the flat root', () => {
  it('treats `<prefix>.html` as externally served', async () => {
    const { isExternallyServedPath } = await import('../scripts/lib/externally-served-paths.mjs');
    for (const p of ['/articoli-frontaliere.html', '/articoli-svizzera.html']) {
      // A false here makes the dist validators hunt for a file the shard owns,
      // and fail the dist — i.e. block publish for a URL that answers fine.
      expect(isExternallyServedPath(p), p).toBe(true);
    }
    for (const p of ['/articoli-frontaliere-altro.html', '/guida-frontaliere.html']) {
      expect(isExternallyServedPath(p), p).toBe(false);
    }
  });
});
