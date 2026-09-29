/**
 * BPS (Banca Popolare di Sondrio) Suisse crawler parser tests
 *
 * Tests parseBpsSuisseListingPage(), parseBpsSuisseDetailPage(),
 * and isTicinoBpsJob() using realistic HTML fixtures.
 */
import { describe, it, expect } from 'vitest';

import {
  parseBpsSuisseListingPage,
  parseBpsSuisseDetailPage,
  isTicinoBpsJob,
  MIN_BPS_FULL_DESC,
  buildBpsSuisseDescriptionFields,
  dropBpsSuisseFabricatedText,
} from '@/scripts/lib/bps-suisse-job-parser.mjs';

// ─── Fixture: Listing page ───
const LISTING_HTML = `
<html>
<body>
<div class="content">
  <h2>Posizioni aperte</h2>
  <a href="carriera-consulente_clientela_individuale__100_.php">
    Consulente Clientela Individuale (100%)
    Sede: Lugano
    Vedi annuncio
  </a>
  <a href="carriera-analista_crediti__100_.php">
    Analista Crediti (100%)
    Sede: Lugano
    Vedi annuncio
  </a>
  <a href="carriera-gestore_patrimoni__80_.php">
    Gestore Patrimoni (80%)
    Sede: Basilea
    Vedi annuncio
  </a>
  <a href="carriera-compliance_officer__100_.php">
    Compliance Officer (100%)
    Sede: Lugano
    Vedi annuncio
  </a>
</div>
</body>
</html>`;

// ─── Fixture: Detail page with content ───
const DETAIL_HTML = `
<html>
<body>
<main>
  <h2>Consulente Clientela Individuale (100%)</h2>
  <p>Sede: Lugano</p>
  <div class="content">
    <p>BPS (Banca Popolare di Sondrio) SUISSE cerca un Consulente Clientela Individuale
    per la sede di Lugano. Il candidato ideale ha esperienza nel settore bancario
    e possiede ottime capacita relazionali. La posizione prevede la gestione di un
    portafoglio clienti privati con focus sulla consulenza patrimoniale e finanziaria.
    Richiesta conoscenza della lingua italiana e tedesca.</p>
    <a href="documenti/job-consulente-2026.pdf">Scarica annuncio completo</a>
  </div>
</main>
</body>
</html>`;

// ─── Fixture: Minimal detail page ───
const MINIMAL_DETAIL_HTML = `
<html>
<body>
  <h2>Stage Banking (50%)</h2>
  <p>Sede: Lugano</p>
</body>
</html>`;

// ═══════════════════════════════════════════════════════════════
// parseBpsSuisseListingPage
// ═══════════════════════════════════════════════════════════════

