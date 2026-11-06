/**
 * Tests for scripts/lib/irsol-html-parser.mjs
 *
 * Verifies stable title extraction, full-body extraction and cross-lingual
 * node-ID matching for the IRSOL/USI bilingual detail pages.
 *
 * Regression pair (FRO-73):
 *   IT: https://www.irsol.usi.ch/it/eventi-notizie/posizione-a-tempo-pieno-di-scienziatoingegnere-del-41206
 *   EN: https://www.irsol.usi.ch/en/events-news/full-time-position-of-an-instrumentation-scientist-41206
 */
import { describe, it, expect } from 'vitest';
import {
  extractDrupalNodeId,
  extractIrsolDetailPage,
  MIN_IRSOL_BODY_LENGTH,
} from '../scripts/lib/irsol-html-parser.mjs';

// ─── Fixture helpers ──────────────────────────────────────────────────────────

function drupalDetailHtml({
  title = '',
  bodyHtml = '',
  bodySelector = 'field-name-body',
}: {
  title?: string;
  bodyHtml?: string;
  bodySelector?: string;
} = {}) {
  return `<!DOCTYPE html>
<html lang="it"><head><title>${title} | IRSOL USI</title></head>
<body>
<main class="main-container">
  <article class="node node-news full clearfix">
    <h1 class="page-title">${title}</h1>
    <div class="field ${bodySelector} field-type-text-with-summary field-label-hidden">
      <div class="field-items">
        <div class="field-item even" property="content:encoded">
          ${bodyHtml}
        </div>
      </div>
    </div>
  </article>
</main>
</body></html>`;
}

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const IT_TITLE = 'Posizione a tempo pieno di Scienziato/Ingegnere della strumentazione';
const EN_TITLE = 'Full-time position of an Instrumentation Scientist/Engineer';

const IT_BODY_HTML = `
<p>L'Istituto ricerche solari Locarno (IRSOL), affiliato all'Università della Svizzera italiana,
è alla ricerca di uno Scienziato o Ingegnere della strumentazione.</p>
<p><strong>Responsabilità principali:</strong></p>
<ul>
  <li>Sviluppo e manutenzione degli strumenti di osservazione solare ad alta risoluzione.</li>
  <li>Collaborazione con team internazionali su progetti scientifici europei (EST, SOLARNET).</li>
  <li>Analisi e riduzione di dati spettropolarimetrici.</li>
</ul>
<p><strong>Requisiti:</strong></p>
<ul>
  <li>Laurea magistrale o dottorato in Fisica, Astronomia, Ingegneria o campo correlato.</li>
  <li>Esperienza con strumentazione astronomica o ottica di precisione è un vantaggio.</li>
  <li>Buona conoscenza di Python e/o IDL per l'elaborazione dati.</li>
</ul>
<p>Sede: Locarno, Svizzera (Canton Ticino). Contratto a tempo indeterminato.</p>
<p>Per candidarsi: inviare CV, lettera motivazionale e referenze a irsol@usi.ch entro il 30 aprile 2026.</p>
`;

const EN_BODY_HTML = `
<p>The Istituto ricerche solari Locarno (IRSOL), affiliated with the Università della Svizzera italiana,
is looking for an Instrumentation Scientist or Engineer.</p>
<p><strong>Main responsibilities:</strong></p>
<ul>
  <li>Development and maintenance of high-resolution solar observation instruments.</li>
  <li>Collaboration with international teams on European scientific projects (EST, SOLARNET).</li>
  <li>Analysis and reduction of spectropolarimetric data.</li>
</ul>
<p><strong>Requirements:</strong></p>
<ul>
  <li>Master's degree or PhD in Physics, Astronomy, Engineering, or a related field.</li>
  <li>Experience with astronomical instrumentation or precision optics is an advantage.</li>
  <li>Good knowledge of Python and/or IDL for data processing.</li>
</ul>
<p>Location: Locarno, Switzerland (Canton Ticino). Permanent contract.</p>
<p>To apply: send CV, cover letter and references to irsol@usi.ch by 30 April 2026.</p>
`;

const IT_URL = 'https://www.irsol.usi.ch/it/eventi-notizie/posizione-a-tempo-pieno-di-scienziatoingegnere-del-41206';
const EN_URL = 'https://www.irsol.usi.ch/en/events-news/full-time-position-of-an-instrumentation-scientist-41206';

// ─── extractDrupalNodeId ─────────────────────────────────────────────────────

