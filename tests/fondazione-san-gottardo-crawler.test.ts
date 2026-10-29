import { describe, expect, it, vi } from 'vitest';
import {
  FONDAZIONE_SAN_GOTTARDO_CAREER_URL,
  FONDAZIONE_SAN_GOTTARDO_COMPANY_NAME,
  FONDAZIONE_SAN_GOTTARDO_KEY,
  fetchAllFondazioneSanGottardoJobs,
  isFondazioneSanGottardoJob,
  isTrustedDomain,
  parseCareersPage,
  parseDetailPage,
} from '../scripts/lib/fondazione-san-gottardo-job-parser.mjs';

const EMPTY_HTML = `
  <main id="tm-main">
    <div class="uk-panel">
      <h1>Candidature</h1>
      <div class="uk-panel">
        <p><strong>Posizioni disponibili:</strong></p>
        <hr>
        <p>Attualmente non abbiamo posizioni disponibili.</p>
        <hr>
        <p>Accettiamo candidature per:</p>
        <ul><li><strong>stage pre SUPSI (9 mesi)</strong></li></ul>
    <p>Selezionare la dicitura corretta nel campo "tipo di candidatura".</p>
        <p>Candidature spontanee: invia il tuo curriculum alla Fondazione.</p>
    <form><select name="Tipo_di_candidatura"><option>Stage pre SUPSI (9 mesi)</option></select></form>
      </div>
    </div>
  </main>
`;

const LISTING_HTML = `
  <main id="tm-main">
    <div class="uk-panel">
      <h1>Candidature</h1>
      <div class="uk-panel">
        <p><strong>Posizioni disponibili:</strong></p>
        <hr>
        <ul>
          <li><a href="/concorsi/educatore-specializzato">Educatore/trice specializzato/a</a></li>
        </ul>
        <p>Accettiamo candidature per:</p>
        <ul><li><a href="/lavoro/stage">stage pre SUPSI (9 mesi)</a></li></ul>
        <p>Selezionare la dicitura corretta nel campo "tipo di candidatura".</p>
      </div>
    </div>
  </main>
`;

const DETAIL_HTML = `
  <main id="tm-main">
    <div class="uk-panel">
      <h1>CONCORSO ASSUNZIONE PERSONALE</h1>
      <table>
        <tr><td>Funzione Struttura o ambito di lavoro</td><td>Educatore/trice specializzato/a, Casa Don Orione, Lopagno, Ticino</td></tr>
        <tr><td>Funzione Percentuale di impiego</td><td>Educatore/trice specializzato/a 100% a tempo indeterminato</td></tr>
        <tr><td>Funzione Requisiti richiesti</td><td>Diploma di educatore specializzato e disponibilità al lavoro in équipe.</td></tr>
      </table>
      <p>La Fondazione San Gottardo cerca una persona motivata per accompagnare gli utenti nelle attività quotidiane presso Casa Don Orione a Lopagno. Il ruolo comprende la progettazione educativa, l'osservazione dei bisogni, la collaborazione con le famiglie e il lavoro interdisciplinare. Sono richieste responsabilità, capacità relazionali, flessibilità, attitudine al lavoro in équipe e disponibilità a partecipare ai turni secondo l'organizzazione del servizio.</p>
    </div>
  </main>
`;

