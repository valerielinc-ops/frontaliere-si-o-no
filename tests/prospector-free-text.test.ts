import { describe, expect, it } from 'vitest';
import { extractFreeTextOffers, validateFreeTextOffer } from '../scripts/lib/prospector/free-text-extract.mjs';
import { synthesizeSpec } from '../scripts/lib/prospector/synthesize.mjs';
import { runSpecInProduction } from '../scripts/lib/prospector/spec-crawler.mjs';

const URL = 'https://tecno.example/';
const SOURCE_TEXT = 'Cerchiamo un elettricista per il nostro team.';
const DESCRIPTION = 'Cerchiamo un elettricista per installazioni, manutenzione e assistenza presso i nostri clienti. La persona si occuperà delle attività quotidiane, collaborerà con il team, seguirà le procedure di sicurezza e potrà candidarsi inviando il proprio CV. Sono richieste autonomia, affidabilità, competenze tecniche e disponibilità al lavoro sul territorio. Offriamo un ambiente professionale e un contratto stabile.';
const PAGE = `<html><body><h1>Offerta di lavoro</h1><p>${SOURCE_TEXT}</p><p>${DESCRIPTION}</p><p>Luogo di lavoro: Lugano, TI.</p></body></html>`;
const GENERIC_SOURCE_TEXT = 'Posizioni aperte: cerchiamo una persona per il nostro team.';
const GENERIC_DESCRIPTION = 'La persona svolgerà mansioni operative, collaborerà con il team, seguirà le procedure di sicurezza e potrà candidarsi inviando il proprio CV. Sono richieste autonomia, affidabilità, competenze tecniche e disponibilità al lavoro sul territorio. Offriamo un ambiente professionale e un contratto stabile. Il luogo di lavoro è Lugano e la posizione prevede attività quotidiane con responsabilità definite.';
const GENERIC_SOURCE_PAGE = `<html><body><h1>Offerta di lavoro</h1><p>${GENERIC_SOURCE_TEXT}</p><p>${GENERIC_DESCRIPTION}</p><p>Luogo di lavoro: Lugano, TI.</p></body></html>`;

const location = {
  city: 'Lugano',
  canton: 'TI',
  postalCode: '6900',
  country: 'CH',
};

function llmResponse() {
  return {
    vacancies: [{
      title: 'Elettricista',
      description: DESCRIPTION,
      sourceText: SOURCE_TEXT,
      location: 'Lugano, TI',
      addressLocality: 'Lugano',
      addressRegion: 'TI',
      postalCode: '6900',
      streetAddress: '',
      employmentType: 'FULL_TIME',
      datePosted: '',
      applyUrl: '',
    }],
    permanentApplications: [],
  };
}

function sourceLocation() {
  return {
    location: 'Lugano',
    addressLocality: 'Lugano',
    addressRegion: 'TI',
    addressCountry: 'CH',
    postalCode: '6900',
  };
}

describe('Prospector free-text offers', () => {
  it('does not load or call the LLM without the homepage hiring signal', async () => {
    let calls = 0;
    const result = await extractFreeTextOffers(
      '<p>Cerchiamo soluzioni su misura per la tua casa.</p>',
      URL,
      { callLLM: async () => { calls += 1; return llmResponse(); } },
    );

    expect(calls).toBe(0);
    expect(result).toMatchObject({ vacancies: [], skipped: 'no-homepage-hiring-signal' });
  });

  it('keeps permanent applications separate from JobPosting vacancies', async () => {
    const page = '<p>Posizioni aperte: candidature spontanee sempre benvenute.</p>';
    const result = await extractFreeTextOffers(page, URL, {
      companyName: 'Tecno Montaggi',
      sourceLocation: location,
      callLLM: async () => ({
        vacancies: [],
        permanentApplications: [{
          label: 'Candidatura spontanea',
          description: 'Invia il tuo profilo per future opportunità.',
          sourceText: 'candidature spontanee sempre benvenute',
          applyUrl: '',
        }],
      }),
    });

    expect(result.vacancies).toEqual([]);
    expect(result.permanentApplications).toHaveLength(1);
    expect(result.reasonCode).toBe('permanent_application_only');
  });

  it('synthesizes and runs the same free-text contract in production', async () => {
    const callLLM = async () => llmResponse();
    const fetchImpl = async () => new Response(PAGE);
    const candidate = {
      careersUrl: URL,
      domain: 'tecno.example',
      name: 'Tecno Montaggi',
      ...location,
    };
    const synthesized = await synthesizeSpec(candidate, {
      fetchImpl,
      callLLM,
      sleepImpl: async () => {},
    });

    expect(synthesized.spec).toMatchObject({
      mode: 'free-text',
      freeTextContractVersion: 1,
      sourceLocation: expect.objectContaining({ addressRegion: 'TI' }),
    });
    expect(synthesized.vacancies).toHaveLength(1);
    expect(synthesized.vacancies[0]).toMatchObject({
      via: 'free-text',
      sourceUrl: URL,
      postalCode: '6900',
      employmentType: 'FULL_TIME',
    });

    const observed = await runSpecInProduction(synthesized.spec, {
      fetchImpl: async (input) => String(input).endsWith('/robots.txt')
        ? new Response('User-agent: *\nAllow: /')
        : new Response(PAGE),
      callLLM,
      lookupImpl: async () => [{ address: '93.184.216.34', family: 4 }],
      sleepImpl: async () => {},
      hostDelayMs: 0,
      retries: 0,
      disableWafProxy: true,
      returnObservation: true,
      failOnIncomplete: false,
    });

    expect(observed.vacancies).toHaveLength(1);
    expect(observed.vacancies[0]).toMatchObject({
      title: 'Elettricista',
      sourceUrl: URL,
      streetAddress: 'Lugano',
      postalCode: '6900',
    });
    expect(observed.observation.sourceBackedLocationRate).toBe(1);
  });

  it('rejects a spontaneous-application title even when the model puts it in vacancies', async () => {
    const result = await extractFreeTextOffers(PAGE, URL, {
      companyName: 'Tecno Montaggi',
      sourceLocation: sourceLocation(),
      callLLM: async () => ({
        vacancies: [{
          ...llmResponse().vacancies[0],
          title: 'Candidatura spontanea',
        }],
        permanentApplications: [],
      }),
    });

    expect(result.vacancies).toEqual([]);
    expect(result.rejectedReasons).toContain('generic_or_spontaneous_title');
  });

  it('rejects a non-generic title that has no evidence on the hiring page', () => {
    const result = validateFreeTextOffer({
      title: 'Responsabile marketing',
      description: GENERIC_DESCRIPTION,
      sourceText: GENERIC_SOURCE_TEXT,
      location: 'Lugano, TI',
      addressLocality: 'Lugano',
      addressRegion: 'TI',
      postalCode: '6900',
      streetAddress: '',
      employmentType: 'FULL_TIME',
      datePosted: '',
      applyUrl: '',
    }, {
      html: GENERIC_SOURCE_PAGE,
      pageUrl: URL,
      context: { companyName: 'Tecno Montaggi', sourceLocation: sourceLocation() },
    });

    expect(result).toMatchObject({ valid: false, reason: 'title_source_evidence_missing' });
  });
});
