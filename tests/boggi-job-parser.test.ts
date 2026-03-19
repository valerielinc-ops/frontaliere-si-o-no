/**
 * Tests for scripts/lib/boggi-job-parser.mjs
 *
 * Verifies:
 *   - `combineRecruiteeDescriptionSections`: combines all API section fields
 *   - `parseBoggiDetailPage`: extracts full body >= 400 chars from HTML
 *   - Saved body contains at least two recognizable source sections
 *   - `buildBoggiJobFromApi`: uses combined sections when available
 *
 * Regression cases (FRO-71):
 *   - https://boggimilano1.recruitee.com/l/it/o/retail-hr-specialist-2
 *   - https://boggimilano1.recruitee.com/l/it/o/treasury-coordinator-3
 */
import { describe, it, expect } from 'vitest';
import {
  parseBoggiDetailPage,
  combineRecruiteeDescriptionSections,
  buildBoggiJobFromApi,
  buildBoggiLocalizedContent,
  MIN_BOGGI_DESC_LENGTH,
} from '../scripts/lib/boggi-job-parser.mjs';
import { syncBoggiDetailDescription } from '../scripts/update-boggi-jobs.mjs';

// ─── Fixture helpers ──────────────────────────────────────────────────────────

function recruiteeDetailHtml({
  title = '',
  sections = [] as { heading: string; content: string }[],
  containerId = 'description',
} = {}) {
  const sectionsHtml = sections
    .map(
      ({ heading, content }) => `
    <div class="sc-offer-section">
      <h3>${heading}</h3>
      ${content}
    </div>`,
    )
    .join('\n');

  return `<!DOCTYPE html>
<html lang="it">
<head><title>${title} | Boggi Milano Careers</title></head>
<body>
<main>
  <h1>${title}</h1>
  <div id="${containerId}">
    ${sectionsHtml}
  </div>
</main>
</body>
</html>`;
}

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const HR_SPECIALIST_TITLE = 'Retail HR Specialist';
const TREASURY_TITLE = 'Treasury Coordinator';

const HR_SPECIALIST_SECTIONS = [
  {
    heading: 'Chi siamo',
    content: `<p>Boggi Milano è un'azienda di abbigliamento maschile con sede a Milano, fondata nel 1939.
    Con oltre 200 punti vendita in 45 paesi, siamo sinonimo di eleganza italiana e qualità sartoriale.</p>`,
  },
  {
    heading: 'Il tuo ruolo',
    content: `<p>Il/La Retail HR Specialist farà parte del team HR e contribuirà alla gestione dei processi HR
    per i negozi Boggi Milano in Svizzera, con sede a Mendrisio (Canton Ticino).</p>`,
  },
  {
    heading: 'Responsabilità',
    content: `<ul>
      <li>Gestione del ciclo completo di recruiting per le posizioni retail</li>
      <li>Onboarding e formazione dei nuovi dipendenti</li>
      <li>Supporto ai manager di negozio per le attività HR quotidiane</li>
      <li>Monitoraggio delle presenze e gestione delle buste paga in collaborazione con il consulente del lavoro</li>
      <li>Supporto nella gestione delle relazioni sindacali e dei contratti collettivi</li>
    </ul>`,
  },
  {
    heading: 'Requisiti',
    content: `<ul>
      <li>Laurea in Gestione delle Risorse Umane, Psicologia del Lavoro o area affine</li>
      <li>Minimo 3-5 anni di esperienza in ruolo HR simile, preferibilmente nel settore retail o moda</li>
      <li>Ottima conoscenza del diritto del lavoro svizzero</li>
      <li>Fluenza in italiano; buona conoscenza dell'inglese; il tedesco è un plus</li>
      <li>Capacità di lavorare in autonomia e in team multiculturali</li>
    </ul>`,
  },
];

