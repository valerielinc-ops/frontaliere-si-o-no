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
 *   2. router.ts module init: for job-detail URLs, fire the slug-map fetch
 *      eagerly instead of in requestIdleCallback, so the slug-map is in
 *      memory by the time the render guard runs. (Since #3526 the eager
 *      fetch is the URL slug's ~16 KB br shard — ensureJobSlugEntriesLoaded
 *      — and non-job routes load nothing at all.)
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
      // Pattern: if (slug-map knows this slug OR map not yet loaded) AND
      // bridgeFetchAttempted !== bridgeTargetForRender, render skeleton.
      expect(jobBoardSrc).toMatch(
        // #3526: per-slug readiness — the guard asks whether THIS slug's
        // shard (or the full map) has loaded, not whether some map exists.
        /if \(\(bridgeMeta\?\.id \|\| !isJobSlugReady\(bridgeTargetForRender\)\) && bridgeFetchAttempted !== bridgeTargetForRender\) \{[\s\S]{0,200}return <SkeletonJobDetail \/>;[\s\S]{0,40}\}/,
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
    it('defines a job-detail-slug extractor that matches cerca-lavoro / find-jobs / jobs-in / trouver-emploi prefixes', () => {
      // #3526: the boolean predicate became a slug extractor so the boot path
      // can fetch exactly the URL slug's shard.
      expect(routerSrc).toContain('const jobDetailSlugFromLocation');
      // Must cover all four locale job-board prefixes.
      expect(routerSrc).toMatch(/cerca-lavoro\|find-jobs\|jobs-in\|trouver-emploi/);
    });

    it('strips optional locale prefix (en / de / fr) before matching', () => {
      expect(routerSrc).toMatch(/\['en', 'de', 'fr'\]\.includes\(segments\[0\]\)/);
    });

    it('requires at least two segments after locale stripping (board + job-slug-or-city)', () => {
      // A bare /cerca-lavoro-ticino/ is the LISTING, not a detail page.
      expect(routerSrc).toMatch(/segments\.length <= start \+ 1\) return null/);
    });

    it('excludes static SEO families (search clusters, company hubs, categories, pagination) from the eager load', () => {
      // /fr/trouver-emploi-suisse/recherche-*/ and friends are NOT job-detail
      // pages: the eager ~1.1MB-gzip slug-map fetch only competed with the
      // SPA chunks for bandwidth there (measured +3s to JobBoard chunk
      // arrival). They must fall through to the idle-time load.
      expect(routerSrc).toMatch(
        /ricerca\|search\|suche\|recherche\|azienda\|company\|unternehmen\|entreprise\|categoria\|category\|kategorie\|categorie\|pagina\|page\|seite/,
      );
    });

    it('fires the per-slug shard fetch eagerly (NOT through requestIdleCallback) when on a job-detail URL', () => {
      // #3526: the eager boot path fetches only the URL slug's shard
      // (~16 KB br) via ensureJobSlugEntriesLoaded instead of the monolith.
      // Locate the eager branch and confirm it does not wrap in deferLoad.
      const eagerBranch = routerSrc.match(
        /if \(eagerSlug\) \{[\s\S]{0,400}\}/,
      );
      expect(eagerBranch).not.toBeNull();
      expect(eagerBranch![0]).toContain('ensureJobSlugEntriesLoaded([eagerSlug])');
      expect(eagerBranch![0]).not.toContain('requestIdleCallback');
      expect(eagerBranch![0]).not.toContain('deferLoad');
      // The full monolith must never be fetched from the boot path.
      expect(eagerBranch![0]).not.toContain('ensureJobSlugMapLoaded');
    });

    it('loads NOTHING on non-job-detail URLs (no idle-time monolith load)', () => {
      // #3526 hardening of the original LCP boundary: non-job routes used to
      // idle-load the full 1.5 MB br monolith on every page view (homepage
      // included). Now they load nothing — per-slug consumers ensure their
      // own shard on demand. Don't reintroduce a blanket idle load.
      expect(routerSrc).not.toMatch(/deferLoad\([\s\S]{0,200}ensureJobSlugMap/);
      expect(routerSrc).not.toMatch(/requestIdleCallback[\s\S]{0,200}ensureJobSlugMap/);
    });
  });
});
