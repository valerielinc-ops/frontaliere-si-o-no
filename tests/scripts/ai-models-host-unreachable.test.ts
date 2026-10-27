import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as aiModels from '../../scripts/lib/ai-models.mjs';

const GITHUB_CATALOG = [
  'openai/gpt-4o-mini',
  'openai/gpt-4.1-mini',
  'openai/gpt-4o',
];

const ENV_KEYS = [
  'AI_MODELS_FORCE_CHAIN',
  'GH_MODELS_PAT',
  'GH_MODELS_PAT_2',
  'GH_MODELS_PAT_3',
  'LOCAL_LLM_ENABLED',
  'LOCAL_LLM_URL',
  'OMNIROUTE_ENABLED',
  'OMNIROUTE_URL',
];

function undiciFetchFailed(code: string, extra: Record<string, unknown> = {}) {
  return Object.assign(new TypeError('fetch failed'), {
    cause: Object.assign(new Error(`${code} provider.example:443`), { code, ...extra }),
  });
}

function callGithub(opts: Record<string, unknown> = {}) {
  return aiModels.callLLM([{ role: 'user', content: 'ping' }], {
    githubModelsCatalog: GITHUB_CATALOG,
    maxTokens: 8,
    backoffMs: 1,
    timeout: 5_000,
    ...opts,
  } as Parameters<typeof aiModels.callLLM>[1]);
}

beforeEach(() => {
  vi.stubEnv('GH_MODELS_PAT', 'test-pat');
  for (const key of ENV_KEYS) {
    if (key !== 'GH_MODELS_PAT') vi.stubEnv(key, '');
  }
  aiModels.__installScoreStoreForTests(null);
  aiModels.resetState();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  aiModels.resetState();
});

describe('host-unreachable classification', () => {
  it('walks undici causes and AggregateError entries', () => {
    expect(aiModels.classifyHostUnreachable(undiciFetchFailed('ENOTFOUND'))).toBe('ENOTFOUND');
    expect(aiModels.classifyHostUnreachable(undiciFetchFailed('ECONNREFUSED'))).toBe('ECONNREFUSED');
    expect(aiModels.classifyHostUnreachable({
      cause: new AggregateError([
        Object.assign(new Error('v6'), { code: 'EHOSTUNREACH' }),
      ]),
    })).toBe('EHOSTUNREACH');
  });

  it('keeps reset, pipe, timeout and resolver hiccups retryable', () => {
    for (const code of ['ECONNRESET', 'EPIPE', 'EAI_AGAIN']) {
      expect(aiModels.classifyHostUnreachable(undiciFetchFailed(code))).toBeNull();
    }
    expect(aiModels.classifyTransientResolver(undiciFetchFailed('EAI_AGAIN'))).toBe('EAI_AGAIN');
    expect(aiModels.classifyTransientResolver(undiciFetchFailed('ENOTFOUND'))).toBeNull();
  });

  it('does not loop on a cyclic cause chain', () => {
    const first: { cause?: unknown } = {};
    const second: { cause?: unknown } = {};
    first.cause = second;
    second.cause = first;
    expect(aiModels.classifyHostUnreachable(first)).toBeNull();
    expect(aiModels.classifyTransientResolver(first)).toBeNull();
  });
});

