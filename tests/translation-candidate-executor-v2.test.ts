import { describe, expect, it } from 'vitest';
import { executeTranslationCandidateV2 } from '../scripts/lib/translation-candidate-executor-v2.mjs';
import {
  createEmptyTranslationMemoryV2,
  recordTranslationCandidateV2,
} from '../scripts/lib/content-addressed-translation-memory-v2.mjs';
import { createTranslationUnitIdentityV2 } from '../scripts/lib/translation-unit-identity-v2.mjs';

const long = (text: string) => `${text} ${'esperienza competenze responsabilità '.repeat(5)}`;
const sourceText = long('The candidate supports clients and the team with practical experience and responsibilities.');
const candidateText = long('Il candidato supporta clienti e il team con esperienza pratica e responsabilità.');
const identity = createTranslationUnitIdentityV2({
  kind: 'job', fieldPath: 'description', sourceLocale: 'en', targetLocale: 'it', sourceText,
  context: { company: null, location: null },
});
const scanDigest = `sha256:${'a'.repeat(64)}`;
const quality = {
  sourceText,
  sourceLang: 'en',
  targetLang: 'it',
  field: 'description',
  protectedTokens: [],
};

function provider(result: string | Error = candidateText) {
  let calls = 0;
  return {
    provider: {
      schemaVersion: 2,
      costClass: 'zero',
      engineVersion: 'stub-v1',
      async translate() {
        calls += 1;
        if (result instanceof Error) throw result;
        return result;
      },
    },
    calls: () => calls,
  };
}

function input(overrides: Record<string, unknown> = {}) {
  const stub = provider();
  return {
    identity,
    memory: createEmptyTranslationMemoryV2(),
    engineVersion: 'stub-v1',
    gateVersion: 'quality-v2',
    scanDigest,
    currentScanDigest: scanDigest,
    quality,
    provider: stub.provider,
    stub,
    ...overrides,
  };
}

function executorInput(value: ReturnType<typeof input>) {
  const { stub: _stub, ...executor } = value;
  return executor;
}

describe('translation candidate executor v2', () => {
  it('only accepts the injected zero-cost provider contract and returns a frozen exact schema', async () => {
    const value = input();
    await expect(executeTranslationCandidateV2({ ...executorInput(value), unexpected: true } as never)).rejects.toThrow(TypeError);
    await expect(executeTranslationCandidateV2({
      ...executorInput(value), provider: { ...value.provider, costClass: 'paid' },
    } as never)).rejects.toThrow(TypeError);

    const result = await executeTranslationCandidateV2(executorInput(value));
    expect(Object.keys(result).sort()).toEqual(['attemptKey', 'candidate', 'evidence', 'memory', 'metrics', 'schemaVersion', 'status']);
    expect(Object.keys(result.metrics).sort()).toEqual(['providerCalls', 'recorded']);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.metrics)).toBe(true);
    expect(result).toMatchObject({ schemaVersion: 2, status: 'validated', metrics: { providerCalls: 1, recorded: true } });
    expect(result.candidate?.status).toBe('validated');
    expect(JSON.stringify({ evidence: result.evidence, metrics: result.metrics })).not.toContain(candidateText);
  });

  it('records validation and rejection outcomes but never patches a target', async () => {
    const validated = input();
    const positive = await executeTranslationCandidateV2(executorInput(validated));
    expect(positive.memory.records[0].candidates[0]).toMatchObject({ status: 'validated', outputText: candidateText });

    const rejected = input();
    rejected.provider = provider(sourceText).provider;
    const negative = await executeTranslationCandidateV2(executorInput(rejected));
    expect(negative).toMatchObject({ status: 'rejected_candidate', metrics: { recorded: true } });
    expect(negative.memory.records[0].candidates[0].status).toBe('rejected');
    expect(Object.keys(negative)).not.toContain('patch');
  });

  it('does not call or mutate memory for provider errors and empty output', async () => {
    for (const generated of [new Error('stub failure'), '   ']) {
      const stub = provider(generated);
      const value = input({ provider: stub.provider });
      const result = await executeTranslationCandidateV2(executorInput(value));
      expect(result).toMatchObject({ status: 'generation_failed', memory: createEmptyTranslationMemoryV2(), metrics: { providerCalls: 1, recorded: false } });
      expect(stub.calls()).toBe(1);
    }
  });

  it('zero-calls exact reuse, negative cache, conflict and stale scan', async () => {
    const makeMemory = (status: 'validated' | 'rejected', outputText: string) => recordTranslationCandidateV2(createEmptyTranslationMemoryV2(), {
      identity, engineVersion: 'stub-v1', gateVersion: 'quality-v2', outputText, status, evidence: [],
    });
    const reusedMemory = makeMemory('validated', candidateText);
    const negativeMemory = makeMemory('rejected', sourceText);
    const conflictMemory = recordTranslationCandidateV2(reusedMemory, {
      identity, engineVersion: 'stub-v1', gateVersion: 'quality-v2', outputText: `${candidateText} ancora`, status: 'rejected', evidence: [],
    });
    for (const [memory, expectedStatus, overrides] of [
      [reusedMemory, 'reused', {}],
      [negativeMemory, 'negative_cache', {}],
      [conflictMemory, 'conflict', {}],
      [createEmptyTranslationMemoryV2(), 'stale_scan', { currentScanDigest: `sha256:${'b'.repeat(64)}` }],
    ] as const) {
      const stub = provider();
      const value = input({ memory, provider: stub.provider, ...overrides });
      const result = await executeTranslationCandidateV2(executorInput(value));
      expect(result.status).toBe(expectedStatus);
      expect(result.metrics).toMatchObject({ providerCalls: 0, recorded: false });
      expect(stub.calls()).toBe(0);
    }
  });

  it('misses when the engine or gate changes and records the new attempt', async () => {
    const first = await executeTranslationCandidateV2(executorInput(input()));
    for (const overrides of [{ engineVersion: 'stub-v2' }, { gateVersion: 'quality-v3' }]) {
      const stub = provider();
      const value = input({ memory: first.memory, provider: { ...stub.provider, engineVersion: overrides.engineVersion ?? 'stub-v1' }, ...overrides });
      const result = await executeTranslationCandidateV2(executorInput(value));
      expect(result).toMatchObject({ status: 'validated', metrics: { providerCalls: 1, recorded: true } });
      expect(stub.calls()).toBe(1);
    }
  });
});
