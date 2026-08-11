import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  DOUBLE_VALIDATED_MIN_ONSITE,
  DOUBLE_VALIDATED_MIN_JOBS,
  SUPPLY_VALIDATED_MIN_JOBS,
  SUPPLY_VALIDATED_MIN_FILTER_JOBS,
  FILTER_PRECISION_MAX_RATIO,
  hasPreciseFeedFilter,
  isPromotable,
} from '../scripts/lib/profession-taxonomy.mjs';
import {
  KEYWORD_LANDING_LOCALE_PREFIX,
  KEYWORD_LANDING_SECTION,
  KEYWORD_LANDING_SEARCH_PREFIX,
  keywordLandingPath,
  keywordPageSlugify,
  professionKeywordQuery,
  professionKeywordLandingPath,
} from '../scripts/lib/keyword-page-paths.mjs';

/**
 * Drift guard for #4564: profession-keyword-opportunities.mjs flags a gap
 * "✅ doppia validazione" once onsite >= DOUBLE_VALIDATED_MIN_ONSITE (10) AND
 * enough matching job ads exist. generate-keyword-pages-config.mjs's
 * profession-gap feed is what actually turns that flag into a live page —
 * it previously re-checked a second, independently-tuned, stricter local
 * floor (`onsiteCount >= 25`) on top of `doubleValidated`, so any gap with
 * onsite in [10, 24] sat in the weekly report forever, correctly flagged
 * "✅" but never promoted to a page. Fixed by trusting `doubleValidated` as
 * the single source of truth (shared constants below) instead of a second
 * copy-pasted threshold that could silently drift stricter again.
 */

const ROOT = resolve(import.meta.dirname, '..');
const OPPORTUNITIES_SRC = readFileSync(resolve(ROOT, 'scripts/profession-keyword-opportunities.mjs'), 'utf-8');
const FEED_SRC = readFileSync(resolve(ROOT, 'scripts/generate-keyword-pages-config.mjs'), 'utf-8');
const PLUGIN_SRC = readFileSync(resolve(ROOT, 'build-plugins/jobsSeoPagesPlugin.ts'), 'utf-8');

describe('DOUBLE_VALIDATED thresholds (#4564 drift guard)', () => {
  it('are the expected values (catches an accidental rename/retune of the shared consts)', () => {
    expect(DOUBLE_VALIDATED_MIN_ONSITE).toBe(10);
    expect(DOUBLE_VALIDATED_MIN_JOBS).toBe(3);
  });

  it('profession-keyword-opportunities.mjs imports the shared consts instead of a local literal', () => {
    expect(
      /import\s*\{[^}]*\bDOUBLE_VALIDATED_MIN_ONSITE\b[^}]*\}\s*from\s*'\.\/lib\/profession-taxonomy\.mjs'/.test(OPPORTUNITIES_SRC),
      "profession-keyword-opportunities.mjs must import DOUBLE_VALIDATED_MIN_ONSITE from './lib/profession-taxonomy.mjs'",
    ).toBe(true);
    expect(
      /^\s*const DOUBLE_VALIDATED_MIN_ONSITE\s*=/m.test(OPPORTUNITIES_SRC),
      'profession-keyword-opportunities.mjs must not re-declare DOUBLE_VALIDATED_MIN_ONSITE locally',
    ).toBe(false);
  });

  it('the profession-gap feed gates on the SHARED predicate, never a local floor', () => {
    expect(
      FEED_SRC.includes('if (!isPromotable(o)) continue;'),
      'generate-keyword-pages-config.mjs must gate the profession-gap feed on the shared '
        + 'isPromotable() predicate — the same one the weekly ranking reports, so a row marked '
        + 'promotable there is always one the feed actually promotes',
    ).toBe(true);
    expect(
      /import\s*\{[^}]*\bisPromotable\b[^}]*\}\s*from\s*'\.\/lib\/profession-taxonomy\.mjs'/.test(FEED_SRC),
      "generate-keyword-pages-config.mjs must import isPromotable from './lib/profession-taxonomy.mjs'",
    ).toBe(true);
    expect(
      /FEED_MIN_ONSITE/.test(FEED_SRC),
      'generate-keyword-pages-config.mjs must not reintroduce a second, stricter onsite floor (the #4564 dead zone)',
    ).toBe(false);
  });
});

