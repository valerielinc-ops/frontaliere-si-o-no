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
        <p>Candidature spontanee: invia il tuo curriculum alla Fondazione.</p>
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

  it('records the official explicit zero without treating the stage link as a vacancy', () => {
    const result = parseCareersPage(EMPTY_HTML);

    expect(result.status).toBe('empty');
    expect(result.candidates).toHaveLength(0);
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

  it('stamps an authoritative empty snapshot for the current live shape', async () => {
    const result = await fetchAllFondazioneSanGottardoJobs({
      fetchPage: vi.fn().mockResolvedValue(EMPTY_HTML),
      fetchDetail: vi.fn(),
    });

    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(0);
    expect(result.authoritativeEmptyState).toBe('authoritative-source-zero');
    expect(result.authoritativeEmptyEvidence).toMatch(/Fondazione San Gottardo/);
  });

  it('fetches and returns each linked detail page', async () => {
    const fetchDetail = vi.fn().mockResolvedValue(DETAIL_HTML);
    const result = await fetchAllFondazioneSanGottardoJobs({
      fetchPage: vi.fn().mockResolvedValue(LISTING_HTML),
      fetchDetail,
    });

    expect(result).toEqual(expect.objectContaining({
      discoveredCount: 1,
      fetchOutcome: 'ok',
      jobs: [expect.objectContaining({ title: 'Educatore/trice specializzato/a' })],
    }));
    expect(fetchDetail).toHaveBeenCalledWith('https://www.fsangottardo.ch/concorsi/educatore-specializzato');
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