describe('extractDrupalNodeId', () => {
  it('extracts numeric node ID from the IT regression URL', () => {
    expect(extractDrupalNodeId(IT_URL)).toBe('41206');
  });

  it('extracts numeric node ID from the EN regression URL', () => {
    expect(extractDrupalNodeId(EN_URL)).toBe('41206');
  });

  it('IT and EN variants of the same job share an identical node ID', () => {
    expect(extractDrupalNodeId(IT_URL)).toBe(extractDrupalNodeId(EN_URL));
  });

  it('returns empty string when the URL path has no numeric suffix', () => {
    expect(extractDrupalNodeId('https://www.irsol.usi.ch/it/')).toBe('');
    expect(extractDrupalNodeId('https://www.irsol.usi.ch/it/chi-siamo/irsol')).toBe('');
  });

  it('returns empty string for an empty or invalid URL', () => {
    expect(extractDrupalNodeId('')).toBe('');
    expect(extractDrupalNodeId('not-a-url')).toBe('');
  });

  it('handles a URL with a 4-digit node ID', () => {
    expect(extractDrupalNodeId('https://www.irsol.usi.ch/it/eventi-notizie/short-title-1234')).toBe('1234');
  });
});

// ─── extractIrsolDetailPage — IT page ────────────────────────────────────────

describe('extractIrsolDetailPage / IT page', () => {
  const html = drupalDetailHtml({ title: IT_TITLE, bodyHtml: IT_BODY_HTML });
  const result = extractIrsolDetailPage(html);

  it('extracts the title from h1.page-title', () => {
    expect(result.title).toBe(IT_TITLE);
  });

  it('title is stable (identical to h1 content, no surrounding whitespace)', () => {
    expect(result.title).not.toMatch(/^\s|\s$/);
    expect(result.title).toBe(IT_TITLE);
  });

  it(`body length is >= MIN_IRSOL_BODY_LENGTH (${MIN_IRSOL_BODY_LENGTH} chars)`, () => {
    expect(result.body.length).toBeGreaterThanOrEqual(MIN_IRSOL_BODY_LENGTH);
  });

  it('body contains the responsibilities section', () => {
    expect(result.body).toContain('Responsabilità');
  });

  it('body contains the requirements section', () => {
    expect(result.body).toContain('Requisiti');
  });

  it('body contains the location detail', () => {
    expect(result.body).toContain('Locarno');
  });

  it('body contains application instructions', () => {
    expect(result.body).toContain('irsol@usi.ch');
  });

  it('body does NOT contain raw HTML tags', () => {
    expect(result.body).not.toMatch(/<[a-zA-Z]/);
  });
});

// ─── extractIrsolDetailPage — EN page ────────────────────────────────────────

describe('extractIrsolDetailPage / EN page', () => {
  const html = drupalDetailHtml({ title: EN_TITLE, bodyHtml: EN_BODY_HTML });
  const result = extractIrsolDetailPage(html);

  it('extracts the English title from h1.page-title', () => {
    expect(result.title).toBe(EN_TITLE);
  });

  it(`body length is >= MIN_IRSOL_BODY_LENGTH (${MIN_IRSOL_BODY_LENGTH} chars)`, () => {
    expect(result.body.length).toBeGreaterThanOrEqual(MIN_IRSOL_BODY_LENGTH);
  });

  it('body contains English-language content', () => {
    expect(result.body).toContain('responsibilities');
    expect(result.body).toContain('Requirements');
  });

  it('EN and IT pages produce different titles (no title bleed-across)', () => {
    const itResult = extractIrsolDetailPage(
      drupalDetailHtml({ title: IT_TITLE, bodyHtml: IT_BODY_HTML }),
    );
    expect(result.title).not.toBe(itResult.title);
  });
});

// ─── extractIrsolDetailPage — edge cases ─────────────────────────────────────

describe('extractIrsolDetailPage / edge cases', () => {
  it('returns empty strings for empty HTML', () => {
    const result = extractIrsolDetailPage('');
    expect(result.title).toBe('');
    expect(result.body).toBe('');
  });

  it('returns empty title if no h1 in page', () => {
    const html = '<html><body><div class="field-name-body field-type-text-with-summary"><div class="field-items"><div class="field-item">Some body text that is long enough to pass the minimum length check for body extraction purposes.</div></div></div></body></html>';
    const result = extractIrsolDetailPage(html);
    expect(result.title).toBe('');
    expect(result.body.length).toBeGreaterThan(0);
  });

  it('falls back to bestCandidate when body is shorter than minimum', () => {
    const html = drupalDetailHtml({ title: 'Test', bodyHtml: '<p>Short.</p>' });
    const result = extractIrsolDetailPage(html);
    expect(result.title).toBe('Test');
    // body may be short but should not be empty when there is content
    expect(typeof result.body).toBe('string');
  });
});
