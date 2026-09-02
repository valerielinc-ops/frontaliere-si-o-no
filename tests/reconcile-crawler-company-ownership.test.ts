import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import {
  assertNoOverlappingJobs,
  ISSUE_6759_COVERAGE,
  ISSUE_6797_SHARED_BOARD_TRANSFERS,
  localeRouteKeys,
  mergeRetiredCrawlerJobs,
  mergeRetiredCrawlerArchive,
  RETIREMENTS,
  SHARED_BOARD_TRANSFERS,
  transferSlugHistory,
  transferOwnedJobs,
  transferOverlappingJobs,
} from '../scripts/reconcile-crawler-company-ownership.mjs';
import { getPreviousSlugsForLocale } from '../scripts/lib/dedicated-crawler-common.mjs';
import { COMPANY_HQ } from '../scripts/lib/crawler-location-config.mjs';
import { resolveBrandCanonical } from '../build-plugins/shared/brandCanonicalMap.mjs';

interface FixtureJob {
  id: string;
  company: string;
  companyKey: string;
  companyDomain: string;
  url: string;
  slug: string;
  slugByLocale: Record<string, string>;
  previousSlugs: string[];
  previousSlugsByLocale: Record<string, string[]>;
}

function job(key: string, id: string, slug: string): FixtureJob {
  return {
    id: `${key}-${id}`,
    company: key,
    companyKey: key,
    companyDomain: `${key}.ch`,
    url: `https://jobs.example/${id}/00000000-0000-4000-8000-${id.padStart(12, '0')}`,
    slug,
    slugByLocale: { it: slug, de: `${slug}-de` },
    previousSlugs: [`${slug}-legacy`],
    previousSlugsByLocale: { de: [`${slug}-alt-de`] },
  };
}

