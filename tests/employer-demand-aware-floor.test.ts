/**
 * The demand-aware half of the employer-profile indexability floor.
 *
 * `MIN_ACTIVE_JOBS` decided indexability on the job count alone: a page with
 * few postings and high search demand was demoted, one with many postings and
 * no demand was promoted. `build-plugins/shared/employerDemandSignal.mjs` adds
 * the missing term, and this file pins the two properties that make adding it
 * safe rather than merely correct.
 *
 *   1. ONE DIRECTION. The signal can only ADD a page to the indexable set.
 *      No demand table, a bad one, a stale one or an empty one must all
 *      produce the SAME result as the pre-demand gate — because a missing
 *      reading is absence of signal, not a measurement of zero demand, and the
 *      two failure modes are not symmetric: holding a thin page indexable for
 *      one build costs crawl budget, demoting a few hundred earning URLs on a
 *      transient bad read costs months of ranking.
 *
 *   2. THE COMPANY LIST IS MANDATORY. Measured on a real 90-day pull
 *      (2026-05-10 → 2026-08-08, 78 796 GSC query rows): 1 706 candidates, of
 *      which only 373 cross-reference data/marquee-companies-list.json. The
 *      top of the other 1 333 by clicks is Basel, Valais, Salute, Logistica,
 *      Crans Montana — cantons and professions, which occupy the same
 *      grammatical slot a brand does ("lavoro Basel" parses like "lavoro
 *      Roche"). Dropping the cross-reference would let a canton hold pages
 *      indexable.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DEMAND_MAX_AGE_DAYS,
  DEMAND_MIN_CLICKS,
  DEMAND_MIN_IMPRESSIONS,
  DEMAND_TABLE_PATH,
  loadEmployerDemandSlugs,
  selectDemandBackedSlugs,
} from '../build-plugins/shared/employerDemandSignal.mjs';
import { BRIDGE_FLOOR, MIN_ACTIVE_JOBS } from '../build-plugins/shared/employerProfileConfig.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const readRepoFile = (rel: string) => readFileSync(resolve(__dirname, '..', rel), 'utf8');

const NOW = new Date('2026-08-08T12:00:00.000Z');
const FRESH = '2026-08-08T06:00:00.000Z';

type Row = {
  company_name: string;
  estimated_clicks: number;
  estimated_impressions: number;
  in_marquee_list: boolean;
};

const row = (over: Partial<Row> & { company_name: string }): Row => ({
  estimated_clicks: 0,
  estimated_impressions: 0,
  in_marquee_list: true,
  ...over,
});

const table = (candidates: Row[], over: Record<string, unknown> = {}) => ({
  _generatedAt: FRESH,
  _truncated: false,
  candidates,
  ...over,
});

describe('selectDemandBackedSlugs — what counts as proven demand', () => {
  it('keys demand by the ONE canonical employer slug, not by the raw name', () => {
    // The same normalisation the hub URL, the dataset and the CompanyAlert key
    // share. A second slugifier here would key demand to a slug no page uses.
    const proven = selectDemandBackedSlugs(
      table([row({ company_name: 'Migros Ticino', estimated_impressions: 500 })]),
      { now: NOW },
    );
    expect(proven.has('migros')).toBe(true);
  });

  it('SUMS the many name variants that fold onto one employer', () => {
    // The extractor keys by extracted NAME, and one employer produces many: the
    // real pull carries 33 rows folding onto `migros` and 32 onto `coop`. They
    // are distinct query groups for one page, so their demand adds — taking the
    // max would under-read the most fragmented brands by exactly that factor.
    const each = Math.floor(DEMAND_MIN_IMPRESSIONS / 4);
    const rows = [1, 2, 3, 4, 5].map(() => row({ company_name: 'Coop', estimated_impressions: each }));
    expect(each * 1).toBeLessThan(DEMAND_MIN_IMPRESSIONS); // no single row clears it
    expect(selectDemandBackedSlugs(table(rows), { now: NOW }).has('coop')).toBe(true);
  });

  it('accepts either bar — clicks OR impressions', () => {
    const byClicks = selectDemandBackedSlugs(
      table([row({ company_name: 'Roche', estimated_clicks: DEMAND_MIN_CLICKS })]),
      { now: NOW },
    );
    expect(byClicks.has('roche')).toBe(true);

    const byImpressions = selectDemandBackedSlugs(
      table([row({ company_name: 'Roche', estimated_impressions: DEMAND_MIN_IMPRESSIONS })]),
      { now: NOW },
    );
    expect(byImpressions.has('roche')).toBe(true);
  });

  it('rejects an employer below BOTH bars', () => {
    const proven = selectDemandBackedSlugs(
      table([
        row({
          company_name: 'Roche',
          estimated_clicks: DEMAND_MIN_CLICKS - 1,
          estimated_impressions: DEMAND_MIN_IMPRESSIONS - 1,
        }),
      ]),
      { now: NOW },
    );
    expect(proven.size).toBe(0);
  });

  it('IGNORES a row that is not on the curated company list, however big', () => {
    // "Basel" took 205 clicks / 3 444 impressions in the real pull and is a
    // canton. Without this filter it would hold pages indexable.
    const proven = selectDemandBackedSlugs(
      table([
        row({
          company_name: 'Basel',
          estimated_clicks: 205,
          estimated_impressions: 3444,
          in_marquee_list: false,
        }),
      ]),
      { now: NOW },
    );
    expect(proven.size).toBe(0);
  });
});

describe('every unknown degrades to the pre-demand floor, never to a demotion', () => {
  const strong = [row({ company_name: 'Roche', estimated_impressions: 10_000, estimated_clicks: 900 })];

  it('a TRUNCATED pull is refused rather than read as a complete table', () => {
    // GSC orders rows by clicks descending, so a truncated set is missing
    // exactly the low-click tail these employers live in. Reading it anyway
    // would treat "we stopped fetching" as "no more demand".
    expect(selectDemandBackedSlugs(table(strong, { _truncated: true }), { now: NOW }).size).toBe(0);
  });

  it('a STALE table stops counting as a reading', () => {
    const stale = new Date(NOW.getTime() + (DEMAND_MAX_AGE_DAYS + 1) * 86_400_000);
    expect(selectDemandBackedSlugs(table(strong), { now: stale }).size).toBe(0);
    // …and one inside the window still does.
    const justInside = new Date(NOW.getTime() + (DEMAND_MAX_AGE_DAYS - 1) * 86_400_000);
    expect(selectDemandBackedSlugs(table(strong), { now: justInside }).has('roche')).toBe(true);
  });

  it('a table with no or unparseable `_generatedAt` proves nothing', () => {
    expect(selectDemandBackedSlugs({ candidates: strong }, { now: NOW }).size).toBe(0);
    expect(selectDemandBackedSlugs(table(strong, { _generatedAt: 'nope' }), { now: NOW }).size).toBe(0);
  });

  it('a table from the FUTURE is a clock problem, not a reading', () => {
    const past = new Date(NOW.getTime() - 5 * 86_400_000);
    expect(selectDemandBackedSlugs(table(strong), { now: past }).size).toBe(0);
  });

  it('malformed input never throws — it returns an empty set', () => {
    for (const bad of [null, undefined, 42, 'x', [], {}, { candidates: 'no' }, { candidates: [null, 1] }]) {
      expect(() => selectDemandBackedSlugs(bad as unknown, { now: NOW })).not.toThrow();
      expect(selectDemandBackedSlugs(bad as unknown, { now: NOW }).size).toBe(0);
    }
  });

  it('a MISSING artifact is the normal state and reads as an empty set', () => {
    // The producer is weekly; until it has run once the file does not exist at
    // all. That has to be indistinguishable from "nobody cleared the bar".
    const set = loadEmployerDemandSlugs(resolve(__dirname, 'no-such-root-at-all'));
    expect(set).toBeInstanceOf(Set);
    expect(set.size).toBe(0);
  });

  it('reads the artifact from the path the workflow commits it to', () => {
    expect(DEMAND_TABLE_PATH).toBe('data/gsc-top-marquee-candidates.json');
    const workflow = readRepoFile('.github/workflows/refresh-gsc-marquee-demand.yml');
    expect(workflow).toContain('data/gsc-top-marquee-candidates.json');
    const script = readRepoFile('scripts/identify-top-marquee-by-gsc.mjs');
    expect(script).toContain("'gsc-top-marquee-candidates.json'");
  });
});

describe('the plugin composes the gate so the signal can only ADD pages', () => {
  const plugin = readRepoFile('build-plugins/employerProfilePagesPlugin.ts');

  it('ORs demand onto the job floor instead of replacing it', () => {
    // `A || B` is a superset of `A`: no page indexable today can become
    // noindex because of this, whatever the demand table says or fails to say.
    // Pinned as source because the alternative — asserting on a full SSG run —
    // needs the whole jobs corpus, and the property is structural.
    expect(plugin).toContain('const meetsFloor = liveActive >= MIN_ACTIVE_JOBS || demandHold;');
    expect(plugin).toContain('const indexable = meetsFloor && countHtmlBodyWords(bodyHtml) >= MIN_INDEXABLE_WORDS;');
  });

  it('keeps the thin-content gate ANDed in, so demand cannot buy an empty page', () => {
    // `countHtmlBodyWords` is a content check, not a popularity one. Demand may
    // hold a page with few JOBS; it may never hold one with no PROSE.
    expect(plugin).toMatch(/meetsFloor && countHtmlBodyWords/);
    expect(plugin).not.toMatch(/demandHold \|\| countHtmlBodyWords/);
  });

  it('never holds a page all the way down to zero jobs', () => {
    // Below BRIDGE_FLOOR the page lists nothing. Thin is a judgement call;
    // empty is not, and demand does not make an empty page worth indexing.
    expect(BRIDGE_FLOOR).toBeGreaterThan(0);
    expect(BRIDGE_FLOOR).toBeLessThan(MIN_ACTIVE_JOBS);
    expect(plugin).toContain('const demandHold = liveActive >= BRIDGE_FLOOR && demandBackedSlugs.has(slug);');
  });

  it('applies the hold ONLY to profiles, never to the below-floor band', () => {
    // A BelowFloorRecord carries no cantons[]/cities[]/salaryMedianChf, so the
    // plugin cannot render a full page for one without re-deriving the
    // generator's aggregates — the structural blocker in
    // employerProfileConfig.mjs. The bridge loop must stay unconditional.
    const bridgeLoop = plugin.slice(
      plugin.indexOf('for (const rec of belowFloor)'),
      plugin.indexOf("np.join(distDir, 'data', 'employer-job-counts.json')"),
    );
    expect(bridgeLoop.length).toBeGreaterThan(500);
    expect(bridgeLoop).not.toContain('demandBackedSlugs');
    expect(bridgeLoop).not.toContain('demandHold');
    expect(bridgeLoop).toContain("robots: 'noindex,follow'");
  });

  it('loads the table ONCE per build, not once per employer', () => {
    const loadCalls = plugin.split('loadEmployerDemandSlugs(').length - 1;
    expect(loadCalls).toBe(1);
    const loadAt = plugin.indexOf('loadEmployerDemandSlugs(rootDir)');
    const loopAt = plugin.indexOf('for (const profile of profiles)');
    expect(loadAt).toBeGreaterThan(-1);
    expect(loadAt).toBeLessThan(loopAt);
  });

  it('reports the reading in the build log, including when it is zero', () => {
    // A demand gate nobody can see is one nobody can tell apart from a broken
    // one — and 0 is the expected value until the weekly producer first runs.
    expect(plugin).toContain('demand signal:');
    expect(plugin).toContain('held indexable below MIN_ACTIVE_JOBS');
  });

  it('the config comment no longer claims the floor ignores demand', () => {
    // That block comment was the reference explanation for "why annunci only".
    // Leaving it intact while the code changed would make it the most
    // convincing wrong document in the repo.
    const config = readRepoFile('build-plugins/shared/employerProfileConfig.mjs');
    expect(config).toContain('employerDemandSignal.mjs');
    expect(config).not.toContain('WHY THE FLOOR IS STILL COUNTED IN ANNUNCI');
    // The two halves that are still deliberately NOT done stay documented.
    expect(config).toContain('PROMOTE (still blocked)');
    expect(config).toContain('DEMOTE (still deliberately absent)');
  });
});
