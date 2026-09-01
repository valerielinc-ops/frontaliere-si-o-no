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
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import {
  parseLidlDetailPage,
  hasListContent,
  MIN_LIDL_FULL_DESC,
  LIDL_SEARCH_API_BASE,
  LIDL_SEARCH_JOBS_KEY,
  LIDL_DEFAULT_RESULTS_PER_PAGE,
  buildLidlSearchQuery,
  getLidlSearchPageCount,
  extractLidlApiHitFields,
} from '../scripts/lib/lidl-job-parser.mjs';
import {
  assertLidlAdapterParity,
  ensureAdapterSeedUrls,
  fetchLidlJobDetailUrls,
} from '../scripts/update-lidl-jobs.mjs';

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

// ---------------------------------------------------------------------------
// LiCa search-API contract (regression guard for issue #3063)
//
// Lidl migrated team.lidl.ch to the LiCa SPA platform: the legacy endpoint
// GET /it/search_api/jobsearch (result.hits[] / result.pageCount) was retired
// and now 404s, so the crawler returned 0 jobs for 3 consecutive runs. The new
// endpoint is GET /it/api/v1/search?general={"page":N,...} -> { jobs[], meta }.
// These tests pin the new contract so a future rename fails loudly here instead
// of silently emptying a 350+ job CH-wide source.
// ---------------------------------------------------------------------------

// Fixture modeled on a real /it/api/v1/search job hit.
const LICA_HIT = {
  title: 'Collaborateur/Collaboratrice libre-service et vente 40%',
  descResponsibilities:
    '<div><h2>Introduction</h2><p>Tu aimes le contact clientèle.</p><ul><li>Travail aux caisses</li><li>Aide self-checkout</li></ul></div>',
  language: 'fr',
  requisitionId: '693901',
  recruitingUrlEasyApply:
    'https://ea-lidl.cfapps.eu20.hana.ondemand.com/easyapply/index.html?ReqId=693901&sap-language=it_CH',
  recruitingUrl:
    'https://ea-lidl.cfapps.eu20.hana.ondemand.com/easyapply/index.html?ReqId=693901&sap-language=it_CH',
  contractType: 'Temps Partiel',
  contractTypeId: 'Teilzeit',
  highlight: false,
  jobDetailUrl:
    'https://team.lidl.ch/fr/jobs/collaborateur-collaboratrice-libre-service-et-vente-40-martigny-693901',
  location: {
    zipCode: '1920',
    address: 'Rue du Levant 145',
    city: 'Martigny',
    country: 'CH',
  },
};

describe('LiCa search-API contract / endpoint constants', () => {
  it('targets the LiCa /api/v1/search endpoint, not the retired search_api/jobsearch', () => {
    expect(LIDL_SEARCH_API_BASE).toContain('/api/v1/search');
    expect(LIDL_SEARCH_API_BASE).not.toContain('search_api');
    expect(LIDL_SEARCH_API_BASE).not.toContain('jobsearch');
  });

  it('reads the job list from the top-level `jobs` key', () => {
    expect(LIDL_SEARCH_JOBS_KEY).toBe('jobs');
  });
});

describe('buildLidlSearchQuery', () => {
  it('paginates via a JSON-encoded `general` object (a bare page=N is ignored)', () => {
    const qs = buildLidlSearchQuery(3, 20);
    const params = new URLSearchParams(qs);
    expect(params.has('general')).toBe(true);
    expect(params.has('page')).toBe(false);
    const general = JSON.parse(params.get('general') as string);
    expect(general.page).toBe(3);
    expect(general.resultsPerPage).toBe(20);
  });

  it('defaults resultsPerPage to LIDL_DEFAULT_RESULTS_PER_PAGE', () => {
    const general = JSON.parse(
      new URLSearchParams(buildLidlSearchQuery(1)).get('general') as string,
    );
    expect(general.resultsPerPage).toBe(LIDL_DEFAULT_RESULTS_PER_PAGE);
  });
});

