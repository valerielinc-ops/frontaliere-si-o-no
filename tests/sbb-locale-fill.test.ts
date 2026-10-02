import { afterEach, describe, expect, it, vi } from 'vitest';
import { fillSbbLocaleText, indexSbbPriorJobsByUrl } from '../scripts/update-sbb-jobs.mjs';

// Synthetic posting: the crawler group runs this parser for ~150 SBB
// postings; translating each one inline (6 cascade calls) on every run timed
// the crawler out at the 91-minute worker watchdog (exit 124).
const SOURCE_TITLE = 'Projektleiter:in Fahrbahn';
const SOURCE_DESCRIPTION = [
  'Du planst und leitest Unterhaltsprojekte an Gleisanlagen in der Region Mitte.',
  'Du koordinierst interne Fachstellen und externe Unternehmen und sicherst Termine, Kosten und Qualität.',
  'Du verfügst über eine Ausbildung im Bauingenieurwesen und mehrjährige Erfahrung in der Projektleitung.',
].join('\n\n');
const STORED_IT_DESCRIPTION = [
  'Pianifichi e dirigi progetti di manutenzione degli impianti di binario nella regione centrale.',
  'Coordini i servizi specialistici interni e le imprese esterne e garantisci scadenze, costi e qualità.',
  'Hai una formazione in ingegneria civile e diversi anni di esperienza nella gestione di progetti.',
].join('\n\n');

function freshSlots() {
  return {
    localeTitles: { de: SOURCE_TITLE } as Record<string, string>,
    localeDescriptions: { de: SOURCE_DESCRIPTION } as Record<string, string>,
  };
}

function storedRecord(overrides: Record<string, unknown> = {}) {
  return {
    url: 'https://jobs.example.invalid/posting/1001',
    sourceLang: 'de',
    titleByLocale: {
      de: SOURCE_TITLE,
      it: 'Capoprogetto binari',
      en: 'Project manager track',
      fr: 'Chef·fe de projet voie',
    },
    descriptionByLocale: {
      de: SOURCE_DESCRIPTION,
      it: STORED_IT_DESCRIPTION,
      en: `${STORED_IT_DESCRIPTION} (en)`,
      fr: `${STORED_IT_DESCRIPTION} (fr)`,
    },
    ...overrides,
  };
}

