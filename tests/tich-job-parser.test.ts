/**
 * Tests for scripts/lib/tich-job-parser.mjs
 *
 * Verifies:
 *   - parseTichDetailPage: extracts the real concorso title (not institutional header)
 *   - parseTichDetailPage: extracts the FULL body including all sections
 *   - titleOverlap: Jaccard similarity scoring for mismatch detection
 *
 * Regression cases (FRO-70):
 *   - https://www.concorsi.ti.ch/offerte-d'impieghi.html?yid=4117
 *     (apprendista operatrice/tore di edifici — institutional h1, real title in h2/h3)
 *   - https://www.concorsi.ti.ch/offerte-d'impieghi.html?yid=3994
 *     (collaboratori/trici amministrativi — short body, full sections present)
 */
import { describe, it, expect } from 'vitest';
import {
  parseTichDetailPage,
  titleOverlap,
  MIN_TICH_DESC_LENGTH,
} from '../scripts/lib/tich-job-parser.mjs';

// ─── Fixture helpers ──────────────────────────────────────────────────────────

/**
 * Build a Rexx Systems Portal 7 style concorso detail page.
 *
 * Structure:
 *   <title>{pageTitle}</title>
 *   <h1>{institutionalH1}</h1>    ← should be SKIPPED for title extraction
 *   <h2>{institutionalH2}</h2>    ← also skip (e.g. "Sezione delle risorse umane")
 *   <h3>Concorsi per la nomina</h3> ← skip
 *   <h3>{concosoTitle}</h3>       ← THIS is the real title
 *   <div class="jobOffer">
 *     <div class="job-section"><h4>Compiti</h4><p>…</p></div>
 *     <div class="job-section"><h4>Requisiti</h4><ul>…</ul></div>
 *     …
 *   </div>
 */
function rexxDetailHtml({
  pageTitle = '',
  institutionalH1 = 'Repubblica e Cantone Ticino',
  institutionalH2 = 'Sezione delle risorse umane',
  concosoTitle = '',
  sections = [] as { heading: string; content: string }[],
  useJobOfferDiv = true,
} = {}) {
  const sectionsHtml = sections
    .map(
      ({ heading, content }) => `
    <div class="job-section">
      <h4>${heading}</h4>
      ${content}
    </div>`,
    )
    .join('\n');

  const jobBodyHtml = useJobOfferDiv
    ? `<div class="jobOffer">${sectionsHtml}</div>`
    : sectionsHtml;

  return `<!DOCTYPE html>
<html lang="it">
<head>
  <title>${pageTitle}</title>
</head>
<body>
<div id="page-header">
  <h1>${institutionalH1}</h1>
  <h2>${institutionalH2}</h2>
</div>
<div id="content">
  <h3>Concorsi per la nomina</h3>
  <p>Numero concorso: 5/25</p>
  <h3>${concosoTitle}</h3>
  ${jobBodyHtml}
</div>
</body>
</html>`;
}

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const APPRENDISTA_TITLE =
  "Apprendista operatrice/tore di edifici e infrastrutture AFC per il periodo dal 31 agosto 2026 al 30 agosto 2029 presso il Servizio Economa";

const COLLABORATORI_TITLE =
  "Concorso Generale 2026: Collaboratori/trici Amministrativi/e e Addetti/e al servizio accoglienza, Addetti/e agli assicurati III, Consulenti telefonici";

const APPRENDISTA_SECTIONS = [
  {
    heading: 'Compiti',
    content: `<p>Il/La candidato/a parteciperà alle attività del Servizio Economa del Dipartimento delle istituzioni,
    occupandosi della manutenzione ordinaria degli edifici e delle infrastrutture cantonali.</p>
    <ul>
      <li>Pulizia e manutenzione di locali e spazi comuni</li>
      <li>Controllo periodico degli impianti tecnici e di sicurezza</li>
      <li>Supporto ai tecnici nella gestione degli interventi di riparazione</li>
      <li>Segnalazione tempestiva di guasti e anomalie</li>
    </ul>`,
  },
  {
    heading: 'Requisiti',
    content: `<ul>
      <li>Licenza scolastica obbligatoria conseguita o in via di conseguimento</li>
      <li>Buona conoscenza della lingua italiana</li>
      <li>Attitudine al lavoro manuale e attenzione alla cura dei dettagli</li>
      <li>Affidabilità, puntualità e spirito di squadra</li>
    </ul>`,
  },
  {
    heading: 'Condizioni',
    content: `<p>Contratto di apprendistato triennale dal 31 agosto 2026 al 30 agosto 2029.
    Sede di lavoro: Bellinzona (Canton Ticino). Stipendio secondo le norme cantonali per apprendisti.</p>`,
  },
  {
    heading: 'Scadenza',
    content: `<p>Le candidature devono essere inviate entro il 15 aprile 2026 tramite il portale online.</p>`,
  },
];