describe('getLidlSearchPageCount', () => {
  it('derives the page count from meta.totalCount / resultsPerPage (ceil)', () => {
    expect(getLidlSearchPageCount({ totalCount: 357, resultsPerPage: 20 })).toBe(18);
    expect(getLidlSearchPageCount({ totalCount: 40, resultsPerPage: 20 })).toBe(2);
  });

  it('returns 1 for a missing/empty meta envelope', () => {
    expect(getLidlSearchPageCount(undefined)).toBe(1);
    expect(getLidlSearchPageCount({})).toBe(1);
  });
});

describe('extractLidlApiHitFields', () => {
  it('maps the new LiCa field names', () => {
    const f = extractLidlApiHitFields(LICA_HIT);
    expect(f.detailUrl).toBe(LICA_HIT.jobDetailUrl);
    expect(f.title).toBe(LICA_HIT.title);
    expect(f.language).toBe('fr');
    expect(f.requisitionId).toBe('693901');
    expect(f.applyUrl).toContain('ReqId=693901');
    expect(f.contractType).toBe('Teilzeit'); // contractTypeId wins (German canonical)
    expect(f.zipCode).toBe('1920');
    expect(f.address).toBe('Rue du Levant 145');
    expect(f.city).toBe('Martigny');
    expect(f.country).toBe('CH');
    expect(f.descriptionHtml).toContain('Travail aux caisses');
  });

  it('falls back to the legacy search_api field names', () => {
    const f = extractLidlApiHitFields({
      url: 'https://team.lidl.ch/it/jobs/x-12345',
      jobLanguage: 'IT',
      descOffer: '<p>old body</p>',
      reference: '12345',
      easyApply: { easyApplyUrl: 'https://ea?ReqId=12345' },
      contractType: 'Vollzeit',
      location: { postcode: '6900', title: 'Lugano Filiale', city: 'Lugano' },
    });
    expect(f.detailUrl).toBe('https://team.lidl.ch/it/jobs/x-12345');
    expect(f.language).toBe('it');
    expect(f.descriptionHtml).toBe('<p>old body</p>');
    expect(f.requisitionId).toBe('12345');
    expect(f.applyUrl).toContain('ReqId=12345');
    expect(f.zipCode).toBe('6900');
    expect(f.locationName).toBe('Lugano Filiale');
    expect(f.city).toBe('Lugano');
  });

  it('returns empty strings (never throws) for a malformed hit', () => {
    const f = extractLidlApiHitFields({});
    expect(f.detailUrl).toBe('');
    expect(f.city).toBe('');
    expect(f.highlight).toBe(false);
  });
});

function licaHit(id: number, overrides: Record<string, unknown> = {}) {
  return {
    title: `Collaboratore vendita ${id}`,
    descResponsibilities: '<ul><li>Consulenza alla clientela e gestione accurata della merce.</li><li>Collaborazione quotidiana con il team della filiale.</li></ul>',
    language: 'it',
    requisitionId: String(id),
    jobDetailUrl: `https://team.lidl.ch/it/jobs/collaboratore-vendita-lugano-${id}`,
    location: { city: 'Lugano', country: 'CH' },
    ...overrides,
  };
}

function lidlPage(input: string | URL | Request) {
  const general = JSON.parse(new URL(String(input)).searchParams.get('general') || '{}');
  return Number(general.page);
}