describe('parseBpsSuisseListingPage', () => {
  it('extracts all job URLs from listing page', () => {
    const results = parseBpsSuisseListingPage(LISTING_HTML);
    expect(results.length).toBe(4);
  });

  it('builds absolute URLs with bps-suisse.ch domain', () => {
    const results = parseBpsSuisseListingPage(LISTING_HTML);
    expect(results[0].url).toBe('https://www.bps-suisse.ch/carriera-consulente_clientela_individuale__100_.php');
  });

  it('extracts job titles', () => {
    const results = parseBpsSuisseListingPage(LISTING_HTML);
    expect(results[0].title).toContain('Consulente Clientela Individuale');
  });

  it('deduplicates URLs', () => {
    const dupeHtml = `
      <a href="carriera-test.php">Test Job</a>
      <a href="carriera-test.php">Test Job Duplicate</a>
    `;
    const results = parseBpsSuisseListingPage(dupeHtml);
    expect(results.length).toBe(1);
  });

  it('returns empty array for empty input', () => {
    expect(parseBpsSuisseListingPage('')).toEqual([]);
    expect(parseBpsSuisseListingPage(null)).toEqual([]);
  });

  it('returns empty array for page with no career links', () => {
    const noJobsHtml = '<html><body><p>No jobs available</p></body></html>';
    expect(parseBpsSuisseListingPage(noJobsHtml)).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════════
// parseBpsSuisseDetailPage
// ═══════════════════════════════════════════════════════════════

describe('parseBpsSuisseDetailPage', () => {
  it('extracts title from detail page', () => {
    const result = parseBpsSuisseDetailPage(DETAIL_HTML);
    expect(result).not.toBeNull();
    expect(result.title).toBe('Consulente Clientela Individuale (100%)');
  });

  it('extracts location', () => {
    const result = parseBpsSuisseDetailPage(DETAIL_HTML);
    expect(result.location).toBe('Lugano');
  });

  it('extracts body text', () => {
    const result = parseBpsSuisseDetailPage(DETAIL_HTML);
    expect(result.body).toContain('Banca Popolare di Sondrio');
    expect(result.body).toContain('consulenza patrimoniale');
  });

  it('extracts PDF URL', () => {
    const result = parseBpsSuisseDetailPage(DETAIL_HTML);
    expect(result.pdfUrl).toContain('.pdf');
  });

  it('returns null for empty input', () => {
    expect(parseBpsSuisseDetailPage('')).toBeNull();
    expect(parseBpsSuisseDetailPage(null)).toBeNull();
  });

  it('handles minimal detail page', () => {
    const result = parseBpsSuisseDetailPage(MINIMAL_DETAIL_HTML);
    expect(result).not.toBeNull();
    expect(result.title).toBe('Stage Banking (50%)');
    expect(result.location).toBe('Lugano');
  });

  it('reports meetsMinLength correctly', () => {
    const result = parseBpsSuisseDetailPage(DETAIL_HTML) as any;
    expect(result.meetsMinLength).toBe(true);
    const minimal = parseBpsSuisseDetailPage(MINIMAL_DETAIL_HTML) as any;
    expect(minimal.meetsMinLength).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════
// isTicinoBpsJob
// ═══════════════════════════════════════════════════════════════

describe('isTicinoBpsJob', () => {
  it('returns true for Lugano location', () => {
    expect(isTicinoBpsJob({ location: 'Lugano', canton: '' })).toBe(true);
  });

  it('returns true for canton TI', () => {
    expect(isTicinoBpsJob({ location: '', canton: 'TI' })).toBe(true);
  });

  it('returns false for Basilea', () => {
    expect(isTicinoBpsJob({ location: 'Basilea', canton: '' })).toBe(false);
  });

  it('returns false for null', () => {
    expect(isTicinoBpsJob(null)).toBe(false);
  });

  it('returns true for Bellinzona', () => {
    expect(isTicinoBpsJob({ location: 'Bellinzona', canton: '' })).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════
// MIN_BPS_FULL_DESC constant
// ═══════════════════════════════════════════════════════════════

describe('MIN_BPS_FULL_DESC', () => {
  it('is a reasonable minimum description length', () => {
    expect(MIN_BPS_FULL_DESC).toBeGreaterThanOrEqual(100);
    expect(MIN_BPS_FULL_DESC).toBeLessThanOrEqual(500);
  });
});

// ═══════════════════════════════════════════════════════════════
// Description = the posting's own text (no wrapper of the runner's)
// ═══════════════════════════════════════════════════════════════

// Minimized from the PDF call of "Consulente alla clientela commerciale
// ipotecaria" (slice of 2026-09-29).
const BPS_CALL = 'Banca Popolare di Sondrio (SUISSE) SA – Ufficio Risorse Umane Via Maggio 1, 6900 Lugano. Lavora con noi. Siamo un istituto bancario svizzero con una solida presenza nazionale e una forte attenzione al territorio.';

describe('buildBpsSuisseDescriptionFields', () => {
  it('publishes the PDF call alone, keyed by its language', () => {
    const fields = buildBpsSuisseDescriptionFields({ pdfText: BPS_CALL, bodyText: 'Testo della pagina.' });
    expect(fields.description).toBe(BPS_CALL);
    expect(fields.descriptionByLocale).toEqual({ it: BPS_CALL });
    expect(fields.sourceLang).toBe('it');
    expect(fields.description).not.toMatch(/posizione aperta|\*\*Settore:\*\*|\*\*Sede:\*\*|Bando ufficiale/);
  });

  it('falls back to the detail-page body, and to nothing without any text', () => {
    expect(buildBpsSuisseDescriptionFields({ bodyText: BPS_CALL }).description).toBe(BPS_CALL);
    expect(buildBpsSuisseDescriptionFields({}).description).toBe('');
  });
});

describe('dropBpsSuisseFabricatedText', () => {
  it('drops the wrapped source slot and the translations made from it', () => {
    const wrapped = `## Consulente Alla Clientela Commerciale Ipotecaria\n\nBPS (Banca Popolare di Sondrio) SUISSE — posizione aperta a Lugano (TI).\n\n${BPS_CALL}\n\n**Settore:** Bancario / Finanziario`;
    const job: any = {
      sourceLang: 'it',
      description: wrapped,
      descriptionByLocale: {
        it: wrapped,
        en: '## Adviser to the Client Commercial Mortgage\n\nBPS (Banca Popolare di Sondrio) SUISSE — open position in Lugano (TI).',
      },
    };
    expect(dropBpsSuisseFabricatedText(job)).toBe(true);
    expect(job.descriptionByLocale).toEqual({});
    expect(job.needsRetranslation).toBe(true);
  });

  it('leaves a clean job alone', () => {
    const job: any = { sourceLang: 'it', description: BPS_CALL, descriptionByLocale: { it: BPS_CALL, en: 'Translated.' } };
    expect(dropBpsSuisseFabricatedText(job)).toBe(false);
    expect(job.descriptionByLocale.en).toBe('Translated.');
  });
});
