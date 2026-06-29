/**
 * National-employer fetch-facet scope guards.
 *
 * These crawlers previously narrowed their fetch to a single canton/city
 * (SRG → Wallis facet, Swiss Medical Network → Ticino region UUID, Skyguide →
 * Locarno/Lugano-Agno facet, Mikron → Agno filter, PEMSA → canton=125,
 * Transgourmet/Interdiscount/Jumbo → Wallis facet `f=30:`) and/or defaulted
 * unresolved jobs to a fixed canton. This locks in the CH-wide behaviour:
 * canton derived per-job, no fixed fallback, foreign rows excluded.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { inferSkyguideCanton } from '@/scripts/lib/skyguide-job-parser.mjs';
import { isPemsaTicinoRelevant } from '@/scripts/lib/pemsa-job-parser.mjs';
import { parseMikronJobs } from '@/scripts/lib/mikron-job-parser.mjs';
import {
  normalizeSmnApiPosting,
  extractSmnApiDescription,
  extractSmnPostingId,
  smnPostingsApiUrl,
} from '@/scripts/lib/swiss-medical-network-job-parser.mjs';
import { fetchAllTransgourmetJobs } from '@/scripts/lib/transgourmet-job-parser.mjs';
import { fetchAllInterdiscountJobs } from '@/scripts/lib/interdiscount-job-parser.mjs';
import { fetchAllJumboJobs } from '@/scripts/lib/jumbo-job-parser.mjs';

describe('Skyguide canton inference — no Ticino default', () => {
  it('derives the real canton for the big control centres', () => {
    expect(inferSkyguideCanton('Genève, CH')).toBe('GE');
    expect(inferSkyguideCanton('Dübendorf, CH')).toBe('ZH');
    expect(inferSkyguideCanton('Sion, CH')).toBe('VS');
  });

  it('returns blank (not TI) when the location is unknown', () => {
    expect(inferSkyguideCanton('')).toBe('');
    expect(inferSkyguideCanton('Atlantis')).toBe('');
  });
});

describe('PEMSA relevance — all 26 cantons, not Ticino-only', () => {
  it('keeps non-Ticino Swiss cities', () => {
    expect(isPemsaTicinoRelevant({ city: 'Genève' })).toBe(true);
    expect(isPemsaTicinoRelevant({ city: 'Bulle' })).toBe(true);
    expect(isPemsaTicinoRelevant({ city: 'Lugano' })).toBe(true);
  });

  it('rejects foreign locations', () => {
    expect(isPemsaTicinoRelevant({ city: 'Paris' })).toBe(false);
    expect(isPemsaTicinoRelevant({ city: 'Milano' })).toBe(false);
  });
});

describe('Mikron teaser parsing — keeps non-Agno Swiss sites, no fabricated location', () => {
  const FIXTURE = `
    <div class="open-jobs">
      <article class="mi-job-teaser">
        <h3><a href="/en/controls-engineer-1" class="stretched-link">Controls Engineer</a></h3>
        <div class="job-attributes"><div><div>Division</div><div>Automation</div></div>
        <div><div>Location</div><div>Switzerland, Boudry</div></div></div>
      </article>
      <article class="mi-job-teaser">
        <h3><a href="/en/cnc-operator-2" class="stretched-link">CNC Operator</a></h3>
        <div class="job-attributes"><div><div>Division</div><div>Machining</div></div>
        <div><div>Location</div><div>Switzerland, Agno</div></div></div>
      </article>
      <article class="mi-job-teaser">
        <h3><a href="/en/sales-rep-3" class="stretched-link">Sales Rep</a></h3>
        <div class="job-attributes"><div><div>Division</div><div>Tool</div></div>
        <div><div>Location</div><div>Germany, Rottweil</div></div></div>
      </article>
    </div>`;

  it('extracts the real per-teaser location (Boudry survives, never forced to Agno)', () => {
    const jobs = parseMikronJobs(FIXTURE, { filterAgno: false });
    const byTitle = Object.fromEntries(jobs.map((j) => [j.title, j.location]));
    expect(byTitle['Controls Engineer']).toBe('Switzerland, Boudry');
    expect(byTitle['CNC Operator']).toBe('Switzerland, Agno');
    expect(byTitle['Sales Rep']).toBe('Germany, Rottweil');
  });
});

describe('Swiss Medical Network — SmartRecruiters API normalization', () => {
  it('builds the postings API URL with pagination', () => {
    expect(smnPostingsApiUrl(0, 100)).toContain('/companies/SwissMedicalNetwork1/postings');
    expect(smnPostingsApiUrl(100, 100)).toContain('offset=100');
  });

  it('resolves canton from a 2-letter region code', () => {
    const p = normalizeSmnApiPosting({ id: '1', name: 'Médecin', location: { city: 'Biel', region: 'BE', country: 'ch' } });
    expect(p).toMatchObject({ city: 'Biel', canton: 'BE', country: 'ch' });
  });

  it('resolves canton from the city when region is absent', () => {
    const p = normalizeSmnApiPosting({ id: '2', name: 'Infirmier', location: { city: 'Genève', country: 'ch' } });
    expect(p.canton).toBe('GE');
  });

  it('leaves canton blank (never Ticino) when unresolved', () => {
    const p = normalizeSmnApiPosting({ id: '3', name: 'X', location: { city: 'Bellelay', country: 'ch' } });
    expect(p.canton).toBe('');
  });

  it('derives PART_TIME / FULL_TIME from the API employment type', () => {
    const pt = normalizeSmnApiPosting({ id: '4', name: 'X', location: { city: 'Bern', region: 'BE', country: 'ch' }, typeOfEmployment: { id: 'part-time', label: 'Part-time' } });
    const ft = normalizeSmnApiPosting({ id: '5', name: 'Y', location: { city: 'Bern', region: 'BE', country: 'ch' }, typeOfEmployment: { id: 'permanent', label: 'Full-time' } });
    expect(pt.employmentType).toBe('PART_TIME');
    expect(ft.employmentType).toBe('FULL_TIME');
  });

  it('extracts the posting id used to de-dup against dedicated clinic crawlers', () => {
    expect(extractSmnPostingId('https://jobs.smartrecruiters.com/SwissMedicalNetwork1/744000134713627-some-slug')).toBe('744000134713627');
    expect(extractSmnPostingId('https://jobs.smartrecruiters.com/SwissMedicalNetwork1/744000134713627')).toBe('744000134713627');
    expect(extractSmnPostingId('https://example.com/x')).toBe('');
  });

  it('joins jobAd sections into a description', () => {
    const detail = { jobAd: { sections: {
      jobDescription: { text: '<p>Main mission here.</p>' },
      qualifications: { text: '<ul><li>Skill A</li></ul>' },
    } } };
    const desc = extractSmnApiDescription(detail);
    expect(desc).toContain('Main mission here.');
    expect(desc).toContain('Skill A');
  });
});

describe('Coop-Group Prospective.ch crawlers — CH-wide fetch, no Wallis facet (issue #3065)', () => {
  // Multi-canton fixture: Bern (BE) + Graubünden (GR) are kept; the
  // Liechtenstein row has no resolvable Swiss canton and must be dropped.
  const FIXTURE_JOBS = [
    {
      viewkey: '11111111-1111-1111-1111-111111111111',
      title: 'Lagermitarbeiter',
      start_date: '2026-06-01',
      attributes: { '30': ['Bern'], '40': ['unbefristet'] },
      szas: { sza_title: 'Lagermitarbeiter', 'sza_workplace.city': 'Bern', 'sza_workplace.region': 'Bern' },
      links: { directlink: 'https://example.ch/job/1' },
    },
    {
      viewkey: '22222222-2222-2222-2222-222222222222',
      title: 'Verkaufsberater',
      start_date: '2026-06-02',
      attributes: { '30': ['Graubünden'], '40': ['unbefristet'] },
      szas: { sza_title: 'Verkaufsberater', 'sza_workplace.city': 'Chur', 'sza_workplace.region': 'Graubünden' },
      links: { directlink: 'https://example.ch/job/2' },
    },
    {
      viewkey: '33333333-3333-3333-3333-333333333333',
      title: 'Filialleiter',
      start_date: '2026-06-03',
      attributes: { '30': ['Principato del Liechtenstein'] },
      szas: { sza_title: 'Filialleiter', 'sza_workplace.city': 'Vaduz', 'sza_workplace.region': 'Principato del Liechtenstein' },
      links: { directlink: 'https://example.li/job/3' },
    },
  ];

  let capturedUrls: string[] = [];

  beforeEach(() => {
    capturedUrls = [];
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      capturedUrls.push(String(url));
      return {
        ok: true,
        status: 200,
        json: async () => ({ total: FIXTURE_JOBS.length, jobs: FIXTURE_JOBS }),
      } as unknown as Response;
    }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  const cases = [
    { name: 'transgourmet', fetchAll: fetchAllTransgourmetJobs, companyFacet: null },
    { name: 'interdiscount', fetchAll: fetchAllInterdiscountJobs, companyFacet: '70%3A' },
    { name: 'jumbo', fetchAll: fetchAllJumboJobs, companyFacet: '70%3A' },
  ];

  for (const { name, fetchAll, companyFacet } of cases) {
    describe(name, () => {
      it('never sends a canton facet (f=30:) so the fetch stays CH-wide', async () => {
        await fetchAll();
        expect(capturedUrls.length).toBeGreaterThan(0);
        for (const url of capturedUrls) {
          expect(url).not.toMatch(/f=30(%3A|:)/i);
        }
      });

      if (companyFacet) {
        it('still scopes by company facet (f=70:)', async () => {
          await fetchAll();
          expect(capturedUrls.some((u) => u.includes(companyFacet))).toBe(true);
        });
      }

      it('keeps jobs from multiple cantons (BE + GR), never Wallis-only', async () => {
        const jobs = await fetchAll();
        const cantons = jobs.map((j) => j.canton);
        expect(cantons).toContain('BE');
        expect(cantons).toContain('GR');
      });

      it('drops foreign rows with no resolvable Swiss canton (Liechtenstein)', async () => {
        const jobs = await fetchAll();
        expect(jobs).toHaveLength(2);
        for (const job of jobs) {
          expect(job.canton).toBeTruthy();
          expect(job.country).toBe('CH');
        }
      });
    });
  }
});
