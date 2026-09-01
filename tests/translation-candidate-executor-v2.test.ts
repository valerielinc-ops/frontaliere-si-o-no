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
      executionClass: 'cooperative_async',
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

  it('records validated/terminal outcomes but keeps retryable rejects out of memory', async () => {
    const validated = input();
    const positive = await executeTranslationCandidateV2(executorInput(validated));
    expect(positive.memory.records[0].candidates[0]).toMatchObject({ status: 'validated', outputText: candidateText });

    const rejected = input();
    rejected.provider = provider(sourceText).provider;
    const negative = await executeTranslationCandidateV2(executorInput(rejected));
    expect(negative).toMatchObject({ status: 'retryable_reject', candidate: null, memory: createEmptyTranslationMemoryV2(), metrics: { providerCalls: 1, recorded: false } });
    expect(JSON.stringify(negative)).not.toContain(sourceText);
    expect(Object.keys(negative)).not.toContain('patch');

    const recovered = await executeTranslationCandidateV2(executorInput(input({ memory: negative.memory })));
    expect(recovered).toMatchObject({ status: 'validated', metrics: { providerCalls: 1, recorded: true } });
    const reused = await executeTranslationCandidateV2(executorInput(input({ memory: recovered.memory })));
    expect(reused).toMatchObject({ status: 'reused', metrics: { providerCalls: 0, recorded: false } });

    const longEnglish = 'The role requires demonstrated experience with customers and technical documentation. Candidates plan work, report progress, collaborate across teams, and deliver reliable results. The successful person communicates clearly, supports colleagues, manages priorities, and contributes practical ideas. This position offers a varied environment with training, responsibility, and opportunities to develop professional skills. Daily work includes reviewing requests, preparing clear updates, resolving issues, coordinating meetings, and sharing useful feedback with stakeholders.';
    const languageRejected = await executeTranslationCandidateV2(executorInput(input({ provider: provider(longEnglish).provider })));
    expect(languageRejected).toMatchObject({ status: 'retryable_reject', candidate: null, memory: createEmptyTranslationMemoryV2(), metrics: { providerCalls: 1, recorded: false } });
    expect(languageRejected.evidence.map((item) => item.code)).toEqual(expect.arrayContaining(['language.low_confidence_mismatch']));
    expect(JSON.stringify(languageRejected)).not.toContain(longEnglish);

    const echoSource = long('The candidate supports clients and the team.');
    const echoIdentity = createTranslationUnitIdentityV2({
      kind: 'job', fieldPath: 'description', sourceLocale: 'en', targetLocale: 'it', sourceText: echoSource,
      context: { company: null, location: null },
    });
    const invisibleEcho = echoSource.replace('supports', 'sup\u2061ports');
    const echoed = await executeTranslationCandidateV2(executorInput(input({
      identity: echoIdentity,
      quality: { ...quality, sourceText: echoSource },
      provider: provider(invisibleEcho).provider,
    })));
    expect(echoed).toMatchObject({ status: 'retryable_reject', candidate: null, memory: createEmptyTranslationMemoryV2(), metrics: { providerCalls: 1, recorded: false } });
  });

  it('does not persist or reuse a duplicate-bearing periodic candidate', async () => {
    const periodic = `${Array.from({ length: 64 }, () => 'uno uno due due tre tre').join(' ')} finale uno due tre quattro cinque`;
    const firstStub = provider(periodic);
    const first = await executeTranslationCandidateV2(executorInput(input({ provider: firstStub.provider })));
    expect(first).toMatchObject({ status: 'retryable_reject', candidate: null, memory: createEmptyTranslationMemoryV2(), metrics: { providerCalls: 1, recorded: false } });
    const retryStub = provider(periodic);
    const retried = await executeTranslationCandidateV2(executorInput(input({ memory: first.memory, provider: retryStub.provider })));
    expect(retried).toMatchObject({ status: 'retryable_reject', candidate: null, memory: createEmptyTranslationMemoryV2(), metrics: { providerCalls: 1, recorded: false } });
    expect(firstStub.calls()).toBe(1);
    expect(retryStub.calls()).toBe(1);
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

  it('requires cooperative thenable providers and rejects synchronous over-budget work', async () => {
    let nonThenableCalls = 0;
    const nonThenable = input({
      provider: {
        schemaVersion: 2, costClass: 'zero', engineVersion: 'stub-v1', executionClass: 'cooperative_async',
        translate() { nonThenableCalls += 1; return candidateText; },
      },
    });
    await expect(executeTranslationCandidateV2(executorInput(nonThenable))).resolves.toMatchObject({
      status: 'generation_failed', metrics: { providerCalls: 1, recorded: false },
    });
    expect(nonThenableCalls).toBe(1);

    const busy = input({
      providerTimeoutMs: 10,
      provider: {
        schemaVersion: 2, costClass: 'zero', engineVersion: 'stub-v1', executionClass: 'cooperative_async',
        translate() {
          const deadline = Date.now() + 120;
          while (Date.now() < deadline) { /* cooperative contract violation */ }
          return Promise.resolve(candidateText);
        },
      },
    });
    await expect(executeTranslationCandidateV2(executorInput(busy))).resolves.toMatchObject({
      status: 'generation_failed', memory: createEmptyTranslationMemoryV2(), metrics: { providerCalls: 1, recorded: false },
    });

    let thenReads = 0;
    const customThenable = input({
      providerTimeoutMs: 10,
      provider: {
        schemaVersion: 2, costClass: 'zero', engineVersion: 'stub-v1', executionClass: 'cooperative_async',
        translate() {
          const deadline = Date.now() + 50;
          while (Date.now() < deadline) { /* untrusted thenables are never assimilated */ }
          return Object.defineProperty({}, 'then', {
            get() { thenReads += 1; return () => undefined; },
          });
        },
      },
    });
    await expect(executeTranslationCandidateV2(executorInput(customThenable))).resolves.toMatchObject({
      status: 'generation_failed', metrics: { providerCalls: 1, recorded: false },
    });
    expect(thenReads).toBe(0);

    let lateSignal: AbortSignal | undefined;
    const busyLateRejection = input({
      providerTimeoutMs: 10,
      provider: {
        schemaVersion: 2, costClass: 'zero', engineVersion: 'stub-v1', executionClass: 'cooperative_async',
        translate(_request: unknown, options: { signal: AbortSignal }) {
          const deadline = Date.now() + 50;
          while (Date.now() < deadline) { /* tested synchronous overrun */ }
          lateSignal = options.signal;
          return Promise.reject(new Error('late provider failure'));
        },
      },
    });
    await expect(executeTranslationCandidateV2(executorInput(busyLateRejection))).resolves.toMatchObject({ status: 'generation_failed' });
    expect(lateSignal?.aborted).toBe(true);

    let proxyGets = 0;
    const proxyPromise = input({
      providerTimeoutMs: 5,
      provider: {
        schemaVersion: 2, costClass: 'zero', engineVersion: 'stub-v1', executionClass: 'cooperative_async',
        translate() {
          return new Proxy(Promise.resolve(candidateText), {
            get(target, key, receiver) {
              proxyGets += 1;
              const deadline = Date.now() + 75;
              while (Date.now() < deadline) { /* attacker trap must stay untouched */ }
              return Reflect.get(target, key, receiver);
            },
          });
        },
      },
    });
    await expect(executeTranslationCandidateV2(executorInput(proxyPromise))).resolves.toMatchObject({ status: 'generation_failed' });
    expect(proxyGets).toBe(0);

    class ProviderPromise<T> extends Promise<T> {}
    const subclassRejected = input({
      provider: {
        schemaVersion: 2, costClass: 'zero', engineVersion: 'stub-v1', executionClass: 'cooperative_async',
        translate() { return ProviderPromise.reject(new Error('subclass rejection')); },
      },
    });
    await expect(executeTranslationCandidateV2(executorInput(subclassRejected))).resolves.toMatchObject({ status: 'generation_failed' });

    vi.useFakeTimers();
    try {
      let signal: AbortSignal | undefined;
      const subclassLate = input({
        providerTimeoutMs: 5,
        provider: {
          schemaVersion: 2, costClass: 'zero', engineVersion: 'stub-v1', executionClass: 'cooperative_async',
          translate(_request: unknown, options: { signal: AbortSignal }) {
            signal = options.signal;
            return new ProviderPromise((_, reject) => setTimeout(() => reject(new Error('late subclass rejection')), 75));
          },
        },
      });
      const pending = executeTranslationCandidateV2(executorInput(subclassLate));
      await vi.advanceTimersByTimeAsync(5);
      await expect(pending).resolves.toMatchObject({ status: 'generation_failed' });
      await vi.advanceTimersByTimeAsync(75);
      expect(signal?.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('observes immediate and late hostile-species promise rejections without persistence or reuse', async () => {
    const unhandled: unknown[] = [];
    const observeUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', observeUnhandled);
    class HostileSpeciesPromise<T> extends Promise<T> {
      static get [Symbol.species]() { throw new Error('hostile species getter'); }
    }
    try {
      const immediate = input({
        provider: {
          schemaVersion: 2, costClass: 'zero', engineVersion: 'stub-v1', executionClass: 'cooperative_async',
          translate() { return HostileSpeciesPromise.reject(new Error('immediate hostile rejection')); },
        },
      });
      const first = await executeTranslationCandidateV2(executorInput(immediate));
      expect(first).toMatchObject({ status: 'generation_failed', memory: createEmptyTranslationMemoryV2(), metrics: { providerCalls: 1, recorded: false } });
      const retried = await executeTranslationCandidateV2(executorInput({ ...immediate, memory: first.memory }));
      expect(retried).toMatchObject({ status: 'generation_failed', metrics: { providerCalls: 1, recorded: false } });

      vi.useFakeTimers();
      try {
        const late = input({
          providerTimeoutMs: 5,
          provider: {
            schemaVersion: 2, costClass: 'zero', engineVersion: 'stub-v1', executionClass: 'cooperative_async',
            translate() { return new HostileSpeciesPromise((_, reject) => setTimeout(() => reject(new Error('late hostile rejection')), 75)); },
          },
        });
        const pending = executeTranslationCandidateV2(executorInput(late));
        await vi.advanceTimersByTimeAsync(5);
        const timedOut = await pending;
        expect(timedOut).toMatchObject({ status: 'generation_failed', memory: createEmptyTranslationMemoryV2(), metrics: { providerCalls: 1, recorded: false } });
        await vi.advanceTimersByTimeAsync(75);
      } finally {
        vi.useRealTimers();
      }
      await Promise.resolve();
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', observeUnhandled);
    }
  });

  it('snapshots hostile identity and memory trees before legacy validators or provider calls', async () => {
    const malformedIdentity = { ...identity } as Record<string, unknown>;
    let sourceHashReads = 0;
    Object.defineProperty(malformedIdentity, 'sourceHash', {
      enumerable: true,
      get() { sourceHashReads += 1; return identity.sourceHash; },
    });
    const existingMemory = recordTranslationCandidateV2(createEmptyTranslationMemoryV2(), {
      identity, engineVersion: 'stub-v1', gateVersion: 'quality-v2', outputText: candidateText, status: 'validated', evidence: [],
    });
    const candidateExtra = { ...existingMemory.records[0].candidates[0], extra: true };
    const malformedMemory = {
      ...existingMemory,
      records: [{ ...existingMemory.records[0], candidates: [candidateExtra] }],
    };
    const cyclicMemory: { schemaVersion: number; records: unknown[] } = { schemaVersion: 2, records: [] };
    cyclicMemory.records.push(cyclicMemory);
    let recordsReads = 0;
    const accessorMemory = Object.defineProperty({ ...createEmptyTranslationMemoryV2() }, 'records', {
      enumerable: true,
      get() { recordsReads += 1; return []; },
    });
    for (const [identityValue, memory] of [
      [malformedIdentity, createEmptyTranslationMemoryV2()],
      [Object.assign({ ...identity }, { [Symbol('extra')]: true }), createEmptyTranslationMemoryV2()],
      [Object.defineProperty({ ...identity }, 'hidden', { value: true }), createEmptyTranslationMemoryV2()],
      [identity, accessorMemory],
      [identity, malformedMemory],
      [identity, cyclicMemory],
    ] as const) {
      const stub = provider();
      await expect(executeTranslationCandidateV2(executorInput(input({ identity: identityValue, memory, provider: stub.provider })))).rejects.toThrow(TypeError);
      expect(stub.calls()).toBe(0);
    }
    expect(sourceHashReads).toBe(0);
    expect(recordsReads).toBe(0);

    for (const length of [500_000, 2 ** 32 - 1]) {
      const records: unknown[] = [];
      records.length = length;
      const stub = provider();
      await expect(executeTranslationCandidateV2(executorInput(input({
        memory: { schemaVersion: 2, records }, provider: stub.provider,
      })))).rejects.toThrow(TypeError);
      expect(stub.calls()).toBe(0);
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
        schemaVersion: 2, costClass: 'zero', engineVersion: 'stub-v1', executionClass: 'cooperative_async',
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

  it('retries invalidated-only attempts and records only a new output', async () => {
    const recorded = recordTranslationCandidateV2(createEmptyTranslationMemoryV2(), {
      identity, engineVersion: 'stub-v1', gateVersion: 'quality-v2', outputText: candidateText, status: 'rejected', evidence: [],
    });
    const invalidated = invalidateTranslationCandidateV2(recorded, {
      identityKey: identity.key,
      candidateId: recorded.records[0].candidates[0].candidateId,
      reasonCode: 'test_invalidated',
    });
    const same = provider(candidateText);
    const duplicate = await executeTranslationCandidateV2(executorInput(input({ memory: invalidated, provider: same.provider })));
    expect(duplicate).toMatchObject({ status: 'duplicate_attempt', memory: invalidated, metrics: { providerCalls: 1, recorded: false } });
    expect(same.calls()).toBe(1);

    const replacementText = candidateText.replace('supporta', 'affianca');
    const different = provider(replacementText);
    const recordedAgain = await executeTranslationCandidateV2(executorInput(input({ memory: invalidated, provider: different.provider })));
    expect(recordedAgain).toMatchObject({ status: 'validated', metrics: { providerCalls: 1, recorded: true } });
    expect(recordedAgain.memory.records[0].candidates).toHaveLength(2);
    const reused = await executeTranslationCandidateV2(executorInput(input({ memory: recordedAgain.memory })));
    expect(reused).toMatchObject({ status: 'reused', metrics: { providerCalls: 0, recorded: false } });
  });

  it('aborts a pending provider at its required bounded timeout', async () => {
    vi.useFakeTimers();
    try {
      let signal: AbortSignal | undefined;
      let calls = 0;
      const value = input({
        providerTimeoutMs: 10,
        provider: {
          schemaVersion: 2, costClass: 'zero', engineVersion: 'stub-v1', executionClass: 'cooperative_async',
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
      executionClass: 'cooperative_async',
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
      executionClass: 'cooperative_async',
      get translate() {
        getterCalls += 1;
        return async () => candidateText;
      },
    };
    await expect(executeTranslationCandidateV2(executorInput(input({ provider: accessorProvider })))).rejects.toThrow(TypeError);
    expect(getterCalls).toBe(0);
  });

  it('snapshots the exact top-level request before reading timeout or provider fields', async () => {
    const stub = provider();
    const request = executorInput(input({ provider: stub.provider })) as Record<string, unknown>;
    let timeoutReads = 0;
    Object.defineProperty(request, 'providerTimeoutMs', {
      enumerable: true,
      get() { timeoutReads += 1; return 1; },
    });
    await expect(executeTranslationCandidateV2(request as never)).rejects.toThrow(TypeError);
    expect(timeoutReads).toBe(0);
    expect(stub.calls()).toBe(0);

    let ownKeysCalls = 0;
    const stable = executorInput(input());
    const oneShotProxy = new Proxy(stable, {
      ownKeys(target) {
        ownKeysCalls += 1;
        return ownKeysCalls === 1 ? Reflect.ownKeys(target) : ['providerTimeoutMs'];
      },
    });
    await expect(executeTranslationCandidateV2(oneShotProxy)).resolves.toMatchObject({ status: 'validated' });
    expect(ownKeysCalls).toBe(1);
  });

  it('uses the frozen exact provider snapshot as the callable receiver', async () => {
    let receiver: unknown;
    const result = await executeTranslationCandidateV2(executorInput(input({
      provider: {
        schemaVersion: 2, costClass: 'zero', engineVersion: 'stub-v1', executionClass: 'cooperative_async',
        async translate(this: unknown) {
          receiver = this;
          return candidateText;
        },
      },
    })));
    expect(result.status).toBe('validated');
    expect(receiver).toEqual(expect.objectContaining({ schemaVersion: 2, costClass: 'zero', engineVersion: 'stub-v1', executionClass: 'cooperative_async' }));
    expect(Object.keys(receiver as object).sort()).toEqual(['costClass', 'engineVersion', 'executionClass', 'schemaVersion', 'translate']);
    expect(Object.isFrozen(receiver)).toBe(true);

    for (const provider of [
      Object.defineProperty({ schemaVersion: 2, costClass: 'zero', engineVersion: 'stub-v1', executionClass: 'cooperative_async', translate: async () => candidateText }, 'hidden', { value: true }),
      Object.assign({ schemaVersion: 2, costClass: 'zero', engineVersion: 'stub-v1', executionClass: 'cooperative_async', translate: async () => candidateText }, { [Symbol('extra')]: true }),
    ]) {
      const value = input({ provider });
      await expect(executeTranslationCandidateV2(executorInput(value))).rejects.toThrow(TypeError);
    }
    const stableProxy = new Proxy({ schemaVersion: 2, costClass: 'zero', engineVersion: 'stub-v1', executionClass: 'cooperative_async', translate: async () => candidateText }, {});
    await expect(executeTranslationCandidateV2(executorInput(input({ provider: stableProxy })))).resolves.toMatchObject({ status: 'validated' });
  });
});