const TREASURY_SECTIONS = [
  {
    heading: 'Il ruolo',
    content: `<p>Stiamo cercando un/una Treasury Coordinator con un'esperienza di almeno 10 anni
    in ambito Tesoreria/Finance per unirsi al nostro team di Mendrisio.</p>`,
  },
  {
    heading: 'Attività principali',
    content: `<ul>
      <li>Gestione della liquidità e dei flussi di cassa aziendali</li>
      <li>Monitoraggio e gestione dei rapporti con le banche e gli istituti finanziari</li>
      <li>Supporto nella pianificazione finanziaria a breve e medio termine</li>
      <li>Preparazione di report di tesoreria per il management</li>
      <li>Gestione dei pagamenti internazionali e delle operazioni di cambio</li>
    </ul>`,
  },
  {
    heading: 'Profilo ricercato',
    content: `<ul>
      <li>Laurea in Economia, Finanza o area affine</li>
      <li>Esperienza di almeno 10 anni in ruolo di Treasury/Finance</li>
      <li>Conoscenza approfondita dei mercati finanziari e degli strumenti di copertura</li>
      <li>Ottima padronanza di Excel e sistemi ERP (SAP preferito)</li>
      <li>Capacità analitiche e attenzione al dettaglio</li>
    </ul>`,
  },
];

// ─── combineRecruiteeDescriptionSections ─────────────────────────────────────

describe('combineRecruiteeDescriptionSections', () => {
  it('combines description and requirements from translations', () => {
    const offer = {
      translations: {
        it: {
          description: '<p>Descrizione del ruolo.</p>',
          requirements: '<ul><li>Requisito 1</li><li>Requisito 2</li></ul>',
        },
      },
    };
    const combined = combineRecruiteeDescriptionSections(offer, 'it');
    expect(combined).toContain('Descrizione del ruolo');
    expect(combined).toContain('Requisito 1');
  });

  it('falls back to top-level fields when translations are missing', () => {
    const offer = {
      description: '<p>Top-level description.</p>',
      requirements: '<p>Top-level requirements.</p>',
    };
    const combined = combineRecruiteeDescriptionSections(offer, 'it');
    expect(combined).toContain('Top-level description');
    expect(combined).toContain('Top-level requirements');
  });

  it('returns empty string for empty offer', () => {
    expect(combineRecruiteeDescriptionSections({}, 'it')).toBe('');
  });

  it('prefers translation fields over top-level when both exist', () => {
    const offer = {
      description: '<p>Top description.</p>',
      translations: { it: { description: '<p>IT translation.</p>' } },
    };
    const combined = combineRecruiteeDescriptionSections(offer, 'it');
    expect(combined).toContain('IT translation');
    expect(combined).not.toContain('Top description');
  });
});

// ─── parseBoggiDetailPage — HR Specialist ─────────────────────────────────────

describe('parseBoggiDetailPage / retail HR specialist', () => {
  const html = recruiteeDetailHtml({ title: HR_SPECIALIST_TITLE, sections: HR_SPECIALIST_SECTIONS });
  const result = parseBoggiDetailPage(html);

  it('extracts the title from h1', () => {
    expect(result.title).toBe(HR_SPECIALIST_TITLE);
  });

  it(`body length >= MIN_BOGGI_DESC_LENGTH (${MIN_BOGGI_DESC_LENGTH} chars)`, () => {
    expect(result.body.length).toBeGreaterThanOrEqual(MIN_BOGGI_DESC_LENGTH);
  });

  it('sourceBodyLength equals body length', () => {
    expect(result.sourceBodyLength).toBe(result.body.length);
    expect(result.sourceBodyLength).toBeGreaterThanOrEqual(MIN_BOGGI_DESC_LENGTH);
  });

  it('body contains the responsibilities section', () => {
    expect(result.body).toContain('Responsabilità');
    expect(result.body).toContain('recruiting');
  });

  it('body contains the requirements section (at least two original sections)', () => {
    expect(result.body).toContain('Requisiti');
    expect(result.body).toContain('diritto del lavoro');
  });

  it('body does NOT contain raw HTML tags', () => {
    expect(result.body).not.toMatch(/<[a-zA-Z]/);
  });
});

