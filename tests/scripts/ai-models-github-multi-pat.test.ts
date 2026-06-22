import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// Pins GitHub Models multi-PAT rotation (2026-06-22). GitHub Models free-tier
// limits are per-ACCOUNT, and all ~25 GitHub-hosted models share that one PAT's
// budget. Supplying extra free-account PATs (GH_MODELS_PAT_2/3/…) multiplies the
// free generation quota: on a per-account daily/429 limit the call rotates to the
// next PAT instead of marking the model globally exhausted. Single-PAT setups
// must behave exactly as before.

const aiModels = (await import('../../scripts/lib/ai-models.mjs')) as unknown as {
  callLLM: (messages: unknown, opts?: Record<string, unknown>) => Promise<string>;
  getGhModelsPats: () => string[];
  resetState: () => void;
  AI_MODELS: Record<string, string>;
};
const { callLLM, getGhModelsPats, resetState, AI_MODELS } = aiModels;

const PAT_ENV = ['GH_MODELS_PAT', 'GH_MODELS_PAT_2', 'GH_MODELS_PAT_3'] as const;
let saved: Record<string, string | undefined>;
let originalFetch: typeof globalThis.fetch;

beforeEach(() => {
  saved = {};
  for (const k of PAT_ENV) { saved[k] = process.env[k]; delete process.env[k]; }
  originalFetch = globalThis.fetch;
  resetState();
});

afterEach(() => {
  for (const k of PAT_ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  globalThis.fetch = originalFetch;
  resetState();
});

describe('getGhModelsPats', () => {
  it('returns [] with no PAT configured', () => {
    expect(getGhModelsPats()).toEqual([]);
  });
  it('returns primary then numbered extras, deduped', () => {
    process.env.GH_MODELS_PAT = 'pat1';
    process.env.GH_MODELS_PAT_2 = 'pat2';
    process.env.GH_MODELS_PAT_3 = 'pat1'; // dup of primary → dropped
    expect(getGhModelsPats()).toEqual(['pat1', 'pat2']);
  });
  it('single PAT → 1-element array (legacy behaviour)', () => {
    process.env.GH_MODELS_PAT = 'solo';
    expect(getGhModelsPats()).toEqual(['solo']);
  });
});

function bearer(init: RequestInit | undefined): string {
  const h = (init?.headers || {}) as Record<string, string>;
  return String(h.Authorization || '').replace(/^Bearer\s+/, '');
}

describe('GitHub Models PAT rotation', () => {
  it('rotates to the second PAT when the first hits its per-account daily limit', async () => {
    process.env.GH_MODELS_PAT = 'pat1';
    process.env.GH_MODELS_PAT_2 = 'pat2';
    const seen: string[] = [];
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      const tok = bearer(init);
      seen.push(tok);
      if (tok === 'pat1') {
        return { ok: false, status: 429, headers: { get: () => null }, text: async () => 'RateLimitReached: userbymodelbyday limit exceeded' } as unknown as Response;
      }
      return { ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify({ choices: [{ message: { content: 'ROTATED-OK' } }] }) } as unknown as Response;
    }) as typeof globalThis.fetch;

    const out = await callLLM([{ role: 'user', content: 'hi' }], { chain: [AI_MODELS.GPT4O], maxRetriesPerModel: 1 });
    expect(out).toBe('ROTATED-OK');
    expect(seen).toContain('pat1');
    expect(seen).toContain('pat2');

    // The pat1 daily-limit must NOT have marked gpt-4o globally exhausted — a
    // second call must still reach the model (and rotate again). If suppression
    // were broken, the model would be skipped and the chain would be empty.
    seen.length = 0;
    const out2 = await callLLM([{ role: 'user', content: 'again' }], { chain: [AI_MODELS.GPT4O], maxRetriesPerModel: 1 });
    expect(out2).toBe('ROTATED-OK');
    expect(seen).toContain('pat2');
  });

  it('single PAT: a daily limit is NOT swallowed (no phantom rotation)', async () => {
    process.env.GH_MODELS_PAT = 'solo';
    globalThis.fetch = (async () =>
      ({ ok: false, status: 429, headers: { get: () => null }, text: async () => 'daily limit reached' } as unknown as Response)
    ) as typeof globalThis.fetch;
    // With one PAT and a single-model chain, the daily limit must surface as a
    // thrown failure (callLLM exhausts the chain), not a silent success.
    await expect(callLLM([{ role: 'user', content: 'hi' }], { chain: [AI_MODELS.GPT4O], maxRetriesPerModel: 1 })).rejects.toBeTruthy();
  });
});
