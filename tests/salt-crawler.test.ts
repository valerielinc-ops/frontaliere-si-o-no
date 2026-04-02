/**
 * Tests for the Salt Mobile SA crawler parser.
 *
 * Tests parseSaltListingHtml(), parseSaltDetailHtml(),
 * slugify(), stripHtml(), inferEmploymentType()
 * using HTML fixtures from the Salt careers page.
 */
import { describe, it, expect } from 'vitest';
import {
  parseSaltListingHtml,
  parseSaltDetailHtml,
  slugify,
  stripHtml,
  inferEmploymentType,
} from '@/scripts/lib/salt-job-parser.mjs';

// ── Fixtures ────────────────────────────────────────────────────

const LISTING_HTML_FIXTURE = `
<div class="careers-list">
  <div class="job-item">
    <a class="job-link" href="https://www.salt.ch/it/careers/job/sales-advisor-lugano/7701">
      Sales Advisor
    </a>
    <span class="location">Lugano</span>
    <span class="department">Sales</span>
  </div>

  <div class="job-item">
    <a class="job-link" href="https://www.salt.ch/it/careers/job/network-engineer/7702">
      Network Engineer
    </a>
    <span class="location">Zürich</span>
    <span class="department">Network</span>
  </div>

  <div class="job-item">
    <a class="job-link" href="https://www.salt.ch/it/careers/job/customer-service-representative/7703">
      Customer Service Representative, 80-100%
    </a>
    <span class="location">Lugano</span>
    <span class="department">Customer Service</span>
  </div>
</div>
`;

const DETAIL_HTML_FIXTURE = `
<div class="job-description">
  <h2>Sales Advisor</h2>
  <p>Salt Mobile SA cerca un Sales Advisor entusiasta per il nostro negozio di Lugano.
     Il candidato sarà responsabile della consulenza ai clienti e della vendita di prodotti
     e servizi di telecomunicazione.</p>
  <h3>Il tuo profilo</h3>
  <ul>
    <li>Esperienza nella vendita al dettaglio</li>
    <li>Ottima conoscenza della lingua italiana</li>
    <li>Passione per la tecnologia</li>
  </ul>
  <h3>Ti offriamo</h3>
  <ul>
    <li>Formazione completa sui prodotti</li>
    <li>Ambiente giovane e dinamico</li>
  </ul>
</div>
`;

// ── Tests ────────────────────────────────────────────────────────

describe('Salt Mobile crawler — listing HTML parsing', () => {
  it('extracts jobs from listing HTML', () => {
    const jobs = parseSaltListingHtml(LISTING_HTML_FIXTURE);
    expect(jobs.length).toBe(3);
  });

  it('extracts correct job titles', () => {
    const jobs = parseSaltListingHtml(LISTING_HTML_FIXTURE);
    const titles = jobs.map((j) => j.title);
    expect(titles).toContain('Sales Advisor');
    expect(titles).toContain('Network Engineer');
    expect(titles).toContain('Customer Service Representative, 80-100%');
  });

  it('builds correct URLs', () => {
    const jobs = parseSaltListingHtml(LISTING_HTML_FIXTURE);
    expect(jobs[0].url).toContain('salt.ch');
    expect(jobs[0].url).toContain('7701');
  });

  it('extracts job IDs from URL', () => {
    const jobs = parseSaltListingHtml(LISTING_HTML_FIXTURE);
    expect(jobs[0].jobId).toBe('7701');
    expect(jobs[1].jobId).toBe('7702');
    expect(jobs[2].jobId).toBe('7703');
  });

  it('deduplicates by jobId', () => {
    const doubledHtml = LISTING_HTML_FIXTURE + LISTING_HTML_FIXTURE;
    const jobs = parseSaltListingHtml(doubledHtml);
    expect(jobs.length).toBe(3);
  });

  it('returns empty array for empty input', () => {
    expect(parseSaltListingHtml('')).toHaveLength(0);
    expect(parseSaltListingHtml(null as any)).toHaveLength(0);
  });

  it('sets canton to TI', () => {
    const jobs = parseSaltListingHtml(LISTING_HTML_FIXTURE);
    jobs.forEach((j) => expect(j.canton).toBe('TI'));
  });
});

describe('Salt Mobile crawler — detail page parsing', () => {
  it('extracts description from detail page', () => {
    const result = parseSaltDetailHtml(DETAIL_HTML_FIXTURE);
    expect(result).not.toBeNull();
    expect(result!.description).toContain('Sales Advisor');
    expect(result!.description).toContain('telecomunicazione');
  });

  it('returns null for empty input', () => {
    expect(parseSaltDetailHtml('')).toBeNull();
    expect(parseSaltDetailHtml(null as any)).toBeNull();
  });
});

describe('Salt Mobile crawler — slugify', () => {
  it('generates correct slug', () => {
    expect(slugify('Sales Advisor Lugano')).toBe('sales-advisor-lugano');
  });

  it('handles accented characters', () => {
    expect(slugify('Représentant Service Clientèle')).toBe('representant-service-clientele');
  });

  it('truncates long slugs to 180 chars', () => {
    const long = 'a'.repeat(200);
    expect(slugify(long).length).toBeLessThanOrEqual(180);
  });
});

describe('Salt Mobile crawler — stripHtml', () => {
  it('removes HTML tags', () => {
    expect(stripHtml('<p>Hello <b>world</b></p>')).not.toMatch(/<[a-z]/i);
  });

  it('decodes HTML entities', () => {
    expect(stripHtml('AT&amp;T')).toContain('AT&T');
  });

  it('returns empty string for empty input', () => {
    expect(stripHtml('')).toBe('');
  });
});

describe('Salt Mobile crawler — inferEmploymentType', () => {
  it('returns FULL_TIME for 100%', () => {
    expect(inferEmploymentType('Sales Advisor 100%')).toBe('FULL_TIME');
  });

  it('returns FULL_TIME for 80-100%', () => {
    expect(inferEmploymentType('Customer Service Representative, 80-100%')).toBe('FULL_TIME');
  });

  it('returns PART_TIME for 50%', () => {
    expect(inferEmploymentType('Receptionist 50%')).toBe('PART_TIME');
  });

  it('returns PART_TIME for Teilzeit keyword', () => {
    expect(inferEmploymentType('Berater Teilzeit')).toBe('PART_TIME');
  });

  it('defaults to FULL_TIME', () => {
    expect(inferEmploymentType('Network Engineer')).toBe('FULL_TIME');
  });
});
