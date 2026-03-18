/**
 * Tests for scripts/lib/lidl-job-parser.mjs
 *
 * Verifies full-body extraction from team.lidl.ch detail page HTML,
 * including the two hard guards: >= 400 chars AND list content.
 *
 * Regression cases (FRO-72):
 *   - https://team.lidl.ch/de/jobs/verkaeufer-verkaeuferin-m-w-d-20-40-st-moritz-657113
 *   - https://team.lidl.ch/de/jobs/filialleiter-filialleiterin-m-w-d-80-100-st-moritz-656562
 */
import { describe, it, expect } from 'vitest';
import {
  parseLidlDetailPage,
  hasListContent,
  MIN_LIDL_FULL_DESC,
} from '../scripts/lib/lidl-job-parser.mjs';

// ─── Fixture helpers ──────────────────────────────────────────────────────────

function lidlDetailHtml({
  title = '',
  sections = [] as { heading: string; items: string[] }[],
  wrapperClass = 'job-detail__description',
} = {}) {
  const sectionsHtml = sections
    .map(
      ({ heading, items }) => `
      <div class="job-detail__section">
        <h2 class="job-detail__section-title">${heading}</h2>
        <div class="job-detail__section-content">
          <ul>
            ${items.map((item) => `<li>${item}</li>`).join('\n            ')}
          </ul>
        </div>
      </div>`,
    )
    .join('\n');

  return `<!DOCTYPE html>
<html lang="de">
<head><title>${title} | Lidl Svizzera Jobs</title></head>
<body>
<main>
  <h1>${title}</h1>
  <div class="${wrapperClass}">
    ${sectionsHtml}
  </div>
</main>
</body>
</html>`;
}

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const STORE_ASSISTANT_TITLE = 'Verkäufer/Verkäuferin (m/w/d) 20–40% – St. Moritz';
const STORE_MANAGER_TITLE = 'Filialleiter/Filialleiterin (m/w/d) 80–100% – St. Moritz';

const STORE_ASSISTANT_SECTIONS = [
  {
    heading: 'Das sind deine Aufgaben',
    items: [
      'Kassier- und Verkaufstätigkeiten sowie Kundenberatung im Verkauf',
      'Warenverräumung, -auszeichnung und -präsentation gemäß unseren Qualitätsstandards',
      'Sicherstellung von Sauberkeit und Ordnung im gesamten Verkaufsbereich',
      'Unterstützung bei der Warenannahme und Überprüfung der Lieferung',
    ],
  },
  {
    heading: 'Das bringst du mit',
    items: [
      'Erste Erfahrungen im Einzelhandel oder Gastronomie von Vorteil, aber kein Muss',
      'Freude am Umgang mit Kunden sowie serviceorientierte und kommunikative Persönlichkeit',
      'Zuverlässigkeit, Flexibilität und Teamgeist',
      'Bereitschaft zur Arbeit an Wochenenden und Feiertagen',
    ],
  },
  {
    heading: 'Das bieten wir dir',
    items: [
      'Einen sicheren Arbeitsplatz in einem dynamischen und wachsenden Unternehmen',
      'Attraktive Vergütung nach GAV Detailhandel mit jährlichen Lohnerhöhungen',
      'Rabatte in unseren Filialen sowie zahlreiche Mitarbeitervorteile',
      'Weiterbildungs- und Entwicklungsmöglichkeiten innerhalb von Lidl Schweiz',
      'Kollegiales Arbeitsumfeld in einem motivierten Team',
    ],
  },
];

