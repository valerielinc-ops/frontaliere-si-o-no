// tests/scripts/generate-faq-it-retry.test.ts
//
// Live incident: a redazione article's publish pipeline failed entirely when
// generateFaqIT's single LLM call returned malformed JSON ("Unterminated
// string in JSON") — there was no retry, and the plain-text regex last-resort
// fallback (extractFaqFromText) only recognizes labeled Q&A text, not a
// truncated JSON array, so it couldn't recover either. A malformed response
// from one model roll is a transient glitch a retry should absorb, same as
// splitBodyIntoSections/translateArticle already do elsewhere in this
// pipeline.
//
// callSingleModel (used internally by callFaqModel's per-model loop) is
// mocked so these tests run with no real network and no real rate-limit
// delay dependency on model success timing.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const aiModelsMock = vi.hoisted(() => ({ callSingleModel: vi.fn(), callLLM: vi.fn() }));

vi.mock('../../scripts/lib/ai-models.mjs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../scripts/lib/ai-models.mjs')>();
  return { ...actual, callSingleModel: aiModelsMock.callSingleModel, callLLM: aiModelsMock.callLLM };
});

const { generateFaqIT } = await import('../../scripts/batch-add-faq-to-articles.mjs');

const VALID_FAQ_JSON = JSON.stringify([
  { q: 'Domanda 1?', a: 'Risposta 1 con dati concreti sufficientemente lunga per passare i controlli di qualita.' },
  { q: 'Domanda 2?', a: 'Risposta 2 con dati concreti sufficientemente lunga per passare i controlli di qualita.' },
  { q: 'Domanda 3?', a: 'Risposta 3 con dati concreti sufficientemente lunga per passare i controlli di qualita.' },
]);

// Mirrors the actual truncated-JSON shape from the live incident.
const TRUNCATED_JSON = '[{"q":"Cosa prevede l\'Accordo?","a":"L\'Accordo Italia-Svizzera del 2020 sulla tassazione dei';

// Real calls are mocked, but generateFaqIT still pays the module's real
// rate-limit gap (~4.5s) between attempts — fake timers (which also fake
// Date, matching the rate limiter's Date.now()-based slot bookkeeping) let
// the retry loop run to completion instantly instead of costing ~10-20s of
// real wall-clock per test.
async function runWithFakeTimers<T>(fn: () => Promise<T>): Promise<T> {
  vi.useFakeTimers();
  try {
    const promise = fn();
    // Suppress the transient "unhandled rejection" warning a promise that
    // rejects mid-advance can trigger before the `await promise` below
    // attaches its real handler — the actual rejection still propagates
    // through the returned/awaited promise.
    promise.catch(() => {});
    // The rate limiter's module-level slot bookkeeping carries over between
    // tests while each test's fake clock resets to "now" — advance generously
    // (real wall-clock cost of this call is ~0 regardless of the ms value).
    await vi.advanceTimersByTimeAsync(60000);
    return await promise;
  } finally {
    vi.useRealTimers();
  }
}

describe('generateFaqIT — retries on malformed/truncated LLM output', () => {
  beforeEach(() => {
    aiModelsMock.callSingleModel.mockReset();
    aiModelsMock.callLLM.mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  it('retries after a truncated-JSON response and succeeds on a later attempt', async () => {
    aiModelsMock.callSingleModel
      .mockResolvedValueOnce(TRUNCATED_JSON)
      .mockResolvedValue(VALID_FAQ_JSON);

    const faq = await runWithFakeTimers(() => generateFaqIT('test-article-id', 'Corpo di test '.repeat(50)));

    expect(Array.isArray(faq)).toBe(true);
    expect(faq.length).toBe(3);
    expect(faq[0].q).toBe('Domanda 1?');
    // At least one failed attempt before the successful one.
    expect(aiModelsMock.callSingleModel.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('gives up after 3 attempts if every response is truncated/malformed', async () => {
    aiModelsMock.callSingleModel.mockResolvedValue(TRUNCATED_JSON);
    aiModelsMock.callLLM.mockResolvedValue(TRUNCATED_JSON);

    await expect(
      runWithFakeTimers(() => generateFaqIT('test-article-id', 'Corpo di test '.repeat(50))),
    ).rejects.toThrow();
  });

  it('succeeds immediately on the first well-formed response (no unnecessary retry)', async () => {
    aiModelsMock.callSingleModel.mockResolvedValueOnce(VALID_FAQ_JSON);

    const faq = await runWithFakeTimers(() => generateFaqIT('test-article-id', 'Corpo di test '.repeat(50)));

    expect(faq.length).toBe(3);
    expect(aiModelsMock.callSingleModel).toHaveBeenCalledTimes(1);
  });
});
