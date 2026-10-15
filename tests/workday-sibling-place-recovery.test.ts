import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, it, expect, vi } from 'vitest';
import { fetchAllLogitechJobs } from '../scripts/lib/logitech-job-parser.mjs';
import { fetchAllBernerMontageJobs } from '../scripts/lib/berner-montage-job-parser.mjs';
import { fetchAllCslBehringJobs } from '../scripts/lib/csl-behring-job-parser.mjs';
import { fetchAllLindtSpruengliJobs } from '../scripts/lib/lindt-spruengli-job-parser.mjs';
import { fetchAllArxadaJobs } from '../scripts/lib/arxada-job-parser.mjs';
import { fetchAllHuntsmanJobs } from '../scripts/lib/huntsman-job-parser.mjs';
import { fetchAllLonzaJobs } from '../scripts/lib/lonza-job-parser.mjs';
import { fetchAllSiegfriedJobs } from '../scripts/lib/siegfried-job-parser.mjs';
import { fetchAllSwissLifeJobs } from '../scripts/lib/swiss-life-job-parser.mjs';
import { parseOtisWorkdayDetail } from '../scripts/lib/otis-job-parser.mjs';
import {
  isWorkdaySwissPlaceCandidate,
  recoverWorkdayPrimarySwissPlace,
  recoverWorkdaySwissPlace,
} from '../scripts/lib/workday-swiss-job-parser-common.mjs';

/**
 * The Workday siblings of 7a2741353 / 9d95e73d0 / 5be63b013 (sibling check on
 * the integrated branch): each placed a req with the commune gazetteer alone
 * — a locality outside the BFS list (Bodio, Rotkreuz, Brüttisellen) or an
 * address-shaped primary dropped the req — and several typed it from the CXS
 * listing row's `timeType`, which that endpoint never fills. They now share
 * `recoverWorkdayPrimarySwissPlace` (official directory or unique postal
 * code, on the req's structured Swiss country only) and read `timeType` from
 * the detail.
 */

const BODY = '<p>'
  + 'Responsibilities and requirements of the role, described at length by the employer. '.repeat(5)
  + '</p>';
const CH = { descriptor: 'Switzerland', id: '187134fccb084a0ea9b4b95f23890dbe', alpha2Code: 'CH' };
const PLACE = 'Brüttisellen';

function json(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json' } });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('recoverWorkdaySwissPlace — the shared recovery', () => {
  const swiss = { jobRequisitionLocation: { country: CH } };

  it('places a locality inside a tenant label, or an address by its postal code', () => {
    expect(recoverWorkdaySwissPlace('CH - Rotkreuz', swiss, { log: false })).toEqual({ location: 'Rotkreuz', canton: 'ZG' });
    expect(recoverWorkdaySwissPlace('EMEA, CH, Rotkreuz, CSL Behring', swiss, { log: false })).toEqual({ location: 'Rotkreuz', canton: 'ZG' });
    expect(recoverWorkdaySwissPlace('Bodio, Switzerland', swiss, { log: false })).toEqual({ location: 'Bodio', canton: 'TI' });
    expect(recoverWorkdaySwissPlace('Switzerland : Technoparkstrass 1 CH 8005', swiss, { log: false })).toEqual({ location: 'Zürich', canton: 'ZH' });
  });

  it('never answers without the structured Swiss country, for two places, or where the gazetteer already does', () => {
    expect(recoverWorkdaySwissPlace('CH - Rotkreuz', {}, { log: false })).toBeNull();
    expect(recoverWorkdaySwissPlace('CH - Rotkreuz', { jobRequisitionLocation: { country: { alpha2Code: 'DE' } } }, { log: false })).toBeNull();
    expect(recoverWorkdaySwissPlace('Rotkreuz, Muri', swiss, { log: false })).toBeNull();
    expect(recoverWorkdaySwissPlace('Zürich', swiss, { log: false })).toBeNull();
    expect(recoverWorkdaySwissPlace('Paris, France', swiss, { log: false })).toBeNull();
  });

  it('reads the requisition first, then the posting location', () => {
    expect(recoverWorkdayPrimarySwissPlace({
      location: 'Switzerland - Zurich',
      jobRequisitionLocation: { descriptor: 'Switzerland : Technoparkstrass 1 CH 8005', country: CH },
    }, { log: false })).toEqual({ location: 'Zürich', canton: 'ZH' });
    expect(recoverWorkdayPrimarySwissPlace({ location: PLACE, country: { descriptor: 'Switzerland' } }, { log: false }))
      .toEqual({ location: PLACE, canton: 'ZH' });
  });

  it('lets a listing pre-filter keep a candidate row, offline', () => {
    expect(isWorkdaySwissPlaceCandidate(PLACE)).toBe(true);
    expect(isWorkdaySwissPlaceCandidate('CH - Rotkreuz')).toBe(true);
    expect(isWorkdaySwissPlaceCandidate('Technoparkstrass 1 CH 8005')).toBe(true);
    expect(isWorkdaySwissPlaceCandidate('Petaling Jaya')).toBe(false);
    expect(isWorkdaySwissPlaceCandidate('Paris, France')).toBe(false);
  });
});

