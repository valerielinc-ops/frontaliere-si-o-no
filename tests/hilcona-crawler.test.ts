import { describe, it, expect } from 'vitest';
import {
  parseHilconaSitemapXml,
  parseHilconaDetailHtml,
  slugify,
  stripHtml,
  inferEmploymentType,
} from '@/scripts/lib/hilcona-job-parser.mjs';

// ── sitemap fixtures ──────────────────────────────────────────────────

const SAMPLE_SITEMAP_XML = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
    <loc>https://career.bellfoodgroup.com/de/stelle/lehrling-mechatronik-m-w-d-2175</loc>
    <lastmod>2026-03-18T08:00:21+00:00</lastmod>
    <changefreq>daily</changefreq>
    <priority>1.0</priority>
  </url>
  <url>
    <loc>https://career.bellfoodgroup.com/fr/emploi/apprenti-mecatronicien-h-f-2175</loc>
    <lastmod>2026-03-18T08:00:21+00:00</lastmod>
    <changefreq>daily</changefreq>
    <priority>1.0</priority>
  </url>
  <url>
    <loc>https://career.bellfoodgroup.com/en/job/apprentice-mechatronics-m-f-d-2175</loc>
    <lastmod>2026-03-18T08:00:21+00:00</lastmod>
    <changefreq>daily</changefreq>
    <priority>1.0</priority>
  </url>
  <url>
    <loc>https://career.bellfoodgroup.com/de/stelle/produktionsmitarbeiter-m-w-d-2180</loc>
    <lastmod>2026-03-25T09:00:18+00:00</lastmod>
    <changefreq>daily</changefreq>
    <priority>1.0</priority>
  </url>
  <url>
    <loc>https://career.bellfoodgroup.com/fr/emploi/employe-de-production-h-f-2180</loc>
    <lastmod>2026-03-25T09:00:18+00:00</lastmod>
    <changefreq>daily</changefreq>
    <priority>1.0</priority>
  </url>
  <url>
    <loc>https://career.bellfoodgroup.com/en/job/production-employee-m-f-d-2180</loc>
    <lastmod>2026-03-25T09:00:18+00:00</lastmod>
    <changefreq>daily</changefreq>
    <priority>1.0</priority>
  </url>
  <url>
    <loc>https://career.bellfoodgroup.com/de/stelle/betriebselektriker-m-w-d-2253</loc>
    <lastmod>2026-02-26T10:00:17+00:00</lastmod>
    <changefreq>daily</changefreq>
    <priority>1.0</priority>
  </url>
</urlset>`;

// ── detail page fixture ───────────────────────────────────────────────

const SAMPLE_DETAIL_HTML = `<!DOCTYPE html>
<html lang="de">
<head>
  <meta charset="utf-8">
  <meta name="description" content="Du bist begeistert von Technik und möchtest mehr über die Verbindung von Mechanik lernen?" />
  <title>Starte deine Karriere bei Bell Food Group</title>
</head>
<body>
<main class="flex-grow mt-20">
  <div id="job-details">
    <div class="container">
      <div class="flex flex-col-reverse bg-white md:flex-row rounded-lg" id="overview">
        <div class="m-auto w-full px-8">
          <div class="flex flex-col-reverse md:flex-row">
            <div class="w-full md:w-9/12">
              <h1 class="text-2xl sm:h1 h1-job-theme">Lehrling Mechatronik (m/w/d)</h1>
            </div>
            <div class="flex w-full justify-center pt-8">
              <img src="/static/career/images/brand-logos/hilcona.svg" alt="Logo Hilcona" class="h-auto w-40">
            </div>
          </div>
          <p class="lead">Du bist begeistert von Technik und möchtest mehr über die Verbindung von Mechanik, Elektronik und Informatik lernen? Dann starte deine Ausbildung als Lehrling in Mechatronik bei uns!</p>

          <div class="flex flex-col gap-4 text-lg">
            <div class="order-1 border-t pt-3">
              <div class="font-bold">Vertragsart</div>
              <p class="mb-0 text-job-theme">Unbefristet</p>
            </div>
            <div class="order-2 border-t pt-3">
              <div class="font-bold">Pensum</div>
              <p class="mb-0 text-job-theme">100%</p>
            </div>
            <div class="order-4 border-t pt-3">
              <p class="mb-0 font-bold text-job-theme">Hilcona AG</p>
              <p class="mb-2 text-job-theme">
                Bendererstrasse 21<br>
                9494 Schaan
              </p>
            </div>
            <div class="order-5 border-t pt-3">
              <div class="font-bold">Sprache</div>
              <p class="mb-0 text-job-theme">Deutsch</p>
            </div>
          </div>
        </div>
      </div>
    </div>

    <div id="task_experience">
      <div class="container">
        <div class="grid grid-cols-1 md:grid-cols-2">
          <div class="w-ful wysiwyg wysiwyg-job-theme">
            <h3 class="text-job-theme">Deine Aufgaben</h3>
            <ul><li>Wartung und Instandhaltung von Produktionsanlagen</li><li>Fehlersuche und Reparatur mechanischer und elektrischer Systeme</li></ul>
          </div>
          <div class="w-full wysiwyg wysiwyg-job-theme">
            <h3 class="text-job-theme">Das bringst du mit</h3>
            <ul><li>Interesse an Technik und Mechanik</li><li>Gute Deutschkenntnisse</li></ul>
          </div>
        </div>
      </div>
    </div>
  </div>
