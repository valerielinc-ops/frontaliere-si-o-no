import { describe, expect, it } from 'vitest';

import {
  INFEED_AD_AB_TEST_SUPPRESSED_CANTONS,
  JOBLIST_AD_EVERY_N,
  JOBLIST_AD_MAX_PER_LIST,
  shouldPlaceInfeedAd,
} from '@/services/adsenseSlots';

/**
 * Issue #2935 (follow-up of #2931 "in-feed ogni 3 uniforme su TUTTE le liste
 * job statiche + cap densità"). Deferred item: confirm the `JOBLIST_AD_MAX_PER_LIST`
 * cap value and evaluate its behaviour on the SPA infinite-scroll main list
 * (`components/community/JobBoard.tsx`), where the rendered list keeps
 * growing (mobile `loadMoreMobile` appends +10 jobs per intersection) instead
 * of being paginated into fixed pages like the static SSG lists.
 *
 * `shouldPlaceInfeedAd` is the single source of truth shared by every
 * render path (SPA JobBoard main list + editorial sections, JobExpiredView
 * related-jobs, and every static build-plugin job list via
 * `renderJobCardListHtml` / `jobCardListBody` / the weeklyEmployersPlugin
 * bespoke loop) — see `gitnexus_impact` upstream (34 impacted symbols across
 * Build-plugins + Services, HIGH risk). These tests pin its cadence + cap
 * contract so no caller can silently drift the density policy.
 */
