/**
 * SBB (FFS – Ferrovie Federali Svizzere) detail page parser tests
 *
 * Tests parseSbbDetailPage(), buildJsonLdDescription(), extractSbbHtmlSections(),
 * extractSbbJsonLd(), stripHtml() using HTML fixtures.
 *
 * Regression case: "Dirigente Team Controllo Qualità (M/F/D)"
 *   https://jobs.sbb.ch/v2/offene-stellen/dirigente-team-controllo-qualita-m-f-d/f40a8456-69e6-4d3f-ad9a-8b7803d10227
 *   — published description was shorter than the source vacancy because only the
 *     JSON-LD `description` teaser was read; structured HTML sections were ignored.
 *   — fix: extract HTML sections and prefer them when they are materially longer.
 */
import { describe, it, expect } from 'vitest';

// @ts-expect-error — ESM .mjs module
import {
  parseSbbDetailPage,
  buildJsonLdDescription,
  extractSbbHtmlSections,
  extractSbbJsonLd,
  stripHtml,
  MIN_SBB_DESC_LENGTH,
} from '@/scripts/lib/sbb-job-parser.mjs';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

/**
 * Regression fixture: jobs.sbb.ch detail page for "Dirigente Team Controllo Qualità".
 * JSON-LD description is a short teaser; full content is in HTML sections.
 */
const FIXTURE_DIRIGENTE_HTML = `<!DOCTYPE html>
<html lang="it">
<head>
  <title>Dirigente Team Controllo Qualità (M/F/D) | Jobs SBB</title>
  <script type="application/ld+json">
  {
    "@context": "https://schema.org/",
    "@type": "JobPosting",
    "title": "Dirigente Team Controllo Qualità (M/F/D)",
    "description": "<p>Siamo alla ricerca di un/una Dirigente Team Controllo Qualità per le Officine FFS di Bellinzona.</p>",
    "datePosted": "2026-01-15",
    "validThrough": "2026-03-15",
    "jobLocation": {
      "@type": "Place",
      "address": {
        "@type": "PostalAddress",
        "addressLocality": "Bellinzona",
        "addressCountry": "CH"
      }
    },
    "hiringOrganization": {
      "@type": "Organization",
      "name": "SBB FFS CFF"
    }
  }
  </script>
</head>
<body>
  <header><nav>Jobs | Karriere</nav></header>
  <main>
    <h1>Dirigente Team Controllo Qualità (M/F/D), Bellinzona</h1>
    <article>
      <p>Siamo alla ricerca di un/una Dirigente Team Controllo Qualità per le Officine FFS di Bellinzona. La persona sarà responsabile della qualità nel settore della manutenzione ferroviaria pesante.</p>

      <h2>Il tuo compito</h2>
      <ul>
        <li>Dirigere e motivare un team di 8–10 collaboratori nel reparto controllo qualità</li>
        <li>Pianificare e coordinare le attività di ispezione e collaudo dei mezzi ferroviari</li>
        <li>Garantire il rispetto degli standard di qualità, sicurezza e normative ferroviarie (EN 15085, ISO 9001)</li>
        <li>Collaborare con i reparti di manutenzione e produzione per il miglioramento continuo dei processi</li>
        <li>Redigere rapporti di qualità e documentazione tecnica per la direzione</li>
      </ul>

      <h2>Il tuo profilo</h2>
      <ul>
        <li>Diploma universitario o di scuola universitaria professionale in ingegneria della produzione, meccanica o simile</li>
        <li>Esperienza pluriennale (min. 3 anni) nella direzione di un team in ambito qualità o produzione</li>
        <li>Conoscenza approfondita delle norme di qualità ISO 9001, EN 15085 o equivalenti</li>
        <li>Buona padronanza dell'italiano; conoscenza del tedesco è un vantaggio</li>
        <li>Capacità analitiche, orientamento ai risultati e comunicazione efficace</li>
      </ul>

      <h2>Cosa offriamo</h2>
      <ul>
        <li>Ambiente di lavoro innovativo in una delle principali aziende ferroviarie europee</li>
        <li>Formazione continua e opportunità di sviluppo professionale</li>
        <li>Condizioni di lavoro attrattive con benefit aziendali</li>
        <li>Uffici moderni a Bellinzona con ottimi collegamenti di trasporto pubblico</li>
      </ul>
    </article>
  </main>
  <footer>© SBB FFS CFF 2026</footer>
</body>
</html>`;

