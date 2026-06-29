/**
 * National-employer fetch-facet scope guards.
 *
 * These crawlers previously narrowed their fetch to a single canton/city
 * (SRG → Wallis facet, Swiss Medical Network → Ticino region UUID, Skyguide →
 * Locarno/Lugano-Agno facet, Mikron → Agno filter, PEMSA → canton=125) and/or
 * defaulted unresolved jobs to Ticino. This locks in the CH-wide behaviour:
 * canton derived per-job, no Ticino fallback, foreign rows excluded.
 */
import { describe, it, expect } from 'vitest';

import { inferSkyguideCanton } from '@/scripts/lib/skyguide-job-parser.mjs';
import { isPemsaTicinoRelevant } from '@/scripts/lib/pemsa-job-parser.mjs';
import { parseMikronJobs } from '@/scripts/lib/mikron-job-parser.mjs';
import {
  normalizeSmnApiPosting,
  extractSmnApiDescription,
  smnPostingsApiUrl,
} from '@/scripts/lib/swiss-medical-network-job-parser.mjs';

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
