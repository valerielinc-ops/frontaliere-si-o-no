/**
 * FART – Ferrovie Autolinee Regionali Ticinesi crawler parser tests
 *
 * Tests parseFartListingPage(), buildFartDescription(), countMeaningfulParagraphs()
 * using HTML and PDF text fixtures.
 *
 * Regression case: "Addetto al Reparto Verifica e Pulizia del Garage Autolinee 100% (M/F)"
 *   https://fartiamo.ch/wp-content/uploads/2026/02/Addetto-al-Reparto-Verifica-e-Pulizia-del-Garage-autolinee.pdf
 *   — description was too short because pdfText was passed already-normalized,
 *     triggering deduplication a second time inside buildPdfBackedDescription.
 *   — fix: pass rawText → normalizePdfJobText applied exactly once.
 */
import { describe, it, expect } from 'vitest';

import {
  parseFartListingPage,
  buildFartDescription,
  countMeaningfulParagraphs,
  MIN_FART_DESC_LENGTH,
} from '@/scripts/lib/fart-job-parser.mjs';

// ─── Fixtures: raw PDF text ────────────────────────────────────────────────

// Regression case: "Addetto al Reparto Verifica e Pulizia del Garage Autolinee"
// Mirrors the kind of raw text unpdf would extract from a FART concorso PDF.
const PDF_RAW_ADDETTO_PULIZIA = `FART - Ferrovie Autolinee Regionali Ticinesi
Via Domenico Galli 9
6600 Locarno
www.centovalli.ch

CONCORSO N. 1/2026

Addetto al Reparto Verifica e Pulizia del Garage Autolinee
100% (M/F)

La FART, azienda di trasporto pubblico regionale attiva nel Locarnese e in Valle Centovalli, è alla ricerca di una persona motivata per rinforzare il proprio reparto di verifica e pulizia dei veicoli.

Compiti principali:
- Pulizia quotidiana degli autobus e dei mezzi ferroviari all'interno del deposito
- Verifica dello stato esterno ed interno dei veicoli prima della messa in servizio
- Segnalazione tempestiva di anomalie tecniche o danni al responsabile di manutenzione
- Rifornimento di carburante, liquidi e materiale di consumo secondo le procedure aziendali
- Collaborazione con il reparto tecnico durante le revisioni periodiche

Profilo ricercato:
- Esperienza pregressa nel settore dei trasporti o della manutenzione di veicoli
- Capacità di lavorare in modo autonomo e in team
- Disponibilità a turni, anche notturni e nei fine settimana
- Buona conoscenza della lingua italiana; la conoscenza del tedesco è un vantaggio
- Patente di guida categoria B; la categoria D è considerata un plus

Offriamo:
- Un impiego stabile in un'azienda pubblica con forte radicamento nel territorio
- Formazione interna e supporto nella fase di inserimento
- Condizioni salariali conformi al contratto collettivo del settore

Informazioni e candidatura:
Inviare la propria candidatura completa (lettera di motivazione, CV, diplomi, referenze) entro il 15 marzo 2026 a:
FART – Ferrovie Autolinee Regionali Ticinesi
Direzione Risorse Umane
Via Domenico Galli 9, 6600 Locarno
E-mail: fart@centovalli.ch
Tel. +41 (0)91 756 04 00

Solo i dossier completi saranno presi in considerazione.
`;

// Short PDF — should trigger the MIN_FART_DESC_LENGTH warning
const PDF_RAW_SHORT = `FART
Concorso 2/2026
Autista

TBD.
`;

// PDF with duplicate paragraphs (deduplication test)
const PDF_RAW_WITH_DUPLICATES = `FART - Ferrovie Autolinee Regionali Ticinesi
Via Domenico Galli 9, 6600 Locarno

Conducente di Autobus 100% (M/F)

Il candidato avrà il compito di condurre autobus di linea sulle rotte del Locarnese.

Requisiti:
- Patente di guida categoria D + CPC
- Buona conoscenza del territorio ticinese
- Disponibilità ai turni

FART - Ferrovie Autolinee Regionali Ticinesi
Via Domenico Galli 9, 6600 Locarno

Il candidato avrà il compito di condurre autobus di linea sulle rotte del Locarnese.
`;

