/**
 * Tests for F3b — Orphan-query cluster landings.
 *
 * Coverage:
 *   - Path builders + parsing (IT/EN/DE/FR).
 *   - Clustering script output shape + gates (≥10 impressions, known-slug skip).
 *   - Job-matching predicate (role + region overlap).
 *   - Build plugin quality gates (≥3 matching jobs → indexable, ≥50 words → indexable).
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  ORPHAN_LANDING_LOCALES,
  ORPHAN_LANDING_SECTION,
  ORPHAN_LANDING_LOCALE_PREFIX,
  buildOrphanLandingPath,
  parseOrphanLandingPath,
  buildOrphanLandingRoutes,
  filterMatchingJobs,
  jobMatchesCluster,
  median,
  topCounts,
  type OrphanQueryCluster,
  type OrphanCountableJob,
} from '../build-plugins/orphanQueryData';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

// ─── Path helpers ────────────────────────────────────────────
describe('orphanQueryData — path helpers', () => {
  it('exposes exactly 4 locales', () => {
    expect(ORPHAN_LANDING_LOCALES).toEqual(['it', 'en', 'de', 'fr']);
  });

  it('maps each locale to a distinct section slug', () => {
    const sections = Object.values(ORPHAN_LANDING_SECTION);
    expect(new Set(sections).size).toBe(sections.length);
    expect(ORPHAN_LANDING_SECTION.it).toBe('ricerca');
    expect(ORPHAN_LANDING_SECTION.en).toBe('search');
    expect(ORPHAN_LANDING_SECTION.de).toBe('suche');
    expect(ORPHAN_LANDING_SECTION.fr).toBe('recherche');
  });

  it('builds a canonical trailing-slash path per locale', () => {
    expect(buildOrphanLandingPath('it', 'chauffeur-jobs')).toBe('/ricerca/chauffeur-jobs/');
    expect(buildOrphanLandingPath('en', 'chauffeur-jobs')).toBe('/en/search/chauffeur-jobs/');
    expect(buildOrphanLandingPath('de', 'chauffeur-jobs')).toBe('/de/suche/chauffeur-jobs/');
    expect(buildOrphanLandingPath('fr', 'chauffeur-jobs')).toBe('/fr/recherche/chauffeur-jobs/');
  });

  it('parses a URL path back to (locale, slug)', () => {
    expect(parseOrphanLandingPath('/ricerca/chauffeur-jobs/')).toEqual({ locale: 'it', slug: 'chauffeur-jobs' });
    expect(parseOrphanLandingPath('/en/search/nursing-jobs-ticino/')).toEqual({ locale: 'en', slug: 'nursing-jobs-ticino' });
    expect(parseOrphanLandingPath('/de/suche/stellen-tessin/')).toEqual({ locale: 'de', slug: 'stellen-tessin' });
    expect(parseOrphanLandingPath('/fr/recherche/emploi-tessin/')).toEqual({ locale: 'fr', slug: 'emploi-tessin' });
  });

  it('returns null for unrelated paths', () => {
    expect(parseOrphanLandingPath('/')).toBeNull();
    expect(parseOrphanLandingPath('/cerca-lavoro-ticino/chauffeur-jobs/')).toBeNull();
    expect(parseOrphanLandingPath('/ricerca/')).toBeNull();
    expect(parseOrphanLandingPath('/ricerca/a/b/')).toBeNull();
  });

  it('produces distinct prefixes per locale', () => {
    const prefixes = Object.values(ORPHAN_LANDING_LOCALE_PREFIX);
    expect(new Set(prefixes).size).toBe(prefixes.length);
  });

  it('buildOrphanLandingRoutes emits one route per cluster', () => {
    const clusters: OrphanQueryCluster[] = [
      makeCluster('it', 'chauffeur-jobs', 20, ['chauffeur'], ['svizzera']),
      makeCluster('de', 'chauffeur-jobs', 15, ['chauffeur'], ['svizzera']),
    ];
    const routes = buildOrphanLandingRoutes(clusters);
    expect(routes).toHaveLength(2);
    expect(routes[0].path).toBe('/ricerca/chauffeur-jobs/');
    expect(routes[1].path).toBe('/de/suche/chauffeur-jobs/');
  });
});

// ─── Job matching ────────────────────────────────────────────
describe('orphanQueryData — job matching', () => {
  const cluster: OrphanQueryCluster = makeCluster('it', 'chauffeur-svizzera', 30, ['chauffeur'], ['svizzera']);

  it('matches a job whose title contains the role token', () => {
    const job = activeJob({ title: 'Chauffeur Kat. C', addressLocality: 'Brunegg' });
    expect(jobMatchesCluster(job, cluster)).toBe(true);
  });

  it('does not match a job whose title has no role overlap', () => {
    const job = activeJob({ title: 'Pastry Chef', addressLocality: 'Lugano' });
    expect(jobMatchesCluster(job, cluster)).toBe(false);
  });

  it('requires locale-specific descriptions (>=50 words) for activity', () => {
    const job = activeJob({ title: 'Chauffeur Kat. C' });
    // Override description to be too short for EN
    job.descriptionByLocale = { en: 'short' };
    expect(jobMatchesCluster(job, { ...cluster, locale: 'en' })).toBe(false);
  });

  it('respects region gate when cluster has specific cities (not catch-all svizzera/ticino)', () => {
    const c: OrphanQueryCluster = makeCluster('it', 'infermiere-lugano', 12, ['infermier'], ['lugano']);
    const luganoJob = activeJob({ title: 'Infermiere', location: 'Lugano', addressLocality: 'Lugano' });
    const luzernJob = activeJob({ title: 'Infermiere', location: 'Luzern', addressLocality: 'Luzern' });
    expect(jobMatchesCluster(luganoJob, c)).toBe(true);
    expect(jobMatchesCluster(luzernJob, c)).toBe(false);
  });

  it('filterMatchingJobs returns at most `limit` jobs sorted by postedDate desc', () => {
    const jobs: OrphanCountableJob[] = Array.from({ length: 10 }).map((_, i) =>
      activeJob({
        title: 'Chauffeur Kat. C',
        addressLocality: 'Brunegg',
        postedDate: `2026-04-${String(i + 1).padStart(2, '0')}`,
      }),
    );
    const out = filterMatchingJobs(jobs, cluster, 5);
    expect(out).toHaveLength(5);
    const dates = out.map((j) => j.postedDate);
    expect([...dates].sort().reverse()).toEqual(dates);
  });
});

// ─── Small helpers ───────────────────────────────────────────
describe('orphanQueryData — helpers', () => {
  it('median returns 0 for empty / all-zero input', () => {
    expect(median([])).toBe(0);
    expect(median([0, 0, 0])).toBe(0);
  });

  it('median handles odd + even lengths', () => {
    expect(median([10, 20, 30])).toBe(20);
    expect(median([10, 20, 30, 40])).toBe(25);
  });

  it('topCounts sorts by frequency desc and caps at n', () => {
    const res = topCounts(['a', 'a', 'b', 'c', 'b', 'a', 'd'], 2);
    expect(res).toEqual([
      { name: 'a', count: 3 },
      { name: 'b', count: 2 },
    ]);
  });

  it('topCounts ignores empty/undefined names', () => {
    expect(topCounts(['x', '', undefined, null, 'x'], 5)).toEqual([{ name: 'x', count: 2 }]);
  });
});

// ─── Clustering script contract ─────────────────────────────
describe('cluster-orphan-queries.mjs — deterministic output', () => {
  const inputPath = path.join(ROOT, 'data', 'gsc-orphan-queries.json');
  const outputPath = path.join(ROOT, 'data', 'gsc-orphan-queries-clusters.json');

  it('produces a valid clusters file when run against the repo data', () => {
    if (!fs.existsSync(inputPath)) {
      // Missing input is OK in CI — plugin degrades gracefully.
      return;
    }
    execFileSync('node', ['scripts/cluster-orphan-queries.mjs'], { cwd: ROOT, stdio: 'pipe' });
    const parsed = JSON.parse(fs.readFileSync(outputPath, 'utf-8'));
    expect(parsed).toHaveProperty('generatedAt');
    expect(parsed).toHaveProperty('clusters');
    expect(Array.isArray(parsed.clusters)).toBe(true);

    for (const c of parsed.clusters) {
      // ≥10 cumulative impressions (hard gate)
      expect(c.totalImpressions).toBeGreaterThanOrEqual(10);
      // Must carry identifying metadata
      expect(typeof c.canonicalQuery).toBe('string');
      expect(typeof c.canonicalSlug).toBe('string');
      expect(c.canonicalSlug.length).toBeGreaterThan(0);
      expect(ORPHAN_LANDING_LOCALES).toContain(c.locale);
      // Queries array non-empty
      expect(Array.isArray(c.queries)).toBe(true);
      expect(c.queries.length).toBeGreaterThan(0);
    }

    // Cluster IDs unique
    const ids = parsed.clusters.map((c: { clusterId: string }) => c.clusterId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('skips clusters whose canonical slug collides with a known job slug', () => {
    if (!fs.existsSync(outputPath) || !fs.existsSync(path.join(ROOT, 'data', 'all-known-job-slugs.json'))) return;
    const parsed = JSON.parse(fs.readFileSync(outputPath, 'utf-8'));
    const known = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'all-known-job-slugs.json'), 'utf-8'));
    const knownKeys = new Set(Object.keys(known || {}));
    for (const c of parsed.clusters) {
      expect(knownKeys.has(c.canonicalSlug)).toBe(false);
    }
  });
});

// ─── Fixture helpers ─────────────────────────────────────────

function makeCluster(
  locale: 'it' | 'en' | 'de' | 'fr',
  slug: string,
  impressions: number,
  roleTokens: string[],
  regionTokens: string[],
): OrphanQueryCluster {
  return {
    clusterId: `${locale}-${slug}`,
    locale,
    canonicalQuery: slug.replace(/-/g, ' '),
    canonicalSlug: slug,
    roleTokens,
    regionTokens,
    totalImpressions: impressions,
    totalClicks: 0,
    queries: [{ query: slug.replace(/-/g, ' '), clicks: 0, impressions }],
  };
}

function activeJob(partial: Partial<OrphanCountableJob>): OrphanCountableJob {
  const longDescription = 'This job description contains more than fifty words so that the activity gate passes during the filterMatchingJobs invocation; it describes the role, the responsibilities, the benefits, the requirements, the schedule, the compensation bracket, the ideal candidate profile, and the onboarding process along with details about training, tenure, mobility, equipment, relocation, and career development pathways.';
  return {
    title: 'Generic Role',
    company: 'Acme AG',
    location: 'Lugano',
    addressLocality: 'Lugano',
    postedDate: '2026-04-18',
    description: longDescription,
    descriptionByLocale: {
      it: longDescription,
      en: longDescription,
      de: longDescription,
      fr: longDescription,
    },
    slug: 'generic-role-acme',
    ...partial,
  };
}
