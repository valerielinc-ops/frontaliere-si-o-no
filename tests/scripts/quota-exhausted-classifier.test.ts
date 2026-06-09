import { describe, expect, it } from 'vitest';

// Regression guard for the "Generate Blog Article" false-positive Bug spam
// (Refs #1652). When every model in the fallback chain hits its daily quota,
// callLLM throws `All AI models failed` with code ALL_MODELS_EXHAUSTED. That is
// a TRANSIENT external-capacity condition (free-tier limits reset at 00:00 UTC),
// NOT a code bug. create-article.mjs uses isQuotaExhaustedError to defer
// gracefully (exit 0 → workflow self-trigger back-off retries later) instead of
// crashing (exit 1 → raises a priority:high "Workflow Failure" Bug issue every
// time the daily quota is briefly exhausted).
//
// The same helper is the single source of truth shared with
// dedicated-crawler-common.mjs (was a duplicated literal substring list).
const aiModels = await import('../../scripts/lib/ai-models.mjs');
const { isQuotaExhaustedError } = aiModels;

describe('isQuotaExhaustedError — transient pool exhaustion vs real bug', () => {
  it('detects the structured ALL_MODELS_EXHAUSTED error code', () => {
    const err = Object.assign(new Error('All AI models failed. Chain: [a → b]. Errors: HTTP 429'), {
      code: 'ALL_MODELS_EXHAUSTED',
    });
    expect(isQuotaExhaustedError(err)).toBe(true);
  });

  it('detects legacy provider quota/rate-limit message substrings', () => {
    const transient = [
      'All AI models failed. Chain: [x]. Errors: daily limit',
      'You have hit your daily request limit',
      'exceeded your current quota, check your plan and billing details',
      'OpenRouter free-models-per-day cap reached',
    ];
    for (const msg of transient) {
      expect(isQuotaExhaustedError(new Error(msg)), msg).toBe(true);
    }
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