describe('provider host breaker', () => {
  it('spends one connect and skips sibling models with a persistent reason', async () => {
    vi.stubEnv('AI_MODELS_FORCE_CHAIN', 'gpt-4o-mini,gpt-4.1-mini');
    const fetchMock = vi.fn(async () => { throw undiciFetchFailed('ENOTFOUND'); });
    vi.stubGlobal('fetch', fetchMock);

    const error = await callGithub({ maxRetriesPerModel: 3 }).then(
      () => null,
      (caught) => caught as Error & { exhaustionBreakdown?: { transient: number; persistent: number } },
    );

    expect(error).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(aiModels.getStats().retries).toBe(0);
    expect(aiModels.getStats().exhaustedModels).toContain('gpt-4o-mini');
    expect(aiModels.getStats().activeCooldowns.github).toBe(Infinity);
    expect(error?.message).toMatch(/skipped — provider github unreachable \(ENOTFOUND\), non-retryable/);
    expect(error?.message).not.toMatch(/cooling down/);
    expect(error?.exhaustionBreakdown?.transient).toBe(0);
    expect(error?.exhaustionBreakdown?.persistent).toBeGreaterThan(0);
  });

  it('escalates three consecutive EAI_AGAIN failures to a finite cooldown', async () => {
    vi.stubEnv('AI_MODELS_FORCE_CHAIN', 'gpt-4o-mini,gpt-4.1-mini,gpt-4o');
    const fetchMock = vi.fn(async () => { throw undiciFetchFailed('EAI_AGAIN'); });
    vi.stubGlobal('fetch', fetchMock);

    await expect(callGithub({ maxRetriesPerModel: 1 })).rejects.toMatchObject({ code: 'ALL_MODELS_EXHAUSTED' });

    expect(fetchMock).toHaveBeenCalledTimes(3);
    const cooldown = aiModels.getStats().activeCooldowns.github;
    expect(cooldown).toBeGreaterThan(60);
    expect(Number.isFinite(cooldown)).toBe(true);
    expect(aiModels.getStats().exhaustedModels).toContain('gpt-4o');
  });

  it('keys resolver flaps by configurable endpoint host', () => {
    expect(aiModels.resolverFlapKey({ provider: 'omniroute', endpointHost: 'Gateway.Example.' }))
      .toBe('gateway.example');
    expect(aiModels.resolverFlapKey({ provider: 'github', endpointHost: 'other.example' }))
      .toBe('github');
  });

  it('keeps the default loopback fallback exempt but arms a remote override', async () => {
    vi.stubEnv('LOCAL_LLM_ENABLED', '1');
    vi.stubEnv('AI_MODELS_FORCE_CHAIN', 'local/fallback');
    vi.stubGlobal('fetch', vi.fn(async () => { throw undiciFetchFailed('ECONNREFUSED'); }));

    await expect(aiModels.callLLM([{ role: 'user', content: 'ping' }], {
      maxRetriesPerModel: 1,
      backoffMs: 1,
      timeout: 5_000,
    })).rejects.toMatchObject({ code: 'ALL_MODELS_EXHAUSTED' });
    expect(aiModels.getStats().exhaustedModels).not.toContain('local/fallback');
    expect(aiModels.getStats().activeCooldowns.local).toBeUndefined();

    aiModels.resetState();
    vi.stubEnv('LOCAL_LLM_URL', 'https://gateway.example.invalid/v1/chat/completions');
    await expect(aiModels.callLLM([{ role: 'user', content: 'ping' }], {
      maxRetriesPerModel: 1,
      backoffMs: 1,
      timeout: 5_000,
    })).rejects.toMatchObject({ code: 'ALL_MODELS_EXHAUSTED' });
    expect(aiModels.getStats().exhaustedModels).toContain('local/fallback');
    expect(aiModels.getStats().activeCooldowns.local).toBe(Infinity);
  });
});

describe('cooldown severity contract', () => {
  it('keeps transient, resolver-flap and persistent durations monotonic', () => {
    const durations = aiModels._cooldownSeverityDurations();
    expect(durations.map((entry) => entry.name)).toEqual(['transient', 'resolverFlap', 'persistent']);
    expect(durations[0].durationMs).toBe(60_000);
    expect(durations[1].durationMs).toBeGreaterThan(durations[0].durationMs);
    expect(durations[2].durationMs).toBe(Infinity);
  });
});

describe('recordScore availability contract', () => {
  it('coerces workflow-style opt-out values without mutating the ledger', async () => {
    expect(aiModels.coerceRecordScore(false)).toBe(false);
    expect(aiModels.coerceRecordScore(0)).toBe(false);
    expect(aiModels.coerceRecordScore(null)).toBe(false);
    expect(aiModels.coerceRecordScore('false')).toBe(false);
    expect(aiModels.coerceRecordScore('true')).toBe(true);

    aiModels.recordModelSuccess('gpt-4o-mini', { recordScore: 'false' });
    aiModels.recordModelFailure('gpt-4o-mini', { recordScore: 0 });
    aiModels.markModelExhausted('gpt-4o-mini', 'nonretryable', 'ENOTFOUND', { recordScore: false });

    expect(aiModels.getStats().dirtyModels).toBe(0);
    expect(aiModels.getScoreBoard()).toEqual([]);
    expect(aiModels.getStats().exhaustedModels).toContain('gpt-4o-mini');
    expect(aiModels.isModelAvailable('gpt-4o-mini')).toBe(false);
  });

  it('keeps the host breaker in-process while recordScore is disabled', async () => {
    vi.stubEnv('AI_MODELS_FORCE_CHAIN', 'gpt-4o-mini,gpt-4.1-mini');
    vi.stubGlobal('fetch', vi.fn(async () => { throw undiciFetchFailed('ENOTFOUND'); }));

    await expect(callGithub({ maxRetriesPerModel: 3, recordScore: 'false' })).rejects.toMatchObject({
      code: 'ALL_MODELS_EXHAUSTED',
    });

    expect(aiModels.getStats().dirtyModels).toBe(0);
    expect(aiModels.getStats().exhaustedModels).toContain('gpt-4o-mini');
    expect(aiModels.getStats().activeCooldowns.github).toBe(Infinity);
    expect(aiModels.getScoreBoard()).toEqual([]);
  });
});
