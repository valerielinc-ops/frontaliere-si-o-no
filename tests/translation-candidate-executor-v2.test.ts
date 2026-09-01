import { describe, expect, it, vi } from 'vitest';
import { executeTranslationCandidateV2 } from '../scripts/lib/translation-candidate-executor-v2.mjs';
import {
  createEmptyTranslationMemoryV2,
  invalidateTranslationCandidateV2,
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
    providerTimeoutMs: 10_000,
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
    for (const generated of [new Error('stub failure'), '   ', null as unknown as string, 'x'.repeat(120_001)]) {
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

  it('binds the identity to validated quality before lookup or provider calls', async () => {
    const alternatives = [
      { identity: createTranslationUnitIdentityV2({
        kind: 'job', fieldPath: 'description', sourceLocale: 'en', targetLocale: 'it', sourceText: `${sourceText} changed`,
        context: { company: null, location: null },
      }) },
      { identity: createTranslationUnitIdentityV2({
        kind: 'job', fieldPath: 'description', sourceLocale: 'en', targetLocale: 'de', sourceText,
        context: { company: null, location: null },
      }) },
      { identity: createTranslationUnitIdentityV2({
        kind: 'job', fieldPath: 'title', sourceLocale: 'en', targetLocale: 'it', sourceText,
        context: { company: null, location: null },
      }) },
      { quality: { ...quality, sourceLang: 'de' } },
    ];
    for (const override of alternatives) {
      const stub = provider();
      const value = input({ provider: stub.provider, ...override });
      await expect(executeTranslationCandidateV2(executorInput(value))).rejects.toThrow(TypeError);
      expect(stub.calls()).toBe(0);
    }
    const malformed = input({ quality: { ...quality, sourceText: 42 } });
    await expect(executeTranslationCandidateV2(executorInput(malformed))).rejects.toThrow(TypeError);
    expect(malformed.stub.calls()).toBe(0);
  });

  it('deep-freezes an isolated quality request before the provider runs', async () => {
    const callerQuality = { ...quality, protectedTokens: [{ category: 'company', value: 'Acme' }] };
    let request: unknown;
    const value = input({
      quality: callerQuality,
      provider: {
        schemaVersion: 2, costClass: 'zero', engineVersion: 'stub-v1',
        async translate(next: { protectedTokens: Array<{ value: string }> }) {
          request = next;
          expect(Object.isFrozen(next)).toBe(true);
          expect(Object.isFrozen(next.protectedTokens)).toBe(true);
          expect(Object.isFrozen(next.protectedTokens[0])).toBe(true);
          expect(() => { next.protectedTokens[0].value = 'changed'; }).toThrow();
          return candidateText;
        },
      },
    });
    await executeTranslationCandidateV2(executorInput(value));
    expect(request).not.toBe(callerQuality);
    expect(callerQuality.protectedTokens[0].value).toBe('Acme');
  });

  it('quarantines an invalidated-only exact attempt without invoking the provider', async () => {
    const recorded = recordTranslationCandidateV2(createEmptyTranslationMemoryV2(), {
      identity, engineVersion: 'stub-v1', gateVersion: 'quality-v2', outputText: candidateText, status: 'rejected', evidence: [],
    });
    const invalidated = invalidateTranslationCandidateV2(recorded, {
      identityKey: identity.key,
      candidateId: recorded.records[0].candidates[0].candidateId,
      reasonCode: 'test_invalidated',
    });
    const stub = provider();
    const result = await executeTranslationCandidateV2(executorInput(input({ memory: invalidated, provider: stub.provider })));
    expect(result).toMatchObject({ status: 'duplicate_attempt', memory: invalidated, metrics: { providerCalls: 0, recorded: false } });
    expect(stub.calls()).toBe(0);
  });

  it('aborts a pending provider at its required bounded timeout', async () => {
    vi.useFakeTimers();
    try {
      let signal: AbortSignal | undefined;
      let calls = 0;
      const value = input({
        providerTimeoutMs: 10,
        provider: {
          schemaVersion: 2, costClass: 'zero', engineVersion: 'stub-v1',
          translate(_request: unknown, options: { signal: AbortSignal }) {
            calls += 1;
            signal = options.signal;
            return new Promise(() => {});
          },
        },
      });
      const pending = executeTranslationCandidateV2(executorInput(value));
      await vi.advanceTimersByTimeAsync(10);
      await expect(pending).resolves.toMatchObject({ status: 'generation_failed', metrics: { providerCalls: 1, recorded: false } });
      expect(calls).toBe(1);
      expect(signal?.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('captures own provider data once and never invokes a later callable', async () => {
    let validatedCalls = 0;
    let changedCalls = 0;
    const mutableProvider = {
      schemaVersion: 2,
      costClass: 'zero',
      engineVersion: 'stub-v1',
      async translate() {
        validatedCalls += 1;
        return candidateText;
      },
    };
    const value = input({ provider: mutableProvider });
    const pending = executeTranslationCandidateV2(executorInput(value));
    mutableProvider.engineVersion = 'changed-v2';
    mutableProvider.translate = async () => {
      changedCalls += 1;
      return sourceText;
    };
    await expect(pending).resolves.toMatchObject({ status: 'validated', metrics: { providerCalls: 1 } });
    expect(validatedCalls).toBe(1);
    expect(changedCalls).toBe(0);

    let getterCalls = 0;
    const accessorProvider = {
      schemaVersion: 2,
      costClass: 'zero',
      engineVersion: 'stub-v1',
      get translate() {
        getterCalls += 1;
        return async () => candidateText;
      },
    };
    await expect(executeTranslationCandidateV2(executorInput(input({ provider: accessorProvider })))).rejects.toThrow(TypeError);
    expect(getterCalls).toBe(0);
  });
});