function fakeTranslate() {
  return vi.fn(async ({ text, targetLang, fieldType }: { text: string; targetLang: string; fieldType?: string }) => (
    fieldType === 'description' ? `[${targetLang}] ${text}` : `${text} (${targetLang})`
  ));
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('fillSbbLocaleText', () => {
  it('reuses the stored translations of an unchanged posting instead of re-translating them', async () => {
    const slots = freshSlots();
    const translate = fakeTranslate();
    const result = await fillSbbLocaleText({
      ...slots,
      sourceLocale: 'de',
      prior: storedRecord(),
      skipAiTranslation: false,
      translate,
    });

    expect(translate).not.toHaveBeenCalled();
    expect(result.translationCalls).toBe(0);
    expect(slots.localeTitles).toMatchObject({ it: 'Capoprogetto binari', en: 'Project manager track', fr: 'Chef·fe de projet voie' });
    expect(slots.localeDescriptions.it).toBe(STORED_IT_DESCRIPTION);
    expect(slots.localeTitles.de).toBe(SOURCE_TITLE);
  });

  it('translates only the slots the stored record does not hold', async () => {
    const slots = freshSlots();
    const translate = fakeTranslate();
    const prior = storedRecord();
    delete (prior.titleByLocale as Record<string, string>).fr;
    delete (prior.descriptionByLocale as Record<string, string>).fr;

    const result = await fillSbbLocaleText({ ...slots, sourceLocale: 'de', prior, skipAiTranslation: false, translate });

    expect(result.translationCalls).toBe(2);
    expect(translate.mock.calls.map(([args]) => args.targetLang)).toEqual(['fr', 'fr']);
    expect(slots.localeTitles.fr).toBe(`${SOURCE_TITLE} (fr)`);
    expect(slots.localeDescriptions.fr).toBe(`[fr] ${SOURCE_DESCRIPTION}`);
    expect(slots.localeTitles.it).toBe('Capoprogetto binari');
  });

  it('does not seed a drifted source with the old posting translations', async () => {
    const slots = freshSlots();
    const translate = fakeTranslate();
    const prior = storedRecord({
      titleByLocale: { de: 'Lokführer:in Personenverkehr Region Ost', it: 'Macchinista traffico viaggiatori' },
      descriptionByLocale: {
        de: 'Als Lokführer:in bringst du Reisende sicher und pünktlich an ihr Ziel und arbeitest im Schichtbetrieb an allen Wochentagen.',
        it: 'Come macchinista porti i viaggiatori a destinazione in modo sicuro e puntuale e lavori a turni in tutti i giorni della settimana.',
      },
    });

    await fillSbbLocaleText({ ...slots, sourceLocale: 'de', prior, skipAiTranslation: false, translate });

    expect(slots.localeTitles.it).toBe(`${SOURCE_TITLE} (it)`);
    expect(slots.localeDescriptions.it).toBe(`[it] ${SOURCE_DESCRIPTION}`);
    expect(translate).toHaveBeenCalledTimes(6);
  });

  it('makes no inline AI call under SKIP_AI_TRANSLATION=1 and leaves the gaps to the deferred pipeline', async () => {
    vi.stubEnv('SKIP_AI_TRANSLATION', '1');
    const slots = freshSlots();
    const translate = fakeTranslate();

    const result = await fillSbbLocaleText({ ...slots, sourceLocale: 'de', translate });

    expect(translate).not.toHaveBeenCalled();
    expect(result.translationCalls).toBe(0);
    expect(slots.localeTitles).toEqual({ de: SOURCE_TITLE });
    expect(slots.localeDescriptions).toEqual({ de: SOURCE_DESCRIPTION });
  });

  it('still reuses stored translations under SKIP_AI_TRANSLATION=1', async () => {
    const slots = freshSlots();
    const translate = fakeTranslate();

    await fillSbbLocaleText({ ...slots, sourceLocale: 'de', prior: storedRecord(), skipAiTranslation: true, translate });

    expect(translate).not.toHaveBeenCalled();
    expect(Object.keys(slots.localeTitles).sort()).toEqual(['de', 'en', 'fr', 'it']);
    expect(slots.localeDescriptions.fr).toBe(`${STORED_IT_DESCRIPTION} (fr)`);
  });

  it('keeps the translation floors when the cascade answers with a clipped description', async () => {
    const slots = freshSlots();
    const translate = vi.fn(async ({ fieldType }: { fieldType?: string }) => (
      fieldType === 'description' ? 'troppo corto' : 'T'
    ));

    await fillSbbLocaleText({ ...slots, sourceLocale: 'de', skipAiTranslation: false, translate });

    expect(slots.localeTitles).toEqual({ de: SOURCE_TITLE });
    expect(slots.localeDescriptions).toEqual({ de: SOURCE_DESCRIPTION });
  });
});

describe('indexSbbPriorJobsByUrl', () => {
  it('keys stored records by canonical detail URL and drops ambiguous URLs', () => {
    const index = indexSbbPriorJobsByUrl([
      { url: 'https://jobs.example.invalid/posting/1001/', id: 'a' },
      { url: 'https://jobs.example.invalid/posting/2002#apply', id: 'b' },
      { url: 'https://jobs.example.invalid/posting/2002', id: 'c' },
      { url: '', id: 'd' },
      null,
    ]);

    expect([...index.keys()]).toEqual(['https://jobs.example.invalid/posting/1001']);
    expect(index.get('https://jobs.example.invalid/posting/1001')?.id).toBe('a');
  });
});
