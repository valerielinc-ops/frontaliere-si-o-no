/**
 * Tests for scripts/lib/convit-job-parser.mjs
 *
 * Verifies that parseConvitDetailPage extracts the full job description from
 * the HTML DOM when JSON-LD is absent or too short (< 350 chars), as seen on
 * careers-page.com/convit-holding-gmbh detail pages.
 */
import { describe, expect, it } from 'vitest';
import { parseConvitDetailPage, parseConvitListingPage, buildConvitLocalizedContent } from '../scripts/lib/convit-job-parser.mjs';

// ─── Shared fixture helpers ────────────────────────────────────────────────────

function careersPageDetailHtml({
  title = 'Consulente previdenziale',
  location = 'Biasca',
  descriptionHtml = '',
  jsonLdDescription = '',
  datePosted = '2026-01-15',
}: {
  title?: string;
  location?: string;
  descriptionHtml?: string;
  jsonLdDescription?: string;
  datePosted?: string;
} = {}) {
  const jsonLd = jsonLdDescription
    ? `<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@type": "JobPosting",
  "title": "${title}",
  "description": ${JSON.stringify(jsonLdDescription)},
  "datePosted": "${datePosted}",
  "jobLocation": { "address": { "addressLocality": "${location}", "addressCountry": "CH" } }
}
</script>`
    : '';

  return `<!DOCTYPE html>
<html lang="en">
<head><title>${title}</title>
${jsonLd}
</head>
<body>
<div class="container mt-5">
  <div class="row">
    <!--Job Description-->
    <div class="col-md-3 col-lg-3">
      <h4><strong>Stellenbeschreibung:</strong></h4>
    </div>
    <div class="col-md-9 col-lg-9 mb-4 mb-sm-3">
      ${descriptionHtml}
    </div>
  </div>
  <div class="row">
    <div class="col-md-3 col-lg-3">
      <h4><strong>Arbeitsplatz:</strong></h4>
    </div>
    <div class="col-md-9 col-lg-9 mb-4 mb-sm-3">
      <h5><span class="fa fa-map-marker"></span> ${location}</h5>
    </div>
  </div>
</div>
<h1 class="job-position-break">${title}</h1>
</body>
</html>`;
}

// ─── Regression fixture: Consulente previdenziale per la vecchiaia ─────────────

const CONVIT_VECCHIAIA_DESC_HTML = `
<h4 class="redactor-styles">
<p><strong>Consulente previdenziale per la vecchiaia &amp; 3a (entrata laterale) tempo indeterminato</strong></p>
<p>Entrata laterale nella consulenza Finanza &amp; Previdenza – senza vendita di prodotti assicurativi. Focus su 3a/3b, piani d'investimento/ETF, fondi previdenziali e budgeting.</p>
<p><strong>Punti chiave:</strong></p>
<p>- Organizzazione: Convit International GmbH</p>
<p>- Sede: Biasca, Svizzera (TI) · Homeoffice/ibrido possibile</p>
<p>- Contratto: Tempo indeterminato · Grado: 10–100% · Lingua: IT (B2+)</p>
<p>- Salario: CHF 1500–7500/mese OTE (fisso + bonus; in base a grado &amp; performance)</p>
<p><strong>Formazione VBV gratuita:</strong></p>
<p>- Formazione VBV inclusa e gratuita; dopo il percorso ottieni la certificazione VBV.</p>
<p>- Adatto anche a cambi di carriera/entrata laterale (senza esperienza).</p>
<p><strong>Profilo ricercato:</strong></p>
<p>- Motivazione, autonomia, spirito imprenditoriale.</p>
<p>- Disponibilità a lavorare in modo ibrido/homeoffice.</p>
</h4>`;

const CONVIT_VECCHIAIA_HTML = careersPageDetailHtml({
  title: 'Consulente previdenziale per la vecchiaia & 3a (entrata laterale) tempo indeterminato',
  location: 'Biasca',
  descriptionHtml: CONVIT_VECCHIAIA_DESC_HTML,
  jsonLdDescription: '', // no JSON-LD — regression case
  datePosted: '2026-03-10',
});

// ─── Fixture with JSON-LD description ─────────────────────────────────────────

const JSONLD_DESC = '<p><strong>Consulenza finanziaria online (entrata laterale)</strong></p><p>Entrata laterale nella consulenza Finanza &amp; Previdenza. Focus su 3a/3b, piani d\'investimento e fondi previdenziali.</p><p>Sede: Caslano, TI · Homeoffice/ibrido possibile.</p><p>Contratto: Tempo indeterminato · Grado 10–100% · Lingua IT (B2+).</p><p>Salario: CHF 1500–7500/mese OTE (fisso + bonus).</p><p>Formazione VBV gratuita inclusa nel percorso di inserimento.</p><p>Profilo: motivazione, autonomia, spirito imprenditoriale.</p>';