describe('adsenseSlots — shouldPlaceInfeedAd cadence + density cap', () => {
  it('places an ad after every Nth card (3, 6, 9, …)', () => {
    const hits = Array.from({ length: 12 }, (_, i) => i + 1).filter(shouldPlaceInfeedAd);
    expect(hits).toEqual([3, 6, 9, 12]);
  });

  it('never places an ad on non-multiple-of-N positions', () => {
    expect(shouldPlaceInfeedAd(1)).toBe(false);
    expect(shouldPlaceInfeedAd(2)).toBe(false);
    expect(shouldPlaceInfeedAd(4)).toBe(false);
    expect(shouldPlaceInfeedAd(0)).toBe(false);
    expect(shouldPlaceInfeedAd(-3)).toBe(false);
  });

  it('caps total ad placements at JOBLIST_AD_MAX_PER_LIST regardless of list length', () => {
    // Confirms the #2935 cap value (12): scanning far past the cap boundary
    // (position 1..500, e.g. a very long paginated or crawled list) never
    // yields more than JOBLIST_AD_MAX_PER_LIST placements.
    const positions = Array.from({ length: 500 }, (_, i) => i + 1);
    const hits = positions.filter(shouldPlaceInfeedAd);
    expect(hits.length).toBe(JOBLIST_AD_MAX_PER_LIST);
    expect(hits[hits.length - 1]).toBe(JOBLIST_AD_EVERY_N * JOBLIST_AD_MAX_PER_LIST);
  });

  it('stops interleaving new ads exactly at the cap boundary card', () => {
    const capBoundary = JOBLIST_AD_EVERY_N * JOBLIST_AD_MAX_PER_LIST; // 36
    expect(shouldPlaceInfeedAd(capBoundary)).toBe(true);
    expect(shouldPlaceInfeedAd(capBoundary + JOBLIST_AD_EVERY_N)).toBe(false);
  });

  describe('SPA infinite-scroll accumulation (JobBoard mobile loadMoreMobile)', () => {
    // JobBoard.tsx's mobile list re-derives `displayJobs` from position 0 on
    // every `loadMoreMobile()` call (`mobileJobs = filteredJobs.slice(0, mobileJobLimit)`,
    // `mobileJobLimit` growing +10 per intersection) and re-evaluates
    // `shouldPlaceInfeedAd(idx + 1)` over the FULL accumulated array each
    // render — positions are absolute/cumulative, never reset per batch. This
    // simulates that growth pattern directly against the shared predicate.
    function adPositionsForListLength(length: number): number[] {
      return Array.from({ length }, (_, i) => i + 1).filter(shouldPlaceInfeedAd);
    }

    it('keeps previously-placed ad positions stable as more batches load (no reflow/duplication)', () => {
      const batches = [10, 20, 30, 40, 50, 100]; // mobileJobLimit after 1..6 "load more" triggers
      let previous: number[] = [];
      for (const limit of batches) {
        const current = adPositionsForListLength(limit);
        // Every ad position already placed in a smaller batch must still be
        // present, at the same index, once the list grows — infinite scroll
        // must never re-shuffle ads the user has already scrolled past.
        expect(current.slice(0, previous.length)).toEqual(previous);
        previous = current;
      }
    });

    it('never exceeds the density cap no matter how many infinite-scroll batches load', () => {
      // Even after loading far beyond the cap boundary (e.g. 50 "load more"
      // triggers x10 = 500 accumulated cards), total ads stay capped at 12 —
      // the SPA main list cannot runaway-emit ads the way an unbounded
      // "every 3" would on a long infinite-scroll session.
      for (const limit of [36, 40, 100, 250, 500]) {
        expect(adPositionsForListLength(limit).length).toBeLessThanOrEqual(JOBLIST_AD_MAX_PER_LIST);
      }
      expect(adPositionsForListLength(500).length).toBe(JOBLIST_AD_MAX_PER_LIST);
    });

    it('reaches the full cap once the accumulated list passes the cap boundary (36 cards)', () => {
      expect(adPositionsForListLength(35).length).toBe(11);
      expect(adPositionsForListLength(36).length).toBe(12);
      expect(adPositionsForListLength(37).length).toBe(12);
    });
  });

  /**
   * Canton in-feed A/B tests: Lucerna ('LU') is the treatment against
   * Basilea, and Ticino ('TI') is the treatment against the national
   * Switzerland listing. Both treatment canton listings suppress the manual
   * in-feed slot (JOBLIST_INFEED_DESKTOP/MOBILE); Basilea and the national
   * listing stay on the unmodified cadence. The two
   * call sites that opt into this (components/community/JobBoard.tsx
   * `displayJobs.map` main list, build-plugins/jobsSeoPagesPlugin.ts
   * canton-index `cantonJobs.map`) both pass `{ canton }` straight through
   * to this shared predicate — it is the single point that decides
   * suppression, so pinning its contract here covers both render paths.
   */
  describe('canton in-feed A/B test (opt-in `opts.canton`)', () => {
    it('suppresses every in-feed placement for both treatment cantons, regardless of cadence', () => {
      for (const canton of ['LU', 'TI']) {
        for (const pos of [3, 6, 9, 12, 36]) {
          expect(shouldPlaceInfeedAd(pos, { canton })).toBe(false);
        }
      }
    });

    it('is case-insensitive on the canton code', () => {
      expect(shouldPlaceInfeedAd(3, { canton: 'lu' })).toBe(false);
      expect(shouldPlaceInfeedAd(3, { canton: 'Lu' })).toBe(false);
      expect(shouldPlaceInfeedAd(3, { canton: 'ti' })).toBe(false);
      expect(shouldPlaceInfeedAd(3, { canton: 'Ti' })).toBe(false);
    });

    it('never suppresses positions that were already non-cadence (no false "it never fires at all" pass)', () => {
      expect(shouldPlaceInfeedAd(1, { canton: 'LU' })).toBe(false);
      expect(shouldPlaceInfeedAd(2, { canton: 'LU' })).toBe(false);
      // Still false, but for the ORIGINAL cadence reason, not the A/B one —
      // both a suppressed canton and a non-multiple-of-N position independently
      // return false, so this only guards against a future refactor that makes
      // the canton branch mask the cadence branch's own test coverage.
    });

    it('leaves the control canton (BASILEA) on the unmodified cadence', () => {
      const hits = [1, 2, 3, 4, 5, 6, 7, 8, 9].filter((p) =>
        shouldPlaceInfeedAd(p, { canton: 'BASILEA' }),
      );
      expect(hits).toEqual([3, 6, 9]);
    });

    it('leaves every other canton on the unmodified cadence', () => {
      for (const canton of ['ZH', 'GE', 'BS', 'BL', 'VD', 'AG']) {
        const hits = [1, 2, 3, 4, 5, 6].filter((p) => shouldPlaceInfeedAd(p, { canton }));
        expect(hits).toEqual([3, 6]);
      }
    });

    it('leaves callers that pass no canton at all untouched (every existing call site)', () => {
      expect(shouldPlaceInfeedAd(3)).toBe(true);
      expect(shouldPlaceInfeedAd(3, {})).toBe(true);
      expect(shouldPlaceInfeedAd(3, { canton: null })).toBe(true);
      expect(shouldPlaceInfeedAd(3, { canton: undefined })).toBe(true);
      expect(shouldPlaceInfeedAd(3, { canton: '' })).toBe(true);
    });

    it('stays safe under the `.filter(shouldPlaceInfeedAd)` idiom used throughout this suite and its callers', () => {
      // Array.prototype.filter calls the predicate as (value, index, array) —
      // the existing cadence tests above rely on `.filter(shouldPlaceInfeedAd)`
      // passing the array index as the SECOND argument (this file's own
      // `opts` position). A number has no `.canton` property, so the A/B
      // branch must stay inert for every call shaped this way; this regression
      // test is the one thing standing between "adding an options param" and
      // silently breaking every `.filter(shouldPlaceInfeedAd)` call site.
      const hits = [1, 2, 3, 4, 5, 6, 7, 8, 9].filter(shouldPlaceInfeedAd);
      expect(hits).toEqual([3, 6, 9]);
    });

    it('INFEED_AD_AB_TEST_SUPPRESSED_CANTONS contains exactly the documented treatment set', () => {
      expect([...INFEED_AD_AB_TEST_SUPPRESSED_CANTONS]).toEqual(['LU', 'TI']);
      expect(INFEED_AD_AB_TEST_SUPPRESSED_CANTONS.has('BASILEA')).toBe(false);
    });
  });
});
