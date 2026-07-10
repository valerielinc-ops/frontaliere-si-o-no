import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  DIAKONIEWERK_KEY,
  DIAKONIEWERK_COMPANY_NAME,
  isDiakoniewerkJob,
  isTrustedDomain,
  splitCardText,
  parseListing,
  buildDiakoniewerkDescription,
} from '../scripts/lib/diakoniewerk-neumuenster-job-parser.mjs';
import { piAspDetailHtmlToDescription } from '../scripts/lib/pi-asp-bewerber-web-detail.mjs';

// Trimmed real markup from the Gesundheitswelt Zollikerberg careers page
// (fetched live 2026-07-10): 3 job cards + the spontaneous-application CTA.
const LISTING_HTML = readFileSync(
  path.join(__dirname, 'fixtures', 'gesundheitswelt-zollikerberg-listing.html'),
  'utf8',
);

const DETAIL_CONTAINER_HTML = readFileSync(
  path.join(__dirname, 'fixtures', 'pi-asp-detail-container.html'),
  'utf8',
);

describe('Diakoniewerk Neumünster (Gesundheitswelt Zollikerberg) crawler parser', () => {
  describe('parseListing', () => {
    it('extracts one row per pi-asp card with the stable position UUID', () => {
      const rows = parseListing(LISTING_HTML);
      expect(rows.length).toBe(3);
      expect(rows[0].positionId).toBe('3dc30036-e741-4dfb-a01a-3b5d37cad5f1');
      expect(rows[0].entity).toBe('Spital Zollikerberg');
      expect(rows[0].title).toContain('Leiterin / Leiter Instrumentierpflege OP');
    });

    it('filters out the spontaneous-application CTA (companyEid link)', () => {
      const rows = parseListing(LISTING_HTML);
      expect(rows.some((r) => r.url.includes('companyEid='))).toBe(false);
    });

    it('returns empty on empty/unrelated HTML', () => {
      expect(parseListing('')).toEqual([]);
    });
  });

  describe('splitCardText', () => {
    it('splits "ENTITY TITLE CATEGORY"', () => {
      expect(splitCardText('Spital Zollikerberg Dipl. Pflegefachperson HF Pflegeberufe')).toEqual({
        entity: 'Spital Zollikerberg',
        title: 'Dipl. Pflegefachperson HF',
        category: 'Pflegeberufe',
      });
    });
    it('tolerates missing entity and category', () => {
      expect(splitCardText('HR Fachperson 80%')).toEqual({
        entity: '',
        title: 'HR Fachperson 80%',
        category: '',
      });
    });
  });

  describe('buildDiakoniewerkDescription', () => {
    const row = { title: 'Dipl. Pflegefachperson HF', entity: 'Spital Zollikerberg', category: 'Pflegeberufe' };
    const loc = { city: 'Zollikerberg', postalCode: '8125' };

    it('uses the rendered pi-asp detail text as the description body', () => {
      const detailText = piAspDetailHtmlToDescription(DETAIL_CONTAINER_HTML);
      const desc = buildDiakoniewerkDescription(row, loc, detailText);
      expect(desc).toContain('Dipl. Pflegefachperson HF bei Spital Zollikerberg');
      expect(desc).toContain('Kategorie: Pflegeberufe.');
      // Structure must survive for the audit's hasStructuredContent (#3836).
      expect(desc.split('\n').filter((l) => l.startsWith('• ')).length).toBeGreaterThanOrEqual(8);
      expect(desc).toContain('Ihr Profil');
      // The synthetic stub's closing boilerplate must NOT appear.
      expect(desc).not.toContain('Bewerbung über das PI-ASP-Karriereportal');
    });

    it('falls back to the synthetic stub when the detail render failed', () => {
      const desc = buildDiakoniewerkDescription(row, loc, '');
      expect(desc).toContain('Bewerbung über das PI-ASP-Karriereportal von Stiftung Diakoniewerk Neumünster.');
      expect(desc).toContain(`(${DIAKONIEWERK_COMPANY_NAME})`);
    });

    it('defaults the entity when the card had none', () => {
      const desc = buildDiakoniewerkDescription({ title: 'HR Fachperson', entity: '', category: '' }, loc, '');
      expect(desc).toContain('HR Fachperson bei Gesundheitswelt Zollikerberg');
    });
  });

  describe('isDiakoniewerkJob / isTrustedDomain', () => {
    it('matches by companyKey and by pi-asp URL', () => {
      expect(isDiakoniewerkJob({ companyKey: DIAKONIEWERK_KEY })).toBe(true);
      expect(isDiakoniewerkJob({ url: 'https://stiftdia.pi-asp.de/bewerber-web?company=1-FIRMA-ID' })).toBe(true);
    });
    it('rejects unrelated jobs and domains', () => {
      expect(isDiakoniewerkJob({ companyKey: 'usz', url: 'https://jobs.usz.ch/x' })).toBe(false);
      expect(isTrustedDomain('https://evil.example.com/')).toBe(false);
    });
    it('trusts the pi-asp ATS and the cluster career sites', () => {
      expect(isTrustedDomain('https://stiftdia.pi-asp.de/bewerber-web')).toBe(true);
      expect(isTrustedDomain('https://gesundheitswelt-zollikerberg.ch/de/jobs-karriere/offene-stellen')).toBe(true);
      expect(isTrustedDomain('https://www.diakoniewerk-neumuenster.ch/karriere')).toBe(true);
    });
  });
});