/**
 * Supply validation (#5051).
 *
 * On-site search is a demand signal that cannot fire for a profession the
 * site has no page for: the visitor is only in the search box because
 * something already ranks. Eight professions with 12-65 live job ads read
 * onsite=0 on the 2026-08-03 report and sat there indefinitely, correctly
 * excluded by a gate that was asking the wrong question of them.
 *
 * The second qualification asks the supply side instead, at FOUR TIMES the
 * job bar, and both paths now require the literal feedFilter to be no broader
 * than the profession it names.
 */
describe('supply validation opens the demand-signal dead zone without lowering anything', () => {
  const row = (o: Partial<{ onsiteCount: number; jobCount: number; feedFilterJobCount: number }>) => ({
    onsiteCount: 0, jobCount: 0, feedFilterJobCount: 0, ...o,
  });

  it('keeps the demand thresholds exactly where they were', () => {
    // The point of this whole change is that nothing got easier. If a future
    // edit "opens up" the funnel by moving these, it fails here.
    expect(DOUBLE_VALIDATED_MIN_ONSITE).toBe(10);
    expect(DOUBLE_VALIDATED_MIN_JOBS).toBe(3);
  });

  it('asks a supply-validated page for four times the double-validated job bar', () => {
    expect(SUPPLY_VALIDATED_MIN_JOBS).toBe(DOUBLE_VALIDATED_MIN_JOBS * 4);
    expect(SUPPLY_VALIDATED_MIN_FILTER_JOBS).toBeGreaterThan(DOUBLE_VALIDATED_MIN_JOBS);
  });

  it('promotes a profession with real inventory and no on-site history', () => {
    // `cassiere` on the 2026-08-03 report: 65 ads, 14 literal matches, 0
    // on-site. A page here lists 65 real jobs; the old gate asked whether
    // anyone had already searched for it on a site that never offered it.
    expect(isPromotable(row({ onsiteCount: 0, jobCount: 65, feedFilterJobCount: 14 }))).toBe(true);
  });

  it('still promotes on demand alone when supply is below the supply bar', () => {
    // `custode`: 15 on-site, 64 ads, 3 literal — double-validated, and its
    // 3 literal matches are under SUPPLY_VALIDATED_MIN_FILTER_JOBS. The two
    // paths must be OR, not a merged floor that drops it.
    expect(isPromotable(row({ onsiteCount: 15, jobCount: 64, feedFilterJobCount: 3 }))).toBe(true);
  });

  it('refuses a profession with no inventory however much it is searched', () => {
    // `parrucchiere`: 30 on-site, 2 ads. jobsSeoPagesPlugin's own >=3 gate
    // would refuse to emit the page — feeding it produces a config entry that
    // silently never becomes a URL.
    expect(isPromotable(row({ onsiteCount: 30, jobCount: 2, feedFilterJobCount: 1 }))).toBe(false);
  });

  it('refuses a filter broader than the profession it names', () => {
    // `agente-sicurezza`, feedFilter "sicurezza": 36 profession matches, 338
    // literal ones — "responsabile sicurezza", "sicurezza sul lavoro", every
    // ad containing the word. A page titled for security guards listing 338
    // unrelated jobs is thin content under a misleading title.
    expect(hasPreciseFeedFilter(36, 338)).toBe(false);
    expect(isPromotable(row({ onsiteCount: 0, jobCount: 36, feedFilterJobCount: 338 }))).toBe(false);
  });

  it('applies the precision guard to the DEMAND path too, not just the new one', () => {
    // Same guard on both qualifications: a broad filter is a bad page
    // regardless of which signal earned it. Nothing promoted today comes near
    // the ratio, so this raises the bar without moving an existing page.
    expect(isPromotable(row({ onsiteCount: 500, jobCount: 10, feedFilterJobCount: 999 }))).toBe(false);
  });

  it('accepts a filter exactly at the ratio and refuses one past it', () => {
    expect(hasPreciseFeedFilter(10, 10 * FILTER_PRECISION_MAX_RATIO)).toBe(true);
    expect(hasPreciseFeedFilter(10, 10 * FILTER_PRECISION_MAX_RATIO + 1)).toBe(false);
  });

  it('fails closed when there is no profession baseline to judge the filter against', () => {
    // jobCount 0 means the curated matcher recognised nothing, so the literal
    // count has nothing to be compared with. Never promote on an unjudgeable
    // filter.
    expect(hasPreciseFeedFilter(0, 50)).toBe(false);
    expect(isPromotable(row({ onsiteCount: 999, jobCount: 0, feedFilterJobCount: 50 }))).toBe(false);
  });

  it('the weekly ranking reports the same predicate it does not recompute', () => {
    expect(
      OPPORTUNITIES_SRC.includes('row.promotable = isPromotable(row);'),
      'profession-keyword-opportunities.mjs must publish `promotable` from the shared predicate, '
        + 'so the report and the feed can never disagree about what is eligible',
    ).toBe(true);
    expect(
      /^\s*(const|let|function)\s+isPromotable\b/m.test(OPPORTUNITIES_SRC),
      'profession-keyword-opportunities.mjs must not re-declare isPromotable locally',
    ).toBe(false);
  });
});

