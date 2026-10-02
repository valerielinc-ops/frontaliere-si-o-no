import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, it, expect, vi } from 'vitest';
import { fetchAllAbbottJobs } from '../scripts/lib/abbott-job-parser.mjs';
import { fetchAllAlconJobs } from '../scripts/lib/alcon-job-parser.mjs';
import { fetchAllArdianJobs } from '../scripts/lib/ardian-job-parser.mjs';
import { fetchAllBossardJobs } from '../scripts/lib/bossard-job-parser.mjs';
import { fetchAllKsbJobs } from '../scripts/lib/ksb-job-parser.mjs';
import { fetchAllNovartisJobs } from '../scripts/lib/novartis-job-parser.mjs';
import { fetchAllRitualsCosmeticsJobs } from '../scripts/lib/rituals-cosmetics-job-parser.mjs';
import { fetchAllRocheJobs } from '../scripts/lib/roche-job-parser.mjs';
import { fetchAllStrykerJobs } from '../scripts/lib/stryker-job-parser.mjs';
import {
  fetchWorkdaySwissCanton,
  resolveWorkdayPostalPlace,
  resolveWorkdaySwissCanton,
} from '../scripts/lib/workday-swiss-job-parser-common.mjs';
import { resolveSwissPostalCodePlace } from '../scripts/lib/swiss-locality-directory.mjs';

