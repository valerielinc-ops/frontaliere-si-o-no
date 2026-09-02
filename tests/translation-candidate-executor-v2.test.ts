import { describe, expect, it } from 'vitest';
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

function moduleUrl(source: string) {
  return `data:text/javascript;charset=utf-8,${encodeURIComponent(source)}`;
}

function provider(source = `export function translate(_request, { succeedText }) { succeedText(${JSON.stringify(candidateText)}); }`) {
  return {
    schemaVersion: 3,
    costClass: 'zero',
    engineVersion: 'stub-v1',
    executionClass: 'isolated_callback',
    moduleUrl: moduleUrl(source),
    exportName: 'translate',
  };
}

function input(overrides: Record<string, unknown> = {}) {
  return {
    identity,
    memory: createEmptyTranslationMemoryV2(),
    engineVersion: 'stub-v1',
    gateVersion: 'quality-v2',
    scanDigest,
    currentScanDigest: scanDigest,
    providerTimeoutMs: 2_000,
    quality,
    provider: provider(),
    ...overrides,
  };
}

describe('translation candidate executor v2 isolated provider protocol', () => {
  it('accepts only the exact cloneable V3 descriptor and preserves the frozen V2 output schema', async () => {
    const value = input();
    const legacy = {
      schemaVersion: 2, costClass: 'zero', engineVersion: 'stub-v1', executionClass: 'cooperative_async',
      translate: async () => candidateText,
    };
    await expect(executeTranslationCandidateV2({ ...value, unexpected: true } as never)).rejects.toThrow(TypeError);
    await expect(executeTranslationCandidateV2({ ...value, provider: legacy } as never)).rejects.toThrow(TypeError);
    await expect(executeTranslationCandidateV2({ ...value, provider: { ...value.provider, unexpected: true } } as never)).rejects.toThrow(TypeError);
    await expect(executeTranslationCandidateV2({ ...value, provider: { ...value.provider, moduleUrl: 'not a URL' } } as never)).rejects.toThrow(TypeError);

    const result = await executeTranslationCandidateV2(value);
    expect(Object.keys(result).sort()).toEqual(['attemptKey', 'candidate', 'evidence', 'memory', 'metrics', 'schemaVersion', 'status']);
    expect(Object.keys(result.metrics).sort()).toEqual(['providerCalls', 'recorded']);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.metrics)).toBe(true);
    expect(result).toMatchObject({ schemaVersion: 2, status: 'validated', metrics: { providerCalls: 1, recorded: true } });
    expect(result.candidate?.status).toBe('validated');
  });

  it('supports synchronous success/fail/throw and rejects every non-undefined return', async () => {
    const cases = [
      {
        source: `export function translate(_request, { succeedText }) { succeedText(${JSON.stringify(candidateText)}); }`,
        status: 'validated',
      },
      { source: 'export function translate(_request, { fail }) { fail(); }', status: 'generation_failed' },
      { source: 'export function translate() { throw new Error("provider failed"); }', status: 'generation_failed' },
      { source: 'export function translate() { process.exit(0); }', status: 'generation_failed' },
      { source: `export function translate() { return ${JSON.stringify(candidateText)}; }`, status: 'generation_failed' },
      { source: 'export function translate() { return Promise.resolve("ignored"); }', status: 'generation_failed' },
    ];
    for (const testCase of cases) {
      await expect(executeTranslationCandidateV2(input({ provider: provider(testCase.source) }))).resolves.toMatchObject({
        status: testCase.status,
        metrics: { providerCalls: 1, recorded: testCase.status === 'validated' },
      });
    }
  });

  it('keeps generation failures out of memory and applies the quality gate to callback text', async () => {
    const empty = await executeTranslationCandidateV2(input({
      provider: provider('export function translate(_request, { succeedText }) { succeedText("   "); }'),
    }));
    expect(empty).toMatchObject({ status: 'generation_failed', memory: createEmptyTranslationMemoryV2(), metrics: { providerCalls: 1, recorded: false } });

    const oversized = await executeTranslationCandidateV2(input({
      provider: provider('export function translate(_request, { succeedText }) { succeedText("x".repeat(120001)); }'),
    }));
    expect(oversized).toMatchObject({ status: 'generation_failed', memory: createEmptyTranslationMemoryV2(), metrics: { providerCalls: 1, recorded: false } });

    const rejected = await executeTranslationCandidateV2(input({
      provider: provider(`export function translate(_request, { succeedText }) { succeedText(${JSON.stringify(sourceText)}); }`),
    }));
    expect(rejected).toMatchObject({ status: 'retryable_reject', candidate: null, memory: createEmptyTranslationMemoryV2(), metrics: { providerCalls: 1, recorded: false } });
    expect(JSON.stringify(rejected)).not.toContain(sourceText);

    const periodic = Array.from({ length: 64 }, () => 'uno due uno due due due').join(' ');
    const duplicateBearing = await executeTranslationCandidateV2(input({
      provider: provider(`export function translate(_request, { succeedText }) { succeedText(${JSON.stringify(periodic)}); }`),
    }));
    expect(duplicateBearing).toMatchObject({ status: 'retryable_reject', memory: createEmptyTranslationMemoryV2(), metrics: { recorded: false } });
  });

  it('records, reuses and invalidates candidates without changing memory semantics', async () => {
    const first = await executeTranslationCandidateV2(input());
    expect(first.memory.records[0].candidates[0]).toMatchObject({ status: 'validated', outputText: candidateText });
    const reused = await executeTranslationCandidateV2(input({
      memory: first.memory,
      provider: provider('throw new Error("must not import on a reuse hit")'),
    }));
    expect(reused).toMatchObject({ status: 'reused', metrics: { providerCalls: 0, recorded: false } });

    const invalidated = invalidateTranslationCandidateV2(first.memory, {
      identityKey: identity.key,
      candidateId: first.candidate!.candidateId,
      reasonCode: 'test_superseded',
    });
    const duplicate = await executeTranslationCandidateV2(input({ memory: invalidated }));
    expect(duplicate).toMatchObject({ status: 'duplicate_attempt', memory: invalidated, metrics: { providerCalls: 1, recorded: false } });

    const replacement = long('La persona selezionata assiste utenti e colleghi con autonomia e competenza concreta.');
    const recordedAgain = await executeTranslationCandidateV2(input({
      memory: invalidated,
      provider: provider(`export function translate(_request, { succeedText }) { succeedText(${JSON.stringify(replacement)}); }`),
    }));
    expect(recordedAgain).toMatchObject({ status: 'validated', metrics: { providerCalls: 1, recorded: true } });
  });

  it('contains immediate and late frozen hostile rejections inside the Worker under strict mode', async () => {
    const listenerCount = process.listenerCount('unhandledRejection');
    for (const source of [
      'export function translate() { Object.freeze(Promise.reject(new Error("immediate hostile rejection"))); }',
      'export function translate() { setTimeout(() => Object.freeze(Promise.reject(new Error("late hostile rejection"))), 20); }',
    ]) {
      const result = await executeTranslationCandidateV2(input({ providerTimeoutMs: 1_000, provider: provider(source) }));
      expect(result).toMatchObject({ status: 'generation_failed', memory: createEmptyTranslationMemoryV2(), metrics: { providerCalls: 1, recorded: false } });
    }
    expect(process.listenerCount('unhandledRejection')).toBe(listenerCount);
  });

  it('preempts synchronous busy loops and ignores callbacks that arrive after the hard timeout', async () => {
    const started = performance.now();
    const busy = await executeTranslationCandidateV2(input({
      providerTimeoutMs: 100,
      provider: provider('export function translate() { while (true) {} }'),
    }));
    expect(busy).toMatchObject({ status: 'generation_failed', metrics: { providerCalls: 1, recorded: false } });
    expect(performance.now() - started).toBeLessThan(1_000);

    const late = await executeTranslationCandidateV2(input({
      providerTimeoutMs: 100,
      provider: provider(`export function translate(_request, { succeedText }) { setTimeout(() => succeedText(${JSON.stringify(candidateText)}), 500); }`),
    }));
    expect(late).toMatchObject({ status: 'generation_failed', memory: createEmptyTranslationMemoryV2(), metrics: { providerCalls: 1, recorded: false } });
    await new Promise((resolve) => setTimeout(resolve, 450));
    expect(late.memory).toEqual(createEmptyTranslationMemoryV2());
  });

  it('never reads a proxy or thenable returned by or passed from the provider', async () => {
    const returnedProxy = `
      export function translate(_request, { succeedText }) {
        return new Proxy({}, { get() { succeedText(${JSON.stringify(candidateText)}); return undefined; } });
      }
    `;
    const passedProxy = `
      export function translate(_request, { succeedText }) {
        const hostile = new Proxy({}, { get() { succeedText(${JSON.stringify(candidateText)}); return undefined; } });
        succeedText(hostile);
      }
    `;
    const returnedThenable = `
      export function translate(_request, { succeedText }) {
        return Object.defineProperty({}, 'then', { get() { succeedText(${JSON.stringify(candidateText)}); } });
      }
    `;
    for (const source of [returnedProxy, passedProxy, returnedThenable]) {
      await expect(executeTranslationCandidateV2(input({ provider: provider(source) }))).resolves.toMatchObject({
        status: 'generation_failed', memory: createEmptyTranslationMemoryV2(), metrics: { recorded: false },
      });
    }
  });

  it('honors the first terminal callback and fails closed on malformed direct Worker messages', async () => {
    const successFirst = await executeTranslationCandidateV2(input({
      provider: provider(`export function translate(_request, { succeedText, fail }) { succeedText(${JSON.stringify(candidateText)}); fail(); throw new Error('late'); }`),
    }));
    expect(successFirst.status).toBe('validated');
    const failureFirst = await executeTranslationCandidateV2(input({
      provider: provider(`export function translate(_request, { succeedText, fail }) { fail(); succeedText(${JSON.stringify(candidateText)}); }`),
    }));
    expect(failureFirst.status).toBe('generation_failed');

    const malformed = `
      import { parentPort } from 'node:worker_threads';
      export function translate() { parentPort.postMessage({ schemaVersion: 3, type: 'succeed', text: ${JSON.stringify(candidateText)}, extra: true }); }
    `;
    await expect(executeTranslationCandidateV2(input({ provider: provider(malformed) }))).resolves.toMatchObject({
      status: 'generation_failed', memory: createEmptyTranslationMemoryV2(), metrics: { recorded: false },
    });
    await expect(executeTranslationCandidateV2(input({
      provider: provider('export function translate(_request, { fail }) { fail(new Error("must not cross the protocol")); }'),
    }))).resolves.toMatchObject({ status: 'generation_failed' });
  });

  it('runs attempts concurrently without a busy provider blocking a sibling', async () => {
    const started = performance.now();
    let fastSettledAt = Infinity;
    const slow = executeTranslationCandidateV2(input({
      providerTimeoutMs: 150,
      provider: provider('export function translate() { while (true) {} }'),
    }));
    const fast = executeTranslationCandidateV2(input()).then((result) => {
      fastSettledAt = performance.now();
      return result;
    });
    const [slowResult, fastResult] = await Promise.all([slow, fast]);
    expect(slowResult.status).toBe('generation_failed');
    expect(fastResult.status).toBe('validated');
    expect(fastSettledAt - started).toBeLessThan(1_000);
  });

  it('passes a deeply frozen isolated request, AbortSignal and exact callbacks to the module export', async () => {
    const source = `
      export function translate(request, options) {
        const requestOk = Object.isFrozen(request) && Object.isFrozen(request.protectedTokens)
          && Object.keys(request).sort().join(',') === 'field,protectedTokens,sourceLang,sourceText,targetLang';
        const optionsOk = Object.isFrozen(options) && options.signal instanceof AbortSignal
          && Object.keys(options).sort().join(',') === 'fail,signal,succeedText';
        if (!requestOk || !optionsOk) { options.fail(); return; }
        options.succeedText(${JSON.stringify(candidateText)});
      }
    `;
    await expect(executeTranslationCandidateV2(input({ provider: provider(source) }))).resolves.toMatchObject({ status: 'validated' });
  });

  it('zero-calls stale, exact reuse, negative cache and conflict outcomes', async () => {
    const validatedMemory = recordTranslationCandidateV2(createEmptyTranslationMemoryV2(), {
      identity, engineVersion: 'stub-v1', gateVersion: 'quality-v2', outputText: candidateText,
      status: 'validated', evidence: [],
    });
    const negativeMemory = recordTranslationCandidateV2(createEmptyTranslationMemoryV2(), {
      identity, engineVersion: 'stub-v1', gateVersion: 'quality-v2', outputText: sourceText,
      status: 'rejected', evidence: [],
    });
    const conflictingMemory = recordTranslationCandidateV2(validatedMemory, {
      identity, engineVersion: 'stub-v1', gateVersion: 'quality-v2', outputText: long('Una traduzione alternativa valida e completa.'),
      status: 'validated', evidence: [],
    });
    const explosive = provider('throw new Error("must never import")');
    for (const [overrides, status] of [
      [{ currentScanDigest: `sha256:${'b'.repeat(64)}` }, 'stale_scan'],
      [{ memory: validatedMemory }, 'reused'],
      [{ memory: negativeMemory }, 'negative_cache'],
      [{ memory: conflictingMemory }, 'conflict'],
    ] as const) {
      const result = await executeTranslationCandidateV2(input({ ...overrides, provider: explosive }));
      expect(result).toMatchObject({ status, metrics: { providerCalls: 0, recorded: false } });
    }
  });

  it('validates identity/quality binding before starting a Worker', async () => {
    await expect(executeTranslationCandidateV2(input({
      quality: { ...quality, sourceText: `${sourceText} changed` },
      provider: provider('throw new Error("must never import")'),
    }))).rejects.toThrow(TypeError);
  });
});