/**
 * The report must name a URL, not a slug.
 *
 * `profession-keyword-opportunities.mjs` wrote its coverage reason as
 * `keyword page /${page.slug}/`. `jobsSeoPagesPlugin` emits keyword landings
 * under `{localePrefix}/{sectionByLocale}/{searchRoutePrefix}-{slug}/`, so
 * every one of those printed paths was a 404: measured on the 2026-08-10
 * report (issue 5505), 23 of the 52 "Già coperte" rows. `/medico-ticino/`
 * 404s; the live page is `/cerca-lavoro-ticino/ricerca-medico-ticino/`, 200
 * and listed in `sitemap-jobs.xml`.
 *
 * The failure mode is not cosmetic. Both a human and the autonomous fix loop
 * read this issue; probing the printed path makes a working chain look broken,
 * which is what a 2026-08-11 session concluded before discovering that all
 * eight professions the report had marked "Promuovibile ✅" were already live.
 *
 * Two invariants keep it closed: the path builder is pinned to the emitter's
 * own literals, and the promotable rows carry the URL they will get — so the
 * claim can be verified with one request instead of inferred.
 */
describe('keyword-page paths: the report prints the URL the emitter serves', () => {
  /** Parse a `const <name>: Record<...> = { it: '…', … };` literal out of the plugin. */
  const pluginLocaleMap = (name: string): Record<string, string> => {
    const block = new RegExp(`const ${name}: Record<[^>]*> = \\{([\\s\\S]*?)\\n\\s*\\};`).exec(PLUGIN_SRC);
    expect(block, `${name} literal not found in build-plugins/jobsSeoPagesPlugin.ts`).toBeTruthy();
    const out: Record<string, string> = {};
    for (const m of block![1].matchAll(/(\w+):\s*'([^']*)'/g)) out[m[1]] = m[2];
    return out;
  };

  it('mirrors the emitter\'s localePrefix / sectionByLocale / searchRoutePrefix verbatim', () => {
    // A rename on the plugin side must fail HERE, not silently turn every URL
    // the weekly report prints into a 404.
    expect(pluginLocaleMap('localePrefix')).toEqual(KEYWORD_LANDING_LOCALE_PREFIX);
    expect(pluginLocaleMap('sectionByLocale')).toEqual(KEYWORD_LANDING_SECTION);
    expect(pluginLocaleMap('searchRoutePrefix')).toEqual(KEYWORD_LANDING_SEARCH_PREFIX);
  });

  it('builds the live path in every locale, trailing slash included', () => {
    // Verified live on 2026-08-11: the IT form is 200 and in sitemap-jobs.xml.
    expect(keywordLandingPath('cassiere-ticino')).toBe('/cerca-lavoro-ticino/ricerca-cassiere-ticino/');
    expect(keywordLandingPath('cassiere-ticino', 'en')).toBe('/en/find-jobs-ticino/search-cassiere-ticino/');
    expect(keywordLandingPath('cassiere-ticino', 'de')).toBe('/de/jobs-im-tessin/suche-cassiere-ticino/');
    expect(keywordLandingPath('cassiere-ticino', 'fr')).toBe('/fr/trouver-emploi-tessin/recherche-cassiere-ticino/');
  });

  it('never returns the bare slug — the exact shape that produced the 404s', () => {
    expect(keywordLandingPath('medico-ticino')).not.toBe('/medico-ticino/');
    expect(keywordLandingPath('medico-ticino')).toBe('/cerca-lavoro-ticino/ricerca-medico-ticino/');
    // Empty in, empty out: a caller must print nothing rather than a path that
    // silently points at the section hub.
    expect(keywordLandingPath('')).toBe('');
  });

  it('the report renders coverage through the shared builder, never a slug template', () => {
    expect(
      /import\s*\{[\s\S]*?\bkeywordLandingPath\b[\s\S]*?\}\s*from\s*'\.\/lib\/keyword-page-paths\.mjs'/.test(OPPORTUNITIES_SRC),
      "profession-keyword-opportunities.mjs must import keywordLandingPath from './lib/keyword-page-paths.mjs'",
    ).toBe(true);
    expect(
      OPPORTUNITIES_SRC.includes('keyword page /${page.slug}/'),
      'profession-keyword-opportunities.mjs must not print the bare slug as a path — that is the 404 this closes',
    ).toBe(false);
  });

  it('the feed slugifies through the same module, so the predicted URL is the created one', () => {
    expect(
      /import\s*\{[\s\S]*?\bkeywordPageSlugify\b[\s\S]*?\}\s*from\s*'\.\/lib\/keyword-page-paths\.mjs'/.test(FEED_SRC),
      "generate-keyword-pages-config.mjs must import keywordPageSlugify from './lib/keyword-page-paths.mjs'",
    ).toBe(true);
    expect(
      /^\s*function slugify\b/m.test(FEED_SRC),
      'generate-keyword-pages-config.mjs must not re-declare a local slugify — one copy, shared with the report',
    ).toBe(false);
  });

  it('predicts, for a promotable profession, the URL the feed really creates', () => {
    // The four measured on 2026-08-11: all live at the predicted path.
    expect(professionKeywordLandingPath('Cassiere')).toBe('/cerca-lavoro-ticino/ricerca-cassiere-ticino/');
    expect(professionKeywordLandingPath('Polimeccanico')).toBe('/cerca-lavoro-ticino/ricerca-polimeccanico-ticino/');
    expect(professionKeywordLandingPath('Disegnatore tecnico')).toBe('/cerca-lavoro-ticino/ricerca-disegnatore-tecnico-ticino/');
    expect(professionKeywordLandingPath('Aiuto cucina')).toBe('/cerca-lavoro-ticino/ricerca-aiuto-cucina-ticino/');
    // Parenthetical qualifiers are dropped by the feed before slugifying.
    expect(professionKeywordQuery('Operatore socio sanitario (OSS)')).toBe('operatore socio sanitario ticino');
    expect(keywordPageSlugify('Custode / portinaio ticino')).toBe('custode-portinaio-ticino');
    // Nothing to name a page after → no URL, rather than a path to the hub.
    expect(professionKeywordLandingPath('(OSS)')).toBe('');
  });

  it('the report publishes the predicted URL on promotable rows', () => {
    expect(
      OPPORTUNITIES_SRC.includes('row.plannedPath = row.promotable ? professionKeywordLandingPath(entry.label) : null;'),
      'profession-keyword-opportunities.mjs must publish `plannedPath` for promotable rows, so '
        + '"Promuovibile ✅" is verifiable with one request instead of inferred from the slug',
    ).toBe(true);
    expect(
      /\|\s*Promuovibile\s*\|\s*Pagina\s*\|/.test(OPPORTUNITIES_SRC),
      'the markdown ranking table must carry the Pagina column that renders plannedPath',
    ).toBe(true);
  });
});
