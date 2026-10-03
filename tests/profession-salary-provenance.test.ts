import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { reportedSalarySummary, realSalaryMedianChf } from '../build-plugins/shared/realSalaryMedian';
import { professionSalaryPresentation } from '../build-plugins/shared/professionSalaryPresentation';
import { aggregateProfessionJobsByCity, _resetProfessionJobsAggregateCache } from '../build-plugins/professionJobsAggregate';
import { renderProfessionCityPage } from '../build-plugins/professionCityLandings';
import { renderProfessionCantonPage } from '../build-plugins/professionCantonLandings';

import { aggregateNursingJobs, _resetNursingJobsAggregateCache } from '../build-plugins/nursingJobsAggregate';
import { aggregateCityJobs, _resetCityJobsAggregateCache } from '../build-plugins/cityJobsAggregate';
import { aggregateCareerLandings, _resetCareerJobsAggregateCache } from '../build-plugins/careerJobsAggregate';
import { aggregateHealthFacilityJobs, _resetHealthFacilityJobsAggregateCache } from '../build-plugins/healthFacilitiesJobsAggregate';
import { HEALTH_FACILITIES } from '../build-plugins/healthFacilitiesData';
import { introProse, type EmployerProfile } from '../build-plugins/employerProfilePagesPlugin';
import { renderJobCardHtml } from '../build-plugins/shared/jobCardHtml';
import { reportedSalaryNote } from '../build-plugins/shared/reportedSalaryNote';

const job = { salaryMin: 80000, salaryMax: 100000, salarySource: 'reported', currency: 'CHF' };
const sample = reportedSalarySummary(Array.from({ length: 5 }, () => ({ ...job })));
let fixture: string | undefined;
afterEach(() => {
  if (fixture) rmSync(fixture, { recursive: true, force: true });
  fixture = undefined;
  _resetProfessionJobsAggregateCache();
  _resetNursingJobsAggregateCache();
  _resetCityJobsAggregateCache();
  _resetCareerJobsAggregateCache();
  _resetHealthFacilityJobsAggregateCache();
});

describe('reported salary provenance', () => {
  it('requires five qualified annual CHF ranges, preserving the legacy median contract', () => {
    expect(reportedSalarySummary(Array.from({ length: 4 }, () => job))).toEqual({ sampleCount: 4, medianChf: null });
    expect(sample).toEqual({ sampleCount: 5, medianChf: 90000 });
    expect(realSalaryMedianChf(Array.from({ length: 3 }, () => ({ salaryMin: 80000, salaryMax: 100000 })))).toBe(90000);
  });

  it('does not turn estimates, unknown currency/provenance, invalid or nonannual ranges into evidence', () => {
    const invalid = [
      { ...job, salarySource: 'estimated' }, { ...job, salarySource: undefined },
      { ...job, salarySource: 'unknown' }, { ...job, salarySource: 'existing' },
      { ...job, currency: 'EUR' },
      { ...job, currency: undefined }, { ...job, salaryMin: NaN },
      { ...job, salaryMax: Infinity }, { ...job, salaryMin: 120000 },
      { ...job, salaryMin: 5000, salaryMax: 7000 }, { ...job, salaryMax: 400000 },
      { ...job, salaryMax: null },
    ];
    expect(reportedSalarySummary(invalid)).toEqual({ sampleCount: 0, medianChf: null });
    expect(reportedSalarySummary([{ ...job, salarySource: 'existing' }, { ...job, currency: 'chf' }]).sampleCount).toBe(1);
    expect(reportedSalarySummary(Array.from({ length: 5 }, () => ({ ...job, salarySource: 'existing' }))))
      .toEqual({ sampleCount: 0, medianChf: null });
  });

  it('qualifies the already matched city/profession population rather than unrelated vacancies', () => {
    fixture = mkdtempSync(join(tmpdir(), 'salary-provenance-'));
    mkdirSync(join(fixture, 'data'));
    const records = Array.from({ length: 5 }, (_, i) => ({
      ...job, id: `nurse-${i}`, title: 'Infermiere diplomato', canton: 'TI',
      addressLocality: 'Lugano', company: 'Clinica', postedDate: new Date(Date.now() - 86400000).toISOString(),
    }));
    writeFileSync(join(fixture, 'data/jobs.json'), JSON.stringify([
      ...records,
      ...records.map((r, i) => ({ ...r, id: `other-city-${i}`, addressLocality: 'Bellinzona', salaryMin: 120000, salaryMax: 140000 })),
      ...records.map((r, i) => ({ ...r, id: `other-role-${i}`, title: 'Software Engineer', salaryMin: 150000, salaryMax: 180000 })),
    ]));
    const city = aggregateProfessionJobsByCity(fixture).lugano.infermiere;
    expect(city.reportedSalary).toEqual({ sampleCount: 5, medianChf: 90000 });
  });
});

