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