const COLLABORATORI_SECTIONS = [
  {
    heading: 'Profilo ricercato',
    content: `<p>Siamo alla ricerca di candidati motivati e orientati al servizio per rinforzare
    il team dell'Ufficio AI (Assicurazioni e Invalidità).</p>
    <ul>
      <li>Diploma di scuola media superiore o formazione professionale equivalente</li>
      <li>Esperienza precedente in ambito amministrativo o in un call center è un vantaggio</li>
      <li>Eccellenti capacità comunicative verbali e scritte in italiano</li>
      <li>Conoscenza di una seconda lingua nazionale (tedesco o francese) è apprezzata</li>
      <li>Familiarità con gli strumenti informatici (pacchetto Office)</li>
    </ul>`,
  },
  {
    heading: 'Mansioni',
    content: `<ul>
      <li>Accoglienza e orientamento dei cittadini che si recano allo sportello</li>
      <li>Gestione delle telefonate in entrata e risposta a quesiti relativi alle prestazioni sociali</li>
      <li>Supporto amministrativo ai consulenti di III livello nella gestione delle pratiche</li>
      <li>Archiviazione e aggiornamento delle banche dati interne</li>
    </ul>`,
  },
  {
    heading: 'Condizioni di impiego',
    content: `<p>Posizioni a tempo pieno e part-time disponibili. Sede principale: Lugano.
    Contratto a tempo determinato con possibilità di rinnovo. Inquadramento secondo la tabella stipendiale
    del personale dell'Amministrazione cantonale.</p>`,
  },
  {
    heading: 'Osservazioni',
    content: `<p>I candidati idonei saranno convocati per un colloquio nelle settimane successive alla scadenza.
    Si prega di allegare lettera di motivazione, CV aggiornato e certificati.</p>`,
  },
];

// ─── titleOverlap ─────────────────────────────────────────────────────────────

describe('titleOverlap', () => {
  it('returns 1 for identical strings', () => {
    expect(titleOverlap('Apprendista edifici', 'Apprendista edifici')).toBe(1);
  });

  it('returns 0 for completely different strings', () => {
    expect(titleOverlap('Apprendista', 'Collaboratore')).toBe(0);
  });

  it('returns partial overlap for partial matches', () => {
    const score = titleOverlap('Apprendista edifici AFC', 'Apprendista edifici');
    expect(score).toBeGreaterThan(0.5);
    expect(score).toBeLessThan(1);
  });

  it('handles empty strings without throwing', () => {
    expect(titleOverlap('', '')).toBe(1);
    expect(titleOverlap('Apprendista', '')).toBe(0);
    expect(titleOverlap('', 'Apprendista')).toBe(0);
  });

  it('detects low overlap between institutional title and real title', () => {
    const institutionalTitle = 'Offerte d\'impieghi Jobportal';
    const realTitle = APPRENDISTA_TITLE;
    const score = titleOverlap(institutionalTitle, realTitle);
    // Overlap must be very low — "offerte" is the only possible hit
    expect(score).toBeLessThan(0.3);
  });

  it('detects high overlap for same title with minor variation', () => {
    const titleA = 'Apprendista operatrice/tore di edifici e infrastrutture AFC';
    const titleB = 'Apprendista operatrice tore di edifici e infrastrutture AFC Bellinzona';
    const score = titleOverlap(titleA, titleB);
    expect(score).toBeGreaterThanOrEqual(0.7);
  });
});

// ─── parseTichDetailPage — apprendista regression (FRO-70 yid=4117) ──────────

describe('parseTichDetailPage / apprendista operatrice/tore (title_mismatch)', () => {
  const html = rexxDetailHtml({
    pageTitle: 'Offerta di lavoro | Portal 7 - Jobportal',
    concosoTitle: APPRENDISTA_TITLE,
    sections: APPRENDISTA_SECTIONS,
  });
  const result = parseTichDetailPage(html);

  it('skips the institutional h1 and returns the real concorso title', () => {
    expect(result.title).not.toMatch(/Repubblica/i);
    expect(result.title).not.toMatch(/Sezione delle risorse/i);
    expect(result.title).toContain('Apprendista');
    expect(result.title).toContain('edifici');
  });

  it(`body length >= MIN_TICH_DESC_LENGTH (${MIN_TICH_DESC_LENGTH} chars)`, () => {
    expect(result.body.length).toBeGreaterThanOrEqual(MIN_TICH_DESC_LENGTH);
  });

  it('body contains the Compiti section', () => {
    expect(result.body).toContain('Compiti');
    expect(result.body).toContain('manutenzione');
  });

  it('body contains the Requisiti section', () => {
    expect(result.body).toContain('Requisiti');
    expect(result.body).toContain('Licenza scolastica');
  });

  it('body contains the Scadenza section', () => {
    expect(result.body).toContain('Scadenza');
    expect(result.body).toContain('aprile 2026');
  });

  it('body does NOT contain raw HTML tags', () => {
    expect(result.body).not.toMatch(/<[a-zA-Z]/);
  });

  it('sourceBodyLength equals body.length', () => {
    expect(result.sourceBodyLength).toBe(result.body.length);
  });
});

// ─── parseTichDetailPage — collaboratori regression (FRO-70 yid=3994) ────────

