/**
 * Città di Lugano crawler parser tests
 *
 * Tests parseListingPage(), parseDetailPage(), buildJob(),
 * parseSwissDate(), stripHtml(), normalizeSpace().
 */
import { describe, it, expect } from 'vitest';

import {
  parseListingPage,
  parseDetailPage,
  buildJob,
  parseSwissDate,
  stripHtml,
  normalizeSpace,
} from '@/scripts/lib/citta-di-lugano-job-parser.mjs';

// ─── Fixture: Concorsi pubblici listing page ───────────────
const LISTING_HTML = `
<html>
<body>
<main>
  <h1>Concorsi pubblici e posti di lavoro</h1>
  <div class="content">
    <ul>
      <li>
        <strong>Architetto/a progettista – Divisione edifici pubblici</strong>
        <br>Scadenza: 30.03.2026
        <a href="/downloadConcorsi/architetto-progettista.pdf">Capitolato</a>
        <a href="https://egov.lugano.ch/it/services/3">Partecipa</a>
      </li>
      <li>
        <strong>Operaio/a di manutenzione spazi sotterranei – Servizi urbani</strong>
        <br>Scadenza: 30.03.2026
        <a href="/downloadConcorsi/operaio-manutenzione.pdf">Capitolato</a>
        <a href="https://egov.lugano.ch/it/services/3">Partecipa</a>
      </li>
      <li>
        <strong>Personale addetto alle pulizie – Amministrazione comunale</strong>
        <br>Scadenza: 09.12.2026
        <a href="/downloadConcorsi/pulizie.pdf">Capitolato</a>
        <a href="https://egov.lugano.ch/it/services/3">Partecipa</a>
      </li>
      <li>
        <strong>Educatore/trice dell'infanzia – Divisione servizi extrascolastici</strong>
        <br>Scadenza: 09.12.2026
        <a href="/downloadConcorsi/educatore.pdf">Capitolato</a>
        <a href="https://egov.lugano.ch/it/services/3">Partecipa</a>
      </li>
      <li>
        <strong>Cassieri/e – Amministrazione comunale</strong>
        <br>Scadenza: 09.12.2026
        <a href="/downloadConcorsi/cassieri.pdf">Capitolato</a>
        <a href="https://egov.lugano.ch/it/services/3">Partecipa</a>
      </li>
    </ul>
  </div>
</main>
</body>
</html>`;

// ─── Fixture: Empty listing ────────────────────────────────
const EMPTY_LISTING = `
<html><body><main>
  <h1>Concorsi pubblici</h1>
  <p>Al momento non sono presenti concorsi attivi.</p>
</main></body></html>`;

// ═══════════════════════════════════════════════════════════════
// parseListingPage
// ═══════════════════════════════════════════════════════════════

describe('parseListingPage', () => {
  it('extracts job listings from concorsi page', () => {
    const jobs = parseListingPage(LISTING_HTML);
    expect(jobs.length).toBe(5);
  });

  it('extracts job titles from <strong> tags', () => {
    const jobs = parseListingPage(LISTING_HTML);
    const titles = jobs.map((j: { title: string }) => j.title);
    expect(titles[0]).toContain('Architetto/a progettista');
    expect(titles[1]).toContain('Operaio/a di manutenzione');
  });

  it('extracts deadline dates', () => {
    const jobs = parseListingPage(LISTING_HTML);
    expect((jobs[0] as any).deadline).toBe('2026-03-30');
    expect((jobs[2] as any).deadline).toBe('2026-12-09');
  });

  it('extracts PDF URLs', () => {
    const jobs = parseListingPage(LISTING_HTML);
    expect((jobs[0] as any).pdfUrl).toContain('downloadConcorsi');
  });

  it('sets location to Lugano for all jobs', () => {
    const jobs = parseListingPage(LISTING_HTML);
    for (const job of jobs) {
      expect((job as { location: string }).location).toBe('Lugano');
    }
  });

  it('returns empty array for empty input', () => {
    expect(parseListingPage('')).toHaveLength(0);
    expect(parseListingPage(null as unknown as string)).toHaveLength(0);
  });

  it('returns empty array for page with no listings', () => {
    expect(parseListingPage(EMPTY_LISTING)).toHaveLength(0);
  });
});

// ═══════════════════════════════════════════════════════════════
// parseSwissDate
// ═══════════════════════════════════════════════════════════════

describe('parseSwissDate', () => {
  it('parses DD.MM.YYYY to ISO format', () => {
    expect(parseSwissDate('30.03.2026')).toBe('2026-03-30');
  });

  it('pads single-digit day and month', () => {
    expect(parseSwissDate('1.1.2026')).toBe('2026-01-01');
  });

  it('returns empty for invalid input', () => {
    expect(parseSwissDate('')).toBe('');
    expect(parseSwissDate('invalid')).toBe('');
  });
});

// ═══════════════════════════════════════════════════════════════
// buildJob
// ═══════════════════════════════════════════════════════════════

describe('buildJob', () => {
  it('builds a complete job object', () => {
    const job = buildJob({
      title: 'Architetto/a progettista',
      url: 'https://egov.lugano.ch/it/services/3',
      deadline: '2026-03-30',
    });
    expect(job).not.toBeNull();
    expect(job!.company).toBe('Città di Lugano');
    expect(job!.companyKey).toBe('citta-di-lugano');
    expect(job!.location).toBe('Lugano');
    expect(job!.canton).toBe('TI');
  });

  it('generates slug with company name', () => {
    const job = buildJob({ title: 'Educatore dell\'infanzia' });
    expect(job!.slug).toContain('citta-di-lugano');
  });

  it('generates only IT slug (other locales filled by translation pipeline)', () => {
    const job = buildJob({ title: 'Architetto progettista' });
    expect(job!.slugByLocale.it).toContain('citta-di-lugano');
    expect(job!.slugByLocale.en).toBeUndefined();
    expect(job!.slugByLocale.de).toBeUndefined();
    expect(job!.slugByLocale.fr).toBeUndefined();
  });

  it('sets default description when none provided', () => {
    const job = buildJob({ title: 'Test Position' });
    expect(job!.description).toContain('Città di Lugano');
    expect(job!.description.length).toBeGreaterThan(50);
  });

  it('returns null for empty or missing title', () => {
    expect(buildJob({ title: '' })).toBeNull();
    expect(buildJob(null as any)).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════
// stripHtml / normalizeSpace
// ═══════════════════════════════════════════════════════════════

describe('stripHtml', () => {
  it('removes HTML tags', () => {
    expect(stripHtml('<p>Hello <b>world</b></p>')).not.toMatch(/<[a-z]/i);
  });

  it('decodes HTML entities', () => {
    expect(stripHtml('&amp;')).toBe('&');
  });

  it('returns empty for empty input', () => {
    expect(stripHtml('')).toBe('');
  });
});

describe('normalizeSpace', () => {
  it('collapses whitespace', () => {
    expect(normalizeSpace('hello    world')).toBe('hello world');
  });
});