// ─── parseBoggiDetailPage — Treasury Coordinator ─────────────────────────────

describe('parseBoggiDetailPage / treasury coordinator', () => {
  const html = recruiteeDetailHtml({ title: TREASURY_TITLE, sections: TREASURY_SECTIONS });
  const result = parseBoggiDetailPage(html);

  it('extracts the treasury coordinator title', () => {
    expect(result.title).toBe(TREASURY_TITLE);
  });

  it(`body length >= MIN_BOGGI_DESC_LENGTH (${MIN_BOGGI_DESC_LENGTH} chars)`, () => {
    expect(result.body.length).toBeGreaterThanOrEqual(MIN_BOGGI_DESC_LENGTH);
  });

  it('body contains the main activities section (section 1)', () => {
    expect(result.body).toContain('liquidità');
  });

  it('body contains the profile section (section 2)', () => {
    expect(result.body).toContain('Profilo ricercato');
    expect(result.body).toContain('Tesoreria');
  });
});

// ─── parseBoggiDetailPage — 25% guard scenario ────────────────────────────────

describe('parseBoggiDetailPage / 25% guard scenario', () => {
  it('sourceBodyLength is large enough to trigger 25% guard when API desc is short', () => {
    const html = recruiteeDetailHtml({ title: 'Test Job', sections: HR_SPECIALIST_SECTIONS });
    const result = parseBoggiDetailPage(html);
    const shortApiDesc = 'Breve introduzione al ruolo.';
    // 25% guard: shortApiDesc.length < 0.25 * result.sourceBodyLength
    expect(shortApiDesc.length).toBeLessThan(0.25 * result.sourceBodyLength);
  });
});

// ─── parseBoggiDetailPage — edge cases ───────────────────────────────────────

describe('parseBoggiDetailPage / edge cases', () => {
  it('returns empty result for empty HTML', () => {
    const result = parseBoggiDetailPage('');
    expect(result.title).toBe('');
    expect(result.body).toBe('');
    expect(result.sourceBodyLength).toBe(0);
  });

  it('handles page with no #description container via fallback', () => {
    const html = `<!DOCTYPE html><html><body>
<main>
  <h1>Retail Sales Advisor</h1>
  <article>
    <p>Boggi Milano cerca un/una Retail Sales Advisor per il negozio di Mendrisio.</p>
    <h3>Responsabilità</h3>
    <ul>
      <li>Assistenza clienti e consulenza di stile</li>
      <li>Gestione delle vendite e raggiungimento degli obiettivi</li>
      <li>Mantenimento degli standard visivi del negozio</li>
    </ul>
    <h3>Requisiti</h3>
    <ul>
      <li>Esperienza nella vendita assistita, preferibilmente nel fashion premium</li>
      <li>Passione per la moda maschile italiana e la qualità sartoriale</li>
      <li>Ottima conoscenza dell'italiano; inglese e tedesco sono un plus</li>
    </ul>
  </article>
</main>
</body></html>`;
    const result = parseBoggiDetailPage(html);
    expect(result.title).toBe('Retail Sales Advisor');
    expect(result.body.length).toBeGreaterThan(50);
  });
});

// ─── buildBoggiJobFromApi — combined sections ─────────────────────────────────

