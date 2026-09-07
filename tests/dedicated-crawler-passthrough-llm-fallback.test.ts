import { describe, it, expect, vi, beforeEach } from 'vitest';
import { aiTranslateJobDescriptionDCC } from '@/scripts/lib/dedicated-crawler-common.mjs';
import { freeTranslateWithRetry, freeTranslateWithRetryDetailed } from '@/scripts/lib/free-translate.mjs';
import { detectLanguageWithConfidence } from '@/scripts/lib/detect-language.mjs';

vi.mock('@/scripts/lib/free-translate.mjs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/scripts/lib/free-translate.mjs')>();
  return {
    ...actual,
    freeTranslateWithRetry: vi.fn(),
    freeTranslateWithRetryDetailed: vi.fn(),
  };
});

/**
 * Da #7750 la cascata MT rende '' per DUE motivi opposti: «i motori erano giu'»
 * (transitorio) e «i motori hanno risposto rendendo la sorgente verbatim».
 * `aiTranslateJobDescriptionDCC` non distingueva i due casi e cadeva nel
 * fallback LLM su entrambi: su un testo che e' GIA' nella lingua target la
 * chiamata al modello — la risorsa scarsa della pipeline — si fa rendere lo
 * stesso testo e se lo vede scartare subito dopo da `translated !== cleanDesc`.
 *
 * Ma il passthrough da solo non dimostra «gia' nella lingua target»: la misura
 * che motiva #7750 e' l'echo genuino, cioe' body che avevano bisogno di
 * traduzione e che i tier gratuiti hanno restituito verbatim. Su quelli l'LLM
 * traduce davvero e la sua uscita viene pubblicata: spegnerlo pubblicherebbe la
 * lingua sorgente sotto /de/ e /fr/.
 *
 * Questo file pinna i QUATTRO versi: il modello si salta solo quando il testo e'
 * verificabilmente gia' nel locale richiesto — argmax E confidenza >= 0.65, che
 * e' il pavimento senza cui un body bilingue passerebbe per «gia' tradotto»;
 * sull'echo genuino, sul segnale ambiguo e coi motori giu' il modello DEVE
 * ancora essere chiamato.
 */

const TRANSLATED_DE = 'Wir suchen einen Softwareentwickler fuer unser Team in Lugano. '
  + 'Sie arbeiten an der Datenpipeline hinter unserer Stellenboerse und verantworten '
  + 'die Qualitaet der veroeffentlichten Inhalte von Anfang bis Ende.';

// Descrizione gia' nel locale target: il passthrough qui e' l'esito onesto
// («non c'e' niente da tradurre»), non un echo da recuperare.
const ALREADY_DE = 'Wir sind ein Team in Lugano und suchen eine Person, die unsere '
  + 'Datenpipeline betreut. Sie verantworten die Qualitaet der veroeffentlichten '
  + 'Inhalte von Anfang bis Ende und arbeiten eng mit der Redaktion zusammen.';

// Annuncio bilingue de/en: l'argmax resta 'de' ma la confidenza crolla, cioe'
// il segnale NON dimostra «gia' nella lingua target».
const MIXED_DE_EN = 'Wir sind ein Team in Lugano und suchen eine Person, die unsere '
  + 'Datenpipeline betreut und die Qualitaet der Inhalte verantwortet. '
  + 'We are looking for a software engineer to join our Lugano team and own the '
  + 'quality of the published content end to end.';

const SOURCE = [
  'We are looking for a software engineer to join our Lugano team.',
  'You will work on the data pipeline that powers our cross-border job board,',
  'and you will own the quality of the published content end to end.',
].join(' ');

function makeCtx(overrides: Record<string, unknown> = {}) {
  const cache = new Map<string, unknown>();
  return {
    cache,
    ctx: {
      buildAiCacheKey: (ns: string, parts: string[]) => `${ns}:${parts.join('|')}`,
      getCachedAiResponse: (k: string) => cache.get(k),
      setCachedAiResponse: (k: string, v: unknown) => { cache.set(k, v); },
      AI_CACHE_RAW_SENTINEL: '__RAW__',
      callLLM: vi.fn(),
      isAnyModelAvailable: () => true,
      ...overrides,
    },
  };
}

