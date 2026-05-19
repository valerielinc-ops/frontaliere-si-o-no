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

  describe('F3: canton-aware breadcrumb text', () => {
    it('exports a helper that adapts the breadcrumb label to the canton display name', () => {
      expect(jobsSeoSrc).toContain('allJobsLinkLabel');
      // The IT label must be a template that includes the canton placeholder.
      expect(jobsSeoSrc).toMatch(/Tutte le offerte di lavoro in \$\{cantonDisplay\}/);
      expect(jobsSeoSrc).toMatch(/All job offers in \$\{cantonDisplay\}/);
    });

    it('uses the helper in the static job-detail breadcrumb (not the hardcoded "in Ticino" string)', () => {
      // The job-detail breadcrumb nav must invoke allJobsLinkLabel with the
      // job's canton display, not the hardcoded localeCopy.allJobsLink.
      const breadcrumbLine = jobsSeoSrc.split('\n').find((l) =>
        l.includes('class="bn"') && l.includes('jobCanton'),
      );
      expect(breadcrumbLine).toBeDefined();
      expect(breadcrumbLine).toContain('allJobsLinkLabel(locale, dc)');
      expect(breadcrumbLine).not.toContain('localeCopy[locale].allJobsLink');
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
      // Meta is stored under reserved keys to avoid colliding with locale keys.
      expect(routerSrc).toContain('record._id = job.id');
      expect(routerSrc).toContain('record._canton');
    });

    it('router exports getJobMetaForSlug for SPA bridge resolution', () => {
      expect(routerSrc).toContain('export function getJobMetaForSlug');
      expect(routerSrc).toMatch(/getJobMetaForSlug\(slug: string\):\s*\{[^}]*id\?:\s*string;[^}]*canton\?:\s*string/);
    });

    it('JobBoard wires a cross-canton lazy fetch when bridgeTarget is in a different canton shard', () => {
      // Must import the new router helper.
      expect(jobBoardSrc).toContain('getJobMetaForSlug');
      expect(jobBoardSrc).toContain('ensureJobSlugMapLoaded');
      // Must call fetchJobsForCanton with the looked-up canton when selectedJob
      // is missing but a bridge target slug is set.
      expect(jobBoardSrc).toMatch(/getJobMetaForSlug\(targetSlug\)/);
      expect(jobBoardSrc).toMatch(/fetchJobsForCanton\(cantonCode\)/);
      // Must guard against re-firing for the same slug.
      expect(jobBoardSrc).toContain('bridgeFetchAttempted');
    });
  });

  describe('F1: backfilled previousSlugs for the canonical Denner case', () => {
    const dennerSlicePath = path.resolve(root, 'data/jobs/by-crawler/denner.json');
    const dennerSlice = JSON.parse(fs.readFileSync(dennerSlicePath, 'utf-8'));
    const targetJob = (dennerSlice.jobs as Array<{
      url?: string;
      slug?: string;
      previousSlugs?: string[];
      previousSlugsByLocale?: Record<string, string[] | undefined>;
    }>).find((j) => j.url?.includes('ebbde505-d2e5-4b59-82af-3663f4eaaf1f'));

    it('finds the Denner Assistent*in Filialleitung job by stable UUID', () => {
      expect(targetJob).toBeDefined();
      expect(targetJob!.slug).toBe('assistente-nella-gestione-delle-branche-denner-appenzell');
    });

    it('includes the 5 Ebikon legacy slugs in previousSlugs', () => {
      const expectedAliases = [
        'assistente-nella-gestione-delle-branche-denner-ebikon',
        'assistente-alla-direzione-di-filiale-denner-ebikon',
        'assistant-store-manager-denner-ebikon',
        'assistent-in-filialleitung-denner-ebikon',
        'assistant-e-de-direction-de-succursale-denner-ebikon',
      ];
      for (const alias of expectedAliases) {
        expect(targetJob!.previousSlugs).toContain(alias);
      }
    });

    it('partitions the Ebikon aliases into the correct locale buckets', () => {
      const byLocale = targetJob!.previousSlugsByLocale ?? {};
      expect(byLocale.it).toContain('assistente-nella-gestione-delle-branche-denner-ebikon');
      expect(byLocale.it).toContain('assistente-alla-direzione-di-filiale-denner-ebikon');
      expect(byLocale.en).toContain('assistant-store-manager-denner-ebikon');
      expect(byLocale.de).toContain('assistent-in-filialleitung-denner-ebikon');
      expect(byLocale.fr).toContain('assistant-e-de-direction-de-succursale-denner-ebikon');
    });
  });
});
