import { beforeEach, describe, expect, it } from 'vitest';

// Regression guard for the smoke-test "empty Errors" bug (Refs #891).
//
// When callLLM is given a single-model chain whose only candidate is skipped
// pre-flight (exhausted / no API key / cooling down / token cap), the loop used
// to exit with an empty `errors` array, producing the undiagnosable message
// "All AI models failed. Chain: [X]. Errors: " — exactly what the 2026-05-29
// smoke run (#26660264763) surfaced for 169/180 failures (ms:0, blank cause).
//
// The fix records a per-model skip reason so the aggregate is always populated.
const aiModels = await import('../../scripts/lib/ai-models.mjs');

describe('ai-models pre-flight skip error-capture', () => {
  beforeEach(() => {
    aiModels.resetState();
  });

  it('propagates the exhaustion reason into the thrown error (not empty)', async () => {
    const model = 'mistral/ministral-8b-latest';
    aiModels.markModelExhausted(model);

    let caught: Error | undefined;
    try {
      await aiModels.callLLM([{ role: 'user', content: "Reply with 'ok'." }], {
        chain: [model],
        retries: 0,
        maxTokens: 8,
      });
    } catch (e) {
      caught = e as Error;
    }

    expect(caught).toBeDefined();
    const detail = String(caught?.message || '');
    // The bug: detail ended with "Errors: " (empty). The fix: the per-model
    // skip reason MUST be present so smoke output is diagnosable.
    expect(detail).not.toMatch(/Errors:\s*$/);
    expect(detail).toContain(model);
    expect(detail).toMatch(/skipped — exhausted/i);
  });

  it('reports a missing API key as the skip reason when no provider key is set', async () => {
    // Pick a provider that has no key in the test env. We assert the message
    // distinguishes "no API key" from "exhausted" so ops can act on it.
    const prevGroq = process.env.GROQ_API_KEY;
    delete process.env.GROQ_API_KEY;
    try {
      const model = 'groq/llama-3.3-70b-versatile';
      let caught: Error | undefined;
      try {
        await aiModels.callLLM([{ role: 'user', content: "Reply with 'ok'." }], {
          chain: [model],
          retries: 0,
          maxTokens: 8,
        });
      } catch (e) {
        caught = e as Error;
      }
      expect(caught).toBeDefined();
      const detail = String(caught?.message || '');
      expect(detail).not.toMatch(/Errors:\s*$/);
      expect(detail).toMatch(/no API key for provider/i);
    } finally {
      if (prevGroq !== undefined) process.env.GROQ_API_KEY = prevGroq;
    }
  });
});