describe('parseTichDetailPage / collaboratori/trici amministrativi (short_body)', () => {
  const html = rexxDetailHtml({
    pageTitle: 'Concorso Generale 2026 | Jobportal',
    concosoTitle: COLLABORATORI_TITLE,
    sections: COLLABORATORI_SECTIONS,
  });
  const result = parseTichDetailPage(html);

  it('extracts the concorso title', () => {
    expect(result.title).toContain('Concorso Generale 2026');
    expect(result.title).not.toMatch(/Offerte d'impieghi/i);
  });

  it(`body length >= MIN_TICH_DESC_LENGTH (${MIN_TICH_DESC_LENGTH} chars)`, () => {
    expect(result.body.length).toBeGreaterThanOrEqual(MIN_TICH_DESC_LENGTH);
  });

  it('body contains all 4 original source sections (Profilo, Mansioni, Condizioni, Osservazioni)', () => {
    expect(result.body).toContain('Profilo');
    expect(result.body).toContain('Mansioni');
    expect(result.body).toContain('Condizioni');
    expect(result.body).toContain('Osservazioni');
  });

  it('body contains content from all sections (not just the first)', () => {
    expect(result.body).toContain('Accoglienza'); // Mansioni
    expect(result.body).toContain('candidati idonei'); // Osservazioni
  });
});

// ─── parseTichDetailPage — page title as job title ───────────────────────────

describe('parseTichDetailPage / page <title> contains real job title', () => {
  it('uses page <title> when it contains the actual job title (not institutional)', () => {
    const html = rexxDetailHtml({
      pageTitle: 'Responsabile Amministrativo | Jobportal',
      concosoTitle: 'Responsabile Amministrativo',
      sections: [
        {
          heading: 'Mansioni',
          content: '<p>Gestione dei processi amministrativi del dipartimento.</p>',
        },
      ],
    });
    const result = parseTichDetailPage(html);
    expect(result.title).toContain('Responsabile Amministrativo');
    expect(result.title).not.toContain('Jobportal');
  });
});

// ─── parseTichDetailPage — page with no .jobOffer container ──────────────────

describe('parseTichDetailPage / no .jobOffer container (fallback)', () => {
  it('falls back to generic content extraction when no specific selector matches', () => {
    const html = `<!DOCTYPE html><html><body>
<div id="page-header">
  <h1>Repubblica e Cantone Ticino</h1>
</div>
<div id="content">
  <h3>Medico cantonale</h3>
  <p>Il Dipartimento della sanità e socialità cerca un Medico cantonale con comprovata
  esperienza in medicina pubblica e gestione di sistemi sanitari regionali.</p>
  <p>Requisiti: Laurea in medicina, specializzazione in sanità pubblica, almeno 10 anni di
  esperienza in ruoli dirigenziali nel settore sanitario pubblico.</p>
  <p>Scadenza candidature: 30 aprile 2026. Sede: Bellinzona.</p>
</div>
</body></html>`;
    const result = parseTichDetailPage(html);
    expect(result.title).toContain('Medico cantonale');
    expect(result.title).not.toMatch(/Repubblica/i);
    expect(result.body.length).toBeGreaterThan(50);
    expect(result.body).toContain('medicina');
  });
});

// ─── parseTichDetailPage — edge cases ────────────────────────────────────────

describe('parseTichDetailPage / edge cases', () => {
  it('returns empty result for empty HTML', () => {
    const result = parseTichDetailPage('');
    expect(result.title).toBe('');
    expect(result.body).toBe('');
    expect(result.sourceBodyLength).toBe(0);
  });

  it('handles page with only institutional headers — title stays empty or non-institutional', () => {
    const html = `<!DOCTYPE html><html><body>
<h1>Repubblica e Cantone Ticino</h1>
<h2>Sezione delle risorse umane</h2>
<h3>Concorsi per la nomina</h3>
<p>5/25</p>
</body></html>`;
    const result = parseTichDetailPage(html);
    // Must not set any institutional text as title
    if (result.title) {
      expect(result.title).not.toMatch(/Repubblica/i);
      expect(result.title).not.toMatch(/Concorsi per la nomina/i);
    }
  });

  it('titleOverlap detects mismatch between institutional title and real title', () => {
    // Simulates the guard: if overlap < 0.4, the enricher replaces the title
    const badTitle = "Offerte d'impieghi";
    const realTitle = APPRENDISTA_TITLE;
    expect(titleOverlap(badTitle, realTitle)).toBeLessThan(0.4);
  });

  it('25% guard scenario: short API description is less than 25% of sourceBodyLength', () => {
    const html = rexxDetailHtml({
      concosoTitle: 'Funzionario Cantonale',
      sections: APPRENDISTA_SECTIONS,
    });
    const result = parseTichDetailPage(html);
    const shortDesc = 'Funzionario cantonale per il Dipartimento.';
    // Guard: shortDesc.length < 0.25 * result.sourceBodyLength
    expect(shortDesc.length).toBeLessThan(0.25 * result.sourceBodyLength);
  });
});