const STORE_MANAGER_SECTIONS = [
  {
    heading: 'Das sind deine Aufgaben',
    items: [
      'Leitung und Motivation des Filialteams sowie Sicherstellung eines reibungslosen Filialbetriebs',
      'Verantwortung für Personalplanung, Einarbeitung und Weiterentwicklung der Mitarbeitenden',
      'Optimierung von Lager- und Bestandsmanagement sowie Disposition der Waren',
      'Umsetzung und Einhaltung der Unternehmensstandards und Qualitätsvorgaben',
      'Analyse von Verkaufszahlen und Ableitung von Maßnahmen zur Umsatzsteigerung',
    ],
  },
  {
    heading: 'Das bringst du mit',
    items: [
      'Abgeschlossene Ausbildung im Detailhandel oder vergleichbare kaufmännische Qualifikation',
      'Mindestens 2 Jahre Führungserfahrung im Einzelhandel oder verwandtem Bereich',
      'Ausgeprägte Führungsqualitäten, Kommunikationsstärke und Entscheidungsfreude',
      'Hohe Einsatzbereitschaft, Flexibilität und Belastbarkeit',
    ],
  },
  {
    heading: 'Das bieten wir dir',
    items: [
      'Attraktives Gehalt mit Erfolgsprämien und regelmäßigen Gehaltsanpassungen',
      'Umfangreiche Einarbeitung und gezielte Weiterbildungsmaßnahmen',
      'Firmenwagen (auch zur privaten Nutzung) sowie weitere Mitarbeitervorteile',
      'Entwicklungsmöglichkeiten in einem internationalen Handelskonzern',
    ],
  },
];

// ─── hasListContent ───────────────────────────────────────────────────────────

describe('hasListContent', () => {
  it('returns true for text with "- item" bullet lines', () => {
    expect(hasListContent('Title\n- First item\n- Second item')).toBe(true);
  });

  it('returns true for text with bullet at the very start', () => {
    expect(hasListContent('- Only item')).toBe(true);
  });

  it('returns false for plain paragraph text without bullets', () => {
    expect(hasListContent('This is just a short abstract without any structured list.')).toBe(false);
  });

  it('returns false for empty string', () => {
    expect(hasListContent('')).toBe(false);
  });
});

// ─── parseLidlDetailPage — Verkäufer/in store role ───────────────────────────

describe('parseLidlDetailPage / store assistant (Verkäufer/in)', () => {
  const html = lidlDetailHtml({ title: STORE_ASSISTANT_TITLE, sections: STORE_ASSISTANT_SECTIONS });
  const result = parseLidlDetailPage(html);

  it('extracts the job title from h1', () => {
    expect(result.title).toBe(STORE_ASSISTANT_TITLE);
  });

  it(`body length >= MIN_LIDL_FULL_DESC (${MIN_LIDL_FULL_DESC} chars)`, () => {
    expect(result.body.length).toBeGreaterThanOrEqual(MIN_LIDL_FULL_DESC);
  });

  it('meetsMinLength guard is true', () => {
    expect(result.meetsMinLength).toBe(true);
  });

  it('hasLists guard is true (list items preserved as "- " bullets)', () => {
    expect(result.hasLists).toBe(true);
  });

  it('body contains the Aufgaben section content', () => {
    expect(result.body).toContain('Kassier');
  });

  it('body contains the Profil section content', () => {
    expect(result.body).toContain('Teamgeist');
  });

  it('body contains the benefits section content', () => {
    expect(result.body).toContain('Weiterbildung');
  });

  it('body does NOT contain raw HTML tags', () => {
    expect(result.body).not.toMatch(/<[a-zA-Z]/);
  });
});

// ─── parseLidlDetailPage — Filialleiter/in store manager ─────────────────────

describe('parseLidlDetailPage / store manager (Filialleiter/in)', () => {
  const html = lidlDetailHtml({ title: STORE_MANAGER_TITLE, sections: STORE_MANAGER_SECTIONS });
  const result = parseLidlDetailPage(html);

  it('extracts the store manager title from h1', () => {
    expect(result.title).toBe(STORE_MANAGER_TITLE);
  });

  it(`body length >= MIN_LIDL_FULL_DESC (${MIN_LIDL_FULL_DESC} chars)`, () => {
    expect(result.body.length).toBeGreaterThanOrEqual(MIN_LIDL_FULL_DESC);
  });

  it('both guards pass: meetsMinLength and hasLists', () => {
    expect(result.meetsMinLength).toBe(true);
    expect(result.hasLists).toBe(true);
  });

  it('body contains responsibilities section', () => {
    expect(result.body).toContain('Filialteams');
  });

  it('body contains requirements section', () => {
    expect(result.body).toContain('Führungserfahrung');
  });
});

