import { describe, expect, it } from 'vitest';
import {
  classifyMopupWriteWithSemantic,
} from '../scripts/local-mt-mopup.mjs';
import {
  cosineSimilarity,
  createLocalMtSemanticJudge,
  DEFAULT_LOCAL_MT_SEMANTIC_THRESHOLD,
} from '../scripts/lib/local-mt-semantic-judge.mjs';

function vectorFor(text: string): number[] {
  if (text === 'Gefängnisseelsorger') return [1, 0, 0];
  if (text === 'Cappellano carcerario') return [0.99, 0.01, 0];
  if (text === 'Prigionieri') return [0, 1, 0];
  if (text === 'Macellaio 60-100%') return [0.98, 0.02, 0];
  return [0.8, 0.1, 0.1];
}

function fakeEmbedder(calls: Array<{ inputs: string[]; prefix: string }>) {
  return async ({ inputs, prefix }: { inputs: string[]; prefix: string }) => {
    calls.push({ inputs, prefix });
    return inputs.map(vectorFor);
  };
}

describe('local-mt semantic judge', () => {
  it('accepts a meaning-preserving translation and rejects an inversion', async () => {
    const calls: Array<{ inputs: string[]; prefix: string }> = [];
    const judge = createLocalMtSemanticJudge({
      embed: fakeEmbedder(calls),
      threshold: 0.8,
    });

    await expect(judge({
      sourceText: 'Gefängnisseelsorger',
      candidateText: 'Cappellano carcerario',
      sourceLang: 'de',
      targetLang: 'it',
    })).resolves.toMatchObject({
      accepted: true,
      reason: 'semantic-match',
    });

    await expect(judge({
      sourceText: 'Gefängnisseelsorger',
      candidateText: 'Prigionieri',
      sourceLang: 'de',
      targetLang: 'it',
    })).resolves.toMatchObject({
      accepted: false,
      reason: 'semantic-mismatch',
    });
    expect(calls.every(({ prefix }) => prefix === 'passage')).toBe(true);
  });

  it('caches repeated source vectors without using a remote provider', async () => {
    const calls: Array<{ inputs: string[]; prefix: string }> = [];
    const judge = createLocalMtSemanticJudge({ embed: fakeEmbedder(calls) });

    await judge({ sourceText: 'Gefängnisseelsorger', candidateText: 'Cappellano carcerario' });
    await judge({ sourceText: 'Gefängnisseelsorger', candidateText: 'Macellaio 60-100%' });

    expect(calls).toHaveLength(3);
    expect(calls.map(({ inputs }) => inputs[0])).toEqual([
      'Gefängnisseelsorger',
      'Cappellano carcerario',
      'Macellaio 60-100%',
    ]);
  });

  it('fails closed for missing text, malformed vectors, and embedder errors', async () => {
    const judge = createLocalMtSemanticJudge({
      embed: async ({ inputs }) => {
        if (inputs[0] === 'malformed') return [[Number.NaN]];
        throw new Error('model unavailable');
      },
    });

    await expect(judge({ sourceText: '', candidateText: 'candidate' })).resolves.toMatchObject({
      accepted: false,
      score: null,
      reason: 'missing-text',
    });
    await expect(judge({ sourceText: 'malformed', candidateText: 'candidate' })).resolves.toMatchObject({
      accepted: false,
      score: null,
      reason: 'embedding-error',
    });
    await expect(judge({ sourceText: 'source', candidateText: 'candidate' })).resolves.toMatchObject({
      accepted: false,
      score: null,
      reason: 'embedding-error',
    });
  });

  it('does not fabricate a score for invalid or zero vectors', () => {
    expect(cosineSimilarity([1, 0], [0, 1])).toBe(0);
    expect(cosineSimilarity([0, 0], [1, 0])).toBeNull();
    expect(cosineSimilarity([1], [1, 0])).toBeNull();
    expect(DEFAULT_LOCAL_MT_SEMANTIC_THRESHOLD).toBeGreaterThan(0.5);
  });
});

describe('local-mt write integration', () => {
  const job = {
    sourceLang: 'de',
    title: 'Gefängnisseelsorger',
    titleByLocale: {
      de: 'Gefängnisseelsorger',
      it: 'Aushilfe Verkauf',
    },
    descriptionByLocale: {},
  };

  it('rejects an inverted candidate after finalization and leaves the existing SEO field untouched', async () => {
    const before = structuredClone(job);
    const result = await classifyMopupWriteWithSemantic({
      job,
      locale: 'it',
      field: 'title',
      rawText: 'Prigionieri',
      semanticJudge: async () => ({
        accepted: false,
        score: 0.12,
        threshold: 0.62,
        reason: 'semantic-mismatch',
      }),
    });

    expect(result.decision).toBe('skip:semantic-mismatch');
    expect(result.semanticScore).toBe(0.12);
    expect(job).toEqual(before);
  });

  it('keeps the stored value when the semantic score is unavailable', async () => {
    const before = structuredClone(job);
    const result = await classifyMopupWriteWithSemantic({
      job,
      locale: 'it',
      field: 'title',
      rawText: 'Cappellano carcerario',
      semanticJudge: async () => ({
        accepted: false,
        score: null,
        reason: 'score-missing',
      }),
    });

    expect(result.decision).toBe('skip:semantic-unavailable');
    expect(result.semanticScore).toBeNull();
    expect(job).toEqual(before);
  });

  it('allows a meaning-preserving candidate through the same boundary', async () => {
    const result = await classifyMopupWriteWithSemantic({
      job: { ...job, titleByLocale: { de: job.title } },
      locale: 'it',
      field: 'title',
      rawText: 'Cappellano carcerario',
      semanticJudge: async () => ({
        accepted: true,
        score: 0.94,
        threshold: 0.62,
        reason: 'semantic-match',
      }),
    });

    expect(result).toMatchObject({
      decision: 'write',
      incoming: 'Cappellano carcerario',
      semanticScore: 0.94,
    });
  });
});
