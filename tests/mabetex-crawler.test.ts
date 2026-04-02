/**
 * Tests for the Mabetex Group crawler parser.
 *
 * Tests parseMabetexListingHtml(), parseMabetexDetailHtml(),
 * slugify(), stripHtml(), and inferEmploymentType()
 * using HTML fixtures mimicking the Mabetex corporate website.
 */
import { describe, it, expect } from 'vitest';
import {
  parseMabetexListingHtml,
  parseMabetexDetailHtml,
  slugify,
  stripHtml,
  inferEmploymentType,
} from '@/scripts/lib/mabetex-job-parser.mjs';

// ── Fixtures ────────────────────────────────────────────────────

const LISTING_HTML_FIXTURE = `
<div class="careers-list">
  <a class="career-item" href="/career/site-manager-lugano/">
    Site Manager
  </a>
  <span class="location">Lugano</span>

  <a class="career-item" href="/career/project-engineer-lugano/">
    Project Engineer
  </a>
  <span class="location">Lugano</span>

  <a class="career-item" href="/career/quantity-surveyor-pristina/">
    Quantity Surveyor
  </a>
  <span class="location">Pristina</span>
</div>
`;

const DETAIL_HTML_FIXTURE = `
<html>
<body>
<article>
  <h1>Site Manager</h1>
  <p>Mabetex Group cerca un Site Manager esperto per il coordinamento di cantieri internazionali con base a Lugano.</p>
  <h3>Requisiti</h3>
  <ul>
    <li>Laurea in ingegneria civile o architettura</li>
    <li>Minimo 5 anni di esperienza in gestione cantieri</li>
    <li>Conoscenza della lingua italiana e inglese</li>
    <li>Disponibilità a trasferte internazionali</li>
  </ul>
  <h3>Offriamo</h3>
  <ul>
    <li>Ambiente di lavoro internazionale</li>
    <li>Progetti di alto profilo</li>
    <li>Retribuzione competitiva</li>
  </ul>
</article>
</body>
</html>
`;

// ── Tests ────────────────────────────────────────────────────────

describe('Mabetex crawler — listing HTML parsing', () => {
  it('extracts jobs from listing HTML', () => {
    const jobs = parseMabetexListingHtml(LISTING_HTML_FIXTURE);
    expect(jobs.length).toBe(3);
  });

  it('extracts correct job titles', () => {
    const jobs = parseMabetexListingHtml(LISTING_HTML_FIXTURE);
    const titles = jobs.map((j) => j.title);
    expect(titles).toContain('Site Manager');
    expect(titles).toContain('Project Engineer');
    expect(titles).toContain('Quantity Surveyor');
  });

  it('builds correct URLs', () => {
    const jobs = parseMabetexListingHtml(LISTING_HTML_FIXTURE);
    expect(jobs[0].url).toContain('mabetex.com/career/');
    expect(jobs[0].url).toContain('site-manager-lugano');
  });

  it('deduplicates by URL', () => {
    const doubledHtml = LISTING_HTML_FIXTURE + LISTING_HTML_FIXTURE;
    const jobs = parseMabetexListingHtml(doubledHtml);
    expect(jobs.length).toBe(3);
  });

  it('returns empty array for empty input', () => {
    expect(parseMabetexListingHtml('')).toHaveLength(0);
    expect(parseMabetexListingHtml(null as any)).toHaveLength(0);
  });

  it('skips the main /career/ page itself', () => {
    const html = '<a href="/career/">Careers Overview</a>';
    const jobs = parseMabetexListingHtml(html);
    expect(jobs).toHaveLength(0);
  });
});

describe('Mabetex crawler — detail page parsing', () => {
  it('extracts description from detail page', () => {
    const result = parseMabetexDetailHtml(DETAIL_HTML_FIXTURE);
    expect(result).not.toBeNull();
    expect(result!.description).toContain('Site Manager');
    expect(result!.description).toContain('cantieri internazionali');
  });

  it('extracts requirements text', () => {
    const result = parseMabetexDetailHtml(DETAIL_HTML_FIXTURE);
    expect(result!.description).toContain('ingegneria civile');
  });

  it('returns null for empty input', () => {
    expect(parseMabetexDetailHtml('')).toBeNull();
    expect(parseMabetexDetailHtml(null as any)).toBeNull();
  });
});

describe('Mabetex crawler — slugify', () => {
  it('generates correct slug', () => {
    expect(slugify('Site Manager Lugano')).toBe('site-manager-lugano');
  });

  it('handles accented characters', () => {
    expect(slugify('Ingénieur Génie Civil à Lugano')).toBe('ingenieur-genie-civil-a-lugano');
  });

  it('truncates long slugs to 180 chars', () => {
    const long = 'a'.repeat(200);
    expect(slugify(long).length).toBeLessThanOrEqual(180);
  });
});

describe('Mabetex crawler — stripHtml', () => {
  it('removes HTML tags', () => {
    expect(stripHtml('<p>Hello <b>world</b></p>')).not.toMatch(/<[a-z]/i);
  });

  it('decodes HTML entities', () => {
    expect(stripHtml('AT&amp;T')).toContain('AT&T');
  });

  it('removes script tags and content', () => {
    expect(stripHtml('<script>alert("x")</script>Hello')).toBe('Hello');
  });

  it('returns empty string for empty input', () => {
    expect(stripHtml('')).toBe('');
  });
});

describe('Mabetex crawler — inferEmploymentType', () => {
  it('detects full-time from 100%', () => {
    expect(inferEmploymentType('Site Manager 100%')).toBe('FULL_TIME');
  });

  it('detects part-time from low percentage', () => {
    expect(inferEmploymentType('Assistant 50-60%')).toBe('PART_TIME');
  });

  it('detects part-time from keyword', () => {
    expect(inferEmploymentType('Part-time Coordinator')).toBe('PART_TIME');
  });

  it('defaults to FULL_TIME', () => {
    expect(inferEmploymentType('Site Manager')).toBe('FULL_TIME');
  });
});