// ─── Fixtures: HTML listing page ──────────────────────────────────────────

const FIXTURE_LISTING_HTML = `<!DOCTYPE html>
<html lang="it">
<head><title>Concorsi | FART</title></head>
<body>
<main>
  <h5>Addetto al Reparto Verifica e Pulizia del Garage Autolinee 100% (M/F)</h5>
  <p>Cerchiamo un candidato motivato.</p>
  <p><a href="https://fartiamo.ch/wp-content/uploads/2026/02/Addetto-al-Reparto-Verifica-e-Pulizia-del-Garage-autolinee.pdf">CONCORSO</a></p>

  <h5>Conducente di Autobus 100% (M/F)</h5>
  <p>Posizione aperta per il servizio linee.</p>
  <p><a href="http://fartiamo.ch/wp-content/uploads/2026/01/Conducente-autobus.pdf">CONCORSO</a></p>

  <h5>Stage Contabilità 60% (F/M)</h5>
  <p>Stage nel dipartimento finanziario.</p>
  <p><a href="https://fartiamo.ch/wp-content/uploads/2026/03/stage-contabilita.pdf">CONCORSO</a></p>

  <!-- Should be skipped: privacy document -->
  <h5>Informativa Privacy</h5>
  <p><a href="https://fartiamo.ch/wp-content/uploads/privacy-informativa.pdf">PDF</a></p>
</main>
</body>
</html>`;

const FIXTURE_LISTING_WITH_RELATIVE_URL = `<!DOCTYPE html>
<html><body>
  <h5>Macchinista Ferroviario 100%</h5>
  <p><a href="/wp-content/uploads/2026/03/macchinista.pdf">CONCORSO</a></p>
</body></html>`;

// ─── buildFartDescription — regression case ──────────────────────────────

describe('buildFartDescription — Addetto al Reparto Verifica regression', () => {
  it(`produces a description >= ${MIN_FART_DESC_LENGTH} characters`, () => {
    const { description } = buildFartDescription(
      'Addetto al Reparto Verifica e Pulizia del Garage Autolinee 100% (M/F)',
      PDF_RAW_ADDETTO_PULIZIA
    );
    expect(description.length).toBeGreaterThanOrEqual(MIN_FART_DESC_LENGTH);
  });

  it('preserves at least 3 meaningful paragraphs', () => {
    const { description } = buildFartDescription(
      'Addetto al Reparto Verifica e Pulizia del Garage Autolinee 100% (M/F)',
      PDF_RAW_ADDETTO_PULIZIA
    );
    expect(countMeaningfulParagraphs(description)).toBeGreaterThanOrEqual(3);
  });

  it('includes the job title intro line', () => {
    const { description } = buildFartDescription(
      'Addetto al Reparto Verifica e Pulizia del Garage Autolinee 100% (M/F)',
      PDF_RAW_ADDETTO_PULIZIA
    );
    expect(description).toContain('Addetto al Reparto Verifica e Pulizia del Garage Autolinee 100% (M/F)');
  });

  it('includes main PDF body content', () => {
    const { description } = buildFartDescription(
      'Addetto al Reparto Verifica e Pulizia del Garage Autolinee 100% (M/F)',
      PDF_RAW_ADDETTO_PULIZIA
    );
    expect(description).toContain('Pulizia quotidiana');
    expect(description).toContain('Patente di guida');
  });

  it('includes the footer contact information', () => {
    const { description } = buildFartDescription(
      'Addetto al Reparto Verifica e Pulizia del Garage Autolinee 100% (M/F)',
      PDF_RAW_ADDETTO_PULIZIA
    );
    expect(description).toContain('fart@centovalli.ch');
  });

  it('emits no warnings for a full-length PDF', () => {
    const { warnings } = buildFartDescription(
      'Addetto al Reparto Verifica e Pulizia del Garage Autolinee 100% (M/F)',
      PDF_RAW_ADDETTO_PULIZIA
    );
    expect(warnings).toHaveLength(0);
  });
});

// ─── buildFartDescription — minimum length guard ─────────────────────────

