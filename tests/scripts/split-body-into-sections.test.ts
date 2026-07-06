// tests/scripts/split-body-into-sections.test.ts
//
// Live incident: the journalist-authored article "L'Accordo Italia-Svizzera
// del 2020 sulla tassazione dei lavoratori frontalieri" (44002-char body,
// ~11x the typical size) failed publish 3/3 with "splitBodyIntoSections:
// impossibile ottenere una suddivisione valida dopo 3 tentativi". Root cause:
// the old implementation had the LLM re-emit the ENTIRE body inside the JSON
// response (body1/body2/body3), so output size scaled 1:1 with input size
// against a fixed maxTokens:4000 — any body whose escaped JSON echo exceeded
// ~4000 tokens truncated identically on every retry (a structural cap
// mismatch, not a transient failure retries could fix).
//
// The fix has the LLM pick only 2 paragraph-index cut points (constant-size
// output regardless of body length) and slices the original paragraphs
// verbatim in JS, with a deterministic non-LLM fallback so the function never
// throws. These tests lock in both properties.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const aiModelsMock = vi.hoisted(() => ({ callLLM: vi.fn() }));

vi.mock('../../scripts/lib/ai-models.mjs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../scripts/lib/ai-models.mjs')>();
  return { ...actual, callLLM: aiModelsMock.callLLM };
});

const { splitBodyIntoSections } = await import('../../scripts/create-article.mjs');

function paragraphs(n: number, wordsPerParagraph = 40): string[] {
  return Array.from({ length: n }, (_, i) =>
    Array.from({ length: wordsPerParagraph }, (_, w) => `p${i}w${w}`).join(' '),
  );
}

describe('splitBodyIntoSections', () => {
  beforeEach(() => {
    aiModelsMock.callLLM.mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('never asks the LLM to echo the body back — output size stays constant regardless of body length', async () => {
    // 400 paragraphs (~44000 chars total) mirrors the failing article's size.
    const ps = paragraphs(400);
    const body = ps.join('\n\n');

    aiModelsMock.callLLM.mockImplementation(async (_messages, opts) => {
      // The old (buggy) implementation requested maxTokens:4000 to fit a full
      // body echo. The fix only needs 2 small integers back.
      expect(opts.maxTokens).toBeLessThanOrEqual(200);
      return JSON.stringify({ section2StartIndex: 150, section3StartIndex: 300 });
    });

    const result = await splitBodyIntoSections(body, 'Titolo di test');

    expect(result.body1).toBe(ps.slice(0, 150).join('\n\n'));
    expect(result.body2).toBe(ps.slice(150, 300).join('\n\n'));
    expect(result.body3).toBe(ps.slice(300).join('\n\n'));
    // Content preserved verbatim — no re-summarization/rewriting risk.
    expect([result.body1, result.body2, result.body3].join('\n\n')).toBe(body);
    expect(aiModelsMock.callLLM).toHaveBeenCalledTimes(1);
  });

  it('falls back deterministically (paragraph thirds) when the LLM returns invalid indices on every attempt', async () => {
    const ps = paragraphs(9);
    const body = ps.join('\n\n');

    aiModelsMock.callLLM.mockResolvedValue(JSON.stringify({ section2StartIndex: 'nope', section3StartIndex: null }));

    const result = await splitBodyIntoSections(body, 'Titolo di test');

    expect(result.body1).toBeTruthy();
    expect(result.body2).toBeTruthy();
    expect(result.body3).toBeTruthy();
    // No content lost or duplicated.
    expect(`${result.body1}\n\n${result.body2}\n\n${result.body3}`).toBe(body);
    expect(aiModelsMock.callLLM).toHaveBeenCalledTimes(3);
  });

  it('never throws even when every LLM call rejects (network/quota exhaustion)', async () => {
    const ps = paragraphs(6);
    const body = ps.join('\n\n');

    aiModelsMock.callLLM.mockRejectedValue(new Error('all models exhausted'));

    const result = await splitBodyIntoSections(body, 'Titolo di test');

    expect(result.body1).toBeTruthy();
    expect(result.body2).toBeTruthy();
    expect(result.body3).toBeTruthy();
  });

  it('falls back deterministically for a body with no paragraph breaks at all', async () => {
    const sentences = Array.from({ length: 9 }, (_, i) => `Questa è la frase numero ${i}.`);
    const body = sentences.join(' ');

    const result = await splitBodyIntoSections(body, 'Titolo di test');

    expect(result.body1).toBeTruthy();
    expect(result.body2).toBeTruthy();
    expect(result.body3).toBeTruthy();
    expect(aiModelsMock.callLLM).not.toHaveBeenCalled();
  });

  it('accepts a valid LLM split on the first attempt without retrying', async () => {
    const ps = paragraphs(5);
    const body = ps.join('\n\n');

    aiModelsMock.callLLM.mockResolvedValueOnce(
      JSON.stringify({ section2StartIndex: 2, section3StartIndex: 4 }),
    );

    const result = await splitBodyIntoSections(body, 'Titolo di test');

    expect(result.body1).toBe(ps.slice(0, 2).join('\n\n'));
    expect(result.body2).toBe(ps.slice(2, 4).join('\n\n'));
    expect(result.body3).toBe(ps.slice(4).join('\n\n'));
    expect(aiModelsMock.callLLM).toHaveBeenCalledTimes(1);
  });

  it('throws on an empty body (unchanged pre-existing guard)', async () => {
    await expect(splitBodyIntoSections('   ', 'Titolo di test')).rejects.toThrow('corpo vuoto');
  });
});