// ─── parseLidlDetailPage — fallback: richest-list element ────────────────────

describe('parseLidlDetailPage / fallback to richest-list element', () => {
  // No known selector matches — just a plain div with many <li>s
  const html = `<!DOCTYPE html><html><body>
<main>
  <h1>Apprendistato nel commercio al dettaglio – CFC/AFP</h1>
  <div class="unknown-container">
    <h2>Cosa farai</h2>
    <ul>
      <li>Vendita e assistenza alla clientela nei reparti</li>
      <li>Gestione delle merci: ricezione, sistemazione e controllo qualità</li>
      <li>Operazioni di cassa e pagamento elettronico</li>
      <li>Mantenimento dell'ordine e della pulizia nel punto vendita</li>
    </ul>
    <h2>Cosa cerchiamo</h2>
    <ul>
      <li>Scuola dell'obbligo completata, con buoni voti nelle materie pratiche</li>
      <li>Interesse per il commercio al dettaglio e il contatto con la clientela</li>
      <li>Disponibilità a lavorare su turni inclusi i fine settimana</li>
    </ul>
  </div>
</main>
</body></html>`;

  const result = parseLidlDetailPage(html);

  it('still extracts content via richest-list fallback', () => {
    expect(result.body.length).toBeGreaterThan(50);
    expect(result.hasLists).toBe(true);
  });

  it('extracts the title even without known-selector wrapper', () => {
    expect(result.title).toBe('Apprendistato nel commercio al dettaglio – CFC/AFP');
  });
});

// ─── parseLidlDetailPage — abstract-only page (guard rejection scenario) ─────

describe('parseLidlDetailPage / abstract-only page (guard rejection)', () => {
  const html = `<!DOCTYPE html><html><body>
<main>
  <h1>Verkäufer (m/w/d) – Locarno</h1>
  <div class="job-detail__description">
    <p>Wir suchen eine/n motivierte/n Verkäufer/in für unsere Filiale in Locarno.</p>
  </div>
</main>
</body></html>`;

  const result = parseLidlDetailPage(html);

  it('extracts title correctly', () => {
    expect(result.title).toBe('Verkäufer (m/w/d) – Locarno');
  });

  it('meetsMinLength is false when content is too short', () => {
    expect(result.meetsMinLength).toBe(false);
  });

  it('hasLists is false when there are no list items', () => {
    expect(result.hasLists).toBe(false);
  });

  it('body is still returned (caller decides whether to use it)', () => {
    expect(typeof result.body).toBe('string');
  });
});

// ─── parseLidlDetailPage — edge cases ────────────────────────────────────────

describe('parseLidlDetailPage / edge cases', () => {
  it('returns empty result for empty HTML', () => {
    const result = parseLidlDetailPage('');
    expect(result.title).toBe('');
    expect(result.body).toBe('');
    expect(result.hasLists).toBe(false);
    expect(result.meetsMinLength).toBe(false);
  });

  it('works with rte-text selector alternative', () => {
    const html = `<!DOCTYPE html><html><body>
<h1>Logistiker/in EFZ – Locarno</h1>
<div class="rte-text">
  <h2>Aufgaben</h2>
  <ul><li>Warenannahme und Kontrolle</li><li>Einlagerung nach System</li><li>Kommissionierung und Verpackung für Filialen</li></ul>
  <h2>Anforderungen</h2>
  <ul><li>EFZ Logistik oder vergleichbare Ausbildung</li><li>Staplerschein von Vorteil</li></ul>
  <h2>Wir bieten</h2>
  <ul><li>Moderne Arbeitsmittel</li><li>Kollegiales Team</li><li>Weiterentwicklungsmöglichkeiten</li></ul>
</div>
</body></html>`;
    const result = parseLidlDetailPage(html);
    expect(result.title).toBe('Logistiker/in EFZ – Locarno');
    expect(result.hasLists).toBe(true);
  });
});
