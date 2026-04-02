import { describe, it, expect } from 'vitest';
import {
  parseDavosKlostersBergbahnenListingHtml,
  parseDavosKlostersBergbahnenDetailHtml,
  slugify,
  stripHtml,
  inferEmploymentType,
} from '@/scripts/lib/davos-klosters-bergbahnen-job-parser.mjs';

// ── fixtures ──────────────────────────────────────────────────────────

const SAMPLE_LISTING_HTML = `
<html><body>
<div class="jobs">
  <a href="/de/bergbahnen/jobs/bergbahnmechaniker">Bergbahnmechaniker (m/w/d)</a>
  <span class="standort">Davos</span>
  <a href="/de/bergbahnen/jobs/pistenfahrzeugfuehrer">Pistenfahrzeugführer 100%</a>
  <span class="standort">Davos</span>
  <a href="/de/bergbahnen/jobs/chef-de-partie">Chef de Partie (Saison)</a>
  <span class="standort">Klosters</span>
  <a href="/de/bergbahnen/jobs/bergbahnmechaniker">Bergbahnmechaniker (m/w/d)</a>
  <a href="/de/bergbahnen/jobs/">Alle Stellen</a>
</div>
</body></html>
`;

const SAMPLE_DETAIL_HTML = `
<html><body>
<article>
  <h1>Bergbahnmechaniker (m/w/d)</h1>
  <p>Die Davos Klosters Bergbahnen AG sucht einen erfahrenen Bergbahnmechaniker für die Wartung
  und Instandhaltung unserer Seilbahnanlagen. Sie sind verantwortlich für die mechanische Wartung,
  Fehlerdiagnose und Reparatur aller Bergbahnanlagen im Skigebiet Davos Klosters.</p>
</article>
</body></html>
`;

// ── tests ─────────────────────────────────────────────────────────────

describe('Davos Klosters Bergbahnen job parser', () => {
  describe('parseDavosKlostersBergbahnenListingHtml', () => {
    it('extracts job links from HTML', () => {
      const jobs = parseDavosKlostersBergbahnenListingHtml(SAMPLE_LISTING_HTML);
      expect(jobs.length).toBeGreaterThanOrEqual(3);
      expect(jobs[0].title).toBe('Bergbahnmechaniker (m/w/d)');
      expect(jobs[0].url).toContain('/jobs/bergbahnmechaniker');
    });

    it('deduplicates by URL', () => {
      const jobs = parseDavosKlostersBergbahnenListingHtml(SAMPLE_LISTING_HTML);
      const urls = jobs.map((j) => j.url);
      expect(new Set(urls).size).toBe(urls.length);
    });

    it('extracts location from context', () => {
      const jobs = parseDavosKlostersBergbahnenListingHtml(SAMPLE_LISTING_HTML);
      const klostersJob = jobs.find((j) => j.title.includes('Chef de Partie'));
      if (klostersJob) {
        expect(klostersJob.location).toBe('Klosters');
      }
    });

    it('sets canton to GR', () => {
      const jobs = parseDavosKlostersBergbahnenListingHtml(SAMPLE_LISTING_HTML);
      for (const job of jobs) {
        expect(job.canton).toBe('GR');
      }
    });

    it('returns empty for null/empty input', () => {
      expect(parseDavosKlostersBergbahnenListingHtml(null)).toEqual([]);
      expect(parseDavosKlostersBergbahnenListingHtml('')).toEqual([]);
      expect(parseDavosKlostersBergbahnenListingHtml(undefined)).toEqual([]);
    });
  });

  describe('parseDavosKlostersBergbahnenDetailHtml', () => {
    it('extracts description from detail page', () => {
      const result = parseDavosKlostersBergbahnenDetailHtml(SAMPLE_DETAIL_HTML);
      expect(result).not.toBeNull();
      expect(result.description).toContain('Bergbahnmechaniker');
      expect(result.description).toContain('Davos Klosters');
      expect(result.description.length).toBeGreaterThan(30);
    });

    it('returns null for empty/short content', () => {
      expect(parseDavosKlostersBergbahnenDetailHtml(null)).toBeNull();
      expect(parseDavosKlostersBergbahnenDetailHtml('')).toBeNull();
      expect(parseDavosKlostersBergbahnenDetailHtml('<html><body><p>X</p></body></html>')).toBeNull();
    });
  });

  describe('slugify', () => {
    it('generates clean slugs', () => {
      expect(slugify('Bergbahnmechaniker (m/w/d)')).toBe('bergbahnmechaniker-m-w-d');
    });

    it('strips umlauts', () => {
      expect(slugify('Pistenfahrzeugführer')).toBe('pistenfahrzeugfuhrer');
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
      expect(stripHtml('<p>Hallo <b>Davos</b></p>')).toBe('Hallo Davos');
    });

    it('decodes entities', () => {
      expect(stripHtml('&amp; &lt; &gt; &quot; &apos;')).toBe("& < > \" '");
    });

    it('handles empty input', () => {
      expect(stripHtml('')).toBe('');
      expect(stripHtml(null)).toBe('');
    });
  });

  describe('inferEmploymentType', () => {
    it('detects full-time by default', () => {
      expect(inferEmploymentType('Bergbahnmechaniker', 'Festanstellung')).toBe('FULL_TIME');
    });

    it('detects seasonal/temporary', () => {
      expect(inferEmploymentType('Chef de Partie (Saison)', '')).toBe('TEMPORARY');
    });

    it('detects part-time from percentage', () => {
      expect(inferEmploymentType('Mitarbeiter 50%', '')).toBe('PART_TIME');
    });

    it('detects part-time from keyword', () => {
      expect(inferEmploymentType('Teilzeit Kassierer', '')).toBe('PART_TIME');
    });

    it('detects full-time from 100%', () => {
      expect(inferEmploymentType('Pistenfahrzeugführer 100%', '')).toBe('FULL_TIME');
    });
  });
});
