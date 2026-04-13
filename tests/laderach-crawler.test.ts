import { describe, it, expect } from 'vitest';
import {
  parseLaderachListingHtml,
  parseLaderachNextDataJobs,
  parseLaderachDetailHtml,
  extractNextData,
  slugify,
  stripHtml,
  inferEmploymentType,
} from '@/scripts/lib/laderach-job-parser.mjs';

// ── fixtures (matching real Softgarden Next.js page) ──────────────────

const SAMPLE_NEXT_DATA_JOBS = [
  {
    jobPostingId: 58614665,
    title: 'Lehrstelle im Detailhandel EFZ ab August 2026 (w/m/d)',
    link: 'https://laderach.career.softgarden.de/jobs/58614665/Lehrstelle-im-Detailhandel-EFZ-ab-August-2026-w-m-d-/',
    location: 'Zug',
    additionalLocations: [],
  },
  {
    jobPostingId: 62367409,
    title: 'Technical IT Architect',
    link: 'https://laderach.career.softgarden.de/jobs/62367409/Technical-IT-Architect/',
    location: 'Bilten',
    additionalLocations: [],
  },
  {
    jobPostingId: 63438569,
    title: 'Verkäufer 40-60% Chocolaterie Chur (w/m/d)',
    link: 'https://laderach.career.softgarden.de/jobs/63438569/Verk%C3%A4ufer-40-60%25-Chocolaterie-Chur-w-m-d-/',
    location: 'Chur',
    additionalLocations: [],
  },
];

const SAMPLE_LISTING_HTML = `
<html><body>
<main><h1>All job offers</h1><ul>
<li><a href="https://laderach.career.softgarden.de/jobs/58614665/Lehrstelle-im-Detailhandel-EFZ-ab-August-2026-w-m-d-/">Lehrstelle im Detailhandel EFZ ab August 2026 (w/m/d)</a><br/><small>Locations: <!-- -->Zug</small></li>
<li><a href="https://laderach.career.softgarden.de/jobs/62367409/Technical-IT-Architect/">Technical IT Architect</a><br/><small>Locations: <!-- -->Bilten</small></li>
<li><a href="https://laderach.career.softgarden.de/jobs/62367409/Technical-IT-Architect/">Technical IT Architect</a><br/><small>Locations: <!-- -->Bilten</small></li>
</ul></main>
<script id="__NEXT_DATA__" type="application/json">{"props":{"pageProps":{"jobs":[{"jobPostingId":58614665,"title":"Lehrstelle im Detailhandel EFZ ab August 2026 (w/m/d)","link":"https://laderach.career.softgarden.de/jobs/58614665/Lehrstelle-im-Detailhandel-EFZ-ab-August-2026-w-m-d-/","location":"Zug","additionalLocations":[]},{"jobPostingId":62367409,"title":"Technical IT Architect","link":"https://laderach.career.softgarden.de/jobs/62367409/Technical-IT-Architect/","location":"Bilten","additionalLocations":[]}]}}}</script>
</body></html>
`;

const SAMPLE_LISTING_HTML_NO_NEXT = `
<html><body>
<main><h1>All job offers</h1><ul>
<li><a href="https://laderach.career.softgarden.de/jobs/58614665/Lehrstelle/">Lehrstelle im Detailhandel EFZ ab August 2026 (w/m/d)</a><br/><small>Locations: <!-- -->Zug</small></li>
<li><a href="/jobs/62367409/Technical-IT-Architect/">Technical IT Architect</a><br/><small>Locations: <!-- -->Bilten</small></li>
</ul></main>
</body></html>
`;

const SAMPLE_DETAIL_HTML = `
<html lang="de"><head>
<script type="application/ld+json">{"@type":"JobPosting","title":"Technical IT Architect","@context":"http://schema.org/","datePosted":"2026-01-26T15:23:10.105+01:00","description":"<p>Hochwertige frische Schokolade – dafür steht die Schweizer Schokoladenmanufaktur Läderach. Das Familienunternehmen beschäftigt heute gruppenweit über 3000 Menschen.</p><b>Das erwartet dich</b><ul><li>Du entwickelst die technische Zielarchitektur für Plattformen und Cloud Integrationen</li></ul>","jobLocation":{"@type":"Place","address":{"@type":"PostalAddress","postalCode":"8865","addressRegion":"Glarus","streetAddress":"Grabenstrasse 6","addressCountry":"Schweiz","addressLocality":"Bilten"}},"employmentType":"FULL_TIME","hiringOrganization":{"name":"Läderach (Schweiz) AG","@type":"Organization"}}</script>
</head><body>
<script id="__NEXT_DATA__" type="application/json">{"props":{"pageProps":{"data":{"context":{"job":{"title":"Technical IT Architect","city":"Bilten","employmentType":"Feste Anstellung","workTime":"Vollzeit","jobPostingId":62367409}},"page":{}}}}}</script>
<main><div class="job-content"><p>Description content here for fallback testing purposes only.</p></div></main>
</body></html>
`;

