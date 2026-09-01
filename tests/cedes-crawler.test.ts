import { describe, it, expect, vi } from 'vitest';
import {
  fetchCedesDetailPage,
  parseCedesListingHtml,
  parseCedesDetailHtml,
  normalizeCedesJobUrl,
  slugify,
  stripHtml,
  inferEmploymentType,
} from '@/scripts/lib/cedes-job-parser.mjs';

// ── fixtures ──────────────────────────────────────────────────────────

const SAMPLE_LISTING_HTML = `
<html><body>
<div class="jobs-list">
  <a href="/en/career/jobs/entwicklungsingenieur">Entwicklungsingenieur (m/w/d)</a>
  <span class="standort">Landquart</span>
  <a href="/en/career/jobs/elektroniker">Elektroniker EFZ</a>
  <span class="standort">Landquart</span>
  <a href="/en/career/jobs/konstrukteur">Konstrukteur 80-100%</a>
  <span class="standort">Landquart</span>
  <a href="/en/career/jobs/entwicklungsingenieur">Entwicklungsingenieur (m/w/d)</a>
  <a href="/en/career/jobs/">Back to all jobs</a>
</div>
</body></html>
`;

const SAMPLE_DETAIL_HTML = `
<html><body>
<article>
  <h1>Entwicklungsingenieur (m/w/d)</h1>
  <p>CEDES AG in Landquart sucht einen erfahrenen Entwicklungsingenieur für die Entwicklung
  innovativer Sensorlösungen. Sie arbeiten in einem internationalen Team und sind verantwortlich
  für die Konzeption und Umsetzung neuer Produkte im Bereich der optischen Sensortechnologie.</p>
</article>
</body></html>
`;

// ── tests ─────────────────────────────────────────────────────────────

describe('CEDES job parser', () => {
  describe('normalizeCedesJobUrl', () => {
    it('allows only relative or same-origin HTTPS CEDES job routes', () => {
      expect(normalizeCedesJobUrl('/en/career/jobs/embedded-engineer/'))
        .toBe('https://www.cedes.com/en/career/jobs/embedded-engineer/');
      expect(normalizeCedesJobUrl('https://www.cedes.com/en/openings/123'))
        .toBe('https://www.cedes.com/en/openings/123');
      expect(normalizeCedesJobUrl('https://attacker.example/en/career/jobs/embedded-engineer/')).toBeNull();
      expect(normalizeCedesJobUrl('http://www.cedes.com/en/career/jobs/embedded-engineer/')).toBeNull();
      expect(normalizeCedesJobUrl('https://www.cedes.com/en/news/embedded-engineer/')).toBeNull();
    });

    it('fails closed before fetch for an unsafe detail URL', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch');
      try {
        await expect(fetchCedesDetailPage('https://attacker.example/en/career/jobs/embedded-engineer/'))
          .resolves.toBeNull();
        expect(fetchSpy).not.toHaveBeenCalled();
      } finally {
        fetchSpy.mockRestore();
      }
    });
  });

  describe('parseCedesListingHtml', () => {
    it('extracts job links from HTML', () => {
      const jobs = parseCedesListingHtml(SAMPLE_LISTING_HTML);
      expect(jobs.length).toBeGreaterThanOrEqual(3);
      expect(jobs[0].title).toBe('Entwicklungsingenieur (m/w/d)');
      expect(jobs[0].url).toContain('/career/jobs/entwicklungsingenieur');
      expect(jobs[0].jobId).toBe('entwicklungsingenieur');
    });

    it('skips listing page URL itself', () => {
      const jobs = parseCedesListingHtml(SAMPLE_LISTING_HTML);
      const urls = jobs.map((j) => j.url);
      expect(urls.some((u) => u.endsWith('/career/jobs/'))).toBe(false);
    });

    it('deduplicates by URL', () => {
      const jobs = parseCedesListingHtml(SAMPLE_LISTING_HTML);
      const urls = jobs.map((j) => j.url);
      expect(new Set(urls).size).toBe(urls.length);
    });

    it("keeps an apostrophe inside a double-quoted job href", () => {
      const [job] = parseCedesListingHtml(
        `<a href="/en/career/jobs/chef-d'equipe">Chef d'équipe</a>`,
      );
      expect(job.url).toBe("https://www.cedes.com/en/career/jobs/chef-d'equipe");
    });

    it('preserves the generic fallback class substring matching', () => {
      const [job] = parseCedesListingHtml(
        '<a class="jobs-listing-link" href="/en/openings/123">Embedded Software Engineer</a>',
      );
      expect(job.url).toBe('https://www.cedes.com/en/openings/123');
      expect(job.title).toBe('Embedded Software Engineer');
    });

    it('matches career URL paths case-insensitively', () => {
      const [job] = parseCedesListingHtml(
        '<a href="/EN/CAREER/JOBS/Embedded-Engineer">Embedded Software Engineer</a>',
      );
      expect(job.url).toBe('https://www.cedes.com/EN/CAREER/JOBS/Embedded-Engineer');
    });

    it('sets canton to GR', () => {
      const jobs = parseCedesListingHtml(SAMPLE_LISTING_HTML);
      for (const job of jobs) {
        expect(job.canton).toBe('GR');
      }
    });

    it('returns empty for null/empty input', () => {
      expect(parseCedesListingHtml(null)).toEqual([]);
      expect(parseCedesListingHtml('')).toEqual([]);
      expect(parseCedesListingHtml(undefined)).toEqual([]);
    });
  });

  describe('parseCedesDetailHtml', () => {
    it('extracts description from detail page', () => {
      const result = parseCedesDetailHtml(SAMPLE_DETAIL_HTML);
      expect(result).not.toBeNull();
      expect(result.description).toContain('Entwicklungsingenieur');
      expect(result.description).toContain('CEDES');
      expect(result.description.length).toBeGreaterThan(30);
    });

    it('returns null for empty/short content', () => {
      expect(parseCedesDetailHtml(null)).toBeNull();
      expect(parseCedesDetailHtml('')).toBeNull();
      expect(parseCedesDetailHtml('<html><body><p>Hi</p></body></html>')).toBeNull();
    });
  });

  describe('slugify', () => {
    it('generates clean slugs', () => {
      expect(slugify('Entwicklungsingenieur (m/w/d)')).toBe('entwicklungsingenieur-m-w-d');
    });

    it('strips umlauts', () => {
      expect(slugify('Bürokauffrau/Bürokaufmann')).toBe('burokauffrau-burokaufmann');
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
      expect(stripHtml('&amp; &lt; &gt;')).toBe('& < >');
    });

    it('removes scripts', () => {
      expect(stripHtml('<script>var x=1;</script>Content')).toBe('Content');
    });

    it('handles empty input', () => {
      expect(stripHtml('')).toBe('');
      expect(stripHtml(null)).toBe('');
    });
  });

  describe('inferEmploymentType', () => {
    it('detects full-time by default', () => {
      expect(inferEmploymentType('Entwicklungsingenieur', 'Festanstellung')).toBe('FULL_TIME');
    });

    it('detects part-time from percentage', () => {
      expect(inferEmploymentType('Konstrukteur 60%', '')).toBe('PART_TIME');
    });

    it('detects part-time from keyword', () => {
      expect(inferEmploymentType('Teilzeit Elektroniker', '')).toBe('PART_TIME');
    });

    it('detects full-time from range', () => {
      expect(inferEmploymentType('Konstrukteur 80-100%', '')).toBe('FULL_TIME');
    });
  });
});
