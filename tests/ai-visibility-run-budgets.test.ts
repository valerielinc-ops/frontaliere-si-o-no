import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Issue #7489 item 3. The per-run budgets of check-ai-visibility.mjs live in
 * module state: `openRouterRequests` (metered spend cap) and `retryBudgetLeftMs`
 * (cumulative sleep between retries). "Per run" only holds if a run clears them
 * on entry — the first was cleared at the top of runCheck(), the second was not,
 * so a second run in the SAME process inherited the first run's spent waiting
 * and gave up on the first transient failure without retrying.
 *
 * The report never writes to disk here: runCheck() appends to the committed
 * history file, which a test must not touch.
 */
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, writeFile: vi.fn(), appendFile: vi.fn(), mkdir: vi.fn() };
});

const {
  OPENROUTER_MAX_REQUESTS,
  fetchWithRetry,
  queryOpenRouter,
  resetRunBudgets,
  runCheck,
} = await import('../scripts/check-ai-visibility.mjs');

/** Run every sleep instantly — the budgets are still charged for the wait. */
const skipSleeps = () => {
  vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void) => {
    fn();
    return 0 as unknown as ReturnType<typeof setTimeout>;
  }) as unknown as typeof setTimeout);
};

const answer = () => new Response(JSON.stringify({
  choices: [{
    message: {
      content: 'Ecco alcune risorse utili.',
      annotations: [{
        type: 'url_citation',
        url_citation: { url: 'https://frontaliereticino.ch/', title: 'Frontaliere Ticino' },
      }],
    },
  }],
}), { status: 200 });

/** Transient failure with the longest honoured wait — burns the budget fast. */
const rateLimited = () => new Response('slow down', {
  status: 429,
  headers: { 'retry-after': '60' },
});

beforeEach(() => {
  vi.stubEnv('PERPLEXITY_API_KEY', '');
  vi.stubEnv('GEMINI_API_KEY', '');
  vi.stubEnv('VITE_GEMINI_API_KEY', '');
  vi.stubEnv('GH_MODELS_PAT', '');
  vi.stubEnv('OPENROUTER_API_KEY', 'sk-or-test');
  vi.stubEnv('AI_VISIBILITY_OPENROUTER_DISABLED', '');
  skipSleeps();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  resetRunBudgets();
});

describe('a run starts with its full budgets, whatever the previous run spent', () => {
  it('retries a transient failure in a second runCheck() in the same process', async () => {
    // Run 1: burn both module budgets — the metered cap and the retry waiting.
    vi.spyOn(globalThis, 'fetch').mockImplementation(rateLimited as unknown as typeof fetch);
    for (let i = 0; i < 12; i++) await fetchWithRetry('X', 'https://x.test', {});
    for (let i = 0; i < OPENROUTER_MAX_REQUESTS + 2; i++) await queryOpenRouter(`q${i}`);

    // Run 2: the first query trips a transient 429, every later one answers.
    let calls = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation((() => {
      calls += 1;
      return Promise.resolve(calls === 1 ? rateLimited() : answer());
    }) as unknown as typeof fetch);

    const report = await runCheck();

    // A fresh retry budget pays for the second attempt, so the first query is
    // measured. With the budget inherited from run 1 there is no second
    // attempt and the query is recorded as an unreachable platform.
    expect(report.results[0].platforms.openrouter).toMatchObject({ checked: true });

    // That retry is an emitted HTTP request, so it is charged to the metered
    // cap like any other: the cap still holds run-wide (it was reset too), and
    // it is the LAST query that goes unmeasured, not the first one that failed.
    expect(calls).toBe(OPENROUTER_MAX_REQUESTS);
    expect(report.results.at(-1).platforms.openrouter).toMatchObject({
      checked: false,
      unmeasured: 'openrouter-per-run-cap',
    });
  });
});