describe('issue #6759 reconciliation', () => {
  it('covers all 18 live duplicate pairs exactly once', () => {
    expect(RETIREMENTS).toHaveLength(10);
    expect(SHARED_BOARD_TRANSFERS).toHaveLength(8);
    expect(ISSUE_6759_COVERAGE).toHaveLength(18);
    const pairs = ISSUE_6759_COVERAGE.map((entry) =>
      entry.retired ? `${entry.retired}->${entry.canonical}` : `${entry.broad}->${entry.dedicated}`,
    );
    expect(new Set(pairs).size).toBe(18);
  });

  it('keeps every retired company hub as an alias of the canonical hub', () => {
    for (const { retired, canonical } of RETIREMENTS) {
      expect(resolveBrandCanonical(retired)).toBe(canonical);
    }
  });

  it('does not leave retired summary slices discoverable by crawler health', () => {
    const trackedSummaries = new Set(
      execFileSync('git', ['ls-files', 'data/jobs-crawler-summaries/by-crawler/*.json'], {
        encoding: 'utf8',
      }).trim().split('\n').filter(Boolean),
    );
    for (const { retired } of RETIREMENTS) {
      expect(trackedSummaries.has(`data/jobs-crawler-summaries/by-crawler/${retired}.json`)).toBe(false);
    }
  });

  it('does not leave retired active slices available to stale data writers', () => {
    for (const { retired } of RETIREMENTS) {
      expect(existsSync(`data/jobs/by-crawler/${retired}.json`)).toBe(false);
    }
  });

  it('does not register retired aliases as runnable writers or HQ identities', () => {
    const roster = JSON.parse(readFileSync('scripts/ci/crawler-generation-roster.json', 'utf8'));
    const groupedCrawlerIds = new Set(Object.values(roster.groups).flat());
    const workflowFiles = execFileSync(
      'git',
      ['ls-files', '.github/workflows/crawler-group-*-logic.yml'],
      { encoding: 'utf8' },
    ).trim().split('\n').filter(Boolean);
    const workflowSource = workflowFiles.map((file) => readFileSync(file, 'utf8')).join('\n');
    for (const { retired } of RETIREMENTS) {
      expect(groupedCrawlerIds.has(retired)).toBe(false);
      expect(Object.hasOwn(roster.primarySlices, retired)).toBe(false);
      expect(existsSync(`scripts/update-${retired}-jobs.mjs`)).toBe(false);
      expect(existsSync(`scripts/lib/${retired}-job-parser.mjs`)).toBe(false);
      expect(Object.hasOwn(COMPANY_HQ, retired)).toBe(false);
      expect(workflowSource).not.toMatch(
        new RegExp(`data/jobs/by-crawler/${retired}\\.json(?:\\s|$)`),
      );
    }
  });

  it('keeps retired expired archives absent and canonical archives route-unique', () => {
    for (const { retired, canonical } of RETIREMENTS) {
      expect(existsSync(`data/jobs/expired/by-crawler/${retired}.json`)).toBe(false);
      const canonicalJobs = JSON.parse(
        readFileSync(`data/jobs/expired/by-crawler/${canonical}.json`, 'utf8'),
      );
      const routeOwners = new Map<string, number>();
      canonicalJobs.forEach((entry: FixtureJob, index: number) => {
        expect(entry.companyKey).toBe(canonical);
        for (const route of localeRouteKeys(entry)) {
          expect(routeOwners.has(route)).toBe(false);
          routeOwners.set(route, index);
        }
      });
    }
  });

  it('observes a zero-change dry run after repairing the SOH stale-writer resurrection', () => {
    const dryRun = JSON.parse(execFileSync(
      process.execPath,
      ['scripts/reconcile-crawler-company-ownership.mjs'],
      { encoding: 'utf8' },
    ));
    const soh = dryRun.report.find(
      (entry: { retired?: string }) => entry.retired === 'solothurner-spitaeler',
    );

    expect(dryRun.mode).toBe('dry-run');
    expect(soh).toMatchObject({
      canonical: 'soh-solothurner-spitaeler',
      active: { skipped: 'retired active slice already absent' },
      archive: {
        skipped: 'retired expired slice already absent; canonical archive already deduplicated',
      },
    });
  });

  it('merges expired aliases by locale route without losing soft landings', () => {
    const canonical = job('canonical', '1', 'canonical-current');
    canonical.previousSlugs = [];
    canonical.previousSlugsByLocale = { de: ['shared-route'] };
    const retiredDuplicate = job('retired', '9', 'retired-current');
    retiredDuplicate.previousSlugs = [];
    retiredDuplicate.previousSlugsByLocale = { de: ['shared-route'], fr: ['retired-fr-history'] };
    const retiredUnique = job('retired', '10', 'retired-unique');
    const beforeRoutes = new Set([
      ...localeRouteKeys(canonical),
      ...localeRouteKeys(retiredDuplicate),
      ...localeRouteKeys(retiredUnique),
    ]);

    const result = mergeRetiredCrawlerArchive(
      [canonical],
      [retiredDuplicate, retiredUnique],
      'canonical',
    );
    const afterRoutes = new Set(result.jobs.flatMap((entry) => [...localeRouteKeys(entry)]));

    expect(result).toMatchObject({ collapsed: 1, rehomed: 1 });
    expect([...beforeRoutes].filter((route) => !afterRoutes.has(route))).toEqual([]);
    expect(result.jobs.every((entry) => entry.companyKey === 'canonical')).toBe(true);
  });

  it('collapses matching aliases while preserving active and historical routes', () => {
    const canonical = job('canonical', '1', 'canonical-slug');
    const retired = job('retired', '1', 'retired-slug');
    const result = mergeRetiredCrawlerJobs([canonical], [retired], 'canonical');

    expect(result.jobs).toHaveLength(1);
    expect(result.collapsed).toBe(1);
    expect(result.jobs[0].previousSlugs).toEqual(expect.arrayContaining([
      'retired-slug',
      'retired-slug-de',
      'retired-slug-legacy',
      'retired-slug-alt-de',
    ]));
  });

  it('preserves flat legacy routes under every locale prefix', () => {
    const canonical = job('canonical', '1', 'canonical-slug');
    const retired = job('retired', '1', 'retired-slug');
    retired.previousSlugs = ['unattributed-legacy-slug'];
    retired.previousSlugsByLocale = {};
    const result = mergeRetiredCrawlerJobs([canonical], [retired], 'canonical');

    for (const locale of ['it', 'en', 'de', 'fr']) {
      expect(getPreviousSlugsForLocale(result.jobs[0], locale)).toContain('unattributed-legacy-slug');
    }
  });

  it('keeps locale-route parity when a merged history exceeds a locale cap', () => {
    const canonical = job('canonical', '1', 'canonical-slug');
    canonical.previousSlugs = [];
    canonical.previousSlugsByLocale = {
      it: Array.from({ length: 20 }, (_, index) => `canonical-it-${index}`),
    };
    const removed = job('retired', '1', 'retired-slug');
    removed.slugByLocale = Object.fromEntries(
      ['it', 'en', 'de', 'fr'].map((locale) => [locale, `retired-active-${locale}`]),
    );
    removed.previousSlugs = ['retired-flat-legacy'];
    removed.previousSlugsByLocale = Object.fromEntries(
      ['it', 'en', 'de', 'fr'].map((locale) => [locale, [`retired-history-${locale}`]]),
    );
    const locales = ['it', 'en', 'de', 'fr'];
    const expected = Object.fromEntries(locales.map((locale) => [locale, new Set([
      canonical.slugByLocale[locale],
      ...getPreviousSlugsForLocale(canonical, locale),
      removed.slugByLocale[locale],
      ...getPreviousSlugsForLocale(removed, locale),
    ])]));

    transferSlugHistory(canonical, removed);

    for (const locale of locales) {
      const actual = new Set([
        canonical.slugByLocale[locale],
        ...getPreviousSlugsForLocale(canonical, locale),
      ]);
      expect([...expected[locale]].filter((route) => !actual.has(route))).toEqual([]);
      expect(canonical.previousSlugsByLocale[locale].length).toBeLessThanOrEqual(20);
    }
    expect(canonical.previousSlugs.length).toBeLessThanOrEqual(80);
  });

  it('rehomes alias-only jobs without changing their active slug', () => {
    const result = mergeRetiredCrawlerJobs(
      [job('canonical', '1', 'canonical-slug')],
      [job('retired', '2', 'indexed-retired-slug')],
      'canonical',
    );
    expect(result.rehomed).toBe(1);
    expect(result.jobs[1]).toMatchObject({
      companyKey: 'canonical',
      company: 'canonical',
      slug: 'indexed-retired-slug',
    });
  });

  it('moves shared-board duplicates to the dedicated owner and transfers slugs', () => {
    const broad = job('broad', '1', 'broad-slug');
    const dedicated = job('dedicated', '1', 'dedicated-slug');
    const result = transferOverlappingJobs([broad], [dedicated]);

    expect(result.sourceJobs).toEqual([]);
    expect(result.targetJobs).toHaveLength(1);
    expect(result.targetJobs[0].previousSlugs).toContain('broad-slug');
  });

  it('fails loud instead of merging jobs identified only by slug', () => {
    const weakIdentity = {
      ...job('retired', '1', 'shared-slug'),
      id: '',
      url: '',
    };

    expect(() => mergeRetiredCrawlerJobs([], [weakIdentity], 'canonical'))
      .toThrow('ownership identity reached unsafe slug fallback: shared-slug');
  });

  it('asserts that shared-board transfer leaves no supplier identity in both slices', () => {
    const broad = job('broad', '1', 'broad-slug');
    const dedicated = job('dedicated', '1', 'dedicated-slug');
    const result = transferOverlappingJobs([broad], [dedicated]);

    expect(() => assertNoOverlappingJobs(
      result.sourceJobs,
      result.targetJobs,
      'broad->dedicated',
    )).not.toThrow();
    expect(() => assertNoOverlappingJobs([broad], [dedicated], 'broad->dedicated'))
      .toThrow('broad->dedicated: 1 shared ownership identities remain');
  });

  it('rehomes predicate-owned unique shared-board jobs without changing their route', () => {
    const broad = job('broad', '2', 'indexed-broad-slug');
    const result = transferOwnedJobs(
      [broad],
      [job('dedicated', '1', 'dedicated-slug')],
      'dedicated',
      () => true,
    );

    expect(result.sourceJobs).toEqual([]);
    expect(result.rehomed).toBe(1);
    expect(result.targetJobs[1]).toMatchObject({
      companyKey: 'dedicated',
      company: 'dedicated',
      slug: 'indexed-broad-slug',
    });
  });
});