/**
 * Same class as the Workday factory fix (imerys / kone, 2026-10-02): the
 * commune gazetteer behind `inferSwissTargetCanton` lists today's BFS communes,
 * so a req placed in a LOCALITY — Rotkreuz (Risch ZG), Muri AG, Brüttisellen
 * (Wangen-Brüttisellen ZH), Bodio (Giornico TI) — had no canton and the nine
 * dedicated Workday parsers dropped it silently. They now share
 * `fetchWorkdaySwissCanton` / `resolveWorkdaySwissCanton`: the official
 * locality directory places the name, only on the req's own structured Swiss
 * country and only when the name sits in exactly one canton.
 *
 * Measured live 2026-10-02: novartis +1 (Medical Manager, `Rotkreuz
 * (Office-Based)` → ZG), ksb +1 (MPA Kinderarztpraxis, `Muri` → AG); the other
 * seven had no locality-only req on their Swiss boards that day. Abbott's 4
 * Zürich reqs carried a street address instead (`Technoparkstrass 1 CH 8005`):
 * they are placed by their postal code, under the same guarantees (see the
 * last describe block) — abbott 18 → 22 live.
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

const PARSERS = [
  { name: 'abbott', fetchAll: fetchAllAbbottJobs },
  { name: 'alcon', fetchAll: fetchAllAlconJobs },
  { name: 'ardian', fetchAll: fetchAllArdianJobs },
  { name: 'bossard', fetchAll: fetchAllBossardJobs },
  { name: 'ksb', fetchAll: fetchAllKsbJobs },
  { name: 'novartis', fetchAll: fetchAllNovartisJobs },
  { name: 'rituals-cosmetics', fetchAll: fetchAllRitualsCosmeticsJobs },
  { name: 'roche', fetchAll: fetchAllRocheJobs },
  { name: 'stryker', fetchAll: fetchAllStrykerJobs },
] as const;

function mockBoard(requisitionCountry: object | null) {
  const posting = { title: 'Service Engineer', externalPath: '/job/Bruttisellen/Service-Engineer_JR7', locationsText: PLACE, postedOn: 'Posted Today', bulletFields: ['JR7'] };
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
          jobRequisitionLocation: requisitionCountry ? { descriptor: PLACE, country: requisitionCountry } : { descriptor: PLACE },
          ...(requisitionCountry === CH ? { country: { descriptor: 'Switzerland', id: CH.id } } : {}),
          // The CXS listing row never carries `timeType`; only the detail does.
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

describe('dedicated Workday parsers — a Swiss locality outside the BFS commune list', () => {
  for (const { name, fetchAll } of PARSERS) {
    it(`${name}: publishes the req in its canton when its structured country is CH`, async () => {
      mockBoard(CH);
      const jobs: any[] = await fetchAll();
      expect(jobs.map((job) => [job.title, job.location, job.canton])).toEqual([['Service Engineer', PLACE, 'ZH']]);
      // Typed from the detail's `timeType`, not from the empty listing row.
      expect(jobs[0]).toMatchObject({ employmentType: 'PART_TIME', contract: 'part-time' });
    }, 20_000);

    it(`${name}: still drops it on text alone or against a foreign requisition`, async () => {
      mockBoard(null);
      expect(await fetchAll()).toHaveLength(0);
      mockBoard({ descriptor: 'Italy', alpha2Code: 'IT' });
      expect(await fetchAll()).toHaveLength(0);
    }, 20_000);
  }

  it('every one of the nine gates its canton through the shared resolver', () => {
    for (const { name } of PARSERS) {
      const source = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'lib', `${name}-job-parser.mjs`), 'utf8');
      expect(source, name).toMatch(/\b(?:fetchWorkdaySwissCanton|resolveWorkdaySwissCanton)\(/);
    }
  });
});

describe('fetchWorkdaySwissCanton / resolveWorkdaySwissCanton', () => {
  const swissReq = { jobRequisitionLocation: { country: CH } };

  it('answers from the commune gazetteer without reading the detail', async () => {
    const fetchDetail = vi.fn();
    expect(await fetchWorkdaySwissCanton('https://x/wday/cxs/x/S', '/job/Basel/X_1', 'Basel', { fetchDetail })).toBe('BS');
    expect(fetchDetail).not.toHaveBeenCalled();
  });

  it('reads the detail only for a place the gazetteer misses, and fails closed when it cannot', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const ok = vi.fn(async () => ({ jobPostingInfo: swissReq }));
    expect(await fetchWorkdaySwissCanton('https://x/wday/cxs/x/S', '/job/R/X_1', 'Rotkreuz (Office-Based)', { fetchDetail: ok })).toBe('ZG');
    expect(ok).toHaveBeenCalledTimes(1);
    const broken = vi.fn(async () => { throw new Error('timeout'); });
    expect(await fetchWorkdaySwissCanton('https://x/wday/cxs/x/S', '/job/R/X_1', 'Rotkreuz', { fetchDetail: broken })).toBe('');
    expect(await fetchWorkdaySwissCanton('https://x/wday/cxs/x/S', '/job/P/X_1', 'Paris, France', { fetchDetail: ok })).toBe('');
  });

  it('costs no request for a place the Swiss directory does not know (a global board stays cheap)', async () => {
    const fetchDetail = vi.fn(async () => ({ jobPostingInfo: swissReq }));
    for (const city of ['Petaling Jaya', 'Welwyn', 'Sant Cugat del Vallès', 'Penzberg']) {
      expect(await fetchWorkdaySwissCanton('https://x/wday/cxs/x/S', '/job/X/X_1', city, { fetchDetail })).toBe('');
    }
    expect(fetchDetail).not.toHaveBeenCalled();
  });

  it('strips a trailing site qualifier, never a reason to guess', () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(resolveWorkdaySwissCanton('Rotkreuz (Office-Based)', swissReq)).toBe('ZG');
    expect(resolveWorkdaySwissCanton('Muri', swissReq)).toBe('AG');
    expect(resolveWorkdaySwissCanton('Rotkreuz (Office-Based)', {})).toBe('');
    expect(resolveWorkdaySwissCanton('Nowhere-Land (Site 4)', swissReq)).toBe('');
  });
});

/**
 * A requisition stated as an ADDRESS (Abbott, live 2026-10-02:
 * `Switzerland : Technoparkstrass 1 CH 8005`, 4 Zürich reqs dropped). Its
 * postal code names the locality — only on the req's structured Swiss country,
 * with exactly one four-digit code in the text, and a code the official
 * directory gives one canton and one locality (data/swiss-postal-code-index.json).
 */
