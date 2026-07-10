import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  SPITAL_ZOLLIKERBERG_KEY,
  SPITAL_ZOLLIKERBERG_COMPANY_NAME,
  JOB_PORTAL_ID,
  isSpitalZollikerbergJob,
  isTrustedDomain,
  parseListing,
  buildSpitalZollikerbergDescription,
} from '../scripts/lib/spital-zollikerberg-job-parser.mjs';
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

describe('Spital Zollikerberg crawler parser', () => {
  describe('parseListing', () => {
    it('extracts one row per pi-asp card scoped to the Spital job portal', () => {
      const rows = parseListing(LISTING_HTML);
      expect(rows.length).toBe(3);
      expect(rows[0].title).toContain('Leiterin / Leiter Instrumentierpflege OP');
      expect(rows[0].url).toContain('stiftdia.pi-asp.de/bewerber-web');
      expect(rows[0].url).toContain(`jobportalid=${JOB_PORTAL_ID}`);
    });

    it('keeps the stable pi-asp position UUID as jobId source', () => {
      const rows = parseListing(LISTING_HTML);
      expect(rows[0].jobId).toBeTruthy();
      // Same fixture → same id: parse twice and compare.
      expect(parseListing(LISTING_HTML)[0].jobId).toBe(rows[0].jobId);
    });

    it('filters out the spontaneous-application CTA (companyEid link, no jobportalid)', () => {
      const rows = parseListing(LISTING_HTML);
      expect(rows.some((r) => r.url.includes('companyEid='))).toBe(false);
    });

    it('returns empty on empty/unrelated HTML', () => {
      expect(parseListing('')).toEqual([]);
      expect(parseListing('<div><a href="https://example.com">x</a></div>')).toEqual([]);
    });
  });

  describe('buildSpitalZollikerbergDescription', () => {
    const row = { title: 'Dipl. Pflegefachfrau HF', category: 'Pflegeberufe' };

    it('uses the rendered pi-asp detail text as the description body', () => {
      const detailText = piAspDetailHtmlToDescription(DETAIL_CONTAINER_HTML);
      const desc = buildSpitalZollikerbergDescription(row, detailText);
      expect(desc).toContain(`Dipl. Pflegefachfrau HF — ${SPITAL_ZOLLIKERBERG_COMPANY_NAME}, Zollikerberg (ZH).`);
      expect(desc).toContain('Bereich: Pflegeberufe.');
      // The real ad's structure must survive: bullet lines for the
      // parser-quality audit's hasStructuredContent check (#3836).
      expect(desc.split('\n').filter((l) => l.startsWith('• ')).length).toBeGreaterThanOrEqual(8);
      expect(desc).toContain('Ihre Aufgaben');
      // The synthetic stub's closing boilerplate must NOT appear.
      expect(desc).not.toContain('Vollständige Stellenbeschreibung und Bewerbung über die externe');
    });

    it('falls back to the synthetic stub when the detail render failed', () => {
      const desc = buildSpitalZollikerbergDescription(row, '');
      expect(desc).toContain('Das Spital Zollikerberg ist ein Akutspital');
      expect(desc).toContain('Vollständige Stellenbeschreibung');
    });
  });

  describe('isSpitalZollikerbergJob', () => {
    it('matches by companyKey', () => {
      expect(isSpitalZollikerbergJob({ companyKey: SPITAL_ZOLLIKERBERG_KEY })).toBe(true);
    });
    it('matches pi-asp URLs carrying the Spital job portal id', () => {
      expect(
        isSpitalZollikerbergJob({
          url: `https://stiftdia.pi-asp.de/bewerber-web?company=1-FIRMA-ID#position,id=x,jobportalid=${JOB_PORTAL_ID}`,
        }),
      ).toBe(true);
    });
    it('rejects unrelated jobs', () => {
      expect(isSpitalZollikerbergJob({ companyKey: 'usz', url: 'https://jobs.usz.ch/x' })).toBe(false);
    });
  });

  describe('isTrustedDomain', () => {
    it('trusts the career site and the pi-asp ATS host', () => {
      expect(isTrustedDomain('https://gesundheitswelt-zollikerberg.ch/de/jobs-karriere/offene-stellen')).toBe(true);
      expect(isTrustedDomain('https://stiftdia.pi-asp.de/bewerber-web?x=1')).toBe(true);
    });
    it('rejects other domains', () => {
      expect(isTrustedDomain('https://evil.example.com/')).toBe(false);
    });
  });
});
