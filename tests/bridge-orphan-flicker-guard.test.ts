import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(__dirname, '..');

/**
 * Regression: cross-canton bridge URLs (e.g. `/cerca-lavoro-ticino/<slug>/`
 * pointing to a job whose canonical canton is SZ/AI/…) used to FLASH
 * `JobOrphanView` ("Questo annuncio non è più disponibile") in the window
 * between SPA hydration and the bridge fallback fetch resolving — even
 * though the pre-rendered static body had the full job content.
 *
 * Reproduced on prod 2026-05-22 with
 *   /cerca-lavoro-ticino/responsabile-pulizie-manutenzione-60-100-spital-schwyz-schwyz/
 * (canonical canton SZ). First load showed the detail (static paint),
 * refresh flipped to Orphan because hydration outran the slug-map fetch.
 *
 * Fix is two-fold:
 *   1. JobBoard.tsx render branch: if the slug-map knows the job
 *      (getJobMetaForSlug returns an id) and the bridge fallback effect
 *      has not yet attempted for the current targetSlug, render a skeleton
 *      instead of Orphan.
 *   2. router.ts module init: for job-detail URLs, fire
 *      ensureJobSlugMapLoaded() eagerly instead of in requestIdleCallback,
 *      so the slug-map is in memory by the time the render guard runs.
 */
