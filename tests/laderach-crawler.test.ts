import { describe, it, expect } from 'vitest';
import {
  parseLaderachApiResponse,
  parseLaderachListingHtml,
  parseLaderachDetailHtml,
  slugify,
  stripHtml,
  inferEmploymentType,
} from '@/scripts/lib/laderach-job-parser.mjs';

// ── fixtures ──────────────────────────────────────────────────────────

const SAMPLE_API_JSON = {
  results: [
    {
      id: '12345',
      title: 'Chocolatier (m/w/d)',
      geoCity: 'Ennenda',
      channelUrl: '/job/12345',
      jobCategory: 'Production',
    },
    {
      id: '12346',
      title: 'Sales Associate 80-100%',
      geoCity: 'Zürich',
      channelUrl: '/job/12346',
      jobCategory: 'Retail',
    },
    {
      id: '12347',
      title: 'Logistiker',
      geoCity: 'Ennenda',
      channelUrl: '/job/12347',
      jobCategory: 'Logistics',
    },
  ],
};

const SAMPLE_LISTING_HTML = `
<html><body>
<div class="job-list">
  <a href="/job/101">Produktionsmitarbeiter</a>
  <span class="location">Ennenda</span>
  <a href="/job/102">Confiseur/in EFZ</a>
  <span class="location">Bilten</span>
  <a href="/job/101">Produktionsmitarbeiter</a>
</div>
</body></html>
`;

const SAMPLE_DETAIL_HTML = `
<html><body>
<div class="job-description">
  <h2>Chocolatier (m/w/d)</h2>
  <p>Wir suchen einen erfahrenen Chocolatier für unsere Produktionsstätte in Ennenda.
  Du bist verantwortlich für die Herstellung von Premium-Schokoladenprodukten und arbeitest
  in einem dynamischen Team. Erfahrung in der Schokoladenherstellung ist von Vorteil.</p>
</div>
</body></html>
`;

// ── tests ─────────────────────────────────────────────────────────────

describe('Läderach job parser', () => {
  describe('parseLaderachApiResponse', () => {
    it('extracts jobs from Softgarden JSON', () => {
      const jobs = parseLaderachApiResponse(SAMPLE_API_JSON);
      expect(jobs).toHaveLength(3);
      expect(jobs[0].title).toBe('Chocolatier (m/w/d)');
      expect(jobs[0].location).toBe('Ennenda');
      expect(jobs[0].canton).toBe('GR');
      expect(jobs[0].jobId).toBe('12345');
    });

    it('deduplicates by URL', () => {
      const duped = {
        results: [
          { id: '1', title: 'Job A', channelUrl: '/job/1', geoCity: 'A' },
          { id: '1', title: 'Job A', channelUrl: '/job/1', geoCity: 'A' },
        ],
      };
      expect(parseLaderachApiResponse(duped)).toHaveLength(1);
    });

    it('returns empty for null/invalid input', () => {
      expect(parseLaderachApiResponse(null)).toEqual([]);
      expect(parseLaderachApiResponse(undefined)).toEqual([]);
      expect(parseLaderachApiResponse({})).toEqual([]);
      expect(parseLaderachApiResponse('')).toEqual([]);
    });
  });

  describe('parseLaderachListingHtml', () => {
    it('extracts job links from HTML', () => {
      const jobs = parseLaderachListingHtml(SAMPLE_LISTING_HTML);
      expect(jobs.length).toBeGreaterThanOrEqual(2);
      expect(jobs[0].title).toBe('Produktionsmitarbeiter');
      expect(jobs[0].url).toContain('/job/101');
    });

    it('deduplicates by URL', () => {
      const jobs = parseLaderachListingHtml(SAMPLE_LISTING_HTML);
      const urls = jobs.map((j) => j.url);
      expect(new Set(urls).size).toBe(urls.length);
    });

    it('returns empty for null/empty input', () => {
      expect(parseLaderachListingHtml(null)).toEqual([]);
      expect(parseLaderachListingHtml('')).toEqual([]);
      expect(parseLaderachListingHtml(undefined)).toEqual([]);
    });
  });

  describe('parseLaderachDetailHtml', () => {
    it('extracts description from detail page', () => {
      const result = parseLaderachDetailHtml(SAMPLE_DETAIL_HTML);
      expect(result).not.toBeNull();
      expect(result.description).toContain('Chocolatier');
      expect(result.description.length).toBeGreaterThan(30);
    });

    it('returns null for empty/short content', () => {
      expect(parseLaderachDetailHtml(null)).toBeNull();
      expect(parseLaderachDetailHtml('')).toBeNull();
      expect(parseLaderachDetailHtml('<html><body><p>Short</p></body></html>')).toBeNull();
    });
  });

  describe('slugify', () => {
    it('generates clean slugs', () => {
      expect(slugify('Chocolatier (m/w/d)')).toBe('chocolatier-m-w-d');
    });

    it('strips accents', () => {
      expect(slugify('Confiseur/Confiseuse Läderach')).toBe('confiseur-confiseuse-laderach');
    });

    it('truncates to 180 chars', () => {
      const long = 'a'.repeat(200);
      expect(slugify(long).length).toBeLessThanOrEqual(180);
    });

    it('handles empty input', () => {
      expect(slugify('')).toBe('');
      expect(slugify(null)).toBe('');
      expect(slugify(undefined)).toBe('');
    });
  });

  describe('stripHtml', () => {
    it('removes tags', () => {
      expect(stripHtml('<p>Hello <b>world</b></p>')).toBe('Hello world');
    });

    it('decodes entities', () => {
      expect(stripHtml('&amp; &lt; &gt; &quot;')).toBe('& < > "');
    });

    it('handles empty input', () => {
      expect(stripHtml('')).toBe('');
      expect(stripHtml(null)).toBe('');
      expect(stripHtml(undefined)).toBe('');
    });
  });

  describe('inferEmploymentType', () => {
    it('detects full-time', () => {
      expect(inferEmploymentType('Chocolatier', 'Vollzeit Stelle')).toBe('FULL_TIME');
    });

    it('detects part-time from percentage', () => {
      expect(inferEmploymentType('Sales Associate 60%', '')).toBe('PART_TIME');
    });

    it('detects part-time from keyword', () => {
      expect(inferEmploymentType('Teilzeit Verkäufer', '')).toBe('PART_TIME');
    });

    it('detects full-time from high percentage', () => {
      expect(inferEmploymentType('Logistiker 80-100%', '')).toBe('FULL_TIME');
    });
  });
});
