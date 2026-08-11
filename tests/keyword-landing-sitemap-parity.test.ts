import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Coverage gate for the GSC keyword-landing family emitted by
 * `build-plugins/jobsSeoPagesPlugin.ts`.
 *
 * The defect
 * ----------
 * The family answered "does this page exist?" TWICE, with two different
 * predicates:
 *
 *   - the EMIT loop skipped a locale on three conditions — the anti-doorway
 *     floor (`kwEligibleLocales`), `editorialSearchSlugsByLocale` (an
 *     editorial landing already owns the search slug) and `activeJobDirs`
 *     (another emitter already wrote the directory);
 *   - the SITEMAP block, which sits OUTSIDE that loop, re-derived its answer
 *     from the floor alone, plus a `dist/` existence stat applied to every
 *     locale EXCEPT `it`.
 *
 * So for Italian the two overrides were invisible to the sitemap: a keyword
 * landing this plugin never wrote still received a `<loc>` in
 * `sitemap-jobs.xml`. The URL is not empty — it is owned by whichever emitter
 * did write it, and those pages are either noindex bridges or non-self-
 * canonical mirrors (`relatedSearchClustersPlugin` mirrors a cluster at
 * `/cerca-lavoro-ticino/ricerca-<slug>/` with canonical pointing at
 * `/cerca-lavoro-svizzera/ricerca-<slug>/`). Both are exactly what
 * `validate:sitemap-pages` and `audit:sitemap-canonicals` hard-fail on, and
 * both are what `relatedSearchClustersPlugin` already filters out of its own
 * sitemap — the keyword family had no equivalent filter because it did not
 * know what it had written.
 *
 * Measured on 2026-08-11 against the live site (origin/main 74b57e3): of the
 * 57 slugs in `data/keyword-pages-config.json`, 49 are listed in
 * `sitemap-jobs.xml` and all 49 are 200 + index + self-canonical, so the
 * divergence had not fired yet. It was latent, not absent: `medico`,
 * `informatic` and `imbianchin` are single-token filters over ~2 500 job ads,
 * so one crawl that lifts them over the floor is enough to push a
 * non-canonical `<loc>` into the sitemap.
 *
 * Why a source contract and not a `dist/` walk
 * -------------------------------------------
 * A dist-walking check would need a built `dist/`, so it could only live in
 * the post-deploy validators — after the bad sitemap has already shipped. And
 * `audit:all`, the natural host for a dist walk, is SAMPLED in CI
 * (`AUDIT_SAMPLE_RATE`), which is sound for per-page checks and wrong for a
 * set-difference one: an unsampled page is indistinguishable from an absent
 * one. Pinning the two predicates to a single Set makes the divergence
 * unrepresentable at build time instead of detectable after deploy — the loc
 * set IS the emitted set, so "emitted but in no sitemap" and "in a sitemap
 * but never emitted" are both closed by construction, for every locale this
 * shard renders.
 */

const ROOT = resolve(import.meta.dirname, '..');
const PLUGIN_SRC = readFileSync(resolve(ROOT, 'build-plugins/jobsSeoPagesPlugin.ts'), 'utf-8');

/** The GSC keyword-landing region: floor constant → config-load catch. */
function keywordRegion(): string {
  const start = PLUGIN_SRC.indexOf('const KEYWORD_LANDING_MIN_JOBS');
  expect(start, 'KEYWORD_LANDING_MIN_JOBS anchor not found — the keyword-landing block was renamed or moved').toBeGreaterThan(-1);
  const end = PLUGIN_SRC.indexOf('Failed to load keyword pages config', start);
  expect(end, 'keyword-pages-config catch anchor not found — re-anchor this test').toBeGreaterThan(start);
  return PLUGIN_SRC.slice(start, end);
}

const REGION = keywordRegion();
const SITEMAP_MARKER = '// Sitemap entry (Italian canonical)';
const SITEMAP_AT = REGION.indexOf(SITEMAP_MARKER);
const EMIT_BLOCK = REGION.slice(0, SITEMAP_AT === -1 ? undefined : SITEMAP_AT);
const SITEMAP_BLOCK = SITEMAP_AT === -1 ? '' : REGION.slice(SITEMAP_AT);

