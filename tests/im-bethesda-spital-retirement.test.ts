import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { migrateRetiredImBethesdaJobs } from '../scripts/migrate-retired-im-bethesda-spital.mjs';

const ROOT = process.cwd();
const readJson = <T>(relativePath: string): T =>
  JSON.parse(readFileSync(resolve(ROOT, relativePath), 'utf8')) as T;

// `im-bethesda-spital` was a prospector spec over the public Bethesda jobs page
// whose JSON-LD `identifier.value` is the Umantis vacancy id of tenant 2998 —
// the tenant the dedicated `bethesda-spital` crawler already reads. It
// published the same vacancies a second time under a mis-extracted employer
// name ("& im Bethesda Spital"), with listing-page fragment URLs and teaser
// descriptions (the only CRITICAL of the parser-quality audit, issue 5253).
const RETIRED_KEY = 'im-bethesda-spital';
// Only repo-authored files: the prospector store and the job slices are live
// data the pipeline rewrites on its own (`scripts/ci/live-data-test-guard.mjs`),
// so the candidate's `rejected` verdict is recorded in `ledger.jsonl`, not
// asserted here.
const RETIRED_SOURCE_FILES = [
  'scripts/lib/im-bethesda-spital-job-parser.mjs',
  'scripts/update-im-bethesda-spital-jobs.mjs',
];

describe('retired duplicate crawler im-bethesda-spital', () => {
  it('cannot be scheduled any more', () => {
    const manifest = readJson<{ manifest: Array<{ slug: string }> }>('data/crawler-manifest.json');
    const assignments = readJson<{ groups: string[][] }>('data/crawler-group-assignments.json');
    const roster = readJson<{ groups: Record<string, string[]>; primarySlices: Record<string, string> }>(
      'scripts/ci/crawler-generation-roster.json',
    );

    expect(manifest.manifest.some(({ slug }) => slug === RETIRED_KEY)).toBe(false);
    expect(manifest.manifest.some(({ slug }) => slug === 'bethesda-spital')).toBe(true);
    expect(assignments.groups.flat()).not.toContain(RETIRED_KEY);
    expect(Object.values(roster.groups).flat()).not.toContain(RETIRED_KEY);
    expect(roster.primarySlices).not.toHaveProperty(RETIRED_KEY);

    for (const relativePath of RETIRED_SOURCE_FILES) {
      expect(existsSync(resolve(ROOT, relativePath)), relativePath).toBe(false);
    }
    for (const relativePath of [
      '.github/workflows/crawler-group-07.yml',
      '.github/workflows/crawler-group-07-logic.yml',
      '.github/corpus-workflows/crawler-group-07.yml',
    ]) {
      expect(readFileSync(resolve(ROOT, relativePath), 'utf8')).not.toContain('update-im-bethesda-spital-jobs');
    }
  });

  it('moves every retired route onto the canonical crawler without losing one', () => {
    const PAGE = 'https://www.bethesda-spital.ch/de/ueber-uns/karriere/jobs.html';
    const canonical = [{
      id: 'bethesda-spital-f45b429950e8',
      url: 'https://recruitingapp-2998.umantis.com/Vacancies/415/Description/1',
      title: 'Oberärztin / Oberarzt Klinik für Frauenmedizin (60 - 100%)',
      company: 'Bethesda Spital',
      companyKey: 'bethesda-spital',
      companyDomain: 'bethesda-spital.ch',
      source: 'Bethesda Spital Dedicated Parser (Umantis listing tenant 2998)',
      slug: 'oberarztin-oberarzt-klinik-fur-frauenmedizin-60-100-bethesda-spital-basel',
      slugByLocale: { de: 'oberarztin-oberarzt-klinik-fur-frauenmedizin-60-100-bethesda-spital-basel' },
    }];
    const retired = [
      {
        id: 'im-bethesda-spital-aaa',
        url: `${PAGE}#job-b68fafd8c3cf`,
        title: canonical[0].title,
        company: '& im Bethesda Spital',
        companyKey: 'im-bethesda-spital',
        slug: 'oberarztin-oberarzt-klinik-per-frauenmedizin-60-100-im-bethesda-spital-basel',
        slugByLocale: { it: 'oberarztin-oberarzt-klinik-per-frauenmedizin-60-100-im-bethesda-spital-basel' },
      },
      {
        // On listing page 2 only: absent from the canonical slice until the
        // paginated crawl, so it is rehomed with the factory's id/url.
        id: 'im-bethesda-spital-bbb',
        url: `${PAGE}#job-f8eccc37df02`,
        title: 'Assistenzärztin/Assistenzarzt Klinik Rheumatologie und Schmerzmedizin 100%',
        company: '& im Bethesda Spital',
        companyKey: 'im-bethesda-spital',
        slug: 'assistenzarztin-assistenzarzt-klinik-rheumatologie-e-schmerzmedizin-100-im-bethesda-spital-basel',
        slugByLocale: { it: 'assistenzarztin-assistenzarzt-klinik-rheumatologie-e-schmerzmedizin-100-im-bethesda-spital-basel' },
      },
    ];

    const result = migrateRetiredImBethesdaJobs(canonical, retired);

    expect(result.collapsed).toBe(1);
    expect(result.rehomed).toBe(1);
    expect(result.routesAfter).toBe(result.routesBefore);
    expect(result.jobs).toHaveLength(2);
    expect(result.jobs[0].previousSlugsByLocale?.it).toContain(retired[0].slugByLocale.it);
    expect(result.jobs[1]).toMatchObject({
      companyKey: 'bethesda-spital',
      company: 'Bethesda Spital',
      url: 'https://recruitingapp-2998.umantis.com/Vacancies/328/Description/1',
      applyUrl: 'https://recruitingapp-2998.umantis.com/Vacancies/328/Application/CheckLogin/1',
      slug: retired[1].slug,
    });
    expect(() => migrateRetiredImBethesdaJobs(canonical, [{ ...retired[0], url: `${PAGE}#job-unknown` }]))
      .toThrow(/unknown retired record/);
  });
});
