/**
 * Tests for the Helvetia Assicurazioni crawler parser.
 *
 * Tests parseHelvetiaListingHtml(), parseHelvetiaDetailHtml(),
 * slugify(), stripHtml(), inferEmploymentType()
 * using HTML fixtures from the Helvetia careers portal.
 */
import { describe, it, expect } from 'vitest';
import {
  parseHelvetiaListingHtml,
  parseHelvetiaDetailHtml,
  slugify,
  stripHtml,
  inferEmploymentType,
} from '@/scripts/lib/helvetia-job-parser.mjs';

// ── Fixtures ────────────────────────────────────────────────────

const LISTING_HTML_FIXTURE = `
<div class="job-list">
  <div class="vacancy-card">
    <a class="vacancy-link" href="/ch/job/consulente-assicurativo-lugano/55001">
      Consulente assicurativo
    </a>
    <span class="location">Lugano</span>
    <span class="department">Consulenza</span>
  </div>

  <div class="vacancy-card">
    <a class="vacancy-link" href="/ch/job/underwriter-ticino/55002">
      Underwriter
    </a>
    <span class="location">Bellinzona</span>
    <span class="department">Underwriting</span>
  </div>

  <div class="vacancy-card">
    <a class="vacancy-link" href="/ch/job/it-business-analyst/55003">
      IT Business Analyst, 80-100%
    </a>
    <span class="location">Lugano</span>
    <span class="department">IT</span>
  </div>
</div>
`;

const DETAIL_HTML_FIXTURE = `
<div class="job-description">
  <h2>Consulente assicurativo</h2>
  <p>Helvetia Assicurazioni cerca un Consulente assicurativo per la sede di Lugano.
     Il ruolo prevede la consulenza e la vendita di prodotti assicurativi a clienti
     privati e aziendali nella regione Ticino.</p>
  <h3>Il tuo profilo</h3>
  <ul>
    <li>Formazione commerciale o equivalente</li>
    <li>Esperienza nel settore assicurativo</li>
    <li>Madrelingua italiana, buona conoscenza del tedesco</li>
  </ul>
  <h3>Cosa offriamo</h3>
  <ul>
    <li>Formazione continua e certificazioni</li>
    <li>Condizioni di lavoro flessibili</li>
  </ul>
</div>
`;

// ── Tests ────────────────────────────────────────────────────────

describe('Helvetia crawler — listing HTML parsing', () => {
  it('extracts jobs from listing HTML', () => {
    const jobs = parseHelvetiaListingHtml(LISTING_HTML_FIXTURE);
    expect(jobs.length).toBe(3);
  });

  it('extracts correct job titles', () => {
    const jobs = parseHelvetiaListingHtml(LISTING_HTML_FIXTURE);
    const titles = jobs.map((j) => j.title);
    expect(titles).toContain('Consulente assicurativo');
    expect(titles).toContain('Underwriter');
    expect(titles).toContain('IT Business Analyst, 80-100%');
  });

  it('builds correct URLs', () => {
    const jobs = parseHelvetiaListingHtml(LISTING_HTML_FIXTURE);
    expect(jobs[0].url).toContain('helvetia.com');
    expect(jobs[0].url).toContain('55001');
  });

  it('extracts job IDs from URL', () => {
    const jobs = parseHelvetiaListingHtml(LISTING_HTML_FIXTURE);
    expect(jobs[0].jobId).toBe('55001');
    expect(jobs[1].jobId).toBe('55002');
    expect(jobs[2].jobId).toBe('55003');
  });

  it('deduplicates by jobId', () => {
    const doubledHtml = LISTING_HTML_FIXTURE + LISTING_HTML_FIXTURE;
    const jobs = parseHelvetiaListingHtml(doubledHtml);
    expect(jobs.length).toBe(3);
  });

  it('returns empty array for empty input', () => {
    expect(parseHelvetiaListingHtml('')).toHaveLength(0);
    expect(parseHelvetiaListingHtml(null as any)).toHaveLength(0);
  });

  it('sets canton to TI', () => {
    const jobs = parseHelvetiaListingHtml(LISTING_HTML_FIXTURE);
    jobs.forEach((j) => expect(j.canton).toBe('TI'));
  });
});

describe('Helvetia crawler — detail page parsing', () => {
  it('extracts description from detail page', () => {
    const result = parseHelvetiaDetailHtml(DETAIL_HTML_FIXTURE);
    expect(result).not.toBeNull();
    expect(result!.description).toContain('Consulente assicurativo');
    expect(result!.description).toContain('Lugano');
  });

  it('returns null for empty input', () => {
    expect(parseHelvetiaDetailHtml('')).toBeNull();
    expect(parseHelvetiaDetailHtml(null as any)).toBeNull();
  });
});

describe('Helvetia crawler — slugify', () => {
  it('generates correct slug', () => {
    expect(slugify('Consulente assicurativo Lugano')).toBe('consulente-assicurativo-lugano');
  });

  it('handles accented characters', () => {
    expect(slugify('Versicherungsberater für Zürich')).toBe('versicherungsberater-fur-zurich');
  });

  it('truncates long slugs to 180 chars', () => {
    const long = 'a'.repeat(200);
    expect(slugify(long).length).toBeLessThanOrEqual(180);
  });
});

describe('Helvetia crawler — stripHtml', () => {
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

describe('Helvetia crawler — inferEmploymentType', () => {
  it('returns FULL_TIME for 100%', () => {
    expect(inferEmploymentType('Consulente assicurativo 100%')).toBe('FULL_TIME');
  });

  it('returns FULL_TIME for 80-100%', () => {
    expect(inferEmploymentType('IT Business Analyst, 80-100%')).toBe('FULL_TIME');
  });

  it('returns PART_TIME for 60%', () => {
    expect(inferEmploymentType('Claims Handler 60%')).toBe('PART_TIME');
  });

  it('returns PART_TIME for temps partiel keyword', () => {
    expect(inferEmploymentType('Conseiller temps partiel')).toBe('PART_TIME');
  });

  it('defaults to FULL_TIME', () => {
    expect(inferEmploymentType('Underwriter')).toBe('FULL_TIME');
  });
});