describe('Fondazione San Gottardo crawler', () => {
  it('uses stable company identifiers and trusted-domain boundaries', () => {
    expect(FONDAZIONE_SAN_GOTTARDO_KEY).toBe('fondazione-san-gottardo');
    expect(FONDAZIONE_SAN_GOTTARDO_COMPANY_NAME).toBe('Fondazione San Gottardo');
    expect(FONDAZIONE_SAN_GOTTARDO_CAREER_URL).toBe('https://www.fsangottardo.ch/lavoro');

    expect(isFondazioneSanGottardoJob({ companyKey: FONDAZIONE_SAN_GOTTARDO_KEY })).toBe(true);
    expect(isFondazioneSanGottardoJob({ company: FONDAZIONE_SAN_GOTTARDO_COMPANY_NAME })).toBe(true);
    expect(isFondazioneSanGottardoJob({ url: 'https://www.fsangottardo.ch/concorsi/test' })).toBe(true);
    expect(isFondazioneSanGottardoJob({ company: 'Other Foundation', url: 'https://example.org/jobs/1' })).toBe(false);

    expect(isTrustedDomain('https://www.fsangottardo.ch/concorsi/test')).toBe(true);
    expect(isTrustedDomain('https://jobs.fsangottardo.ch/concorsi/test')).toBe(true);
    expect(isTrustedDomain('https://fsangottardo.ch/concorsi/test')).toBe(true);
    expect(isTrustedDomain('https://example.org/concorsi/test')).toBe(false);
  });

  it('records the official vacancy zero and keeps the stage as a separate opportunity', () => {
    const result = parseCareersPage(EMPTY_HTML);

    expect(result.status).toBe('empty');
    expect(result.candidates).toHaveLength(0);
    expect(result.opportunities).toEqual([
      expect.objectContaining({
        title: 'Stage pre SUPSI (9 mesi)',
        applicationLabel: 'Stage pre SUPSI (9 mesi)',
      }),
    ]);
    expect(result.evidence).toMatch(/non abbiamo posizioni disponibili/i);
  });

  it('extracts only links in the bounded available-positions section', () => {
    const result = parseCareersPage(LISTING_HTML);

    expect(result.status).toBe('ok');
    expect(result.candidates).toEqual([
      expect.objectContaining({
        title: 'Educatore/trice specializzato/a',
        url: 'https://www.fsangottardo.ch/concorsi/educatore-specializzato',
      }),
    ]);
    expect(result.opportunities).toEqual([
      expect.objectContaining({ title: 'Stage pre SUPSI (9 mesi)' }),
    ]);
  });

  it('discovers Joomla detail links on the careers path when they have a query string', () => {
    const html = LISTING_HTML.replace(
      '/concorsi/educatore-specializzato',
      '/lavoro?view=article&id=42',
    );
    const result = parseCareersPage(html);

    expect(result.status).toBe('ok');
    expect(result.candidates).toEqual([
      expect.objectContaining({
        title: 'Educatore/trice specializzato/a',
        url: 'https://www.fsangottardo.ch/lavoro?view=article&id=42',
      }),
    ]);
  });

  it('fails closed when the source section changes without an explicit zero', () => {
    const result = parseCareersPage(EMPTY_HTML.replace(
      'Attualmente non abbiamo posizioni disponibili.',
      'Le opportunità saranno pubblicate qui.',
    ));

    expect(result.status).toBe('selector_miss');
    expect(result.candidates).toHaveLength(0);
  });

  it('parses a detail page with the source role, location and body floor', () => {
    const job = parseDetailPage(
      DETAIL_HTML,
      'https://www.fsangottardo.ch/concorsi/educatore-specializzato',
      { title: 'Educatore/trice specializzato/a' },
    );

    expect(job).toEqual(expect.objectContaining({
      companyKey: FONDAZIONE_SAN_GOTTARDO_KEY,
      title: 'Educatore/trice specializzato/a',
      location: 'Lopagno',
      canton: 'TI',
      sourceLang: 'it',
      employmentType: 'FULL_TIME',
      url: 'https://www.fsangottardo.ch/concorsi/educatore-specializzato',
    }));
    expect((job?.description.split(/\s+/).length || 0)).toBeGreaterThanOrEqual(50);
  });

  it('selects the application link from the detail content, not global navigation', () => {
    const html = `
      <header><a href="/candidature">Candidature</a></header>
      ${DETAIL_HTML.replace(
        '</div>\n  </main>',
        '<p><a href="/candidati/educatore">Invia candidatura</a></p></div>\n  </main>',
      )}
    `;
    const job = parseDetailPage(
      html,
      'https://www.fsangottardo.ch/concorsi/educatore-specializzato',
      { title: 'Educatore/trice specializzato/a' },
    );

    expect(job?.applyUrl).toBe('https://www.fsangottardo.ch/candidati/educatore');
  });

  it('publishes the stage opportunity instead of stamping an empty snapshot', async () => {
    const result = await fetchAllFondazioneSanGottardoJobs({
      fetchPage: vi.fn().mockResolvedValue(EMPTY_HTML),
      fetchDetail: vi.fn(),
    });

    expect(result).toEqual(expect.objectContaining({
      discoveredCount: 1,
      fetchOutcome: 'ok',
      jobs: [expect.objectContaining({
        title: 'Stage pre SUPSI (9 mesi)',
        contract: 'internship',
        employmentType: 'INTERN',
        experienceLevel: 'intern',
        url: FONDAZIONE_SAN_GOTTARDO_CAREER_URL,
        applyUrl: FONDAZIONE_SAN_GOTTARDO_CAREER_URL,
      })],
    }));
    expect(result.jobs[0].description.split(/\s+/).length).toBeGreaterThanOrEqual(50);
    expect(result.authoritativeEmptyState).toBeUndefined();
    expect(result.jobs[0].source).toMatch(/Internship Opportunity/);
  });

  it('fetches and returns each linked detail page', async () => {
    const fetchDetail = vi.fn().mockResolvedValue(DETAIL_HTML);
    const result = await fetchAllFondazioneSanGottardoJobs({
      fetchPage: vi.fn().mockResolvedValue(LISTING_HTML),
      fetchDetail,
    });

    expect(result).toEqual(expect.objectContaining({
      discoveredCount: 2,
      fetchOutcome: 'ok',
      jobs: expect.arrayContaining([
        expect.objectContaining({ title: 'Educatore/trice specializzato/a' }),
        expect.objectContaining({
          title: 'Stage pre SUPSI (9 mesi)',
          contract: 'internship',
        }),
      ]),
    }));
    expect(fetchDetail).toHaveBeenCalledWith('https://www.fsangottardo.ch/concorsi/educatore-specializzato');
    expect(fetchDetail).toHaveBeenCalledTimes(1);
  });

  it('returns selector_miss instead of publishing a guessed zero', async () => {
    const result = await fetchAllFondazioneSanGottardoJobs({
      fetchPage: vi.fn().mockResolvedValue(EMPTY_HTML.replace(
        'Attualmente non abbiamo posizioni disponibili.',
        'Le opportunità saranno pubblicate qui.',
      )),
    });

    expect(result).toEqual({ jobs: [], discoveredCount: 0, fetchOutcome: 'selector_miss' });
  });
});
