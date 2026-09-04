import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = process.cwd();
const readJson = <T>(relativePath: string): T =>
  JSON.parse(readFileSync(resolve(ROOT, relativePath), 'utf8')) as T;

type ArchivedJob = {
  slug: string;
  slugByLocale: Record<string, string>;
  previousSlugs?: string[];
  previousSlugsByLocale?: Record<string, string[]>;
  company: string;
  companyKey: string;
  location: string;
  addressLocality: string;
  expiredAt: string;
};

const RETIRED_KEY = 'de';
const RETIRED_SOURCE_FILES = [
  'data/jobs/by-crawler/de.json',
  'data/jobs-crawler-summaries/by-crawler/de.json',
  'data/prospector/crawlers/de.json',
  'scripts/lib/de-job-parser.mjs',
  'scripts/update-de-jobs.mjs',
];

const ROUTES_PRESENT_BEFORE_RETIREMENT = [
  'anlagenmechaniker-m-w-d-schwerpunkt-sanitar-e-gastechnik-mpi-age-lugano',
  'plant-mechanic-m-f-d-focus-on-sanitary-and-gas-technology-mpi-age-lugano',
  'anlagenmechaniker-m-w-d-schwerpunkt-sanitar-und-gastechnik-de-ch',
  'mecanicien-d-usine-h-f-d-focus-sur-la-technologie-sanitaire-et-gaziere-mpi-age-lugano',
  'ingegneria-dell-elettronica-sistemi-energetici-m-f-d-focus-on-indoor-air-technology-rlt-mpi-age-lugano',
  'electronics-engineer-operating-engineering-energy-systems-m-f-d-focus-on-indoor-air-technology-rlt-mpi-age-lugano',
  'elektroniker-betriebstechnik-energieanlagen-m-w-d-schwerpunkt-raumlufttechnik-rlt-de-ch',
  'ingenieur-en-electronique-genie-d-exploitation-systemes-energetiques-h-f-d-focus-sur-la-technologie-de-l-air-interieur',
];

function archivedRoutes(job: ArchivedJob): Set<string> {
  return new Set([
    job.slug,
    ...Object.values(job.slugByLocale || {}),
    ...(job.previousSlugs || []),
    ...Object.values(job.previousSlugsByLocale || {}).flat(),
  ]);
}

describe('retired foreign MPI AGE source (#6822)', () => {
  it('cannot be scheduled or rediscovered as a Swiss crawler', () => {
    const manifest = readJson<{ manifest: Array<{ slug: string }> }>('data/crawler-manifest.json');
    const assignments = readJson<{ groups: string[][] }>('data/crawler-group-assignments.json');
    const roster = readJson<{ primarySlices: Record<string, string> }>('scripts/ci/crawler-generation-roster.json');
    const health = readJson<{ crawlers: Record<string, unknown> }>('data/crawler-health.json');
    const candidates = readJson<{
      candidates: Record<string, { status: string; country: string; reason?: string }>;
    }>('data/prospector/candidates.json');

    expect(manifest.manifest.some(({ slug }) => slug === RETIRED_KEY)).toBe(false);
    expect(assignments.groups.flat()).not.toContain(RETIRED_KEY);
    expect(roster.primarySlices).not.toHaveProperty(RETIRED_KEY);
    expect(health.crawlers).not.toHaveProperty(RETIRED_KEY);
    expect(candidates.candidates['de@umantis.com']).toMatchObject({
      status: 'rejected',
      country: 'DE',
    });
    expect(candidates.candidates['de@umantis.com'].reason).toContain('outside Swiss scope');

    for (const relativePath of RETIRED_SOURCE_FILES) {
      expect(existsSync(resolve(ROOT, relativePath)), relativePath).toBe(false);
    }

    for (const relativePath of [
      '.github/workflows/crawler-group-11.yml',
      '.github/workflows/crawler-group-11-logic.yml',
      '.github/corpus-workflows/crawler-group-11.yml',
    ]) {
      expect(readFileSync(resolve(ROOT, relativePath), 'utf8')).not.toContain('update-de-jobs');
    }
  });

  it('keeps both former jobs as expired soft landings with every published route', () => {
    const archived = readJson<ArchivedJob[]>('data/jobs/expired/by-crawler/de.json');
    expect(archived).toHaveLength(2);

    const preservedRoutes = new Set(archived.flatMap((job) => [...archivedRoutes(job)]));
    for (const route of ROUTES_PRESENT_BEFORE_RETIREMENT) {
      expect(preservedRoutes, route).toContain(route);
    }

    for (const job of archived) {
      expect(job.company).toBe('MPI AGE');
      expect(job.companyKey).toBe(RETIRED_KEY);
      expect(job.location).toBe('Köln, Deutschland');
      expect(job.addressLocality).toBe('Köln');
      expect(Number.isNaN(Date.parse(job.expiredAt))).toBe(false);
    }
  });
});
