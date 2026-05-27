/**
 * Tests for the Rapelli (ORIOR Food AG) crawler parser.
 *
 * Tests parseRapelliListingHtml(), slugify(), stripHtml()
 * using HTML fixtures from the ORIOR SuccessFactors careers portal.
 */
import { describe, it, expect } from 'vitest';
import {
  parseRapelliListingHtml,
  parseRapelliDetailHtml,
  slugify,
  stripHtml,
} from '@/scripts/lib/rapelli-job-parser.mjs';

// ── Fixtures ────────────────────────────────────────────────────

const LISTING_HTML_FIXTURE = `
<div class="job-list">
  <a class="jobTitle-link" href="/job/Stabio-Maintenance-Technician%2C-100-TI/1375847133/">
    Maintenance Technician, 100%
  </a>
  <span class="company">Rapelli - ORIOR Food AG</span>
  <span class="location">Stabio, TI</span>
  <span class="department">Tecnologia</span>

  <a class="jobTitle-link" href="/job/Stabio-Tecnologo-Alimentare%2C-100-TI/1375846933/">
    Tecnologo Alimentare, 100%
  </a>
  <span class="company">Rapelli - ORIOR Food AG</span>
  <span class="location">Stabio, TI</span>
  <span class="department">Ricerca e sviluppo</span>

  <a class="jobTitle-link" href="/job/Stabio-Operatore-di-Produzione%2C-100-TI/1375846833/">
    Operatore di Produzione, 100%
  </a>
  <span class="company">Rapelli - ORIOR Food AG</span>
  <span class="location">Stabio, TI</span>
  <span class="department">Produzione</span>
</div>
`;

const DETAIL_HTML_FIXTURE = `
<div class="job-description">
  <h2>Maintenance Technician, 100%</h2>
  <p>Rapelli - ORIOR Food AG cerca un tecnico di manutenzione per lo stabilimento di Stabio.</p>
  <h3>Requisiti</h3>
  <ul>
    <li>Formazione tecnica completata (AFC o equivalente)</li>
    <li>Esperienza in ambiente industriale alimentare</li>
    <li>Conoscenza della lingua italiana</li>
  </ul>
  <h3>Offriamo</h3>
  <ul>
    <li>Ambiente di lavoro dinamico</li>
    <li>Formazione continua</li>
  </ul>
</div>
`;

// ── Tests ────────────────────────────────────────────────────────

describe('Rapelli crawler — listing HTML parsing', () => {
  it('extracts jobs from listing HTML', () => {
    const jobs = parseRapelliListingHtml(LISTING_HTML_FIXTURE);
    expect(jobs.length).toBe(3);
  });

  it('extracts correct job titles', () => {
    const jobs = parseRapelliListingHtml(LISTING_HTML_FIXTURE);
    const titles = jobs.map((j) => j.title);
    expect(titles).toContain('Maintenance Technician, 100%');
    expect(titles).toContain('Tecnologo Alimentare, 100%');
    expect(titles).toContain('Operatore di Produzione, 100%');
  });

  it('builds correct URLs', () => {
    const jobs = parseRapelliListingHtml(LISTING_HTML_FIXTURE);
    expect(jobs[0].url).toContain('careers.orior.ch/job/');
    expect(jobs[0].url).toContain('1375847133');
  });

  it('extracts job IDs from URL', () => {
    const jobs = parseRapelliListingHtml(LISTING_HTML_FIXTURE);
    expect(jobs[0].jobId).toBe('1375847133');
    expect(jobs[1].jobId).toBe('1375846933');
  });

  it('deduplicates by jobId', () => {
    const doubledHtml = LISTING_HTML_FIXTURE + LISTING_HTML_FIXTURE;
    const jobs = parseRapelliListingHtml(doubledHtml);
    expect(jobs.length).toBe(3);
  });

  it('returns empty array for empty input', () => {
    expect(parseRapelliListingHtml('')).toHaveLength(0);
    expect(parseRapelliListingHtml(null as any)).toHaveLength(0);
  });

  it('sets canton to TI', () => {
    const jobs = parseRapelliListingHtml(LISTING_HTML_FIXTURE);
    jobs.forEach((j) => expect(j.canton).toBe('TI'));
  });
});

describe('Rapelli crawler — detail page parsing', () => {
  it('extracts description from detail page', () => {
    const result = parseRapelliDetailHtml(DETAIL_HTML_FIXTURE);
    expect(result).not.toBeNull();
    expect(result!.description).toContain('tecnico di manutenzione');
  });

  it('returns null for empty input', () => {
    expect(parseRapelliDetailHtml('')).toBeNull();
    expect(parseRapelliDetailHtml(null as any)).toBeNull();
  });
});

describe('Rapelli crawler — slugify', () => {
  it('generates correct slug', () => {
    expect(slugify('Maintenance Technician, 100%')).toBe('maintenance-technician-100');
  });

  it('handles accented characters', () => {
    expect(slugify('Tecnologo Alimentare à Stabio')).toBe('tecnologo-alimentare-a-stabio');
  });

  it('truncates long slugs to 180 chars', () => {
    const long = 'a'.repeat(200);
    expect(slugify(long).length).toBeLessThanOrEqual(180);
  });
});

describe('Rapelli crawler — stripHtml', () => {
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