</main>
</body>
</html>`;

const MINIMAL_DETAIL_HTML = `<html><body>
<h1 class="h1-job-theme">Sachbearbeiter Reklamation (m/w/d)</h1>
<p class="lead">Wir suchen einen erfahrenen Sachbearbeiter für unser Reklamationsmanagement im Bereich Lebensmittelproduktion.</p>
<p class="mb-0 font-bold text-job-theme">Bell Schweiz AG</p>
<p class="mb-2 text-job-theme">Industriestrasse 10<br>4147 Aesch</p>
<div class="font-bold">Vertragsart</div>
<p class="mb-0 text-job-theme">Befristet</p>
<div class="font-bold">Pensum</div>
<p class="mb-0 text-job-theme">80-100%</p>
</body></html>`;

// ── tests ─────────────────────────────────────────────────────────────

describe('Hilcona job parser', () => {
  describe('parseHilconaSitemapXml', () => {
    it('extracts only German /de/stelle/ URLs', () => {
      const jobs = parseHilconaSitemapXml(SAMPLE_SITEMAP_XML);
      expect(jobs.length).toBe(3);
      for (const job of jobs) {
        expect(job.url).toContain('/de/stelle/');
      }
    });

    it('extracts numeric job ID from URL', () => {
      const jobs = parseHilconaSitemapXml(SAMPLE_SITEMAP_XML);
      expect(jobs[0].jobId).toBe('2175');
      expect(jobs[1].jobId).toBe('2180');
      expect(jobs[2].jobId).toBe('2253');
    });

    it('generates prettified title from slug', () => {
      const jobs = parseHilconaSitemapXml(SAMPLE_SITEMAP_XML);
      expect(jobs[0].title).toBe('Lehrling Mechatronik M W D');
      expect(jobs[1].title).toBe('Produktionsmitarbeiter M W D');
    });

    it('sets id to full slug including numeric ID', () => {
      const jobs = parseHilconaSitemapXml(SAMPLE_SITEMAP_XML);
      expect(jobs[0].id).toBe('lehrling-mechatronik-m-w-d-2175');
    });

    it('sets full URL', () => {
      const jobs = parseHilconaSitemapXml(SAMPLE_SITEMAP_XML);
      expect(jobs[0].url).toBe('https://career.bellfoodgroup.com/de/stelle/lehrling-mechatronik-m-w-d-2175');
    });

    it('deduplicates identical URLs', () => {
      const dupeXml = `<urlset>
        <url><loc>https://career.bellfoodgroup.com/de/stelle/test-job-100</loc></url>
        <url><loc>https://career.bellfoodgroup.com/de/stelle/test-job-100</loc></url>
      </urlset>`;
      const jobs = parseHilconaSitemapXml(dupeXml);
      expect(jobs.length).toBe(1);
    });

    it('returns empty for null/empty input', () => {
      expect(parseHilconaSitemapXml(null)).toEqual([]);
      expect(parseHilconaSitemapXml('')).toEqual([]);
      expect(parseHilconaSitemapXml(undefined)).toEqual([]);
    });

    it('returns empty for XML with no German URLs', () => {
      const frOnly = `<urlset>
        <url><loc>https://career.bellfoodgroup.com/fr/emploi/test-job-100</loc></url>
        <url><loc>https://career.bellfoodgroup.com/en/job/test-job-100</loc></url>
      </urlset>`;
      expect(parseHilconaSitemapXml(frOnly)).toEqual([]);
    });
  });

  describe('parseHilconaDetailHtml', () => {
    it('extracts title from h1', () => {
      const result = parseHilconaDetailHtml(SAMPLE_DETAIL_HTML);
      expect(result).not.toBeNull();
      expect(result.title).toBe('Lehrling Mechatronik (m/w/d)');
    });

    it('builds description from lead + tasks + requirements', () => {
      const result = parseHilconaDetailHtml(SAMPLE_DETAIL_HTML);
      expect(result.description).toContain('begeistert von Technik');
      expect(result.description).toContain('Aufgaben:');
      expect(result.description).toContain('Wartung');
      expect(result.description).toContain('Anforderungen:');
      expect(result.description).toContain('Interesse an Technik');
      expect(result.description.length).toBeGreaterThan(30);
    });

    it('extracts company name', () => {
      const result = parseHilconaDetailHtml(SAMPLE_DETAIL_HTML);
      expect(result.company).toBe('Hilcona AG');
    });

    it('extracts location from address', () => {
      const result = parseHilconaDetailHtml(SAMPLE_DETAIL_HTML);
      expect(result.location).toBe('Schaan');
    });

    it('extracts contract type', () => {
      const result = parseHilconaDetailHtml(SAMPLE_DETAIL_HTML);
      expect(result.contractType).toBe('Unbefristet');
    });

    it('extracts pensum', () => {
      const result = parseHilconaDetailHtml(SAMPLE_DETAIL_HTML);
      expect(result.pensum).toBe('100%');
    });

    it('extracts language', () => {
      const result = parseHilconaDetailHtml(SAMPLE_DETAIL_HTML);
      expect(result.language).toBe('Deutsch');
    });

    it('works with minimal HTML structure', () => {
      const result = parseHilconaDetailHtml(MINIMAL_DETAIL_HTML);
      expect(result).not.toBeNull();
      expect(result.title).toBe('Sachbearbeiter Reklamation (m/w/d)');
      expect(result.company).toBe('Bell Schweiz AG');
      expect(result.location).toBe('Aesch');
      expect(result.description).toContain('Reklamationsmanagement');
    });

    it('falls back to meta description when content is short', () => {
      const shortHtml = `<html>
        <meta name="description" content="Eine spannende Stelle bei Bell Food Group im Bereich Produktion und Logistik.">
        <body><h1>Test Job</h1></body>
      </html>`;
      const result = parseHilconaDetailHtml(shortHtml);
      expect(result).not.toBeNull();
      expect(result.description).toContain('Bell Food Group');
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