describe('Lidl authoritative LiCa discovery', () => {
  it('drains every reported page and preserves exact feed-to-adapter accounting', async () => {
    const allHits = Array.from({ length: 21 }, (_, index) => licaHit(70000 + index));
    const fetchImpl = async (input: string | URL | Request) => {
      const page = lidlPage(input);
      const jobs = page === 1 ? allHits.slice(0, 20) : allHits.slice(20);
      return new Response(JSON.stringify({
        jobs,
        meta: { totalCount: 21, resultsPerPage: 20, page, count: jobs.length },
      }), { status: 200 });
    };
    const result = await fetchLidlJobDetailUrls({ fetchImpl, timeoutMs: 1000 });
    expect(result).toMatchObject({
      totalCount: 21,
      rawFetched: 21,
      duplicateIdentity: 0,
      droppedNonCh: 0,
      droppedMalformed: 0,
      sourceZero: false,
    });
    expect(result.urls).toHaveLength(21);
    expect(result.jobsFromApi).toHaveLength(21);
    expect(Object.keys(result.seedMetaByUrl)).toHaveLength(21);
  });

  it('fails closed on partial pagination, total drift, malformed URLs, and HTTP failure', async () => {
    const partial = async (input: string | URL | Request) => {
      const page = lidlPage(input);
      const jobs = page === 1
        ? Array.from({ length: 20 }, (_, index) => licaHit(71000 + index))
        : [licaHit(71020)];
      return new Response(JSON.stringify({
        jobs,
        meta: { totalCount: 22, resultsPerPage: 20, page, count: jobs.length },
      }), { status: 200 });
    };
    await expect(fetchLidlJobDetailUrls({ fetchImpl: partial, timeoutMs: 1000 }))
      .rejects.toThrow(/fetched 21\/22/);

    const drift = async (input: string | URL | Request) => {
      const page = lidlPage(input);
      const jobs = page === 1
        ? Array.from({ length: 20 }, (_, index) => licaHit(72000 + index))
        : [licaHit(72020)];
      return new Response(JSON.stringify({
        jobs,
        meta: { totalCount: page === 1 ? 21 : 22, resultsPerPage: 20, page, count: jobs.length },
      }), { status: 200 });
    };
    await expect(fetchLidlJobDetailUrls({ fetchImpl: drift, timeoutMs: 1000 }))
      .rejects.toThrow(/total drift/);

    const malformed = async () => new Response(JSON.stringify({
      jobs: [licaHit(73000, { jobDetailUrl: 'https://example.test/it/jobs/x-73000' })],
      meta: { totalCount: 1, resultsPerPage: 20, page: 1, count: 1 },
    }), { status: 200 });
    await expect(fetchLidlJobDetailUrls({ fetchImpl: malformed, timeoutMs: 1000 }))
      .rejects.toThrow(/malformed=1/);

    const unavailable = async () => new Response('down', { status: 503 });
    await expect(fetchLidlJobDetailUrls({ fetchImpl: unavailable, timeoutMs: 1000 }))
      .rejects.toThrow(/503/);
  });

  it('accepts an authoritative zero only with a complete empty envelope', async () => {
    const fetchImpl = async () => new Response(JSON.stringify({
      jobs: [],
      meta: { totalCount: 0, resultsPerPage: 20, page: 1, count: 0 },
    }), { status: 200 });
    await expect(fetchLidlJobDetailUrls({ fetchImpl, timeoutMs: 1000 })).resolves.toMatchObject({
      urls: [], jobsFromApi: [], totalCount: 0, rawFetched: 0, sourceZero: true,
    });
  });
});

describe('Lidl adapter persistence', () => {
  it('is atomic, parity-checked, idempotent, and never swallows stale/write failures', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lidl-adapter-'));
    const adapterPath = path.join(dir, 'lidl.json');
    const urls = ['https://team.lidl.ch/it/jobs/collaboratore-vendita-lugano-74000'];
    const meta = { [urls[0]]: { location: 'Lugano', canton: 'TI' } };
    const updatedAt = '2026-09-01T00:00:00.000Z';
    try {
      ensureAdapterSeedUrls(urls, meta, adapterPath, updatedAt);
      const firstBytes = fs.readFileSync(adapterPath, 'utf8');
      ensureAdapterSeedUrls(urls, meta, adapterPath, updatedAt);
      expect(fs.readFileSync(adapterPath, 'utf8')).toBe(firstBytes);
      expect(() => assertLidlAdapterParity({ seedUrls: [] }, urls, meta)).toThrow(/parity failed/);

      fs.writeFileSync(adapterPath, '{ stale');
      const staleBytes = fs.readFileSync(adapterPath, 'utf8');
      expect(() => ensureAdapterSeedUrls(urls, meta, adapterPath, updatedAt)).toThrow();
      expect(fs.readFileSync(adapterPath, 'utf8')).toBe(staleBytes);
      expect(() => ensureAdapterSeedUrls(urls, meta, dir, updatedAt)).toThrow();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
