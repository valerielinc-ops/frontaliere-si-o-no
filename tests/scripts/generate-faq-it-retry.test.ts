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

const { generateFaqIT, generateTopUpFaqIT } = await import('../../scripts/batch-add-faq-to-articles.mjs');

const VALID_FAQ_JSON = JSON.stringify([
  { q: 'Domanda 1?', a: 'Risposta 1 con dati concreti sufficientemente lunga per passare i controlli di qualita.' },
  { q: 'Domanda 2?', a: 'Risposta 2 con dati concreti sufficientemente lunga per passare i controlli di qualita.' },
  { q: 'Domanda 3?', a: 'Risposta 3 con dati concreti sufficientemente lunga per passare i controlli di qualita.' },
]);

// Mirrors the actual truncated-JSON shape from the live incident.
const TRUNCATED_JSON = '[{"q":"Cosa prevede l\'Accordo?","a":"L\'Accordo Italia-Svizzera del 2020 sulla tassazione dei';

// Mirrors the SECOND live incident on the same article (after the first
// retry fix landed): every one of 3 retry attempts truncated identically at
// maxTokens:2000 — 2+ complete pairs generated, then cut off mid-answer on
// the next one. Real cause: 2000 tokens wasn't enough for 5 detailed answers,
// not a random glitch (confirmed by the raw response showing clean prose cut
// mid-sentence, not corruption around a special character).
const TRUNCATED_WITH_COMPLETE_PAIRS =
  '[{"q":"Cosa prevede l\'Accordo?","a":"L\'Accordo del 2020 introduce un modello di tassazione alla fonte."},' +
  '{"q":"Quali sono i requisiti di frontiera?","a":"Risiedere entro 20 km dal confine e rientrare quotidianamente."},' +
  '{"q":"Quali comuni beneficiano della compensazione?","a":"I comuni italiani frontalieri ricevono il 40% fino al 2033."},' +
  '{"q":"Come funziona il telelavoro dal 2024?","a":"È previsto un adeguamento del 25% per il telelavoro in regime permanente, in attesa della ratifica del prot';

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
    // Generous margin: drift accumulates across every test in this file since
    // the rate limiter's slot state is module-global, not reset per test.
    await vi.advanceTimersByTimeAsync(180000);
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

  it('salvages complete pairs from a truncated array without needing a retry', async () => {
    aiModelsMock.callSingleModel.mockResolvedValueOnce(TRUNCATED_WITH_COMPLETE_PAIRS);

    const faq = await runWithFakeTimers(() => generateFaqIT('test-article-id', 'Corpo di test '.repeat(50)));

    expect(faq.length).toBe(3);
    expect(faq[0].q).toBe("Cosa prevede l'Accordo?");
    expect(faq[2].q).toBe('Quali comuni beneficiano della compensazione?');
    expect(aiModelsMock.callSingleModel).toHaveBeenCalledTimes(1);
  });

  // Verifies the fix: _extractCompleteJsonFaqPairs must receive `repaired` (the
  // repairJsonArray output), not the original `raw`. When all complete pairs
  // carry the common LLM quote-corruption (unescaped " inside a string value —
  // documented in JSON_QUOTE_SAFETY_RULE_IT / issue #3282), the regex's
  // [^"\\]* capture group stops at the first unescaped " and no pair matches
  // in `raw`, making salvage a no-op. repairJsonArray escapes those quotes;
  // passing `repaired` lets the extractor recover both complete pairs with no
  // retry needed.
  it('salvages complete pairs from a quote-corrupted truncated response via repaired string', async () => {
    // Both complete pairs have unescaped inner " (e.g. "tassa" echoed from
    // source) — the truncated third pair prevents JSON.parse(repaired) from
    // succeeding. Only _extractCompleteJsonFaqPairs(repaired) recovers them.
    const TRUNCATED_QUOTE_CORRUPTED =
      '[{"q":"Come funziona la "tassa sulla salute"?","a":"L\'importo ufficiale dipende dal reddito."},' +
      '{"q":"Chi \xe8 interessato?","a":"I frontalieri "regolari" con residenza entro 20 km."},' +
      '{"q":"Cosa succede con il telelavoro?","a":"Dal 2024 \xe8 previsto';

    aiModelsMock.callSingleModel.mockResolvedValue(TRUNCATED_QUOTE_CORRUPTED);

    const faq = await runWithFakeTimers(() => generateFaqIT('test-article-id', 'Corpo di test '.repeat(50)));

    expect(faq.length).toBe(2);
    expect(faq[0].q).toContain('tassa sulla salute');
    expect(faq[1].a).toContain('regolari');
    // Salvage succeeded on the first attempt — no retry.
    expect(aiModelsMock.callSingleModel).toHaveBeenCalledTimes(1);
  });

  it('escalates maxTokens on a truncation-shaped failure instead of repeating the same budget', async () => {
    aiModelsMock.callSingleModel
      .mockResolvedValueOnce(TRUNCATED_JSON)
      .mockResolvedValueOnce(TRUNCATED_JSON)
      .mockResolvedValue(VALID_FAQ_JSON);

    await runWithFakeTimers(() => generateFaqIT('test-article-id', 'Corpo di test '.repeat(50)));

    const maxTokensUsed = aiModelsMock.callSingleModel.mock.calls.map((call) => call[1]?.maxTokens);
    expect(maxTokensUsed).toEqual([2000, 4000, 8000]);
  });
});

// Review finding on PR #3629: generateTopUpFaqIT shares the exact same
// LLM-JSON-array shape and single-attempt fragility generateFaqIT had — both
// now share the _withFaqRetry wrapper, locked in here.
describe('generateTopUpFaqIT — shares the same retry wrapper as generateFaqIT', () => {
  const existingFaq = [{ q: 'Domanda esistente?', a: 'Risposta esistente.' }];

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

    const faq = await runWithFakeTimers(() =>
      generateTopUpFaqIT('test-article-id', 'Corpo di test '.repeat(50), existingFaq),
    );

    expect(Array.isArray(faq)).toBe(true);
    expect(faq.length).toBeGreaterThan(0);
    expect(aiModelsMock.callSingleModel.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('gives up after 3 attempts if every response is truncated/malformed', async () => {
    aiModelsMock.callSingleModel.mockResolvedValue(TRUNCATED_JSON);
    aiModelsMock.callLLM.mockResolvedValue(TRUNCATED_JSON);

    await expect(
      runWithFakeTimers(() => generateTopUpFaqIT('test-article-id', 'Corpo di test '.repeat(50), existingFaq)),
    ).rejects.toThrow();
  });
});