const labels = {
  it: ['Mediana fasce dichiarate nel campione', 'Benchmark generale della grande regione'],
  en: ['Median of reported ranges in the sample', 'General major-region benchmark'],
  de: ['Median gemeldeter Lohnspannen der Stichprobe', 'Allgemeiner Vergleichswert der Grossregion'],
  fr: ['Médiane des fourchettes déclarées de l’échantillon', 'Repère général de la grande région'],
};

for (const locale of ['it', 'en', 'de', 'fr'] as const) {
  describe(`profession salary presentation: ${locale}`, () => {
    for (const family of ['city', 'canton'] as const) {
      for (const qualified of [false, true]) {
        it(`${family} identifies ${qualified ? 'sample and count' : 'general benchmark and original source'}`, () => {
          const snapshot = {
            liveCount: 12, fresh30Count: 4, medianSalaryChf: 123456,
            reportedSalary: qualified ? sample : { sampleCount: 4, medianChf: null },
            featured: [], topEmployers: [{ name: 'Clinica', count: 12 }],
          };
          const { html } = family === 'city'
            ? renderProfessionCityPage({ locale, cityKey: 'lugano', id: 'infermiere', snapshot, distDir: '/nonexistent' })
            : renderProfessionCantonPage({ locale, cantonKey: 'ZH', id: 'infermiere', snapshot, distDir: '/nonexistent' });
          expect(html).toContain(labels[locale][qualified ? 0 : 1]);
          const provenance = html.match(/\bdata-salary-provenance=(?:"([^"]+)"|'([^']+)'|([^\s>]+))/);
          expect(provenance?.slice(1).find(Boolean)).toBe(qualified ? 'sample' : 'benchmark');
          expect(html).toContain('CHF');
          expect(html).not.toContain('123456');
          if (qualified) {
            expect(html).toMatch(/(?:5 offres|5 annonces|5 matching|5 passende|5 offerte)/);
          } else {
            expect(html).toContain('2024');
            expect(html).toContain('https://www.pxweb.bfs.admin.ch/pxweb/de/px-x-0304010000_203/');
            expect(html).toContain('× 12');
          }
          const ld = [...html.matchAll(/<script[^>]*type=["']?application\/ld\+json["']?[^>]*>([\s\S]*?)<\/script>/g)]
            .map((match) => JSON.parse(match[1]));
          expect(ld.length).toBeGreaterThan(0);
          expect(JSON.stringify(ld)).not.toContain('baseSalary');
        });
      }
    }
    it('fails closed for a legacy or malformed summary', () => {
      expect(professionSalaryPresentation(locale, 'TI').source).toBe('benchmark');
      expect(professionSalaryPresentation(locale, 'TI', { sampleCount: 5, medianChf: NaN }).source).toBe('benchmark');
      expect(professionSalaryPresentation(locale, 'TI', { sampleCount: 1, medianChf: 90000 }).source).toBe('benchmark');
    });
  });
}


describe('collection salary population and provenance', () => {
  function records(count: number, overrides: Record<string, unknown> = {}) {
    return Array.from({ length: count }, (_, i) => ({ ...job, id: `job-${i}`,
      title: 'Infermiere diplomato', canton: 'TI', addressLocality: 'Lugano',
      company: 'Clinica', postedDate: new Date(Date.now() - 86400000).toISOString(), ...overrides }));
  }
  function seed(jobs: unknown[]) {
    fixture = mkdtempSync(join(tmpdir(), 'salary-collections-'));
    mkdirSync(join(fixture, 'data'));
    writeFileSync(join(fixture, 'data/jobs.json'), JSON.stringify(jobs));
    return fixture;
  }
  it('city, nursing and career statistics exclude estimated, unknown and other populations', () => {
    const root = seed([...records(5), ...records(8, { salarySource: 'existing', salaryMin: 200000, salaryMax: 220000 }),
      ...records(8, { canton: 'ZH', addressLocality: 'Zürich', salaryMin: 200000, salaryMax: 220000 })]);
    expect(aggregateNursingJobs(root).nurses.reportedSalary).toEqual(sample);
    expect(aggregateCityJobs(root, 'lugano').reportedSalary).toEqual(sample);
    expect(aggregateCareerLandings(root)['contratti-lavoro-frontalieri'].reportedSalary).toEqual(sample);
  });
  it('healthcare does not borrow salaries from nonhealthcare roles at the same employer', () => {
    const facility = HEALTH_FACILITIES.find((f) => f.companyKeys.length > 0)!;
    expect(facility).toBeDefined();
    const root = seed([...records(4, { companyKey: facility.companyKeys[0] }),
      ...records(9, { companyKey: facility.companyKeys[0], title: 'Software Engineer', salaryMin: 200000, salaryMax: 220000 })]);
    const snapshot = aggregateHealthFacilityJobs(root).get(facility.slug)!;
    expect(snapshot.reportedSalary).toEqual({ sampleCount: 4, medianChf: null });
    expect(snapshot.medianSalaryChf).toBeNull();
  });
  it('employer prose ignores stale cached medians and unknown ranges', () => {
    const profile: EmployerProfile = { slug: 'clinica', name: 'Clinica', activeJobs: 6, cantons: [], cities: [], salaryMedianChf: 289999 };
    const unknown = records(6, { salaryMin: 210000, salaryMax: 230000 })
      .map((record) => ({ ...record, salarySource: 'existing' as const }));
    const prose = introProse(profile, unknown, 'en');
    expect(prose).not.toContain('289');
    expect(prose).not.toContain('210');
    expect(prose).not.toContain('230');
    expect(prose).not.toContain('Published salaries');
  });
  for (const locale of ['it', 'en', 'de', 'fr'] as const) {
    it(`discloses count, annual CHF and threshold in ${locale}`, () => {
      const note = reportedSalaryNote(locale, sample);
      expect(note).toContain('5');
      expect(note).toContain('CHF');
      expect(note).toContain('data-salary-provenance="reported-sample"');
    });
  }
});


describe('job card provenance survives collection projections', () => {
  for (const locale of ['it', 'en', 'de', 'fr'] as const) {
    it(`distinguishes reported, estimated and unverified in ${locale}`, () => {
      const base = { title: 'Nurse', salaryMin: 80000, salaryMax: 90000, currency: 'EUR' };
      const render = (salarySource?: string) => renderJobCardHtml({ ...base, salarySource }, { locale, href: '/jobs/nurse/' });
      const reported = render('reported');
      const estimated = render('estimated');
      const unknown = render();
      expect(reported).toContain('EUR 80k');
      expect(estimated).not.toBe(reported);
      expect(unknown).not.toBe(reported);
      expect(render('existing')).toBe(unknown);
    });
  }
});
