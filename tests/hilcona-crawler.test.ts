import { describe, it, expect } from 'vitest';
import {
  parseHilconaListingHtml,
  parseHilconaDetailHtml,
  slugify,
  stripHtml,
  inferEmploymentType,
} from '@/scripts/lib/hilcona-job-parser.mjs';

// ── fixtures ──────────────────────────────────────────────────────────

const SAMPLE_LISTING_HTML = `
<html><body>
<div class="job-listing">
  <a href="/en/job/5001">Produktionsmitarbeiter (m/w/d)</a>
  <span class="location">Landquart</span>
  <a href="/en/job/5002">Qualitätsprüfer 80-100%</a>
  <span class="location">Landquart</span>
  <a href="/en/job/5003">Logistiker</a>
  <span class="standort">Schaan</span>
  <a href="/en/job/5001">Produktionsmitarbeiter (m/w/d)</a>
</div>
</body></html>
`;

const SAMPLE_DETAIL_HTML = `
<html><body>
<div class="job-description">
  <h1>Produktionsmitarbeiter (m/w/d)</h1>
  <p>Hilcona AG in Landquart sucht einen engagierten Produktionsmitarbeiter für die Herstellung
  von frischen Convenience-Produkten. Sie arbeiten im Schichtbetrieb und sind verantwortlich für
  die Bedienung von Produktionsanlagen. Gute Deutschkenntnisse werden vorausgesetzt.</p>
</div>
</body></html>
`;

// ── tests ─────────────────────────────────────────────────────────────

describe('Hilcona job parser', () => {
  describe('parseHilconaListingHtml', () => {
    it('extracts job links from HTML', () => {
      const jobs = parseHilconaListingHtml(SAMPLE_LISTING_HTML);
      expect(jobs.length).toBeGreaterThanOrEqual(3);
      expect(jobs[0].title).toBe('Produktionsmitarbeiter (m/w/d)');
      expect(jobs[0].url).toContain('/en/job/5001');
      expect(jobs[0].jobId).toBe('5001');
    });

    it('deduplicates by URL', () => {
      const jobs = parseHilconaListingHtml(SAMPLE_LISTING_HTML);
      const urls = jobs.map((j) => j.url);
      expect(new Set(urls).size).toBe(urls.length);
    });

    it('sets canton to GR', () => {
      const jobs = parseHilconaListingHtml(SAMPLE_LISTING_HTML);
      for (const job of jobs) {
        expect(job.canton).toBe('GR');
      }
    });

    it('returns empty for null/empty input', () => {
      expect(parseHilconaListingHtml(null)).toEqual([]);
      expect(parseHilconaListingHtml('')).toEqual([]);
      expect(parseHilconaListingHtml(undefined)).toEqual([]);
    });
  });

  describe('parseHilconaDetailHtml', () => {
    it('extracts description from detail page', () => {
      const result = parseHilconaDetailHtml(SAMPLE_DETAIL_HTML);
      expect(result).not.toBeNull();
      expect(result.description).toContain('Produktionsmitarbeiter');
      expect(result.description).toContain('Hilcona');
      expect(result.description.length).toBeGreaterThan(30);
    });

    it('returns null for empty/short content', () => {
      expect(parseHilconaDetailHtml(null)).toBeNull();
      expect(parseHilconaDetailHtml('')).toBeNull();
      expect(parseHilconaDetailHtml('<html><body>X</body></html>')).toBeNull();
    });
  });

  describe('slugify', () => {
    it('generates clean slugs', () => {
      expect(slugify('Produktionsmitarbeiter (m/w/d)')).toBe('produktionsmitarbeiter-m-w-d');
    });

    it('strips umlauts', () => {
      expect(slugify('Qualitätsprüfer')).toBe('qualitatsprufer');
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
    it('removes tags and decodes entities', () => {
      expect(stripHtml('<p>Hallo &amp; Welt</p>')).toBe('Hallo & Welt');
    });

    it('handles scripts and styles', () => {
      expect(stripHtml('<script>alert("x")</script>Text')).toBe('Text');
      expect(stripHtml('<style>.a{}</style>Text')).toBe('Text');
    });

    it('handles empty input', () => {
      expect(stripHtml('')).toBe('');
      expect(stripHtml(null)).toBe('');
    });
  });

  describe('inferEmploymentType', () => {
    it('detects full-time by default', () => {
      expect(inferEmploymentType('Logistiker', 'Vollzeit')).toBe('FULL_TIME');
    });

    it('detects part-time from percentage', () => {
      expect(inferEmploymentType('Qualitätsprüfer 60%', '')).toBe('PART_TIME');
    });

    it('detects part-time from keyword', () => {
      expect(inferEmploymentType('Teilzeit Mitarbeiter', '')).toBe('PART_TIME');
    });

    it('detects full-time from high range', () => {
      expect(inferEmploymentType('Mitarbeiter 80-100%', '')).toBe('FULL_TIME');
    });
  });
});