const SAMPLE_DETAIL_HTML_MINIMAL = `
<html><body>
<main><p>Short</p></main>
</body></html>
`;

// ── tests ─────────────────────────────────────────────────────────────

describe('Läderach job parser', () => {
  describe('extractNextData', () => {
    it('extracts __NEXT_DATA__ JSON from HTML', () => {
      const data = extractNextData(SAMPLE_LISTING_HTML);
      expect(data).not.toBeNull();
      expect(data.props.pageProps.jobs).toHaveLength(2);
    });

    it('returns null for HTML without __NEXT_DATA__', () => {
      expect(extractNextData('<html><body></body></html>')).toBeNull();
    });

    it('returns null for invalid input', () => {
      expect(extractNextData(null)).toBeNull();
      expect(extractNextData('')).toBeNull();
    });
  });

  describe('parseLaderachNextDataJobs', () => {
    it('extracts jobs from __NEXT_DATA__ jobs array', () => {
      const jobs = parseLaderachNextDataJobs(SAMPLE_NEXT_DATA_JOBS);
      expect(jobs).toHaveLength(3);
      expect(jobs[0].title).toBe('Lehrstelle im Detailhandel EFZ ab August 2026 (w/m/d)');
      expect(jobs[0].location).toBe('Zug');
      expect(jobs[0].jobId).toBe('58614665');
      expect(jobs[0].url).toContain('58614665');
      expect(jobs[0].canton).toBe('ZG');
      expect(jobs[0].id).toBe(slugify(jobs[0].title));
    });

    it('deduplicates by URL', () => {
      const duped = [
        { jobPostingId: 1, title: 'Job A', link: 'https://example.com/jobs/1/A/', location: 'Zug' },
        { jobPostingId: 1, title: 'Job A', link: 'https://example.com/jobs/1/A/', location: 'Zug' },
      ];
      expect(parseLaderachNextDataJobs(duped)).toHaveLength(1);
    });

    it('returns empty for invalid input', () => {
      expect(parseLaderachNextDataJobs(null)).toEqual([]);
      expect(parseLaderachNextDataJobs([])).toEqual([]);
      expect(parseLaderachNextDataJobs('not an array')).toEqual([]);
    });
  });

  describe('parseLaderachListingHtml', () => {
    it('extracts jobs from __NEXT_DATA__ when present', () => {
      const jobs = parseLaderachListingHtml(SAMPLE_LISTING_HTML);
      expect(jobs).toHaveLength(2);
      expect(jobs[0].title).toBe('Lehrstelle im Detailhandel EFZ ab August 2026 (w/m/d)');
      expect(jobs[0].jobId).toBe('58614665');
      expect(jobs[1].title).toBe('Technical IT Architect');
    });

    it('falls back to HTML parsing without __NEXT_DATA__', () => {
      const jobs = parseLaderachListingHtml(SAMPLE_LISTING_HTML_NO_NEXT);
      expect(jobs.length).toBeGreaterThanOrEqual(2);
      expect(jobs[0].title).toContain('Lehrstelle');
      expect(jobs[0].url).toContain('/jobs/58614665');
      expect(jobs[0].location).toBe('Zug');
    });

    it('deduplicates by URL in fallback mode', () => {
      const jobs = parseLaderachListingHtml(SAMPLE_LISTING_HTML_NO_NEXT);
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
    it('extracts metadata from __NEXT_DATA__ and description from JSON-LD', () => {
      const result = parseLaderachDetailHtml(SAMPLE_DETAIL_HTML);
      expect(result).not.toBeNull();
      expect(result.title).toBe('Technical IT Architect');
      expect(result.location).toBe('Bilten');
      expect(result.employmentTypeRaw).toBe('Feste Anstellung');
      expect(result.workTime).toBe('Vollzeit');
      expect(result.description).toContain('Schokolade');
      expect(result.description).toContain('Zielarchitektur');
      expect(result.description.length).toBeGreaterThan(30);
    });

    it('returns null for empty/short content', () => {
      expect(parseLaderachDetailHtml(null)).toBeNull();
      expect(parseLaderachDetailHtml('')).toBeNull();
      expect(parseLaderachDetailHtml(SAMPLE_DETAIL_HTML_MINIMAL)).toBeNull();
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
