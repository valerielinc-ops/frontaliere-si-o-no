import { describe, it, expect } from 'vitest';
import {
  expectedCtrForPosition,
  ctrGapRatio,
  aggregateFamilyRows,
  effectiveTargetCtr,
  discoverUnregisteredFamilies,
  SEO_CTR_FAMILIES,
  MIN_IMPRESSIONS_TO_MONITOR,
} from '../scripts/lib/seo-ctr-curve.mjs';

describe('seo-ctr-curve (issue #4300)', () => {
  describe('expectedCtrForPosition', () => {
    it('returns the position-1 CTR for position 1', () => {
      expect(expectedCtrForPosition(1)).toBe(0.316);
    });

    it('returns the tail CTR beyond position 20', () => {
      expect(expectedCtrForPosition(25)).toBe(0.006);
    });

    it('rounds fractional positions to the nearest integer bucket', () => {
      expect(expectedCtrForPosition(7.4)).toBe(expectedCtrForPosition(7));
    });

    it('clamps non-finite / sub-1 positions to position 1', () => {
      expect(expectedCtrForPosition(0)).toBe(expectedCtrForPosition(1));
      expect(expectedCtrForPosition(NaN)).toBe(expectedCtrForPosition(1));
    });
  });

  describe('ctrGapRatio', () => {
    it('returns >1 when actual CTR beats the position curve', () => {
      const ratio = ctrGapRatio(0.5, 1); // expected @ pos1 = 0.316
      expect(ratio).toBeGreaterThan(1);
    });

    it('returns <1 when actual CTR underperforms the position curve', () => {
      const ratio = ctrGapRatio(0.01, 1);
      expect(ratio).toBeLessThan(1);
    });
  });

  describe('SEO_CTR_FAMILIES', () => {
    it('has the 3 monitored families from the issue with their target CTRs', () => {
      const byId = Object.fromEntries(SEO_CTR_FAMILIES.map((f) => [f.id, f]));
      expect(byId['articoli-frontaliere'].targetCtr).toBe(0.03);
      expect(byId['guida-frontaliere'].targetCtr).toBe(0.035);
      expect(byId['tasse-e-pensione'].targetCtr).toBe(0.03);
      expect(byId['articoli-frontaliere'].monitored).toBe(true);
      expect(byId['guida-frontaliere'].monitored).toBe(true);
      expect(byId['tasse-e-pensione'].monitored).toBe(true);
    });

    it('keeps the /de/ locale prefix report-only (unmonitored, no target)', () => {
      const byId = Object.fromEntries(SEO_CTR_FAMILIES.map((f) => [f.id, f]));
      expect(byId['de'].kind).toBe('locale');
      expect(byId['de'].monitored).toBe(false);
      expect(byId['de'].targetCtr).toBeNull();
    });

    it('monitors /cerca-lavoro-ticino/, the highest-volume family', () => {
      // Regression guard for the state this test itself used to pin: the
      // family was `monitored: false, targetCtr: null` while carrying
      // 911.138 impressioni / 90gg — 2,4× le tre famiglie sorvegliate insieme.
      const byId = Object.fromEntries(SEO_CTR_FAMILIES.map((f) => [f.id, f]));
      const fam = byId['cerca-lavoro-ticino'];
      expect(fam.kind).toBe('template');
      expect(fam.monitored).toBe(true);
      expect(fam.targetCtrCurveMultiple).toBeGreaterThan(1);
      expect(fam.targetCtr).toBeGreaterThan(0);
    });

    it('every family carries a measured 90-day impression volume', () => {
      // The invariant below is only as good as its input: a family with no
      // `impressions90d` would slip under any volume threshold for free.
      for (const family of SEO_CTR_FAMILIES) {
        expect(
          Number.isFinite(family.impressions90d),
          `${family.id}: manca impressions90d (misura GSC a 90 giorni)`,
        ).toBe(true);
        expect(family.impressions90d, `${family.id}: impressions90d non positivo`).toBeGreaterThan(0);
        expect(typeof family.measuredOn, `${family.id}: manca measuredOn`).toBe('string');
      }
    });

    it('THE INVARIANT: every template family above the volume threshold is monitored with a usable target', () => {
      // This is the test the missing `/cerca-lavoro-ticino/` entry needed and
      // did not have. Without it, dropping `monitored: true` is a silent
      // one-word edit that no gate notices.
      const offenders = SEO_CTR_FAMILIES.filter(
        (f) => f.kind === 'template' && f.impressions90d >= MIN_IMPRESSIONS_TO_MONITOR && !f.monitored,
      ).map((f) => `${f.id} (${f.impressions90d} impressioni/90gg)`);
      expect(
        offenders,
        `famiglie template sopra ${MIN_IMPRESSIONS_TO_MONITOR} impressioni/90gg lasciate fuori dal monitor: ${offenders.join(', ')}`,
      ).toEqual([]);

      for (const family of SEO_CTR_FAMILIES.filter((f) => f.monitored)) {
        // A monitored family whose target resolves to null (or to 0) would
        // make `ctr < target` always false — a monitor that can never fire.
        const target = effectiveTargetCtr(family, 8);
        expect(target, `${family.id}: target effettivo non risolvibile`).not.toBeNull();
        expect(target, `${family.id}: target effettivo non positivo`).toBeGreaterThan(0);
      }
    });

    it('the `locale` exemption cannot be used to hide a template family', () => {
      // `kind: 'locale'` is the only way out of the invariant above, so it is
      // pinned to an actual locale root. Relabelling e.g. /cerca-lavoro-ticino/
      // as `locale` to silence the invariant fails here.
      for (const family of SEO_CTR_FAMILIES.filter((f) => f.kind === 'locale')) {
        expect(
          family.pathContains,
          `${family.id}: kind 'locale' ammesso solo su una radice /xx/`,
        ).toMatch(/^\/(en|de|fr|it)\/$/);
      }
      for (const family of SEO_CTR_FAMILIES) {
        expect(['template', 'locale'], `${family.id}: kind sconosciuto`).toContain(family.kind);
      }
    });
  });

  describe('effectiveTargetCtr', () => {
    const curveFamily = { id: 'x', targetCtr: 0.053, targetCtrCurveMultiple: 1.9 };
    const staticFamily = { id: 'y', targetCtr: 0.03 };

    it('derives the target from the position curve when a multiple is declared', () => {
      // expectedCtrForPosition(8.61) → bucket 9 → 0.028; 1.9 × 0.028 = 0.0532
      expect(effectiveTargetCtr(curveFamily, 8.61)).toBeCloseTo(1.9 * 0.028, 10);
    });

    it('moves the target with the position instead of freezing it', () => {
      const atFour = effectiveTargetCtr(curveFamily, 4);
      const atFifteen = effectiveTargetCtr(curveFamily, 15);
      expect(atFour).toBeGreaterThan(atFifteen);
    });

    it('falls back to the static target when the position is unusable', () => {
      expect(effectiveTargetCtr(curveFamily, null)).toBe(0.053);
      expect(effectiveTargetCtr(curveFamily, NaN)).toBe(0.053);
      expect(effectiveTargetCtr(curveFamily, 0)).toBe(0.053);
    });

    it('leaves families without a curve multiple on their static target', () => {
      expect(effectiveTargetCtr(staticFamily, 8.61)).toBe(0.03);
    });

    it('returns null for a report-only family', () => {
      expect(effectiveTargetCtr({ id: 'z', targetCtr: null }, 8.61)).toBeNull();
    });

    it('would not fire on the /cerca-lavoro-ticino/ CTR measured on 2026-08-11', () => {
      // Sanity check that the chosen threshold is neither ornamental nor
      // trigger-happy: at the measured 6,63% / pos 8,61 the family is above
      // target, and a 25% CTR regression at the same position drops below it.
      const fam = SEO_CTR_FAMILIES.find((f) => f.id === 'cerca-lavoro-ticino')!;
      const target = effectiveTargetCtr(fam, 8.61)!;
      expect(0.0663).toBeGreaterThan(target);
      expect(0.0663 * 0.75).toBeLessThan(target);
    });
  });

  describe('discoverUnregisteredFamilies (issue #5656)', () => {
    const families = [
      { id: 'articoli-frontaliere', pathContains: '/articoli-frontaliere/' },
      { id: 'de', pathContains: '/de/' },
    ];

    it('flags an unregistered segment above the threshold', () => {
      const rows = [
        { path: '/cerca-lavoro-ticino/qualche-annuncio/', impressions: 40_000 },
        { path: '/cerca-lavoro-ticino/altro-annuncio/', impressions: 20_000 },
      ];
      const result = discoverUnregisteredFamilies(rows, { families, minImpressions: 50_000 });
      expect(result).toEqual([{ pathContains: '/cerca-lavoro-ticino/', impressions90d: 60_000 }]);
    });

    it('rolls up locale-prefixed pages into the same segment as the default locale', () => {
      const rows = [
        { path: '/cerca-lavoro-ticino/annuncio-it/', impressions: 30_000 },
        { path: '/en/cerca-lavoro-ticino/annuncio-en/', impressions: 25_000 },
      ];
      const result = discoverUnregisteredFamilies(rows, { families, minImpressions: 50_000 });
      expect(result).toEqual([{ pathContains: '/cerca-lavoro-ticino/', impressions90d: 55_000 }]);
    });

    it('excludes segments already covered by a registered pathContains', () => {
      const rows = [{ path: '/articoli-frontaliere/qualche-post/', impressions: 1_000_000 }];
      const result = discoverUnregisteredFamilies(rows, { families, minImpressions: 50_000 });
      expect(result).toEqual([]);
    });

    it('drops segments below the impressions threshold', () => {
      const rows = [{ path: '/nuova-sezione/pagina/', impressions: 49_999 }];
      const result = discoverUnregisteredFamilies(rows, { families, minImpressions: 50_000 });
      expect(result).toEqual([]);
    });

    it('sorts multiple candidates by descending impressions', () => {
      const rows = [
        { path: '/sezione-a/x/', impressions: 60_000 },
        { path: '/sezione-b/x/', impressions: 90_000 },
      ];
      const result = discoverUnregisteredFamilies(rows, { families, minImpressions: 50_000 });
      expect(result.map((r) => r.pathContains)).toEqual(['/sezione-b/', '/sezione-a/']);
    });

    it('ignores rows with no path or root-only paths', () => {
      const rows = [
        { path: '/', impressions: 1_000_000 },
        { path: '', impressions: 1_000_000 },
        { impressions: 1_000_000 },
      ];
      const result = discoverUnregisteredFamilies(rows, { families, minImpressions: 50_000 });
      expect(result).toEqual([]);
    });

    it('defaults to SEO_CTR_FAMILIES and MIN_IMPRESSIONS_TO_MONITOR when not overridden', () => {
      const result = discoverUnregisteredFamilies([]);
      expect(result).toEqual([]);
    });
  });

  describe('aggregateFamilyRows', () => {
    const rows = [
      { path: '/a', clicks: 10, impressions: 200, position: 3, ctr: 0.05 },
      { path: '/b', clicks: 1, impressions: 100, position: 5, ctr: 0.01 }, // well below curve
      { path: '/c', clicks: 2, impressions: 10, position: 2, ctr: 0.2 }, // below minImpressions, excluded
    ];

    it('filters rows below minImpressions and aggregates the rest', () => {
      const agg = aggregateFamilyRows(rows, { minImpressions: 20 });
      expect(agg.pageCount).toBe(2);
      expect(agg.totalClicks).toBe(11);
      expect(agg.totalImpressions).toBe(300);
      expect(agg.avgCtr).toBeCloseTo(11 / 300, 6);
    });

    it('computes an impressions-weighted average position', () => {
      const agg = aggregateFamilyRows(rows, { minImpressions: 20 });
      const expected = (3 * 200 + 5 * 100) / 300;
      expect(agg.avgPosition).toBeCloseTo(expected, 6);
    });

    it('flags pages whose CTR falls below underperformRatio × expected-for-position', () => {
      // Expected CTR @ position 3 ≈ 0.106: /healthy sits well above it,
      // /weak sits well below it (ratio < 0.6) and should be the only flag.
      const flagRows = [
        { path: '/healthy', clicks: 30, impressions: 200, position: 3, ctr: 0.15 },
        { path: '/weak', clicks: 1, impressions: 100, position: 3, ctr: 0.01 },
      ];
      const agg = aggregateFamilyRows(flagRows, { minImpressions: 20, underperformRatio: 0.6 });
      expect(agg.belowCurveCount).toBe(1);
      expect(agg.belowCurvePages[0].path).toBe('/weak');
    });

    it('returns null avgCtr/avgPosition and zero counts for an empty/all-filtered input', () => {
      const agg = aggregateFamilyRows([], { minImpressions: 20 });
      expect(agg.pageCount).toBe(0);
      expect(agg.totalClicks).toBe(0);
      expect(agg.totalImpressions).toBe(0);
      expect(agg.avgCtr).toBeNull();
      expect(agg.avgPosition).toBeNull();
      expect(agg.belowCurveCount).toBe(0);
    });
  });
});