describe('keyword landing pages: sitemap registry and emitter share one source of truth', () => {
  it('keeps the sitemap block outside the emit loop (the shape this gate exists for)', () => {
    expect(
      SITEMAP_AT,
      `"${SITEMAP_MARKER}" not found inside the keyword-landing region — re-anchor this test`,
    ).toBeGreaterThan(-1);
  });

  it('the emit loop records every locale it actually writes', () => {
    expect(
      /const kwEmittedLocales = new Set</.test(EMIT_BLOCK),
      'the keyword emit loop must declare `kwEmittedLocales` — without a record of what was '
        + 'written, the sitemap block can only guess, and its guess omits the '
        + '`editorialSearchSlugsByLocale` / `activeJobDirs` overrides',
    ).toBe(true);
    expect(
      /kwEmittedLocales\.add\(locale\);/.test(EMIT_BLOCK),
      'the keyword emit loop must `kwEmittedLocales.add(locale)` after writing the page, next to '
        + '`keywordPageCount++` — a declaration nothing populates makes the sitemap set empty',
    ).toBe(true);
  });

  it('all three emit-side gates stay inside the emit loop, so the record subsumes them', () => {
    for (const gate of [
      'if (!kwEligibleLocales.has(locale)) continue;',
      'if (editorialSearchSlugsByLocale.get(locale)?.has(kwFullSlug)) continue;',
      'if (activeJobDirs.has(kwRelDir)) continue;',
    ]) {
      expect(
        EMIT_BLOCK.includes(gate),
        `the emit loop must still gate on \`${gate}\` — if a gate moved out of the loop or was `
          + 'renamed, kwEmittedLocales stops meaning "what shipped" and this parity gate is void',
      ).toBe(true);
    }
  });

  it('the sitemap block derives ONE set, from the emitter record for shard-owned locales', () => {
    expect(
      /const kwSitemapLocales = new Set</.test(SITEMAP_BLOCK),
      'the sitemap block must build a single `kwSitemapLocales` set that decides <loc>, '
        + 'alternates and x-default together',
    ).toBe(true);
    expect(
      /if \(shouldEmitLocale\(l\)\) \{\s*if \(!kwEmittedLocales\.has\(l\)\) continue;/.test(SITEMAP_BLOCK),
      'for a locale THIS shard renders, `kwSitemapLocales` must be gated on `kwEmittedLocales` — '
        + 'not on the floor and not on a dist existence stat. A stat cannot tell a page this '
        + 'plugin wrote from a page another emitter wrote at the same path, which is precisely '
        + 'how a non-self-canonical mirror URL entered sitemap-jobs.xml',
    ).toBe(true);
  });

  it('keeps the dist existence stat only for locales another shard renders', () => {
    expect(
      /\} else if \(l !== 'it'\) \{/.test(SITEMAP_BLOCK),
      "the existence stat must sit in the `else` branch (another shard renders `l`) and keep the "
        + '`it` exemption — on a non-IT shard the IT page is written elsewhere and a stat there '
        + 'false-negatives',
    ).toBe(true);
  });

  it('advertises alternates from the same set as the <loc> entries (reciprocity)', () => {
    expect(
      /buildSitemapAlternateBlock\(\{\s*eligibleLocales: kwSitemapLocales,/.test(SITEMAP_BLOCK),
      'the alternate block must read `kwSitemapLocales`. Feeding it a wider set advertises an '
        + 'alternate that has no published <loc>, which is the reciprocity failure the hreflang '
        + 'audits reject',
    ).toBe(true);
    expect(
      /if \(!kwSitemapLocales\.has\(l\)\) continue;/.test(SITEMAP_BLOCK),
      'the <loc> push loop must be gated on `kwSitemapLocales`, the same set the alternates use',
    ).toBe(true);
  });

  it('only advertises x-default when the IT landing is itself published', () => {
    expect(
      /kwSitemapLocales\.has\('it'\)/.test(SITEMAP_BLOCK),
      'x-default names the IT landing, so it may only be emitted when `it` is in '
        + '`kwSitemapLocales` — otherwise dropping IT re-opens the reciprocity hole one level down',
    ).toBe(true);
    const xDefaultInPush = /keywordSitemapEntries\.push\([^;]*hreflang="x-default"/.test(SITEMAP_BLOCK);
    expect(
      xDefaultInPush,
      'the x-default link must be hoisted into its own conditional binding, not inlined into the '
        + 'pushed <url> template — inlined, it ships unconditionally and cannot follow the set',
    ).toBe(false);
  });

  it('never re-derives a second answer from the floor inside the sitemap block', () => {
    // Code uses only — prose in the comments above may name the set freely.
    const floorHits = SITEMAP_BLOCK.match(/kwEligibleLocales\s*\.\s*has\s*\(/g) ?? [];
    expect(
      floorHits.length,
      'the sitemap block may READ `kwEligibleLocales` exactly once — inside the '
        + '`kwSitemapLocales` derivation. A second read means a second predicate, and two '
        + 'predicates for one question is the defect this gate closes',
    ).toBe(1);
    expect(
      /keywordSitemapEntries\.push\([\s\S]{0,400}?\)/.test(SITEMAP_BLOCK),
      'keywordSitemapEntries.push must still live in the sitemap block',
    ).toBe(true);
    const pushAt = SITEMAP_BLOCK.indexOf('keywordSitemapEntries.push');
    const guardAt = SITEMAP_BLOCK.indexOf('if (!kwSitemapLocales.has(l)) continue;');
    expect(
      guardAt > -1 && guardAt < pushAt,
      'the `kwSitemapLocales` guard must precede the push — a push reachable without it '
        + 'advertises a URL this plugin never wrote',
    ).toBe(true);
  });
});
