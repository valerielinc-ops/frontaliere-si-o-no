import { describe, it, expect, vi, beforeEach } from 'vitest';
import { aiTranslateJobDescriptionDCC } from '@/scripts/lib/dedicated-crawler-common.mjs';
import { freeTranslateWithRetry, freeTranslateWithRetryDetailed } from '@/scripts/lib/free-translate.mjs';

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
 * (transitorio) e «i motori hanno risposto rendendo la sorgente verbatim»,
 * cioe' il testo e' gia' quello della lingua target. `aiTranslateJobDescriptionDCC`
 * non distingueva i due casi e cadeva nel fallback LLM su entrambi: una stringa
 * che non ha bisogno di traduzione costava una chiamata al modello — la risorsa
 * scarsa della pipeline — per farsi rendere lo stesso testo e vederselo scartare
 * subito dopo dal controllo `translated !== cleanDesc`.
 *
 * Questo file pinna i DUE versi, che e' il punto: sul passthrough il modello non
 * va chiamato, sui motori giu' DEVE ancora essere chiamato. Il verso positivo da
 * solo si soddisfa spegnendo il fallback LLM, che sarebbe un difetto peggiore di
 * quello che chiude.
 */

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

  it('sul passthrough non chiama il modello e memoizza la sentinella', async () => {
    vi.mocked(freeTranslateWithRetryDetailed).mockResolvedValue({ text: '', passthrough: true });
    vi.mocked(freeTranslateWithRetry).mockResolvedValue('');
    const { cache, ctx } = makeCtx();

    const out = await aiTranslateJobDescriptionDCC(
      { description: SOURCE, locale: 'de', sourceLang: 'en' }, ctx,
    );

    // '' e' il contratto «nessuna traduzione»: il chiamante tiene la sorgente,
    // esattamente il testo che il passthrough avrebbe scritto.
    expect(out).toBe('');
    expect(ctx.callLLM).not.toHaveBeenCalled();
    expect([...cache.values()]).toEqual(['__RAW__']);
  });

  it('coi motori giu\' il fallback LLM resta e la traduzione viene memoizzata', async () => {
    vi.mocked(freeTranslateWithRetryDetailed).mockResolvedValue({ text: '', passthrough: false });
    vi.mocked(freeTranslateWithRetry).mockResolvedValue('');
    const translated = 'Wir suchen einen Softwareentwickler fuer unser Team in Lugano. '
      + 'Sie arbeiten an der Datenpipeline hinter unserer Stellenboerse und verantworten '
      + 'die Qualitaet der veroeffentlichten Inhalte von Anfang bis Ende.';
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
