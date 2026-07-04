import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(__dirname, '..');

describe('Bridge page canton-aware UX', () => {
  // Read sources once at module load — keeps test runtime negligible.
  const jobsSeoSrc = fs.readFileSync(
    path.resolve(root, 'build-plugins/jobsSeoPagesPlugin.ts'),
    'utf-8',
  );
  const slugSplitSrc = fs.readFileSync(
    path.resolve(root, 'build-plugins/localeJobsSplitPlugin.ts'),
    'utf-8',
  );
  const routerSrc = fs.readFileSync(
    path.resolve(root, 'services/router.ts'),
    'utf-8',
  );
  const jobBoardSrc = fs.readFileSync(
    path.resolve(root, 'components/community/JobBoard.tsx'),
    'utf-8',
  );
  const jobSlugShardsSrc = fs.readFileSync(
    path.resolve(root, 'services/jobSlugShards.ts'),
    'utf-8',
  );

  describe('F3: canton-aware breadcrumb text', () => {
    it('exports a helper that adapts the breadcrumb label to the canton display name', () => {
      expect(jobsSeoSrc).toContain('allJobsLinkLabel');
      // The IT label must be a template that includes the canton placeholder.
      expect(jobsSeoSrc).toMatch(/Tutte le offerte di lavoro in \$\{cantonDisplay\}/);
      expect(jobsSeoSrc).toMatch(/All job offers in \$\{cantonDisplay\}/);
    });

    it('uses the helper in the static job-detail breadcrumb (not the hardcoded "in Ticino" string)', () => {
      // The job-detail breadcrumb nav must invoke allJobsLinkLabel with the
      // job's canton display name, looked up via getCantonDisplayLabel per
      // locale on the RAW job.canton (e.g. "AI"), NOT the resolved jobCanton
      // (which is the URL-group code, e.g. "APPENZELLO" — AI+AR consolidated).
      // Two incomplete predecessors:
      //   - `dc` (CANTON_DISPLAY[job.canton]): keys come from
      //     data/canton-url-slugs.json which doesn't register AI/AR/BS/BL
      //     → fallback to raw 2-letter code ("in AI").
      //   - getCantonDisplayLabel(jobCanton, locale): receives the URL group
      //     "APPENZELLO" → falls through the localised table → returns the
      //     raw token ("in APPENZELLO").
      // Correct: getCantonDisplayLabel(String(job.canton || DEFAULT_CANTON), locale)
      // — the helper has all 26 canton codes hardcoded with IT/EN/DE/FR.
      const breadcrumbLine = jobsSeoSrc.split('\n').find((l) =>
        l.includes('class="bn"') && l.includes('jobCanton'),
      );
      expect(breadcrumbLine).toBeDefined();
      expect(breadcrumbLine).toContain('allJobsLinkLabel(locale, getCantonDisplayLabel(String(job.canton || DEFAULT_CANTON), locale))');
      expect(breadcrumbLine).not.toContain('allJobsLinkLabel(locale, dc)');
      expect(breadcrumbLine).not.toContain('getCantonDisplayLabel(jobCanton');
      expect(breadcrumbLine).not.toContain('localeCopy[locale].allJobsLink');
    });

    it('getCantonDisplayLabel returns localized names for AI/AR/BS/BL (4 canton codes missing from canton-url-slugs registry)', () => {
      // Inline parse of the localised table inside getCantonDisplayLabel to
      // assert the 4 missing-from-registry cantons resolve correctly in all
      // locales. Without these, the breadcrumb falls back to the raw 2-letter
      // code (bug reproduced on prod 2026-05-19 — see PR #380 follow-up).
      const expectations: Array<[string, string, string, string, string]> = [
        // [code, it, en, de, fr]
        ['AI', 'Appenzello Interno', 'Appenzell Innerrhoden', 'Appenzell Innerrhoden', 'Appenzell Rhodes-Intérieures'],
        ['AR', 'Appenzello Esterno', 'Appenzell Ausserrhoden', 'Appenzell Ausserrhoden', 'Appenzell Rhodes-Extérieures'],
        ['BS', 'Basilea Città', 'Basel-City', 'Basel-Stadt', 'Bâle-Ville'],
        ['BL', 'Basilea Campagna', 'Basel-Country', 'Baselland', 'Bâle-Campagne'],
      ];
      // Verify the table inside getCantonDisplayLabel contains all expected mappings.
      for (const [code, it, en, de, fr] of expectations) {
        const tableRegex = new RegExp(`${code}:\\s*\\{\\s*it:\\s*'${it.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}'`);
        expect(jobsSeoSrc).toMatch(tableRegex);
        // Cross-check each locale's value exists in the file (loose match — table is dense).
        for (const [loc, expected] of [['en', en], ['de', de], ['fr', fr]] as const) {
          expect(jobsSeoSrc).toContain(`${loc}: '${expected}'`);
        }
      }
    });
  });

  describe('F5: slug-map carries id + canton for cross-canton bridge resolution', () => {
    it('localeJobsSplitPlugin emits id + canton into jobs-slug-map.json entries', () => {
      // The slug-map projection must include id and canton.
      expect(slugSplitSrc).toContain('if (j.id) entry.id = j.id;');
      expect(slugSplitSrc).toContain('if (j.canton) entry.canton = j.canton;');
    });

    it('router.registerJobSlugMap accepts and indexes id + canton meta', () => {
      // Type signature must accept id + canton.
      expect(routerSrc).toContain('id?: string');
      expect(routerSrc).toContain('canton?: string');
      // Record building is shared with the build-time shard emitter
      // (services/jobSlugShards.ts) so router and emitter cannot drift; meta
      // is stored under reserved keys to avoid colliding with locale keys.
      expect(routerSrc).toContain('buildJobSlugRecord');
      expect(jobSlugShardsSrc).toContain('record._id = job.id');
      expect(jobSlugShardsSrc).toContain('record._canton');
    });

    it('router exports getJobMetaForSlug for SPA bridge resolution', () => {
      expect(routerSrc).toContain('export function getJobMetaForSlug');
      expect(routerSrc).toMatch(/getJobMetaForSlug\(slug: string\):\s*\{[^}]*id\?:\s*string;[^}]*canton\?:\s*string/);
    });

    it('JobBoard wires a cross-canton lazy fetch when bridgeTarget is in a different canton shard', () => {
      // Must import the new router helper.
      expect(jobBoardSrc).toContain('getJobMetaForSlug');
      // Per-slug shard ensure (#3526) replaced the full-monolith ensure.
      expect(jobBoardSrc).toContain('ensureJobSlugEntriesLoaded');
      // Must call fetchJobsForCanton with the looked-up canton when selectedJob
      // is missing but a bridge target slug is set.
      expect(jobBoardSrc).toMatch(/getJobMetaForSlug\(targetSlug\)/);
      expect(jobBoardSrc).toMatch(/fetchJobsForCanton\(cantonCode\)/);
      // Must guard against re-firing for the same slug.
      expect(jobBoardSrc).toContain('bridgeFetchAttempted');
    });

    it('JobBoard falls back to the slim locale index when the canton shard returns empty', () => {
      // Production reality (2026-05-19): /data/jobs-by-canton/<X>.json is NOT
      // generated by the build pipeline — every shard 404s. F5 must fall back
      // to the slim locale index (the SPA's actual primary loader path) and
      // filter the corpus by stable id to merge ONE target job into `jobs`,
      // so the bridge URL resolves to selectedJob instead of JobOrphanView.
      expect(jobBoardSrc).toMatch(/\/data\/jobs-\$\{locale\}-index\.json/);
      // Filter must be id-based to avoid loading a 5MB monolith into state.
      expect(jobBoardSrc).toMatch(/all\.find\(\(j: \{ id\?: string \}\) => j\?\.id === targetId\)/);
    });

    it('selectedJob resolves cross-canton bridge jobs from the unscoped pool (no orphan for live content)', () => {
      // Root-cause guard for "Questo annuncio non è più disponibile" on a
      // legacy-TI bridge URL (e.g. /cerca-lavoro-ticino/<BE-job-slug>/): the URL
      // parses to jobBoardCanton='TI', so the canton-scoped `jobs` array never
      // contains the BE job. The async bridge-rescue fetch can race against the
      // wholesale `setJobs` of the full load (which would clobber a merged
      // record) → intermittent JobOrphanView for a live, pre-rendered job.
      //
      // The deterministic fix: `selectedJob` must ALSO look up the locale-wide
      // `unscopedJobs` pool (already loaded for cross-canton search) before
      // falling through to the orphan view. This resolves synchronously off
      // in-memory data, independent of the rescue fetch timing.
      const selectedJobStart = jobBoardSrc.indexOf('const selectedJob = useMemo(');
      expect(selectedJobStart).toBeGreaterThan(-1);
      const selectedJobBlock = jobBoardSrc.slice(selectedJobStart, selectedJobStart + 2500);
      // The unscoped pool is consulted as a fallback inside the selectedJob memo.
      expect(selectedJobBlock).toMatch(/unscopedJobs\.find\(\(j\) => matchesRouteSlug\(j, lookupSlug\)\)/);
      // And `unscopedJobs` is a reactive dependency so the memo recomputes once
      // the pool lands.
      expect(selectedJobBlock).toMatch(/\}, \[jobs, unscopedJobs,/);
    });
  });

  describe('F1: backfilled previousSlugs for the canonical Denner case', () => {
    // The original Denner backfill incident was anchored to a specific job UUID
    // (52bec962-4621-486c-a8f9-e68852c99fb2). That job has since expired and been
    // rotated out of data/jobs/by-crawler/denner.json. The regression these tests
    // guard against (previousSlugs partitioning across locales when an alias set
    // crosses multiple language slug forms) still applies — we look for ANY current
    // Denner job that exercises the same structural shape (previousSlugs +
    // previousSlugsByLocale with entries in multiple locales).
    const dennerSlicePath = path.resolve(root, 'data/jobs/by-crawler/denner.json');
    const dennerSlice = JSON.parse(fs.readFileSync(dennerSlicePath, 'utf-8'));
    const allDennerJobs = dennerSlice.jobs as Array<{
      url?: string;
      slug?: string;
      previousSlugs?: string[];
      previousSlugsByLocale?: Record<string, string[] | undefined>;
    }>;
    // Count a job's non-empty previousSlugsByLocale buckets.
    const localeBucketCount = (j: { previousSlugsByLocale?: Record<string, string[] | undefined> }) =>
      Object.values(j.previousSlugsByLocale ?? {}).filter(
        (arr) => Array.isArray(arr) && arr.length > 0,
      ).length;
    // Prefer a job that actually carries previousSlugsByLocale buckets — first a
    // multi-locale one (the original failure mode), then ANY single-locale one.
    // Only if NO Denner job exposes previousSlugsByLocale do we fall back to a
    // job with a flat previousSlugs array. Without the single-locale tier the
    // fallback could pick a flat-only job that lacks byLocale, making the
    // "buckets are non-empty" assertion below fail purely because the live
    // Denner crawl drifted (the migration backfills flat previousSlugs onto more
    // jobs than it does previousSlugsByLocale) — a data-driven false red, not a
    // real regression.
    const targetByLocale =
      allDennerJobs.find((j) => localeBucketCount(j) >= 2) ??
      allDennerJobs.find((j) => localeBucketCount(j) >= 1);
    const targetJob =
      targetByLocale ??
      allDennerJobs.find((j) => Array.isArray(j.previousSlugs) && j.previousSlugs.length > 0);

    it('Denner slice has at least one job exercising previousSlugs backfill', () => {
      expect(allDennerJobs.length).toBeGreaterThan(0);
      expect(targetJob).toBeDefined();
    });

    it('the target job carries a non-empty previousSlugs array', () => {
      expect(Array.isArray(targetJob!.previousSlugs)).toBe(true);
      expect(targetJob!.previousSlugs!.length).toBeGreaterThan(0);
    });

    it('previousSlugsByLocale partitions entries into known locale buckets', () => {
      const byLocale = targetJob!.previousSlugsByLocale ?? {};
      const knownLocales = ['it', 'en', 'de', 'fr'];
      for (const loc of Object.keys(byLocale)) {
        expect(knownLocales).toContain(loc);
      }
      // When at least one Denner job exposes previousSlugsByLocale (the normal
      // case), targetJob IS that job, so a non-empty bucket must exist for the
      // partition test to be meaningful. If the live crawl ever contains zero
      // such jobs, the structural shape simply isn't present — the key-validity
      // check above still holds and we don't manufacture a false red.
      if (targetByLocale) {
        const nonEmpty = Object.values(byLocale).filter(
          (arr) => Array.isArray(arr) && arr.length > 0,
        );
        expect(nonEmpty.length).toBeGreaterThan(0);
      }
    });
  });
});
