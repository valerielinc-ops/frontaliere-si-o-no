/**
 * BancaStato crawler parser tests
 *
 * Tests parseListingPage(), parseDetailPage(), buildJob(),
 * stripHtml(), normalizeSpace() using HTML fixtures.
 */
import { describe, it, expect } from 'vitest';

import {
  parseListingPage,
  parseDetailPage,
  buildJob,
  stripHtml,
  normalizeSpace,
} from '@/scripts/lib/bancastato-job-parser.mjs';

// ─── Fixture: Career page with real job listings ────────────
const LISTING_HTML = `
<html>
<body>
<main>
  <div class="content">
    <h1>Posti vacanti</h1>
    <ul>
      <li>
        <a href="/carriere/posti-vacanti/consulente-clientela-privata">
          <strong>Consulente clientela privata</strong>
        </a>
        <span>Bellinzona</span>
      </li>
      <li>
        <a href="/carriere/posti-vacanti/analista-crediti">
          <strong>Analista crediti</strong>
        </a>
        <span>Lugano</span>
      </li>
      <li>
        <a href="/carriere/posti-vacanti/specialista-compliance">
          <strong>Specialista compliance</strong>
        </a>
        <span>Bellinzona</span>
      </li>
    </ul>
  </div>
</main>
</body>
</html>`;

// ─── Fixture: Product/service pages (should NOT be parsed as jobs) ──
const PRODUCT_HTML = `
<html>
<body>
<main>
  <div class="content">
    <h1>I nostri servizi</h1>
    <ul>
      <li><a href="/privati/carte/prepaid-mastercard">PrePaid Mastercard</a></li>
      <li><a href="/privati/investimenti/fondi">Fondi di investimento</a></li>
      <li><a href="/aziende/servizi/e-banking">E-Banking per aziende</a></li>
      <li><a href="/contatti/sportelli">I nostri sportelli</a></li>
      <li><a href="/la-banca/posti-vacanti">Posti vacanti e carriera</a></li>
    </ul>
  </div>
</main>
</body>
</html>`;

// ─── Fixture: Detail page ──────────────────────────────────
const DETAIL_HTML = `
<html>
<body>
<main>
  <article>
    <h1>Consulente clientela privata</h1>
    <div class="content">
      <p>BancaStato cerca un/una consulente clientela privata per la sede di Bellinzona.
         La risorsa si occuperà della gestione e dello sviluppo del portafoglio clienti,
         offrendo consulenza personalizzata su prodotti bancari e finanziari.</p>
      <h2>Requisiti</h2>
      <ul>
        <li>Formazione bancaria o equivalente (AFC impiegato di commercio, diploma SSS banca e finanza)</li>
        <li>Esperienza pluriennale nella consulenza alla clientela privata</li>
        <li>Ottime capacità relazionali e comunicative</li>
        <li>Conoscenza fluente della lingua italiana, buona conoscenza del tedesco</li>
        <li>Orientamento al cliente e ai risultati</li>
      </ul>
      <h2>Offriamo</h2>
      <ul>
        <li>Ambiente di lavoro stimolante in un istituto bancario cantonale solido</li>
        <li>Condizioni di impiego competitive</li>
        <li>Possibilità di formazione continua</li>
        <li>Sede di lavoro: Bellinzona</li>
      </ul>
    </div>
  </article>
</main>
</body>
</html>`;

// ─── Fixture: Empty page ───────────────────────────────────
const EMPTY_HTML = `
<html>
<body>
<main>
  <h1>Posti vacanti</h1>
  <p>Al momento non ci sono posti vacanti.</p>
</main>
</body>
</html>`;

// ─── Fixture: Minimal detail ───────────────────────────────
const MINIMAL_DETAIL_HTML = `
<html><body><main><h1>Impiegato/a di banca</h1><p>Short.</p></main></body></html>`;

// ═══════════════════════════════════════════════════════════════
// parseListingPage
// ═══════════════════════════════════════════════════════════════

