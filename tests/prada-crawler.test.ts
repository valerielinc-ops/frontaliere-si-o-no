/**
 * Tests for the Prada Group crawler parser.
 *
 * Tests parsePradaListingHtml(), parsePradaDetailHtml(),
 * slugify(), stripHtml(), inferEmploymentType()
 * using HTML fixtures from the Prada Group careers portal.
 */
import { describe, it, expect } from 'vitest';
import {
  parsePradaListingHtml,
  parsePradaDetailHtml,
  slugify,
  stripHtml,
  inferEmploymentType,
} from '@/scripts/lib/prada-job-parser.mjs';

// ── Fixtures ────────────────────────────────────────────────────

const LISTING_HTML_FIXTURE = `
<div class="job-list">
  <div class="job-card">
    <a class="job-title" href="/job/store-manager-mendrisio/88001">
      Store Manager
    </a>
    <span class="location">Mendrisio, Switzerland</span>
    <span class="department">Retail</span>
  </div>

  <div class="job-card">
    <a class="job-title" href="/job/visual-merchandiser-ticino/88002">
      Visual Merchandiser
    </a>
    <span class="location">Mendrisio, Svizzera</span>
    <span class="department">Visual Merchandising</span>
  </div>

  <div class="job-card">
    <a class="job-title" href="/job/logistics-coordinator/88003">
      Logistics Coordinator
    </a>
    <span class="location">Mendrisio, TI</span>
    <span class="department">Logistics</span>
  </div>
</div>
`;

const DETAIL_HTML_FIXTURE = `
<div class="job-description">
  <h2>Store Manager</h2>
  <p>Prada Group cerca uno Store Manager dinamico per il nostro outlet di Mendrisio.
     Il candidato ideale ha esperienza nel retail di lusso e capacità di leadership.</p>
  <h3>Responsabilità</h3>
  <ul>
    <li>Gestione del team di vendita</li>
    <li>Raggiungimento degli obiettivi di fatturato</li>
    <li>Mantenimento degli standard del brand</li>
  </ul>
  <h3>Requisiti</h3>
  <ul>
    <li>Esperienza minima di 3 anni nel retail di lusso</li>
    <li>Conoscenza fluente di italiano e inglese</li>
  </ul>
</div>
`;

// ── Tests ────────────────────────────────────────────────────────

describe('Prada Group crawler — listing HTML parsing', () => {
  it('extracts jobs from listing HTML', () => {
    const jobs = parsePradaListingHtml(LISTING_HTML_FIXTURE);
    expect(jobs.length).toBe(3);
  });

  it('extracts correct job titles', () => {
    const jobs = parsePradaListingHtml(LISTING_HTML_FIXTURE);
    const titles = jobs.map((j) => j.title);
    expect(titles).toContain('Store Manager');
    expect(titles).toContain('Visual Merchandiser');
    expect(titles).toContain('Logistics Coordinator');
  });

  it('builds correct URLs', () => {
    const jobs = parsePradaListingHtml(LISTING_HTML_FIXTURE);
    expect(jobs[0].url).toContain('pradagroup.com');
    expect(jobs[0].url).toContain('88001');
  });

  it('extracts job IDs from URL', () => {
    const jobs = parsePradaListingHtml(LISTING_HTML_FIXTURE);
    expect(jobs[0].jobId).toBe('88001');
    expect(jobs[1].jobId).toBe('88002');
    expect(jobs[2].jobId).toBe('88003');
  });

  it('deduplicates by jobId', () => {
    const doubledHtml = LISTING_HTML_FIXTURE + LISTING_HTML_FIXTURE;
    const jobs = parsePradaListingHtml(doubledHtml);
    expect(jobs.length).toBe(3);
  });

  it('returns empty array for empty input', () => {
    expect(parsePradaListingHtml('')).toHaveLength(0);
    expect(parsePradaListingHtml(null as any)).toHaveLength(0);
  });

  it('sets canton to TI', () => {
    const jobs = parsePradaListingHtml(LISTING_HTML_FIXTURE);
    jobs.forEach((j) => expect(j.canton).toBe('TI'));
  });
});

describe('Prada Group crawler — detail page parsing', () => {
  it('extracts description from detail page', () => {
    const result = parsePradaDetailHtml(DETAIL_HTML_FIXTURE);
    expect(result).not.toBeNull();
    expect(result!.description).toContain('Store Manager');
    expect(result!.description).toContain('Mendrisio');
  });

  it('returns null for empty input', () => {
    expect(parsePradaDetailHtml('')).toBeNull();
    expect(parsePradaDetailHtml(null as any)).toBeNull();
  });
});

describe('Prada Group crawler — slugify', () => {
  it('generates correct slug', () => {
    expect(slugify('Store Manager Mendrisio')).toBe('store-manager-mendrisio');
  });

  it('handles accented characters', () => {
    expect(slugify('Coordinatore Logística à Mendrisio')).toBe('coordinatore-logistica-a-mendrisio');
  });

  it('truncates long slugs to 180 chars', () => {
    const long = 'a'.repeat(200);
    expect(slugify(long).length).toBeLessThanOrEqual(180);
  });
});

describe('Prada Group crawler — stripHtml', () => {
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

describe('Prada Group crawler — inferEmploymentType', () => {
  it('returns FULL_TIME for 100%', () => {
    expect(inferEmploymentType('Store Manager 100%')).toBe('FULL_TIME');
  });

  it('returns PART_TIME for 50%', () => {
    expect(inferEmploymentType('Sales Associate 50%')).toBe('PART_TIME');
  });

  it('returns PART_TIME for tempo parziale', () => {
    expect(inferEmploymentType('Addetto vendite tempo parziale')).toBe('PART_TIME');
  });

  it('defaults to FULL_TIME', () => {
    expect(inferEmploymentType('Visual Merchandiser')).toBe('FULL_TIME');
  });
});
