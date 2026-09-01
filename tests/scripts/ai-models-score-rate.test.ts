import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as aiModels from '../../scripts/lib/ai-models.mjs';

const LOWER_RATE_HIGH_VOLUME = aiModels.AI_MODELS.MISTRAL_SMALL;
const HIGHER_RATE_LOW_VOLUME = aiModels.AI_MODELS.GROQ_LLAMA_3_3;
const ENV_KEYS = ['MISTRAL_API_KEY', 'GROQ_API_KEY', 'AI_MODELS_FORCE_CHAIN', 'AI_MODELS_PREFER'] as const;

describe('sortChainByScore — affidabilita prima della somma additiva', () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    aiModels.resetState();
    for (const key of ENV_KEYS) saved[key] = process.env[key];
    process.env.MISTRAL_API_KEY = 'test-key';
    process.env.GROQ_API_KEY = 'test-key';
    delete process.env.AI_MODELS_FORCE_CHAIN;
    delete process.env.AI_MODELS_PREFER;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    aiModels.resetState();
  });

  it('un tasso piu basso non vince solo perche il volume gli da uno score maggiore', () => {
    // 610/1000 = 61%, score +50: il vecchio ordinamento sceglieva questo.
    for (let i = 0; i < 610; i++) aiModels.recordModelSuccess(LOWER_RATE_HIGH_VOLUME);
    for (let i = 0; i < 390; i++) aiModels.recordModelFailure(LOWER_RATE_HIGH_VOLUME);

    // 9/10 = 90%, score +15: meno volume, ma affidabilita molto maggiore.
    for (let i = 0; i < 9; i++) aiModels.recordModelSuccess(HIGHER_RATE_LOW_VOLUME);
    aiModels.recordModelFailure(HIGHER_RATE_LOW_VOLUME);

    expect(aiModels.getScoreBoard()[0].model).toBe(LOWER_RATE_HIGH_VOLUME);
    expect(aiModels.getPreferredModel({ chain: [LOWER_RATE_HIGH_VOLUME, HIGHER_RATE_LOW_VOLUME] }))
      .toBe(HIGHER_RATE_LOW_VOLUME);
  });

  it('a parita di tasso conserva score e ordine originale come tiebreak', () => {
    // Laplace rate 0.5 per entrambi; il volume maggiore ha score piu basso.
    aiModels.recordModelSuccess(LOWER_RATE_HIGH_VOLUME);
    aiModels.recordModelFailure(LOWER_RATE_HIGH_VOLUME);
    for (let i = 0; i < 10; i++) aiModels.recordModelSuccess(HIGHER_RATE_LOW_VOLUME);
    for (let i = 0; i < 10; i++) aiModels.recordModelFailure(HIGHER_RATE_LOW_VOLUME);

    expect(aiModels.getPreferredModel({ chain: [HIGHER_RATE_LOW_VOLUME, LOWER_RATE_HIGH_VOLUME] }))
      .toBe(LOWER_RATE_HIGH_VOLUME);

    aiModels.resetState();
    expect(aiModels.getPreferredModel({ chain: [HIGHER_RATE_LOW_VOLUME, LOWER_RATE_HIGH_VOLUME] }))
      .toBe(HIGHER_RATE_LOW_VOLUME);
  });

  it('converte un HTTP success bocciato dal validator in un solo esito negativo', () => {
    aiModels.recordModelSuccess(LOWER_RATE_HIGH_VOLUME);
    aiModels.recordModelContentFailure(LOWER_RATE_HIGH_VOLUME);
    for (let i = 0; i < 4; i++) aiModels.recordModelSuccess(HIGHER_RATE_LOW_VOLUME);
    for (let i = 0; i < 6; i++) aiModels.recordModelFailure(HIGHER_RATE_LOW_VOLUME);

    // Senza la conversione il modello con contenuto inutilizzabile risulta 1/2
    // e batte il modello realmente riuscito 4 volte su 10.
    expect(aiModels.getPreferredModel({ chain: [LOWER_RATE_HIGH_VOLUME, HIGHER_RATE_LOW_VOLUME] }))
      .toBe(HIGHER_RATE_LOW_VOLUME);
    expect(aiModels.getScoreBoard().find(({ model }) => model === LOWER_RATE_HIGH_VOLUME))
      .toMatchObject({ successes: 1, failures: 1 });
  });

  it('mantiene visibile un guasto transportOnly senza usarlo per il ranking', () => {
    aiModels.recordModelFailure(LOWER_RATE_HIGH_VOLUME, { transportOnly: true });

    expect(aiModels.getPreferredModel({ chain: [LOWER_RATE_HIGH_VOLUME, HIGHER_RATE_LOW_VOLUME] }))
      .toBe(LOWER_RATE_HIGH_VOLUME);
    expect(aiModels.getStats().runOutcomes).toContainEqual({
      model: LOWER_RATE_HIGH_VOLUME,
      successes: 0,
      failures: 1,
    });
  });

  it('persiste le correzioni di ranking come incrementi atomici separati', async () => {
    const set = vi.fn().mockResolvedValue(undefined);
    aiModels.__installScoreStoreForTests({
      collection: () => ({ doc: () => ({ set }) }),
    }, {
      increment: (value: number) => ({ increment: value }),
    });

    aiModels.recordModelSuccess(LOWER_RATE_HIGH_VOLUME);
    aiModels.recordModelContentFailure(LOWER_RATE_HIGH_VOLUME);
    aiModels.recordModelFailure(HIGHER_RATE_LOW_VOLUME, { transportOnly: true });
    await aiModels.flushScores();

    const models = set.mock.calls[0][0].models;
    expect(models[LOWER_RATE_HIGH_VOLUME.replaceAll('/', '__')]).toMatchObject({
      successes: { increment: 1 },
      failures: { increment: 1 },
      rankRejectedSuccesses: { increment: 1 },
    });
    expect(models[HIGHER_RATE_LOW_VOLUME.replaceAll('/', '__')]).toMatchObject({
      failures: { increment: 1 },
      rankIgnoredFailures: { increment: 1 },
    });
  });

  it('un successo diagnostico non altera il nuovo ordinamento per tasso', async () => {
    // Evita init/discovery: il test deve osservare soltanto la chiamata indicata.
    aiModels.__installScoreStoreForTests(null);
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ choices: [{ message: { content: 'ok' } }] }),
    }) as Response));

    await aiModels.callLLM([{ role: 'user', content: 'ping' }], {
      chain: [LOWER_RATE_HIGH_VOLUME],
      maxRetriesPerModel: 1,
      recordScore: false,
    });

    expect(aiModels.getPreferredModel({ chain: [HIGHER_RATE_LOW_VOLUME, LOWER_RATE_HIGH_VOLUME] }))
      .toBe(HIGHER_RATE_LOW_VOLUME);
    expect(aiModels.getScoreBoard()).toEqual([]);
  });

  it('un 404 diagnostico non affonda ne esaurisce il modello nella catena', async () => {
    aiModels.__installScoreStoreForTests(null);
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: false,
      status: 404,
      text: async () => '',
    }) as Response));

    await expect(aiModels.callLLM([{ role: 'user', content: 'ping' }], {
      chain: [LOWER_RATE_HIGH_VOLUME],
      maxRetriesPerModel: 1,
      recordScore: false,
    })).rejects.toThrow(/HTTP 404/);

    expect(aiModels.getPreferredModel({ chain: [LOWER_RATE_HIGH_VOLUME, HIGHER_RATE_LOW_VOLUME] }))
      .toBe(LOWER_RATE_HIGH_VOLUME);
    expect(aiModels.getStats().exhaustedModels).not.toContain(LOWER_RATE_HIGH_VOLUME);
    expect(aiModels.getScoreBoard()).toEqual([]);
  });
});