/** Page where JSON-LD has all content (no HTML sections truncation issue). */
const FIXTURE_FULL_JSONLD_HTML = `<!DOCTYPE html>
<html lang="it">
<head>
  <script type="application/ld+json">
  {
    "@context": "https://schema.org/",
    "@type": "JobPosting",
    "title": "Macchinista Ferroviario (M/F/D)",
    "description": "<p>Conduci treni regionali e intercity sulla rete FFS in Ticino. Sei responsabile della sicurezza dei passeggeri e del rispetto degli orari.</p><p>Questo è un ruolo di grande responsabilità che richiede concentrazione e precisione.</p>",
    "qualifications": "<ul><li>Patente di guida categoria B</li><li>Disponibilità ai turni inclusi festivi e notturni</li><li>Buona padronanza dell'italiano o del tedesco</li><li>Nessuna controindicazione medica per la conduzione di veicoli ferroviari</li></ul>",
    "datePosted": "2026-02-01",
    "jobLocation": {
      "@type": "Place",
      "address": { "addressLocality": "Lugano" }
    }
  }
  </script>
</head>
<body>
  <h1>Macchinista Ferroviario (M/F/D)</h1>
</body>
</html>`;

/** Page with no JSON-LD and only HTML sections. */
const FIXTURE_HTML_ONLY = `<!DOCTYPE html>
<html lang="it">
<head><title>Tecnico Manutenzione | SBB</title></head>
<body>
  <h1>Tecnico Manutenzione Impianti, Chiasso</h1>
  <main>
    <p>Cerchiamo un tecnico per la manutenzione degli impianti ferroviari nel nodo di Chiasso.</p>
    <h2>Responsabilità</h2>
    <ul>
      <li>Manutenzione preventiva e correttiva degli impianti di segnalamento</li>
      <li>Esecuzione di ispezioni periodiche secondo le procedure SBB</li>
      <li>Collaborazione con il team tecnico per interventi di emergenza</li>
    </ul>
    <h2>Requisiti</h2>
    <ul>
      <li>Diploma AFC come elettricista o tecnico in automazione</li>
      <li>Disponibilità a lavoro su turni e reperibilità</li>
      <li>Patente di guida categoria B</li>
    </ul>
  </main>
</body>
</html>`;

/** Page with no title — should return empty title. */
const FIXTURE_NO_TITLE_HTML = `<!DOCTYPE html>
<html>
<head>
  <script type="application/ld+json">{"@type":"JobPosting","description":"<p>Some job.</p>"}</script>
</head>
<body><p>Content here.</p></body>
</html>`;

/** Page with navigation headings that should be skipped. */
const FIXTURE_NAV_HEADINGS_HTML = `<!DOCTYPE html>
<html lang="it">
<head>
  <script type="application/ld+json">
  {
    "@type": "JobPosting",
    "title": "Analista Dati (M/F/D)",
    "description": "<p>Analisi dati per i sistemi informativi FFS.</p>",
    "jobLocation": { "@type": "Place", "address": { "addressLocality": "Bellinzona" } }
  }
  </script>
</head>
<body>
  <nav><h2>Menu</h2><h2>Home</h2><h2>Jobs</h2></nav>
  <main>
    <h1>Analista Dati (M/F/D)</h1>
    <h2>Il tuo compito</h2>
    <p>Sviluppare modelli di analisi dati per ottimizzare i processi operativi delle Officine FFS di Bellinzona.</p>
    <p>Collaborare con i team di ingegneria per identificare opportunità di miglioramento basate sui dati.</p>
    <h2>Requisiti</h2>
    <ul>
      <li>Laurea in informatica, statistica o ingegneria</li>
      <li>Esperienza con Python o R per l'analisi dei dati</li>
      <li>Conoscenza di SQL e database relazionali</li>
    </ul>
  </main>
  <footer><h2>Cookie</h2></footer>
</body>
</html>`;

// ─── parseSbbDetailPage — regression ──────────────────────────────────────────

describe(`parseSbbDetailPage — MIN_SBB_DESC_LENGTH is ${MIN_SBB_DESC_LENGTH}`, () => {
  it('MIN_SBB_DESC_LENGTH equals 400', () => {
    expect(MIN_SBB_DESC_LENGTH).toBe(400);
  });
});