describe('issue #6797 reconciliation', () => {
  it('registers the SMN umbrella to Obach ownership transfer separately', () => {
    expect(ISSUE_6797_SHARED_BOARD_TRANSFERS).toEqual([expect.objectContaining({
      broad: 'swiss-medical-network',
      dedicated: 'privatklinik-obach',
    })]);
  });

  it('preserves every locale route while collapsing the shared posting', () => {
    const broad = job('swiss-medical-network', '146478439', 'smn-route');
    broad.slugByLocale = { en: 'smn-route-en', it: 'smn-route-it' };
    broad.previousSlugs = [];
    broad.previousSlugsByLocale = {};
    const dedicated = job('privatklinik-obach', '146478439', 'obach-route');
    dedicated.slugByLocale = {
      de: 'obach-route-de',
      en: 'obach-route-en',
      fr: 'obach-route-fr',
      it: 'obach-route-it',
    };

    const before = [broad, dedicated];
    const result = transferOverlappingJobs([broad], [dedicated]);

    expect(result.sourceJobs).toEqual([]);
    expect(result.targetJobs).toHaveLength(1);
    for (const locale of ['it', 'en', 'de', 'fr']) {
      const routes = (jobs: FixtureJob[]) => new Set(jobs.flatMap((entry) => [
        entry.slugByLocale[locale],
        ...(locale === 'it' ? [entry.slug] : []),
        ...getPreviousSlugsForLocale(entry, locale),
      ].filter(Boolean)));
      const beforeRoutes = routes(before);
      const afterRoutes = routes(result.targetJobs as FixtureJob[]);
      expect([...beforeRoutes].filter((route) => !afterRoutes.has(route))).toEqual([]);
    }
    expect(result.targetJobs[0].slugByLocale).toEqual(dedicated.slugByLocale);
  });

  it('keeps the checked-in witness under Obach only, with both former SMN locale routes bridged', () => {
    const readJobs = (key: string) => JSON.parse(
      readFileSync(`data/jobs/by-crawler/${key}.json`, 'utf8'),
    ).jobs as FixtureJob[];
    const witness = (entry: FixtureJob) => entry.url.includes('744000146478439');
    const obach = readJobs('privatklinik-obach').filter(witness);
    const umbrella = readJobs('swiss-medical-network').filter(witness);

    expect(obach).toHaveLength(1);
    expect(umbrella).toHaveLength(0);
    expect(getPreviousSlugsForLocale(obach[0], 'en')).toContain(
      'ausbildung-dipl-pflegefachperson-hf-swiss-medical-network',
    );
    expect(getPreviousSlugsForLocale(obach[0], 'it')).toContain(
      'ausbildung-dipl-pflegefachperson-hf-swiss-medical-network',
    );
  });
});