const PARSERS = [
  { name: 'logitech', fetchAll: fetchAllLogitechJobs },
  { name: 'berner-montage', fetchAll: fetchAllBernerMontageJobs },
  { name: 'csl-behring', fetchAll: fetchAllCslBehringJobs },
  { name: 'lindt-spruengli', fetchAll: fetchAllLindtSpruengliJobs },
  { name: 'arxada', fetchAll: fetchAllArxadaJobs },
  { name: 'huntsman', fetchAll: fetchAllHuntsmanJobs },
  { name: 'lonza', fetchAll: fetchAllLonzaJobs },
  { name: 'siegfried', fetchAll: fetchAllSiegfriedJobs },
  { name: 'swiss-life', fetchAll: fetchAllSwissLifeJobs },
] as const;

function mockBoard(country: object | null, { listing = PLACE } = {}) {
  const posting = { title: 'Service Engineer', externalPath: '/job/Bruttisellen/Service-Engineer_JR7', locationsText: listing, postedOn: 'Posted Today', bulletFields: ['JR7'] };
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: any = {}) => {
    const href = String(url);
    if (init?.method === 'POST' && href.endsWith('/jobs')) {
      const body = JSON.parse(init.body || '{}');
      return json({ total: 1, jobPostings: body.offset > 0 ? [] : [posting] });
    }
    if (href.endsWith('_JR7')) {
      return json({
        jobPostingInfo: {
          title: 'Service Engineer',
          location: PLACE,
          jobRequisitionLocation: country ? { descriptor: PLACE, country } : { descriptor: PLACE },
          ...(country === CH ? { country: { descriptor: 'Switzerland', id: CH.id } } : {}),
          timeType: 'Part time',
          jobDescription: BODY,
        },
      });
    }
    return new Response('', { status: 404 });
  }));
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
}

describe('dedicated Workday siblings — a Swiss locality outside the BFS commune list', () => {
  for (const { name, fetchAll } of PARSERS) {
    it(`${name}: publishes the req in its canton on a structured Swiss country`, async () => {
      mockBoard(CH);
      const jobs: any[] = await fetchAll();
      expect(jobs.map((job) => [job.title, job.location, job.canton])).toEqual([['Service Engineer', PLACE, 'ZH']]);
    }, 20_000);

    it(`${name}: still drops it on text alone or against a foreign requisition`, async () => {
      mockBoard(null);
      const textOnly: any[] = await fetchAll();
      expect(textOnly.filter((job) => job.canton === 'ZH')).toHaveLength(0);
      mockBoard({ descriptor: 'Italy', alpha2Code: 'IT' });
      const foreign: any[] = await fetchAll();
      expect(foreign.filter((job) => job.canton === 'ZH')).toHaveLength(0);
    }, 20_000);
  }

  it('otis: the detail parser places the same locality', () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const parsed = parseOtisWorkdayDetail({
      jobPostingInfo: {
        title: 'Service Technician',
        location: PLACE,
        jobRequisitionLocation: { descriptor: PLACE, country: CH },
        jobDescription: BODY,
      },
    }, '/job/Bruttisellen/Service-Technician_1');
    expect(parsed).toMatchObject({ city: PLACE, canton: 'ZH' });
  });
});

describe('dedicated Workday siblings — the detail `timeType` types the req', () => {
  for (const name of ['logitech', 'berner-montage', 'csl-behring', 'lindt-spruengli'] as const) {
    it(`${name}: a part-time detail publishes a part-time req`, async () => {
      mockBoard(CH);
      const parser = PARSERS.find((p) => p.name === name)!;
      const [job]: any[] = await parser.fetchAll();
      expect(job.employmentType).toBe('PART_TIME');
      expect(job.contract).toBe('part-time');
    }, 20_000);
  }
});

describe('runners and shared paths route through the shared recovery', () => {
  const read = (rel: string) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

  it.each([
    'scripts/lib/julius-baer-job-parser.mjs',
    'scripts/update-swisscom-jobs.mjs',
    'scripts/update-fnz-jobs.mjs',
    'scripts/update-bracco-jobs.mjs',
    'scripts/lib/shared-jobs-crawler.mjs',
  ])('%s recovers the place from the req detail', (rel) => {
    expect(read(rel)).toMatch(/recoverWorkdayPrimarySwissPlace\((?:info|apiInfo)\)/);
  });

  it('the scaffold generates a Workday parser over the shared factory', () => {
    const scaffold = read('scripts/scaffold-crawler.mjs');
    expect(scaffold).toContain("writeFile(files.parser, atsTier === 'workday' ? workdayParserContent : parserContent, 'Parser');");
    const template = scaffold.slice(scaffold.indexOf('const workdayParserContent = `'), scaffold.indexOf('/* ── Template: Runner'));
    expect(template).toContain("import { createWorkdaySwissParser } from './workday-swiss-job-parser-common.mjs';");
    expect(template).toContain('fetchAll${pascalKey}Jobs = parser.fetchAllJobs');
    expect(template).not.toMatch(/inferSwissTargetCanton|listing\.timeType/);
  });
});