describe('parseSbbDetailPage — Dirigente Controllo Qualità regression', () => {
  it('returns a non-null result with a title', () => {
    const result = parseSbbDetailPage(FIXTURE_DIRIGENTE_HTML);
    expect(result.title).toBe('Dirigente Team Controllo Qualità (M/F/D)');
  });

  it(`produces a description >= ${MIN_SBB_DESC_LENGTH} characters`, () => {
    const result = parseSbbDetailPage(FIXTURE_DIRIGENTE_HTML);
    expect(result.description.length).toBeGreaterThanOrEqual(MIN_SBB_DESC_LENGTH);
  });

  it('includes HTML section content (not just the JSON-LD teaser)', () => {
    const result = parseSbbDetailPage(FIXTURE_DIRIGENTE_HTML);
    expect(result.description).toContain('Dirigere e motivare un team');
    expect(result.description).toContain('ISO 9001');
    expect(result.description).toContain('Formazione continua');
  });

  it('includes the section headings', () => {
    const result = parseSbbDetailPage(FIXTURE_DIRIGENTE_HTML);
    expect(result.description).toContain('Il tuo compito');
    expect(result.description).toContain('Il tuo profilo');
    expect(result.description).toContain('Cosa offriamo');
  });

  it('extracts the location from JSON-LD', () => {
    const result = parseSbbDetailPage(FIXTURE_DIRIGENTE_HTML);
    expect(result.location).toBe('Bellinzona');
  });

  it('emits no warnings for a full-content page', () => {
    const result = parseSbbDetailPage(FIXTURE_DIRIGENTE_HTML);
    expect(result.warnings).toHaveLength(0);
  });
});

// ─── parseSbbDetailPage — JSON-LD fallback ────────────────────────────────────

describe('parseSbbDetailPage — JSON-LD-only page', () => {
  it('uses JSON-LD when HTML has no structured sections', () => {
    const result = parseSbbDetailPage(FIXTURE_FULL_JSONLD_HTML);
    expect(result.description).toContain('Conduci treni regionali');
    expect(result.description).toContain('Patente di guida categoria B');
  });

  it('extracts title from JSON-LD', () => {
    const result = parseSbbDetailPage(FIXTURE_FULL_JSONLD_HTML);
    expect(result.title).toBe('Macchinista Ferroviario (M/F/D)');
  });

  it('extracts location from JSON-LD', () => {
    const result = parseSbbDetailPage(FIXTURE_FULL_JSONLD_HTML);
    expect(result.location).toBe('Lugano');
  });
});

// ─── parseSbbDetailPage — HTML-only page ─────────────────────────────────────

describe('parseSbbDetailPage — HTML-only page (no JSON-LD)', () => {
  it('extracts sections from HTML when no JSON-LD is present', () => {
    const result = parseSbbDetailPage(FIXTURE_HTML_ONLY);
    expect(result.description).toContain('Manutenzione preventiva');
    expect(result.description).toContain('Diploma AFC');
  });

  it('includes section headings from HTML', () => {
    const result = parseSbbDetailPage(FIXTURE_HTML_ONLY);
    expect(result.description).toContain('Responsabilità');
    expect(result.description).toContain('Requisiti');
  });

  it('extracts location from h1 comma-split when no JSON-LD', () => {
    const result = parseSbbDetailPage(FIXTURE_HTML_ONLY);
    expect(result.location).toBe('Chiasso');
  });
});

// ─── parseSbbDetailPage — navigation heading guard ───────────────────────────

describe('parseSbbDetailPage — navigation heading guard', () => {
  it('skips nav/footer headings (Menu, Home, Jobs, Cookie)', () => {
    const result = parseSbbDetailPage(FIXTURE_NAV_HEADINGS_HTML);
    expect(result.description).not.toContain('## Menu');
    expect(result.description).not.toContain('## Home');
    expect(result.description).not.toContain('## Jobs');
    expect(result.description).not.toContain('## Cookie');
  });

  it('keeps real vacancy section headings', () => {
    const result = parseSbbDetailPage(FIXTURE_NAV_HEADINGS_HTML);
    expect(result.description).toContain('Il tuo compito');
    expect(result.description).toContain('Requisiti');
  });
});

// ─── parseSbbDetailPage — guards ──────────────────────────────────────────────

describe('parseSbbDetailPage — guards', () => {
  it('returns empty title when no title is present', () => {
    const result = parseSbbDetailPage(FIXTURE_NO_TITLE_HTML);
    expect(result.title).toBe('');
  });

  it('returns empty strings and empty arrays for empty input', () => {
    const result = parseSbbDetailPage('');
    expect(result.title).toBe('');
    expect(result.description).toBe('');
    expect(result.requirements).toHaveLength(0);
    expect(result.location).toBe('');
  });

  it('emits a warning when description is short', () => {
    const result = parseSbbDetailPage(FIXTURE_NO_TITLE_HTML);
    // "Some job." is < 400 chars, so a warning should be emitted
    expect(result.warnings.some((w: string) => w.includes('too short'))).toBe(true);
  });
});

// ─── extractSbbHtmlSections ────────────────────────────────────────────────────