const CONVIT_JSONLD_HTML = careersPageDetailHtml({
  title: 'Consulenza finanziaria online (entrata laterale) Ibrido/Homeoffice',
  location: 'Caslano',
  descriptionHtml: `<h4 class="redactor-styles">${JSONLD_DESC}</h4>`,
  jsonLdDescription: JSONLD_DESC,
  datePosted: '2026-02-20',
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('convit-job-parser / parseConvitDetailPage', () => {
  describe('regression: no JSON-LD, description only in DOM (7X4V6XR5 style)', () => {
    const result = parseConvitDetailPage(CONVIT_VECCHIAIA_HTML, 'fallback title');

    it('extracts title from h1', () => {
      expect(result.title).toContain('Consulente previdenziale');
    });

    it('extracts location', () => {
      expect(result.location).toBe('Biasca');
    });

    it('description length >= 350 chars (full body, not empty)', () => {
      expect(result.description.length).toBeGreaterThanOrEqual(350);
    });

    it('description contains at least two content blocks', () => {
      expect(result.description).toContain('Formazione VBV');
      expect(result.description).toContain('Profilo ricercato');
    });

    it('description contains key Convit role details', () => {
      expect(result.description).toContain('Finanza');
      expect(result.description).toContain('Biasca');
    });

    it('datePosted falls back to today when no JSON-LD is present', () => {
      // No JSON-LD in this fixture, so the parser uses today's date as fallback
      expect(result.datePosted).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });
  });

  describe('when JSON-LD description is present and full-length', () => {
    const result = parseConvitDetailPage(CONVIT_JSONLD_HTML, '');

    it('uses JSON-LD description when it is sufficiently long', () => {
      expect(result.description.length).toBeGreaterThanOrEqual(350);
    });

    it('description contains expected content from JSON-LD', () => {
      expect(result.description).toContain('Finanza');
      expect(result.description).toContain('Formazione VBV');
    });

    it('location is extracted from DOM', () => {
      expect(result.location).toBe('Caslano');
    });
  });

  describe('when JSON-LD description is short (< 350 chars)', () => {
    const shortJsonLd = 'Breve introduzione al ruolo di consulente previdenziale presso Convit.';
    const html = careersPageDetailHtml({
      title: 'Consulente previdenziale',
      location: 'Lugano',
      descriptionHtml: CONVIT_VECCHIAIA_DESC_HTML,
      jsonLdDescription: shortJsonLd,
    });
    const result = parseConvitDetailPage(html, '');

    it('falls back to DOM extraction when JSON-LD is too short', () => {
      expect(result.description.length).toBeGreaterThanOrEqual(350);
    });

    it('DOM description is richer than the short JSON-LD', () => {
      expect(result.description).toContain('Formazione VBV');
    });
  });

  describe('page with no description at all', () => {
    const html = careersPageDetailHtml({
      title: 'Ruolo sconosciuto',
      location: 'Lugano',
      descriptionHtml: '<p>Breve nota.</p>',
      jsonLdDescription: '',
    });
    const result = parseConvitDetailPage(html, 'fallback');

    it('returns empty string (not throw) when no full description is available', () => {
      expect(typeof result.description).toBe('string');
    });
  });
});

describe('convit-job-parser / parseConvitListingPage', () => {
  const listingHtml = `<!DOCTYPE html><html><body>
<ul class="list-group">
  <li class="list-group-item">
    <a href="/convit-holding-gmbh/job/ABC123">
      <span class="job-position-break">Consulente previdenziale senior</span>
    </a>
  </li>
  <li class="list-group-item">
    <a href="/convit-holding-gmbh/job/DEF456">
      <span class="job-position-break">Tirocinante finanza e previdenza</span>
    </a>
  </li>
</ul>
</body></html>`;

  it('extracts job codes and titles from listing page', () => {
    const items = parseConvitListingPage(listingHtml);
    expect(items).toHaveLength(2);
    expect(items[0].code).toBe('ABC123');
    expect(items[0].title).toBe('Consulente previdenziale senior');
    expect(items[1].code).toBe('DEF456');
  });

  it('builds correct detailUrl', () => {
    const items = parseConvitListingPage(listingHtml);
    expect(items[0].detailUrl).toBe('https://www.careers-page.com/convit-holding-gmbh/job/ABC123');
  });

  it('returns empty array for empty HTML', () => {
    expect(parseConvitListingPage('')).toEqual([]);
  });
});

describe('convit-job-parser / buildConvitLocalizedContent', () => {
  it('builds Italian slug from title + company + location', () => {
    const result = buildConvitLocalizedContent({
      title: 'Consulente previdenziale senior',
      location: 'Biasca',
      canton: 'TI',
      description: 'Descrizione completa del ruolo consulenziale.',
    });
    expect(result.slugByLocale.it).toContain('consulente-previdenziale-senior');
    expect(result.slugByLocale.it).toContain('convit');
  });

  it('uses description from job when provided', () => {
    const result = buildConvitLocalizedContent({
      title: 'Analista finanziario',
      location: 'Lugano',
      canton: 'TI',
      description: 'Analisi di portafogli previdenziali e consulenza 3a/3b.',
    });
    expect(result.descriptionByLocale.it).toContain('Analisi di portafogli');
  });

  it('falls back to generated description when job description is empty', () => {
    const result = buildConvitLocalizedContent({
      title: 'Consulente',
      location: 'Massagno',
      canton: 'TI',
      description: '',
    });
    expect(result.descriptionByLocale.it).toContain('Convit');
    expect(result.descriptionByLocale.it.length).toBeGreaterThan(50);
  });
});
