import { describe, it, expect } from 'vitest';
import {
  RFSM_FRIBOURG_KEY,
  RFSM_FRIBOURG_COMPANY_NAME,
  RFSM_FRIBOURG_CAREERS_URL,
  RFSM_FRIBOURG_CAREERS_URLS,
  isRfsmFribourgJob,
  isTrustedDomain,
  parseListing,
  parseDetail,
  extractBalancedJobDescription,
  resolveSite,
  RFSM_SITES,
} from '../scripts/lib/rfsm-fribourg-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

const FIXTURE_LISTING_HTML = `
<div class="row">
  <a class="jobTitle-link" href="/job/Villars-sur-Gl%C3%A2ne%2C-CH-Infirmier-%C3%A8re%2C-RFSM-Villars-sur-Gl%C3%A2ne-Unit%C3%A9-V%C3%A9nus-Sari/1360783757/">
    Infirmier-ère, RFSM Villars-sur-Glâne - Unité Vénus
  </a>
  <a class="jobIcon" href="/job/Villars-sur-Gl%C3%A2ne%2C-CH-Infirmier-%C3%A8re%2C-RFSM-Villars-sur-Gl%C3%A2ne-Unit%C3%A9-V%C3%A9nus-Sari/1360783757/" aria-label="">icon</a>
  <a class="jobTitle-link" href="/job/Bulle%2C-CH-Psychologue-assistant-e-RFSM-Bulle-Gruy/1360796657/">
    Psychologue-assistant-e (Psychothérapeute en form.), RFSM Bulle
  </a>
  <a class="jobIcon" href="/job/Marsens%2C-CH-Infirmier-%C3%A8re-Marsens-other/1234567890/">Enseignant primaire, Marsens</a>
  <a class="jobTitle-link" href="/job/Marsens%2C-CH-Pflegefachperson-FNPG-Marsens/1368233057/">
    Pflegefachperson FH/HF, FNPG Marsens
  </a>
</div>
`;

const FIXTURE_DETAIL_HTML = `
<html><body>
<span itemprop="title" data-careersite-propertyid="title" class="rtltextaligneligible">Infirmier-ère, RFSM Villars-sur-Glâne - Unité Vénus</span>
<span data-careersite-propertyid="shifttype" class="rtltextaligneligible">65-70%</span>
<span data-careersite-propertyid="location" class="rtltextaligneligible">Villars-sur-Glâne, CH, Sarine, CH</span>
<span class="jobdescription">
  <div><div><p>Qui sommes-nous? Le RFSM est rattaché à la DSAS.</p></div>
    <div>
      <H2><b>Vos missions</b></H2>
      <p>Prise en charge des crises psychiatriques <span style="font-weight:bold">dans le contexte des premiers séjours</span> pour une durée moyenne d'hospitalisation de 2 à 3 semaines</p>
    </div>
    <div>
      <H2><b>Nous offrons</b></H2>
      <p>Un cadre <span>de travail stimulant en pleine extension</span> au sein d'une équipe pluridisciplinaire dynamique.</p>
    </div>
  </div>
</span>
<div>footer content outside body</div>
</body></html>
`;

