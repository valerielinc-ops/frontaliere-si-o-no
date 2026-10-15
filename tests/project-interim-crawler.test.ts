import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  PROJECT_INTERIM_KEY,
  fetchAllProjectInterimJobs,
  isMasonRole,
  isProjectInterimJob,
  isTrustedDomain,
  parseProjectInterimWork,
} from '../scripts/lib/project-interim-job-parser.mjs';
import { evaluatePromotion } from '../scripts/lib/prospector/promotion-gate.mjs';
import {
  MIN_JOBS,
  meetsJobsFloor,
  renderProfessionBelowFloorBridge,
} from '../build-plugins/shared/professionJobsFloor';

type WorkRecord = Record<string, any>;

const fixture = JSON.parse(readFileSync(
  new URL('./fixtures/project-interim-works.json', import.meta.url),
  'utf8',
)) as WorkRecord[];

function daysAgo(days: number): string {
  const date = new Date(Date.now() - days * 86_400_000);
  return date.toISOString().replace(/\.\d{3}Z$/, '');
}

function dated(records = fixture): WorkRecord[] {
  return records.map((record, index) => ({
    ...structuredClone(record),
    date_gmt: daysAgo(index + 3),
    date: `${daysAgo(index + 3)}+02:00`,
  }));
}

function jsonResponse(body: unknown, totalPages = 1) {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    headers: {
      get: (name: string) => name.toLowerCase() === 'x-wp-totalpages' ? String(totalPages) : null,
    },
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

describe('Project Interim muratore:GE crawler', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('pins the promoted spec and fixture to the official careers source', () => {
    const spec = JSON.parse(readFileSync(
      new URL('../data/prospector/crawlers/project-interim.json', import.meta.url),
      'utf8',
    ));
    expect(spec.companyKey).toBe(PROJECT_INTERIM_KEY);
    expect(spec.candidateKey).toBe('project-interim');
    expect(spec.revalidateRejectedWithSourceAdapter).toBe(true);
    expect(spec.companyHost).toBe('projectinterim.ch');
    expect(spec.seedUrls).toEqual(['https://projectinterim.ch/work/']);
    expect(spec.sampleVacancyCount).toBe(fixture.length);
    expect(spec.sampleTitles).toEqual(fixture.map((record) => record.title.rendered));
    expect(JSON.stringify(spec)).not.toMatch(/jobup\.ch|jobs\.ch/);
  });

  it('builds source-backed structured jobs without inventing address detail', () => {
    const jobs = dated().map((record) => parseProjectInterimWork(record)).filter(Boolean);

    expect(jobs).toHaveLength(2);
    expect(jobs.map((job) => job.title)).toEqual([
      'Maçon Génie Civil (H/F)',
      'Maçon Gros Oeuvre (H/F)',
    ]);
    expect(jobs.every((job) => job.id.startsWith('project-interim-'))).toBe(true);
    expect(jobs.every((job) => job.canton === 'GE' && job.location === 'Genève')).toBe(true);
    expect(jobs.every((job) => job.addressLocality === 'Genève' && job.addressRegion === 'GE')).toBe(true);
    expect(jobs.every((job) => job.addressCountry === 'CH' && job.country === 'CH')).toBe(true);
    expect(jobs.every((job) => job.postalCode === '' && job.streetAddress === '')).toBe(true);
    expect(jobs.every((job) => job.employmentType === 'TEMPORARY' && job.contract === 'temporary')).toBe(true);
    expect(jobs.every((job) => job.postingDateSource === 'reported')).toBe(true);
    expect(jobs.every((job) => job.description.split(/\s+/).length >= 50)).toBe(true);
    expect(new Set(jobs.map((job) => job.url)).size).toBe(2);
  });

  it('uses the stable WordPress record id to disambiguate repeated titles', () => {
    const [record] = dated();
    const duplicateTitle = structuredClone(record);
    duplicateTitle.id = Number(record.id) + 1;
    duplicateTitle.link = 'https://projectinterim.ch/work/macon-genie-civil-duplicate/';

    const first = parseProjectInterimWork(record);
    const second = parseProjectInterimWork(duplicateTitle);

    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(first?.slug).toContain('macon-genie-civil-h-f-project-interim-geneve');
    expect(first?.slug).toMatch(new RegExp(`-${record.id}$`));
    expect(second?.slug).toMatch(new RegExp(`-${duplicateTitle.id}$`));
    expect(first?.slug).not.toBe(second?.slug);
    expect(first?.slugDisambiguator).toBe(String(record.id));
    expect(second?.slugDisambiguator).toBe(String(duplicateTitle.id));
  });

  it('filters fail-closed by profession, GE source location and canonical official detail URL', () => {
    const [record] = dated();
    expect(isMasonRole(record.title.rendered)).toBe(true);
    expect(isMasonRole('Centraliste à Béton (H/F)')).toBe(false);

    const wrongRole = structuredClone(record);
    wrongRole.title.rendered = 'Carreleur (H/F)';
    wrongRole['work-meta-fields'].work_type = 'Carreleur';
    expect(parseProjectInterimWork(wrongRole)).toBeNull();

    const wrongCanton = structuredClone(record);
    wrongCanton['work-meta-fields'].location = 'Lausanne';
    expect(parseProjectInterimWork(wrongCanton)).toBeNull();

    const marketplace = structuredClone(record);
    marketplace.link = 'https://www.jobup.ch/fr/emplois/detail/123';
    expect(parseProjectInterimWork(marketplace)).toBeNull();
  });

  it('fetches the official WordPress work collection and extracts muratore:GE', async () => {
    const requested: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      requested.push(url);
      return jsonResponse(dated());
    }));

    const jobs = await fetchAllProjectInterimJobs();

    expect(jobs).toHaveLength(2);
    expect(requested).toHaveLength(1);
    expect(requested[0]).toContain('projectinterim.ch/wp-json/wp/v2/works');
    expect(requested[0]).toContain('work-meta-fields');
  });

  it('passes the promotion contract while retaining the below-floor noindex bridge', async () => {
    const jobs = dated().map((record) => parseProjectInterimWork(record)).filter(Boolean);
    const observed = {
      verdict: 'good',
      score: 1,
      sampled: 3,
      vacancyCount: jobs.length,
      reachableRate: 1,
      titleMatchRate: 1,
      contentfulRate: 1,
      locationSourceRate: 1,
      distinctRate: 1,
      detailDistinctRate: 1,
      jobLikeRate: 1,
      logoFound: true,
    };
    const gate = evaluatePromotion({
      status: 'promoted',
      crawlerKey: PROJECT_INTERIM_KEY,
      tenantHost: 'projectinterim.ch',
      aggregator: false,
      validationHistory: [
        { ...observed, at: daysAgo(2) },
        { ...observed, at: daysAgo(1) },
      ],
    }, { existingKeys: new Set(), hostOwners: new Map() });
    expect(gate.passed, gate.reasons.join('\n')).toBe(true);

    expect(jobs.length).toBeGreaterThanOrEqual(1);
    expect(jobs.length).toBeLessThan(MIN_JOBS);
    expect(meetsJobsFloor({ liveCount: jobs.length, recentlyExpiredCount: 0 }).meetsFloor).toBe(false);
    expect(renderProfessionBelowFloorBridge('it', 'GE', 'muratore'))
      .toContain('<meta name="robots" content="noindex,follow">');
  });

  it('trusts only the official Project Interim origin', () => {
    expect(isTrustedDomain('https://projectinterim.ch/work/macon-genie-civil-h-f/')).toBe(true);
    expect(isTrustedDomain('https://www.projectinterim.ch/work/macon-construction-h-f/')).toBe(true);
    expect(isProjectInterimJob({ companyKey: PROJECT_INTERIM_KEY })).toBe(true);
    expect(isTrustedDomain('https://new.projectinterim.ch/work/macon-gc-h-f/')).toBe(false);
    expect(isTrustedDomain('https://www.jobup.ch/fr/emplois/detail/123')).toBe(false);
  });
});
