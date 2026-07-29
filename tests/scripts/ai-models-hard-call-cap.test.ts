import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Pins the per-call HARD CAP around _callModel (2026-07-29).
//
// Run 30436268314: a single model call in create-article.mjs hung 3h36m with
// ZERO log output — no per-model failure line, no fallback line, no wall-clock
// abort — and only ended when a human cancelled the job. Neither the provider's
// own 90s AbortSignal nor create-article's 55min deadlineMs fired: the deadline
// is only re-checked BETWEEN models in the cascade, so it cannot help while one
// call is in flight, and an in-request signal cannot help when the provider
// never lets it fire. These tests reproduce exactly that shape — a fetch that
// never settles and ignores its abort signal — and assert the cascade still
// advances.

const aiModels = (await import('../../scripts/lib/ai-models.mjs')) as unknown as {
  callLLM: (messages: unknown, opts?: Record<string, unknown>) => Promise<string>;
  initScoreStore: () => Promise<unknown>;
  resetState: () => void;
};
const { callLLM, initScoreStore, resetState } = aiModels;

const MESSAGES = [{ role: 'user', content: 'ping' }];

/** Cap for timeout=1000/maxRetriesPerModel=1: 1 * (30_000 floor + 120_000) * 2 + 60_000. */
const EXPECTED_CAP_MS = 360_000;

let savedPat: string | undefined;
let originalFetch: typeof globalThis.fetch;

function okResponse(content: string) {
  return {
    ok: true,
    status: 200,
    headers: { get: () => null },
    text: async () => JSON.stringify({ choices: [{ message: { content } }] }),
  } as unknown as Response;
}

// callLLM lazily initialises the Firestore-backed score store on its first
// invocation. With no credentials in CI that path burns several minutes of
// backoff — harmless, but under fake timers it has to be advanced through
// before the first request is ever dispatched, which would make every test
// below depend on test ORDER. Pay it once, up front, on real timers.
beforeAll(async () => {
  await initScoreStore();
});

beforeEach(() => {
  savedPat = process.env.GH_MODELS_PAT;
  process.env.GH_MODELS_PAT = 'test-pat';
  originalFetch = globalThis.fetch;
  resetState();
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
});

afterEach(() => {
  vi.useRealTimers();
  if (savedPat === undefined) delete process.env.GH_MODELS_PAT;
  else process.env.GH_MODELS_PAT = savedPat;
  globalThis.fetch = originalFetch;
  resetState();
});

describe('per-call hard cap', () => {
  it('abandons a call that never settles and falls through to the next model', async () => {
    const attempted: string[] = [];
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      const model = JSON.parse(String(init?.body || '{}')).model;
      attempted.push(model);
      // First model: a request that neither resolves nor honours its abort
      // signal — the exact failure shape of the incident.
      if (attempted.length === 1) return new Promise<Response>(() => {});
      return okResponse('second model answered');
    }) as unknown as typeof globalThis.fetch;

    const p = callLLM(MESSAGES, {
      chain: ['gpt-4o', 'gpt-4.1'],
      timeout: 1000,
      maxRetriesPerModel: 1,
    });

    await vi.advanceTimersByTimeAsync(EXPECTED_CAP_MS + 1000);

    await expect(p).resolves.toBe('second model answered');
    expect(attempted[0]).toBe('gpt-4o');
    expect(attempted).toHaveLength(2);
  });

  it('surfaces the stall as a timeout-classified error naming the model', async () => {
    globalThis.fetch = (async () => new Promise<Response>(() => {})) as unknown as typeof globalThis.fetch;

    const p = callLLM(MESSAGES, { chain: ['gpt-4o'], timeout: 1000, maxRetriesPerModel: 1 });
    const settled = p.catch((e: Error) => e);

    await vi.advanceTimersByTimeAsync(EXPECTED_CAP_MS + 1000);

    const err = (await settled) as Error;
    expect(err.message).toContain('hard cap');
    expect(err.message).toContain('gpt-4o');
  });

  it('clamps the cap to the remaining wall-clock budget when the caller sets deadlineMs', async () => {
    globalThis.fetch = (async () => new Promise<Response>(() => {})) as unknown as typeof globalThis.fetch;

    // Deadline 1s out → cap collapses to grace (60s) + remaining, far below the
    // 360s ceiling above. Without the clamp this call would still be in flight.
    const p = callLLM(MESSAGES, {
      chain: ['gpt-4o'],
      timeout: 1000,
      maxRetriesPerModel: 1,
      deadlineMs: Date.now() + 1000,
    });
    const settled = p.catch((e: Error) => e);

    await vi.advanceTimersByTimeAsync(62_000);

    const err = (await settled) as Error;
    expect(err.message).toContain('hard cap');
  });

  it('does not delay a healthy call', async () => {
    globalThis.fetch = (async () => okResponse('fast')) as unknown as typeof globalThis.fetch;

    const p = callLLM(MESSAGES, { chain: ['gpt-4o'], timeout: 1000, maxRetriesPerModel: 1 });
    // No timer advance at all: a responsive provider must settle on microtasks.
    await expect(p).resolves.toBe('fast');
  });
});
