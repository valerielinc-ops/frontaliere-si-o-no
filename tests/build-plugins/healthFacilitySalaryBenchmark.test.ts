import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  aggregateHealthFacilityJobs,
  _resetHealthFacilityJobsAggregateCache,
} from '../../build-plugins/healthFacilitiesJobsAggregate';
import { getHealthFacility, HEALTH_FACILITIES, HEALTH_FACILITY_LOCALES } from '../../build-plugins/healthFacilitiesData';
import { renderFacilityPage } from '../../build-plugins/healthFacilitiesPlugin';
import { CANTON_TO_GROSSREGION } from '../../build-plugins/shared/cantonSalaryIndex';
import {
  GROSSREGION_IN,
  GROSSREGION_LABEL,
  HEALTH_SECTOR_MONTHLY_WAGES,
  healthSectorWageBenchmark,
} from '../../build-plugins/shared/healthSectorWageBenchmark';

const tempRoots: string[] = [];
const NOW = Date.parse('2026-09-14T00:00:00.000Z');

function fixtureRoot(jobCount: number, salary?: { min: number; max: number }): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'health-facility-salary-'));
  tempRoots.push(root);
  fs.mkdirSync(path.join(root, 'data'), { recursive: true });
  const jobs = Array.from({ length: jobCount }, (_, index) => ({
    id: `usz-salary-${index + 1}`,
    slug: `usz-salary-job-${index + 1}`,
    title: `Pflegefachperson USZ ${index + 1}`,
    company: 'Universitätsspital Zürich (USZ)',
    companyKey: 'usz',
    canton: 'ZH',
    addressLocality: 'Zürich',
    contract: 'full-time',
    postedDate: '2026-09-01T00:00:00.000Z',
    firstSeenAt: '2026-09-01T00:00:00.000Z',
    url: `https://example.test/usz-salary-${index + 1}`,
    ...(salary
      ? { salaryMin: salary.min + index * 1000, salaryMax: salary.max + index * 1000, salarySource: 'reported', currency: 'CHF' }
      : { salaryMin: 92000, salaryMax: 128000, salarySource: 'estimated', currency: 'CHF' }),
  }));
  fs.writeFileSync(path.join(root, 'data', 'jobs.json'), JSON.stringify(jobs));
  return root;
}

function render(root: string, locale: (typeof HEALTH_FACILITY_LOCALES)[number]): string {
  const facility = getHealthFacility('usz');
  const snapshot = aggregateHealthFacilityJobs(root, NOW).get('usz');
  if (!facility || !snapshot) throw new Error('USZ fixture did not aggregate');
  return renderFacilityPage(locale, facility, snapshot, '2026-09-14', root).html;
}

afterEach(() => {
  _resetHealthFacilityJobsAggregateCache();
  for (const root of tempRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('healthSectorWageBenchmark — BFS LSE NOGA 86 reference', () => {
  it('resolves every registry canton to its own Grossregion, never the national fallback', () => {
    for (const facility of HEALTH_FACILITIES) {
      const benchmark = healthSectorWageBenchmark(facility.canton);
      expect(benchmark.region, facility.slug).toBe(CANTON_TO_GROSSREGION[facility.canton]);
    }
  });

  it('annualises the standardised monthly wage ×12 and keeps the quartiles ordered', () => {
    const zh = healthSectorWageBenchmark('ZH');
    expect(zh.annualMedianChf).toBe(HEALTH_SECTOR_MONTHLY_WAGES.zurich.median * 12);
    for (const [region, q] of Object.entries(HEALTH_SECTOR_MONTHLY_WAGES)) {
      expect(q.p25, region).toBeLessThan(q.median);
      expect(q.median, region).toBeLessThan(q.p75);
    }
  });

  it('falls back to the Switzerland total for an unknown canton', () => {
    expect(healthSectorWageBenchmark('XX').region).toBe('switzerland');
    expect(healthSectorWageBenchmark(null).region).toBe('switzerland');
  });

  it('labels every region in every locale', () => {
    for (const locale of HEALTH_FACILITY_LOCALES) {
      for (const region of Object.keys(HEALTH_SECTOR_MONTHLY_WAGES)) {
        expect(GROSSREGION_LABEL[locale][region as keyof typeof HEALTH_SECTOR_MONTHLY_WAGES]).toBeTruthy();
        expect(GROSSREGION_IN[locale][region as keyof typeof HEALTH_SECTOR_MONTHLY_WAGES]).toBeTruthy();
      }
    }
  });
});

describe('health-facility salary tile', () => {
  it('shows the BFS sector median instead of "insufficient sample" when no listing reports a range', () => {
    const root = fixtureRoot(8);
    const annual = HEALTH_SECTOR_MONTHLY_WAGES.zurich.median * 12;
    for (const locale of HEALTH_FACILITY_LOCALES) {
      const html = render(root, locale);
      expect(html).not.toMatch(/Insufficient sample|Unzureichende Stichprobe|Échantillon insuffisant|Campione insufficiente/);
      expect(html, locale).toMatch(/data-salary-provenance="?official-benchmark/);
      expect(html, locale).toContain('px-x-0304010000_201');
      // The tile value is the Zurich NOGA 86 median, whatever the locale's digit grouping.
      const digits = html.replace(/[^\d]/g, ' ');
      expect(digits, locale).toContain(String(annual).replace(/\B(?=(\d{3})+$)/g, ' '));
    }
  });

  it('keeps the reported median and omits the benchmark once the sample clears the floor', () => {
    const root = fixtureRoot(6, { min: 80000, max: 100000 });
    const html = render(root, 'en');
    expect(html).toContain('Median of reported ranges');
    expect(html).not.toMatch(/data-salary-provenance="?official-benchmark/);
    expect(html).not.toContain('Healthcare sector median (BFS');
  });
});