describe('address-shaped requisitions — the Swiss postal code names the place', () => {
  const addressDetail = JSON.parse(fs.readFileSync(
    path.join(__dirname, 'fixtures', 'workday', 'abbott-detail-address-requisition.json'), 'utf8',
  ));
  const swissReq = { jobRequisitionLocation: addressDetail.jobPostingInfo.jobRequisitionLocation };

  it('reads only unique postal codes from the official index', () => {
    expect(resolveSwissPostalCodePlace('8005')).toEqual({ canton: 'ZH', locality: 'Zürich' });
    expect(resolveSwissPostalCodePlace('6743')).toEqual({ canton: 'TI', locality: 'Bodio' });
    expect(resolveSwissPostalCodePlace('6343')).toBeNull(); // Rotkreuz, Buonas, Holzhäusern
    expect(resolveSwissPostalCodePlace('9485')).toBeNull(); // Liechtenstein
    expect(resolveSwissPostalCodePlace('80')).toBeNull();
  });

  it('places an address only on a Swiss structured country with exactly one code', () => {
    const address = addressDetail.jobPostingInfo.jobRequisitionLocation.descriptor;
    expect(resolveWorkdayPostalPlace(address, swissReq)).toEqual({ canton: 'ZH', locality: 'Zürich' });
    expect(resolveWorkdayPostalPlace(address, {})).toBeNull();
    expect(resolveWorkdayPostalPlace(address, { jobRequisitionLocation: { country: { alpha2Code: 'DE' } } })).toBeNull();
    expect(resolveWorkdayPostalPlace('Switzerland : Hauptstrasse 1234 CH 8005', swissReq)).toBeNull();
  });

  it('abbott publishes the address-shaped Zürich req at its postal locality', async () => {
    const posting = {
      title: addressDetail.jobPostingInfo.title,
      externalPath: '/job/Switzerland---Zurich/EHS-Specialist_31155192',
      locationsText: 'Switzerland - Zurich',
      postedOn: 'Posted Today',
      bulletFields: ['31155192'],
    };
    const serve = (detail: unknown) => {
      vi.stubGlobal('fetch', vi.fn(async (url: string, init: any = {}) => {
        const href = String(url);
        if (init?.method === 'POST' && href.endsWith('/jobs')) {
          const body = JSON.parse(init.body || '{}');
          return json({ total: 1, jobPostings: body.offset > 0 ? [] : [posting] });
        }
        if (href.endsWith('_31155192')) return json(detail);
        return new Response('', { status: 404 });
      }));
    };
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    serve(addressDetail);
    const jobs: any[] = await fetchAllAbbottJobs();
    expect(jobs.map((job) => [job.title, job.location, job.canton])).toEqual([['EHS Specialist', 'Zürich', 'ZH']]);

    const { country: _country, ...requisitionWithoutCountry } = addressDetail.jobPostingInfo.jobRequisitionLocation;
    serve({ jobPostingInfo: { ...addressDetail.jobPostingInfo, country: undefined, jobRequisitionLocation: requisitionWithoutCountry } });
    expect(await fetchAllAbbottJobs()).toHaveLength(0);
  }, 20_000);

  it('keeps the index honest: real cantons, no Liechtenstein codes, a pinned source', () => {
    const index = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'swiss-postal-code-index.json'), 'utf8'));
    const cantons = new Set(['AG', 'AI', 'AR', 'BE', 'BL', 'BS', 'FR', 'GE', 'GL', 'GR', 'JU', 'LU', 'NE', 'NW', 'OW', 'SG', 'SH', 'SO', 'SZ', 'TG', 'TI', 'UR', 'VD', 'VS', 'ZG', 'ZH']);
    expect(index.sourceUrl).toContain('ortschaftenverzeichnis_plz');
    expect(index.sourceSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(Object.keys(index.postalCodes)).toHaveLength(index.totalPostalCodes);
    for (const [code, [canton, locality]] of Object.entries(index.postalCodes) as Array<[string, [string, string]]>) {
      expect(code).toMatch(/^\d{4}$/);
      expect(cantons.has(canton), code).toBe(true);
      expect(locality.length, code).toBeGreaterThan(0);
      expect(Number(code) >= 9485 && Number(code) <= 9498, code).toBe(false);
    }
  });
});