describe('RFSM Fribourg crawler parser', () => {
  it('exports valid constants', () => {
    expect(RFSM_FRIBOURG_KEY).toBe('rfsm-fribourg');
    expect(RFSM_FRIBOURG_COMPANY_NAME).toMatch(/^RFSM/);
    expect(RFSM_FRIBOURG_CAREERS_URL).toMatch(/^https:\/\/jobs\.fr\.ch\/search\/\?q=RFSM/);
    expect(RFSM_FRIBOURG_CAREERS_URLS).toEqual([
      expect.stringContaining('q=RFSM'),
      expect.stringContaining('q=FNPG'),
    ]);
  });

  describe('isRfsmFribourgJob', () => {
    it('matches by companyKey', () => {
      expect(isRfsmFribourgJob({ companyKey: 'rfsm-fribourg' })).toBe(true);
    });
    it('matches by company "RFSM" substring', () => {
      expect(isRfsmFribourgJob({ company: 'RFSM Villars' })).toBe(true);
    });
    it('matches by company "Réseau fribourgeois" substring', () => {
      expect(isRfsmFribourgJob({ company: 'Réseau fribourgeois santé mentale' })).toBe(true);
    });
    it('matches by RFSM-tagged jobs.fr.ch URL', () => {
      expect(
        isRfsmFribourgJob({ url: 'https://jobs.fr.ch/job/Bulle-RFSM-x/123/' })
      ).toBe(true);
    });
    it('rejects non-RFSM jobs.fr.ch URLs', () => {
      expect(isRfsmFribourgJob({ url: 'https://jobs.fr.ch/job/teacher/123/' })).toBe(false);
    });
    it('rejects null and unrelated jobs', () => {
      expect(isRfsmFribourgJob(null)).toBe(false);
      expect(isRfsmFribourgJob({ companyKey: 'other' })).toBe(false);
    });
  });

  describe('isTrustedDomain', () => {
    it('trusts jobs.fr.ch', () => {
      expect(isTrustedDomain('https://jobs.fr.ch/job/x/1/')).toBe(true);
    });
    it('rejects other domains', () => {
      expect(isTrustedDomain('https://example.com')).toBe(false);
      expect(isTrustedDomain('not-a-url')).toBe(false);
    });
  });

  describe('resolveSite', () => {
    it('routes Villars-sur-Glâne text to PC 1752', () => {
      expect(resolveSite('Villars-sur-Glâne, CH, Sarine, CH').postalCode).toBe('1752');
    });
    it('routes Marsens text to PC 1633', () => {
      expect(resolveSite('Marsens Unité X').postalCode).toBe('1633');
    });
    it('routes Givisiez text to PC 1762', () => {
      expect(resolveSite('Givisiez clinique').postalCode).toBe('1762');
    });
    it('falls back to Fribourg 1700 when no site matches', () => {
      const out = resolveSite('No city anywhere');
      expect(out.city).toBe('Fribourg');
      expect(out.postalCode).toBe('1700');
    });
    it('site list covers the 4 known RFSM sites', () => {
      const cities = RFSM_SITES.map((s) => s.city);
      for (const c of ['Marsens', 'Villars-sur-Glâne', 'Givisiez', 'Bulle']) {
        expect(cities).toContain(c);
      }
    });
  });

  describe('parseListing', () => {
    it('extracts unique RFSM jobs by numeric ID and skips icon/non-RFSM anchors', () => {
      const rows = parseListing(FIXTURE_LISTING_HTML);
      // Both jobTitle-link rows are RFSM; the icon anchor for the first job
      // has no human title (dedupe by jobId), the third anchor is non-RFSM.
      expect(rows.length).toBe(3);
      expect(rows[0].jobId).toBe('1360783757');
      expect(rows[1].jobId).toBe('1360796657');
      expect(rows[2].jobId).toBe('1368233057');
      expect(rows[0].title).toMatch(/RFSM Villars-sur-Glâne/);
    });
    it('keeps RFSM and FNPG while dropping unrelated jobs', () => {
      const rows = parseListing(FIXTURE_LISTING_HTML);
      for (const row of rows) expect(row.title).toMatch(/RFSM|FNPG/i);
    });
    it('resolves URLs to absolute jobs.fr.ch', () => {
      const rows = parseListing(FIXTURE_LISTING_HTML);
      for (const row of rows) expect(row.url).toMatch(/^https:\/\/jobs\.fr\.ch\/job\//);
    });
    it('returns empty on empty HTML', () => {
      expect(parseListing('')).toEqual([]);
    });
  });

  describe('extractBalancedJobDescription', () => {
    it('walks balanced spans to capture the full nested body', () => {
      const raw = extractBalancedJobDescription(FIXTURE_DETAIL_HTML);
      expect(raw).toContain('Vos missions');
      expect(raw).toContain('Nous offrons');
      expect(raw).toContain('pluridisciplinaire dynamique');
      expect(raw).not.toContain('footer content outside body');
    });
    it('returns empty string when jobdescription span absent', () => {
      expect(extractBalancedJobDescription('<div>no span here</div>')).toBe('');
    });
  });

  describe('parseDetail', () => {
    it('extracts title / shiftType / location / description from the SF page', () => {
      const d = parseDetail(FIXTURE_DETAIL_HTML);
      expect(d.title).toMatch(/Infirmier/);
      expect(d.shiftType).toBe('65-70%');
      expect(d.location).toMatch(/Villars-sur-Glâne/);
      expect(d.description).toContain('Vos missions');
      expect(d.description).toContain('Nous offrons');
      expect(d.description.length).toBeGreaterThan(200);
      expect(d.description).not.toContain('footer content');
    });
    it('handles empty input safely', () => {
      const d = parseDetail('');
      expect(d.title).toBe('');
      expect(d.description).toBe('');
    });
  });

  describe('slugify', () => {
    it('handles French diacritics and dash sequences', () => {
      expect(slugify('Infirmier-ère, RFSM Villars-sur-Glâne')).toBe(
        'infirmier-ere-rfsm-villars-sur-glane'
      );
    });
    it('respects max length', () => {
      expect(slugify('a'.repeat(200)).length).toBeLessThanOrEqual(90);
    });
  });
});