describe('parseListingPage', () => {
  it('extracts job listings from career page', () => {
    const jobs = parseListingPage(LISTING_HTML);
    expect(jobs.length).toBeGreaterThanOrEqual(3);
  });

  it('extracts job titles correctly', () => {
    const jobs = parseListingPage(LISTING_HTML);
    const titles = jobs.map((j: { title: string }) => j.title);
    expect(titles).toContain('Consulente clientela privata');
    expect(titles).toContain('Analista crediti');
  });

  it('generates valid URLs', () => {
    const jobs = parseListingPage(LISTING_HTML);
    for (const job of jobs) {
      expect((job as { url: string }).url).toMatch(/^https:\/\//);
    }
  });

  it('returns empty array for empty input', () => {
    expect(parseListingPage('')).toHaveLength(0);
    expect(parseListingPage(null as unknown as string)).toHaveLength(0);
  });

  it('returns empty array for page with no jobs', () => {
    const jobs = parseListingPage(EMPTY_HTML);
    expect(jobs).toHaveLength(0);
  });

  it('does NOT extract product/service pages as jobs', () => {
    const jobs = parseListingPage(PRODUCT_HTML);
    expect(jobs).toHaveLength(0);
  });

  it('rejects links to product paths like /privati/, /aziende/, /contatti/', () => {
    const html = `<html><body>
      <a href="/privati/carte/prepaid-mastercard">PrePaid Mastercard</a>
      <a href="/aziende/servizi/e-banking">E-Banking</a>
      <a href="/contatti/sportelli">Sportelli</a>
    </body></html>`;
    const jobs = parseListingPage(html);
    expect(jobs).toHaveLength(0);
  });
});

// ═══════════════════════════════════════════════════════════════
// parseDetailPage
// ═══════════════════════════════════════════════════════════════

describe('parseDetailPage', () => {
  it('extracts title from h1', () => {
    const result = parseDetailPage(DETAIL_HTML);
    expect(result).not.toBeNull();
    expect(result!.title).toBe('Consulente clientela privata');
  });

  it('extracts description text', () => {
    const result = parseDetailPage(DETAIL_HTML);
    expect(result!.description.length).toBeGreaterThan(100);
    expect(result!.description).toContain('portafoglio clienti');
  });

  it('extracts requirement sections', () => {
    const result = parseDetailPage(DETAIL_HTML);
    expect(result!.requirements.length).toBeGreaterThanOrEqual(3);
    expect(result!.requirements[0]).toContain('Formazione bancaria');
  });

  it('sets location to Bellinzona by default', () => {
    const result = parseDetailPage(DETAIL_HTML);
    expect(result!.location).toBe('Bellinzona');
    expect(result!.canton).toBe('TI');
  });

  it('returns null for empty input', () => {
    expect(parseDetailPage('')).toBeNull();
    expect(parseDetailPage(null as unknown as string)).toBeNull();
  });

  it('returns null for page without meaningful title', () => {
    expect(parseDetailPage('<html><body></body></html>')).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════
// buildJob
// ═══════════════════════════════════════════════════════════════

describe('buildJob', () => {
  it('builds a complete job object from raw data', () => {
    const job = buildJob({
      title: 'Consulente clientela privata',
      url: 'https://www.bancastato.ch/carriere/posti-vacanti/consulente',
      location: 'Bellinzona',
    });
    expect(job).not.toBeNull();
    expect(job!.company).toBe('BancaStato');
    expect(job!.companyKey).toBe('bancastato');
    expect(job!.canton).toBe('TI');
    expect(job!.country).toBe('CH');
  });

  it('includes postalCode and streetAddress', () => {
    const job = buildJob({ title: 'Test Job', location: 'Bellinzona' });
    expect(job!.postalCode).toBe('6500');
    expect(job!.streetAddress).toBe('Viale Henri Guisan 5');
    expect(job!.employmentType).toBe('FULL_TIME');
  });

  it('generates slug with company name', () => {
    const job = buildJob({ title: 'Analista crediti', location: 'Lugano' });
    expect(job!.slug).toContain('bancastato');
    expect(job!.slug).toContain('analista-crediti');
  });

  it('sets default description when none provided', () => {
    const job = buildJob({ title: 'Test Job' });
    expect(job!.description).toContain('BancaStato');
    expect(job!.description.length).toBeGreaterThan(50);
  });

  it('returns null for empty title', () => {
    expect(buildJob({ title: '' })).toBeNull();
    expect(buildJob(null as any)).toBeNull();
  });

  it('generates locale slugs', () => {
    const job = buildJob({ title: 'Responsabile IT', location: 'Bellinzona' });
    expect(job!.slugByLocale.it).toContain('responsabile-it');
    expect(job!.slugByLocale.en).toContain('responsabile-it');
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
    expect(stripHtml('AT&amp;T')).toContain('AT&T');
  });

  it('handles br tags (replaced then whitespace-normalized)', () => {
    const result = stripHtml('First<br>Second');
    expect(result).toContain('First');
    expect(result).toContain('Second');
  });

  it('returns empty string for empty input', () => {
    expect(stripHtml('')).toBe('');
  });
});

describe('normalizeSpace', () => {
  it('collapses multiple spaces', () => {
    expect(normalizeSpace('hello    world')).toBe('hello world');
  });

  it('trims whitespace', () => {
    expect(normalizeSpace('  hello  ')).toBe('hello');
  });

  it('returns empty for empty input', () => {
    expect(normalizeSpace('')).toBe('');
  });
});