describe('extractSbbHtmlSections', () => {
  it('extracts h2 section headings and their content', () => {
    const html = `<h2>Il tuo compito</h2><ul><li>Dirigere il team di qualità</li></ul>
                  <h2>Il tuo profilo</h2><p>Esperienza richiesta.</p>`;
    const result = extractSbbHtmlSections(html);
    expect(result).toContain('## Il tuo compito');
    expect(result).toContain('Dirigere il team di qualità');
    expect(result).toContain('## Il tuo profilo');
    expect(result).toContain('Esperienza richiesta');
  });

  it('extracts h3 section headings', () => {
    const html = `<h3>Compiti principali</h3><p>Gestione della qualità nel reparto.</p>`;
    const result = extractSbbHtmlSections(html);
    expect(result).toContain('## Compiti principali');
    expect(result).toContain('Gestione della qualità');
  });

  it('skips sections with empty body', () => {
    const html = `<h2>Empty Section</h2><h2>Full Section</h2><p>Content here in the section.</p>`;
    const result = extractSbbHtmlSections(html);
    expect(result).not.toContain('## Empty Section');
    expect(result).toContain('## Full Section');
  });

  it('strips nav content', () => {
    const html = `<nav><h2>Navigation</h2><ul><li>Home</li></ul></nav>
                  <h2>Il ruolo</h2><p>Descrizione del ruolo disponibile.</p>`;
    const result = extractSbbHtmlSections(html);
    expect(result).not.toContain('Navigation');
    expect(result).toContain('Il ruolo');
  });

  it('returns empty string for empty input', () => {
    expect(extractSbbHtmlSections('')).toBe('');
  });
});

// ─── buildJsonLdDescription ────────────────────────────────────────────────────

describe('buildJsonLdDescription', () => {
  it('combines description and qualifications from JSON-LD', () => {
    const result = buildJsonLdDescription({
      description: '<p>We are looking for a qualified engineer.</p>',
      qualifications: '<ul><li>Engineering degree</li><li>5 years experience</li></ul>',
    });
    expect(result).toContain('We are looking for a qualified engineer');
    expect(result).toContain('Engineering degree');
  });

  it('deduplicates blocks that are subsets of each other', () => {
    const result = buildJsonLdDescription({
      description: '<p>We are looking for a qualified engineer with 5 years experience.</p>',
      qualifications: '<p>We are looking for a qualified engineer with 5 years experience.</p>',
    });
    // Should not repeat the same content
    const count = result.split('qualified engineer').length - 1;
    expect(count).toBe(1);
  });

  it('returns empty string for null input', () => {
    expect(buildJsonLdDescription(null)).toBe('');
    expect(buildJsonLdDescription(undefined)).toBe('');
  });

  it('returns empty string for all-empty fields', () => {
    expect(buildJsonLdDescription({ description: '', qualifications: '' })).toBe('');
  });
});

// ─── extractSbbJsonLd ──────────────────────────────────────────────────────────

describe('extractSbbJsonLd', () => {
  it('extracts JobPosting from inline script', () => {
    const html = `<script type="application/ld+json">
      {"@type":"JobPosting","title":"Ingegnere FFS","datePosted":"2026-01-01"}
    </script>`;
    const result = extractSbbJsonLd(html);
    expect(result?.['@type']).toBe('JobPosting');
    expect(result?.title).toBe('Ingegnere FFS');
  });

  it('extracts from @graph array', () => {
    const html = `<script type="application/ld+json">
      {"@context":"https://schema.org/","@graph":[
        {"@type":"WebSite","name":"SBB"},
        {"@type":"JobPosting","title":"Macchinista","datePosted":"2026-01-01"}
      ]}
    </script>`;
    const result = extractSbbJsonLd(html);
    expect(result?.['@type']).toBe('JobPosting');
    expect(result?.title).toBe('Macchinista');
  });

  it('returns null when no JSON-LD is present', () => {
    expect(extractSbbJsonLd('<html><body><p>No JSON-LD here.</p></body></html>')).toBeNull();
  });

  it('returns null for empty input', () => {
    expect(extractSbbJsonLd('')).toBeNull();
  });
});

// ─── stripHtml ─────────────────────────────────────────────────────────────────

describe('stripHtml', () => {
  it('removes HTML tags', () => {
    expect(stripHtml('<p>Hello <b>world</b></p>')).toBe('Hello world');
  });

  it('converts <li> to bullet line', () => {
    const result = stripHtml('<ul><li>Item one</li><li>Item two</li></ul>');
    expect(result).toContain('- Item one');
    expect(result).toContain('- Item two');
  });

  it('decodes HTML entities', () => {
    expect(stripHtml('AT&amp;T &mdash; Qualit&agrave;')).toContain('AT&T');
    expect(stripHtml('AT&amp;T &mdash; Qualit&agrave;')).toContain('Qualità');
  });

  it('returns empty string for empty input', () => {
    expect(stripHtml('')).toBe('');
  });
});
