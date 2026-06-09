import { describe, expect, it } from 'vitest';

// Regression guard for the "Generate Blog Article" false-positive Bug spam
// (Refs #1652) AND the reviewer's safety-net finding on PR #1671.
//
// callLLM throws `All AI models failed` with code ALL_MODELS_EXHAUSTED whenever
// the fallback chain empties — REGARDLESS of cause. A TRANSIENT cause (daily
// quota / rate-limit, resets at 00:00 UTC) should defer (exit 0 → self-trigger
// back-off retries later). A PERSISTENT cause (stale keys 401, depleted credits
// 402, removed models 404, chronically oversized payload 413, missing API keys)
// must still exit 1 and raise the Workflow-Failure issue — otherwise a real
// outage silences article generation forever with zero alert.
//
// So isQuotaExhaustedError trusts the dominant-cause flag (`transientExhaustion`)
// for structured callLLM errors, and the unambiguous quota substrings for
// re-thrown single-provider errors. It is the single source of truth shared
// with dedicated-crawler-common.mjs.
const aiModels = await import('../../scripts/lib/ai-models.mjs');
const { isQuotaExhaustedError } = aiModels;

describe('isQuotaExhaustedError — transient pool exhaustion vs real bug', () => {
  it('defers a structured ALL_MODELS_EXHAUSTED error only when transient-dominant', () => {
    const transient = Object.assign(new Error('All AI models failed. Chain: [a → b]. Errors: HTTP 429'), {
      code: 'ALL_MODELS_EXHAUSTED',
      transientExhaustion: true,
    });
    expect(isQuotaExhaustedError(transient)).toBe(true);
  });

  it('does NOT defer a persistent-dominant ALL_MODELS_EXHAUSTED outage (must still exit 1)', () => {
    // All keys revoked (401) / credits gone (402) / models removed (404) →
    // callLLM still throws ALL_MODELS_EXHAUSTED but flags it non-transient.
    const persistent = Object.assign(new Error('All AI models failed. Chain: [a]. Errors: HTTP 401 invalid key'), {
      code: 'ALL_MODELS_EXHAUSTED',
      transientExhaustion: false,
    });
    expect(isQuotaExhaustedError(persistent)).toBe(false);

    // Defensive: a structured error missing the flag entirely is treated as
    // non-transient (surfaces the issue rather than silencing it).
    const unflagged = Object.assign(new Error('All AI models failed.'), { code: 'ALL_MODELS_EXHAUSTED' });
    expect(isQuotaExhaustedError(unflagged)).toBe(false);
  });

  it('detects legacy provider quota/rate-limit message substrings (re-thrown single calls)', () => {
    const transient = [
      'You have hit your daily request limit',
      'exceeded your current quota, check your plan and billing details',
      'OpenRouter free-models-per-day cap reached',
    ];
    for (const msg of transient) {
      expect(isQuotaExhaustedError(new Error(msg)), msg).toBe(true);
    }
  });

  it('does NOT treat a bare "all ai models failed" message (no code) as transient', () => {
    // Without the structured code+flag we cannot know the cause → do not silence.
    expect(isQuotaExhaustedError(new Error('All AI models failed. Chain: [x]'))).toBe(false);
  });

  it('does NOT treat genuine code/data errors as transient (must still exit 1)', () => {
    const realBugs = [
      new Error('Campo body2 troppo corto per de'),
      new Error('Articolo rigettato: fact-check fallito'),
      new Error('Output JSON non valido dopo 3 tentativi con validazione jsonMode'),
      new Error('topic-gate abort: 0 frontaliere keywords'),
      new TypeError("Cannot read properties of undefined (reading 'it')"),
    ];
    for (const err of realBugs) {
      expect(isQuotaExhaustedError(err), err.message).toBe(false);
    }
  });

  it('handles null/undefined defensively', () => {
    expect(isQuotaExhaustedError(null)).toBe(false);
    expect(isQuotaExhaustedError(undefined)).toBe(false);
  });
});

describe('callLLM exhaustion cause classification (end-to-end)', () => {
  it('flags a daily-limit-exhausted chain as transient → deferrable', async () => {
    aiModels.resetState();
    const model = 'mistral/ministral-8b-latest';
    aiModels.markModelExhausted(model); // skip reason: "exhausted (daily limit …)"

    let caught: any;
    try {
      await aiModels.callLLM([{ role: 'user', content: "Reply 'ok'." }], { chain: [model], retries: 0, maxTokens: 8 });
    } catch (e) {
      caught = e;
    }
    expect(caught?.code).toBe('ALL_MODELS_EXHAUSTED');
    expect(caught?.transientExhaustion).toBe(true);
    expect(isQuotaExhaustedError(caught)).toBe(true);
  });

  it('flags a missing-API-key chain as persistent → NOT deferrable (raises issue)', async () => {
    aiModels.resetState();
    const prev = process.env.GROQ_API_KEY;
    delete process.env.GROQ_API_KEY;
    try {
      const model = 'groq/llama-3.3-70b-versatile'; // skip reason: "no API key for provider groq"
      let caught: any;
      try {
        await aiModels.callLLM([{ role: 'user', content: "Reply 'ok'." }], { chain: [model], retries: 0, maxTokens: 8 });
      } catch (e) {
        caught = e;
      }
      expect(caught?.code).toBe('ALL_MODELS_EXHAUSTED');
      expect(caught?.transientExhaustion).toBe(false);
      expect(isQuotaExhaustedError(caught)).toBe(false);
    } finally {
      if (prev !== undefined) process.env.GROQ_API_KEY = prev;
    }
  });
});