describe('buildFartDescription — MIN_FART_DESC_LENGTH guard', () => {
  it(`MIN_FART_DESC_LENGTH is ${MIN_FART_DESC_LENGTH}`, () => {
    expect(MIN_FART_DESC_LENGTH).toBe(400);
  });

  it('emits a warning when PDF text is provided but description is too short', () => {
    const { warnings } = buildFartDescription('Autista', PDF_RAW_SHORT);
    expect(warnings.some((w: string) => w.includes('too short'))).toBe(true);
  });

  it('does not emit a warning when no PDF text is provided (fallback is expected)', () => {
    const { warnings } = buildFartDescription('Autista', '');
    expect(warnings).toHaveLength(0);
  });

  it('uses fallback text when rawPdfText is empty', () => {
    const { description } = buildFartDescription('Autista', '');
    expect(description).toContain('Concorso Autista');
    expect(description).toContain('FART');
  });
});

// ─── buildFartDescription — duplicate content ────────────────────────────

describe('buildFartDescription — duplicate paragraph deduplication', () => {
  it('does not repeat identical content blocks', () => {
    const { description } = buildFartDescription('Conducente di Autobus 100% (M/F)', PDF_RAW_WITH_DUPLICATES);
    // The intro paragraph about "condurre autobus" should appear only once
    const count = description.split('Il candidato avrà il compito di condurre autobus').length - 1;
    expect(count).toBe(1);
  });
});

// ─── parseFartListingPage ─────────────────────────────────────────────────

describe('parseFartListingPage', () => {
  it('extracts jobs from h5+PDF-link structure', () => {
    const jobs = parseFartListingPage(FIXTURE_LISTING_HTML);
    expect(jobs.length).toBeGreaterThanOrEqual(3);
  });

  it('extracts the regression job title', () => {
    const jobs = parseFartListingPage(FIXTURE_LISTING_HTML);
    const titles = jobs.map((j: any) => j.title);
    expect(titles).toContain('Addetto al Reparto Verifica e Pulizia del Garage Autolinee 100% (M/F)');
  });

  it('normalizes http:// PDF URLs to https://', () => {
    const jobs = parseFartListingPage(FIXTURE_LISTING_HTML);
    const conducente = jobs.find((j: any) => j.title.includes('Conducente'));
    expect(conducente?.pdfUrl).toMatch(/^https:\/\//);
  });

  it('builds absolute URL from relative href', () => {
    const jobs = parseFartListingPage(FIXTURE_LISTING_WITH_RELATIVE_URL);
    expect(jobs[0]?.pdfUrl).toBe('https://fartiamo.ch/wp-content/uploads/2026/03/macchinista.pdf');
  });

  it('skips privacy/informativa documents', () => {
    const jobs = parseFartListingPage(FIXTURE_LISTING_HTML);
    const titles = jobs.map((j: any) => j.title);
    expect(titles).not.toContain('Informativa Privacy');
  });

  it('returns empty array for empty HTML', () => {
    expect(parseFartListingPage('')).toHaveLength(0);
  });

  it('skips h5 blocks without a PDF link', () => {
    const html = '<h5>No PDF here</h5><p>Just text.</p><h5>With PDF</h5><p><a href="a.pdf">PDF</a></p>';
    const jobs = parseFartListingPage(html);
    expect(jobs).toHaveLength(1);
    expect(jobs[0].title).toBe('With PDF');
  });
});

// ─── countMeaningfulParagraphs ────────────────────────────────────────────

describe('countMeaningfulParagraphs', () => {
  it('counts paragraphs separated by double newlines', () => {
    const text =
      'First meaningful paragraph with real content.\n\nSecond meaningful paragraph with content.\n\nThird meaningful paragraph here.';
    expect(countMeaningfulParagraphs(text)).toBe(3);
  });

  it('ignores empty or very short paragraphs', () => {
    const text = 'Long first paragraph with real content.\n\n\n\nLong second paragraph here.\n\nOK';
    // "OK" is only 2 chars (< 20 non-whitespace), so it doesn't count
    expect(countMeaningfulParagraphs(text)).toBe(2);
  });

  it('returns 0 for empty input', () => {
    expect(countMeaningfulParagraphs('')).toBe(0);
    expect(countMeaningfulParagraphs(null as any)).toBe(0);
  });
});