describe('buildBoggiJobFromApi / combined description sections', () => {
  it('uses combined description + requirements from API when both are present', () => {
    const offer = {
      slug: 'treasury-coordinator-3',
      title: 'Treasury Coordinator',
      translations: {
        it: {
          title: 'Treasury Coordinator',
          description: '<p>Stiamo cercando un Treasury Coordinator.</p>',
          requirements: '<ul><li>10 anni di esperienza in Tesoreria</li><li>Conoscenza SAP</li></ul>',
        },
      },
      locations: [{ city: 'Mendrisio', state: 'Ticino', country: 'Switzerland', country_code: 'CH' }],
      employment_type_code: 'fulltime_permanent',
    };
    const result = buildBoggiJobFromApi(offer);
    expect(result.description).toContain('Treasury Coordinator');
    expect(result.description).toContain('10 anni di esperienza');
    expect(result.description).toContain('SAP');
  });

  it('falls back to description-only when requirements is absent', () => {
    const offer = {
      slug: 'test-job',
      title: 'Test Job',
      description: '<p>Solo descrizione senza requirements.</p>',
      locations: [{ city: 'Mendrisio', state: 'Ticino', country: 'Switzerland', country_code: 'CH' }],
      employment_type_code: 'fulltime_permanent',
    };
    const result = buildBoggiJobFromApi(offer);
    expect(result.description).toContain('Solo descrizione');
  });
});

describe('buildBoggiLocalizedContent', () => {
  it('stores a rich English source description under en and mirrors it into it for later translation', () => {
    const richEnglishDescription = `The Retail HR Specialist will be part of the HR Team and will contribute to managing the HR processes.
Key Responsibilities
- Manage the full recruitment cycle for retail stores
- Support employer branding initiatives

Requirements
- 5 years of recruiting experience in premium retail
- Fluent English and Italian`;

    const localized = buildBoggiLocalizedContent({
      title: 'Retail HR Specialist',
      location: 'Mendrisio, Ticino',
      description: richEnglishDescription,
    });

    expect(localized.descriptionByLocale.en).toBe(richEnglishDescription);
    expect(localized.descriptionByLocale.it).toBe(richEnglishDescription);
    expect(localized.descriptionByLocale.de).toContain('Boggi Milano sucht aktuell');
  });
});

describe('syncBoggiDetailDescription', () => {
  it('replaces a thin Italian fallback with the richer detail body so locale translation can rebuild it', () => {
    const job = {
      description: `The Retail HR Specialist will contribute to managing the HR processes across retail stores.
Working closely with the HR leadership team, the role supports hiring, onboarding, employer branding, Workday operations and recruitment KPI analysis.

Requirements
- 5 years of recruiting experience in premium retail
- Fluent English and Italian`,
      descriptionByLocale: {
        it: '## Specialista delle risorse umane al dettaglio\n\nBoggi Milano sta assumendo per la posizione di Retail HR Specialist a Mendrisio, in Ticino. Moda, design e qualità maschile italiana. Candidati attraverso la pagina ufficiale delle carriere di Boggi Milano.',
        en: 'Boggi Milano is hiring for the Retail HR Specialist position in Mendrisio, Ticino.',
      },
    };
    const richBody = `The Retail HR Specialist will be part of the HR Team and will contribute to managing the HR processes, with special focus on recruitment, ensuring the attraction and hiring of top talent in line with Boggi Milano's values and standards.
Working closely with the International HR Manager and the Head of HR Retail, the role will ensure full coverage of the retail network's staffing needs and support the qualitative development of our teams.

Key Responsibilities
Manage the full recruitment cycle for retail stores in the assigned area.
Support staffing plans, structured interviews, employer branding initiatives and onboarding programs.
Draft and monitor job postings on Workday and manage recruitment KPIs.

Requirements
Degree in Humanities, Psychology, Economics, or related fields.
At least 5 years of experience in recruiting within the premium retail or fashion/luxury sector.
Fluent English and Italian, plus one language between French and German.`;

    const result = syncBoggiDetailDescription(job, richBody);

    expect(result.changed).toBe(true);
    expect(result.sourceLang).toBe('en');
    expect(job.description).toBe(richBody);
    expect(job.descriptionByLocale.en).toBe(richBody);
    expect(job.descriptionByLocale.it).toBe(richBody);
  });
});
