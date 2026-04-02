/**
 * Tests for the Pini Group SA crawler parser.
 *
 * Tests parsePiniGroupListingHtml(), parsePiniGroupDetailHtml(),
 * slugify(), stripHtml(), inferEmploymentType()
 * using HTML fixtures from the Pini Group careers portal.
 */
import { describe, it, expect } from 'vitest';
import {
  parsePiniGroupListingHtml,
  parsePiniGroupDetailHtml,
  slugify,
  stripHtml,
  inferEmploymentType,
} from '@/scripts/lib/pini-group-job-parser.mjs';

// ── Fixtures ────────────────────────────────────────────────────

const LISTING_HTML_FIXTURE = `
<div class="job-list">
  <div class="job-card">
    <a class="job-link" href="/job/view-job.php?id=4501&lang=it">
      Project Manager Tunnel
    </a>
    <span class="location">Lugano, TI</span>
    <span class="department">Engineering</span>
  </div>

  <div class="job-card">
    <a class="job-link" href="/job/view-job.php?id=4502&lang=it">
      Ingegnere Strutturista
    </a>
    <span class="location">Lugano, TI</span>
    <span class="department">Structural</span>
  </div>

  <div class="job-card">
    <a class="job-link" href="/job/view-job.php?id=4503&lang=it">
      BIM Coordinator, 80-100%
    </a>
    <span class="location">Lugano, TI</span>
    <span class="department">BIM</span>
  </div>
</div>
`;

const DETAIL_HTML_FIXTURE = `
<div class="job-description">
  <h2>Project Manager Tunnel</h2>
  <p>Pini Group SA cerca un Project Manager esperto per la gestione di progetti infrastrutturali
     nel settore tunnel e opere sotterranee. La posizione è basata a Lugano.</p>
  <h3>Requisiti</h3>
  <ul>
    <li>Laurea in ingegneria civile o equivalente</li>
    <li>Esperienza minima di 5 anni nella gestione di progetti tunnel</li>
    <li>Conoscenza di italiano e inglese</li>
  </ul>
  <h3>Offriamo</h3>
  <ul>
    <li>Ambiente di lavoro internazionale</li>
    <li>Progetti di grande rilevanza</li>
  </ul>
</div>
`;

// ── Tests ────────────────────────────────────────────────────────

describe('Pini Group crawler — listing HTML parsing', () => {
  it('extracts jobs from listing HTML', () => {
    const jobs = parsePiniGroupListingHtml(LISTING_HTML_FIXTURE);
    expect(jobs.length).toBe(3);
  });

  it('extracts correct job titles', () => {
    const jobs = parsePiniGroupListingHtml(LISTING_HTML_FIXTURE);
    const titles = jobs.map((j) => j.title);
    expect(titles).toContain('Project Manager Tunnel');
    expect(titles).toContain('Ingegnere Strutturista');
    expect(titles).toContain('BIM Coordinator, 80-100%');
  });

  it('builds correct URLs', () => {
    const jobs = parsePiniGroupListingHtml(LISTING_HTML_FIXTURE);
    expect(jobs[0].url).toContain('pini.group');
    expect(jobs[0].url).toContain('4501');
  });

  it('extracts job IDs from URL', () => {
    const jobs = parsePiniGroupListingHtml(LISTING_HTML_FIXTURE);
    expect(jobs[0].jobId).toBe('4501');
    expect(jobs[1].jobId).toBe('4502');
    expect(jobs[2].jobId).toBe('4503');
  });

  it('deduplicates by jobId', () => {
    const doubledHtml = LISTING_HTML_FIXTURE + LISTING_HTML_FIXTURE;
    const jobs = parsePiniGroupListingHtml(doubledHtml);
    expect(jobs.length).toBe(3);
  });

  it('returns empty array for empty input', () => {
    expect(parsePiniGroupListingHtml('')).toHaveLength(0);
    expect(parsePiniGroupListingHtml(null as any)).toHaveLength(0);
  });

  it('sets canton to TI', () => {
    const jobs = parsePiniGroupListingHtml(LISTING_HTML_FIXTURE);
    jobs.forEach((j) => expect(j.canton).toBe('TI'));
  });
});

describe('Pini Group crawler — detail page parsing', () => {
  it('extracts description from detail page', () => {
    const result = parsePiniGroupDetailHtml(DETAIL_HTML_FIXTURE);
    expect(result).not.toBeNull();
    expect(result!.description).toContain('Project Manager');
    expect(result!.description).toContain('tunnel');
  });

  it('returns null for empty input', () => {
    expect(parsePiniGroupDetailHtml('')).toBeNull();
    expect(parsePiniGroupDetailHtml(null as any)).toBeNull();
  });
});

describe('Pini Group crawler — slugify', () => {
  it('generates correct slug', () => {
    expect(slugify('Project Manager Tunnel')).toBe('project-manager-tunnel');
  });

  it('handles accented characters', () => {
    expect(slugify('Ingegnere Strutturista à Lugano')).toBe('ingegnere-strutturista-a-lugano');
  });

  it('truncates long slugs to 180 chars', () => {
    const long = 'a'.repeat(200);
    expect(slugify(long).length).toBeLessThanOrEqual(180);
  });
});

describe('Pini Group crawler — stripHtml', () => {
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

describe('Pini Group crawler — inferEmploymentType', () => {
  it('returns FULL_TIME for 100%', () => {
    expect(inferEmploymentType('Project Manager 100%')).toBe('FULL_TIME');
  });

  it('returns FULL_TIME for 80-100%', () => {
    expect(inferEmploymentType('BIM Coordinator, 80-100%')).toBe('FULL_TIME');
  });

  it('returns PART_TIME for 60%', () => {
    expect(inferEmploymentType('Assistant 60%')).toBe('PART_TIME');
  });

  it('returns PART_TIME for part-time keyword', () => {
    expect(inferEmploymentType('Engineer part-time')).toBe('PART_TIME');
  });

  it('defaults to FULL_TIME', () => {
    expect(inferEmploymentType('Senior Engineer')).toBe('FULL_TIME');
  });
});