describe('aiTranslateJobDescriptionDCC — passthrough rifiutato vs motori giu\'', () => {
  beforeEach(() => {
    vi.mocked(freeTranslateWithRetry).mockReset();
    vi.mocked(freeTranslateWithRetryDetailed).mockReset();
  });

  it('sul passthrough di un testo gia\' nel locale target non chiama il modello e memoizza la sentinella', async () => {
    vi.mocked(freeTranslateWithRetryDetailed).mockResolvedValue({ text: '', passthrough: true });
    vi.mocked(freeTranslateWithRetry).mockResolvedValue('');
    const { cache, ctx } = makeCtx();

    const out = await aiTranslateJobDescriptionDCC(
      { description: ALREADY_DE, locale: 'de', sourceLang: 'en' }, ctx,
    );

    // '' e' il contratto «nessuna traduzione»: il chiamante tiene la sorgente,
    // esattamente il testo che il passthrough avrebbe scritto.
    expect(out).toBe('');
    expect(ctx.callLLM).not.toHaveBeenCalled();
    expect([...cache.values()]).toEqual(['__RAW__']);
  });

  it('sul passthrough di un echo genuino (sorgente ancora in lingua sorgente) il modello viene chiamato', async () => {
    vi.mocked(freeTranslateWithRetryDetailed).mockResolvedValue({ text: '', passthrough: true });
    vi.mocked(freeTranslateWithRetry).mockResolvedValue('');
    const { cache, ctx } = makeCtx();
    vi.mocked(ctx.callLLM).mockResolvedValue(TRANSLATED_DE);

    // SOURCE e' inglese e il locale richiesto e' 'de': il passthrough qui dice
    // solo che i tier gratuiti hanno echeggiato un body che andava tradotto —
    // e' il caso misurato in free-translate.mjs (27 body italiani verbatim
    // sotto /en/, /de/, /fr/). Il rung LLM e' l'unico recovery che resta.
    const out = await aiTranslateJobDescriptionDCC(
      { description: SOURCE, locale: 'de', sourceLang: 'en' }, ctx,
    );

    expect(ctx.callLLM).toHaveBeenCalledTimes(1);
    expect(out.toLowerCase()).toBe(TRANSLATED_DE.toLowerCase());
    expect([...cache.values()]).toEqual([out]);
  });

  it('sul passthrough di un body misto (argmax = locale ma confidenza sotto soglia) il modello viene chiamato', async () => {
    vi.mocked(freeTranslateWithRetryDetailed).mockResolvedValue({ text: '', passthrough: true });
    vi.mocked(freeTranslateWithRetry).mockResolvedValue('');
    const { cache, ctx } = makeCtx();
    vi.mocked(ctx.callLLM).mockResolvedValue(TRANSLATED_DE);

    // MIXED_DE_EN e' un annuncio bilingue: l'argmax e' 'de' (= locale) ma con
    // confidenza ~0.09. L'argmax nudo lo avrebbe letto come «gia' in tedesco»,
    // saltato l'LLM E memoizzato la sentinella, rendendo PERMANENTE la sorgente
    // pubblicata sotto /de/. Il pavimento a 0.65 lo manda al modello.
    const det = detectLanguageWithConfidence(MIXED_DE_EN, 'en');
    expect(det.lang).toBe('de');
    expect(det.confidence).toBeLessThan(0.65);

    const out = await aiTranslateJobDescriptionDCC(
      { description: MIXED_DE_EN, locale: 'de', sourceLang: 'en' }, ctx,
    );

    expect(ctx.callLLM).toHaveBeenCalledTimes(1);
    expect(out.toLowerCase()).toBe(TRANSLATED_DE.toLowerCase());
    expect([...cache.values()]).toEqual([out]);
  });

  it('coi motori giu\' il fallback LLM resta e la traduzione viene memoizzata', async () => {
    vi.mocked(freeTranslateWithRetryDetailed).mockResolvedValue({ text: '', passthrough: false });
    vi.mocked(freeTranslateWithRetry).mockResolvedValue('');
    const translated = TRANSLATED_DE;
    const { cache, ctx } = makeCtx();
    vi.mocked(ctx.callLLM).mockResolvedValue(translated);

    const out = await aiTranslateJobDescriptionDCC(
      { description: SOURCE, locale: 'de', sourceLang: 'en' }, ctx,
    );

    expect(ctx.callLLM).toHaveBeenCalledTimes(1);
    // `cleanDescriptionDCC` normalizza la capitalizzazione dell'uscita del
    // modello: il confronto guarda il TESTO, non la forma.
    expect(out.toLowerCase()).toBe(translated.toLowerCase());
    expect([...cache.values()]).toEqual([out]);
  });

  it('con la cascata che traduce non tocca il modello', async () => {
    const deepl = 'Wir suchen einen Softwareentwickler fuer unser Team in Lugano, '
      + 'der die Datenpipeline hinter unserer Stellenboerse betreut und fuer die '
      + 'Qualitaet der veroeffentlichten Inhalte geradesteht.';
    vi.mocked(freeTranslateWithRetryDetailed).mockResolvedValue({ text: deepl, passthrough: false });
    const { ctx } = makeCtx();

    const out = await aiTranslateJobDescriptionDCC(
      { description: SOURCE, locale: 'de', sourceLang: 'en' }, ctx,
    );

    expect(out).toBe(deepl);
    expect(ctx.callLLM).not.toHaveBeenCalled();
  });
});