describe('Bridge orphan-flicker guard (2026-05-22 regression)', () => {
  const jobBoardSrc = fs.readFileSync(
    path.resolve(root, 'components/community/JobBoard.tsx'),
    'utf-8',
  );
  const routerSrc = fs.readFileSync(
    path.resolve(root, 'services/router.ts'),
    'utf-8',
  );

  describe('JobBoard render guard', () => {
    it('looks up bridge meta via getJobMetaForSlug before rendering JobOrphanView', () => {
      // The guard must consult the slug map BEFORE the Orphan render branch.
      expect(jobBoardSrc).toMatch(/const bridgeTargetForRender = bridgeTargetSlug \|\| initialJobSlug;/);
      expect(jobBoardSrc).toMatch(/const bridgeMeta = getJobMetaForSlug\(bridgeTargetForRender\);/);
    });

    it('returns SkeletonJobDetail when the bridge fetch has not yet attempted for the current slug', () => {
      // Pattern: if slug-map knows this slug (bridgeMeta.id present) AND
      // bridgeFetchAttempted !== bridgeTargetForRender, render skeleton.
      expect(jobBoardSrc).toMatch(
        /if \(bridgeMeta\?\.id && bridgeFetchAttempted !== bridgeTargetForRender\) \{[\s\S]{0,200}return <SkeletonJobDetail \/>;[\s\S]{0,40}\}/,
      );
    });

    it('places the guard above the JobOrphanView fallback', () => {
      // Source order matters: guard must precede the Orphan return.
      const guardIdx = jobBoardSrc.indexOf('bridgeFetchAttempted !== bridgeTargetForRender');
      const orphanIdx = jobBoardSrc.indexOf('<JobOrphanView');
      expect(guardIdx).toBeGreaterThan(0);
      expect(orphanIdx).toBeGreaterThan(0);
      expect(guardIdx).toBeLessThan(orphanIdx);
    });
  });

  describe('Cold-load active-job race guard (2026-06-05 regression)', () => {
    // A LIVE job page (e.g. /cerca-lavoro-grigioni/<slug>/) showed a generic
    // centered spinner (and, post-load, could flash JobOrphanView in the
    // cross-canton bridge window) on the FIRST cold load. Root cause: the
    // multi-MB jobs index is still downloading on first paint, so `selectedJob`
    // is transiently undefined. The `if (jobsLoading)` block returns
    // unconditionally, so the guard MUST live inside it (a guard placed in the
    // post-`jobsLoading` orphan cascade is dead code — that cascade is only
    // reached once `jobsLoading === false`). Fix: for a non-seeded job-detail
    // URL, return the layout-matching SkeletonJobDetail inside the
    // `if (jobsLoading)` block, before the generic spinner.
    it('returns SkeletonJobDetail for a non-seeded job-detail URL while jobsLoading is true', () => {
      expect(jobBoardSrc).toMatch(
        /if \(initialJobSlug && !companySlugFilter && !locationSlugFilter && !searchSlugFilter && !seeded\) \{[\s\S]{0,80}return <SkeletonJobDetail \/>;[\s\S]{0,20}\}/,
      );
    });

    it('places the cold-load skeleton INSIDE the jobsLoading block, before the generic listing fallback', () => {
      // Reachability is the whole point: `if (jobsLoading)` returns in every
      // branch, so the guard must precede the generic listing fallback (the
      // <SkeletonJobBoard /> that replaced the old min-h-[80vh] spinner) AND
      // sit after the `if (jobsLoading) {` opener — otherwise it is dead code.
      const jobsLoadingIdx = jobBoardSrc.indexOf('if (jobsLoading) {');
      const coldGuardIdx = jobBoardSrc.indexOf('!searchSlugFilter && !seeded');
      const listingFallbackIdx = jobBoardSrc.indexOf('<SkeletonJobBoard />');
      const orphanIdx = jobBoardSrc.indexOf('<JobOrphanView');
      expect(jobsLoadingIdx).toBeGreaterThan(0);
      expect(coldGuardIdx).toBeGreaterThan(0);
      expect(listingFallbackIdx).toBeGreaterThan(0);
      expect(orphanIdx).toBeGreaterThan(0);
      expect(coldGuardIdx).toBeGreaterThan(jobsLoadingIdx);
      expect(coldGuardIdx).toBeLessThan(listingFallbackIdx);
      expect(coldGuardIdx).toBeLessThan(orphanIdx);
    });

    it('exempts seeded pages so expired/orphan window-data still paints synchronously', () => {
      // The `!seeded` clause is load-bearing: without it, seeded expired pages
      // would be delayed behind the jobs-index fetch they do not need.
      expect(jobBoardSrc).toContain('!searchSlugFilter && !seeded');
    });
  });

  describe('router eager slug-map preload', () => {
    it('defines an isJobDetailUrl predicate that matches cerca-lavoro / find-jobs / jobs-in / trouver-emploi prefixes', () => {
      expect(routerSrc).toContain('const isJobDetailUrl');
      // Must cover all four locale job-board prefixes.
      expect(routerSrc).toMatch(/cerca-lavoro\|find-jobs\|jobs-in\|trouver-emploi/);
    });

    it('strips optional locale prefix (en / de / fr) before matching', () => {
      expect(routerSrc).toMatch(/\['en', 'de', 'fr'\]\.includes\(segments\[0\]\)/);
    });

    it('requires at least two segments after locale stripping (board + job-slug-or-city)', () => {
      // A bare /cerca-lavoro-ticino/ is the LISTING, not a detail page.
      expect(routerSrc).toMatch(/segments\.length > start \+ 1/);
    });

    it('fires ensureJobSlugMapLoaded eagerly (NOT through requestIdleCallback) when on a job-detail URL', () => {
      // Locate the eager branch and confirm it does not wrap in deferLoad.
      const eagerBranch = routerSrc.match(
        /if \(isJobDetailUrl\(\)\) \{[\s\S]{0,400}\} else \{/,
      );
      expect(eagerBranch).not.toBeNull();
      expect(eagerBranch![0]).toContain('ensureJobSlugMapLoaded()');
      expect(eagerBranch![0]).not.toContain('requestIdleCallback');
      expect(eagerBranch![0]).not.toContain('deferLoad');
    });

    it('keeps the requestIdleCallback path for non-job-detail URLs (LCP-preserving default)', () => {
      // The else branch must still defer to keep the original LCP win on
      // calc/landing/blog pages. This is the regression boundary: don't
      // accidentally eager-load on every page.
      expect(routerSrc).toMatch(
        /\} else \{[\s\S]{0,400}deferLoad\([\s\S]{0,200}ensureJobSlugMapLoaded/,
      );
    });
  });
});
