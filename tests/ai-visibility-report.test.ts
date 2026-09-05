import { describe, expect, it, vi, afterEach } from 'vitest';

import {
  OPENROUTER_MAX_REQUESTS,
  applyPlatformAnswer,
  fetchWithRetry,
  findCompetitorMentions,
  findSiteMention,
  generateMarkdown,
  listAvailablePlatforms,
  queryOpenRouter,
  resetOpenRouterBudget,
  resetRetryBudget,
  RETRY_BUDGET_MS,
  UNMEASURED_BUDGET_CAP,
} from '../scripts/check-ai-visibility.mjs';

/**
 * Regression cover for issue #7005. Three monthly reports in a row read
 * "0/20 queries cite us" while EVERY platform call had failed: the run counted
 * an unreachable API as a query that does not cite us, and appended that 0 to
 * the committed history as if it were a measurement.
 */

const query = (over: Record<string, unknown> = {}) => ({
  query: 'costo vita Ticino',
  lang: 'it',
  category: 'cost-of-living',
  platforms: {},
  citedByAny: false,
  checkedByAny: false,
  citedUrls: [],
  competitorsCited: [],
  ...over,
});

const meta = (over: Record<string, unknown> = {}) => ({
  date: '2026-09-01',
  timestamp: '2026-09-01T12:00:00.000Z',
  domain: 'frontaliereticino.ch',
  totalQueries: 2,
  queriesChecked: 2,
  platformsChecked: ['gemini'],
  score: 0,
  scoreMax: 2,
  scorePercent: 0,
  ...over,
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.useRealTimers();
  resetOpenRouterBudget();
  resetRetryBudget();
});

const openRouterAnswer = (url: string) => new Response(JSON.stringify({
  choices: [{
    message: {
      content: 'Ecco alcune risorse utili.',
      annotations: [{ type: 'url_citation', url_citation: { url, title: 'Frontaliere Ticino' } }],
    },
  }],
}), { status: 200 });

describe('unreachable platforms are not a visibility signal', () => {
  it('lists a query nobody could check apart from the misses', () => {
    const md = generateMarkdown({
      meta: meta({ queriesChecked: 1, scoreMax: 1 }),
      results: [
        query({ checkedByAny: true, platforms: { gemini: { checked: true, cited: false } } }),
        query({ query: 'permesso G vantaggi svantaggi', platforms: { gemini: { checked: false, error: 'API call failed' } } }),
      ],
      competitorSummary: [],
    });

    expect(md).toContain('## Not checked (platform unreachable)');
    expect(md).toContain('- "permesso G vantaggi svantaggi"');
    // The unreachable query must NOT be recommended as content work.
    const actionItems = md.slice(md.indexOf('## Action Items'), md.indexOf('Recommendations:'));
    expect(actionItems).toContain('costo vita Ticino');
    expect(actionItems).not.toContain('permesso G');
  });

  it('does not report a lost citation for a query it could not check', () => {
    const md = generateMarkdown({
      meta: meta({ queriesChecked: 1, scoreMax: 1 }),
      results: [query({ query: 'tassazione frontalieri 2026' })],
      competitorSummary: [],
      trend: {
        previousDate: '2026-08-01',
        previousScore: 1,
        previousQueriesChecked: 1,
        previousResults: { 'tassazione frontalieri 2026': true },
      },
    });

    expect(md).not.toContain('🔴 Lost citations');
  });
});

describe('citation matching', () => {
  it('finds our domain in a Gemini grounding chunk title, not just in the redirect uri', () => {
    // groundingChunks expose the source host in `web.title`; `web.uri` is an
    // opaque vertexaisearch redirect that never contains the real domain.
    const citations = [
      'https://vertexaisearch.cloud.google.com/grounding-api-redirect/AbC123',
      'frontaliereticino.ch',
    ];
    expect(findSiteMention('Some grounded answer.', citations).cited).toBe(true);
    expect(findCompetitorMentions('', ['comparis.ch'])).toEqual(['comparis.ch']);
  });
});

describe('fetchWithRetry', () => {
  it('retries a 429 and returns the eventual success', async () => {
    vi.useFakeTimers();
    const ok = new Response('{}', { status: 200 });
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response('rate limited', { status: 429, headers: { 'retry-after': '1' } }))
      .mockResolvedValueOnce(ok);

    const promise = fetchWithRetry('Gemini', 'https://example.test', {});
    await vi.runAllTimersAsync();

    expect(await promise).toBe(ok);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('returns null (never a fake answer) when the platform stays down', async () => {
    vi.useFakeTimers();
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('down', { status: 503 }));

    const promise = fetchWithRetry('Gemini', 'https://example.test', {});
    await vi.runAllTimersAsync();

    expect(await promise).toBeNull();
  });

  it('does not retry a non-transient 410', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockImplementation(async () => new Response('retired', { status: 410 }));

    expect(await fetchWithRetry('GitHub Models', 'https://example.test', {})).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

/**
 * Issue #7402. With GitHub Models in retirement brownout, Gemini was the only
 * platform whose answer is GROUNDED (backed by live retrieval): one 429 of
 * quota and the whole run observes nothing. OpenRouter's web-search plugin is
 * a second grounded platform reachable with a key the repo already maps.
 */
describe('OpenRouter web-search platform', () => {
  it('reads the url_citation annotations as the real sources', async () => {
    vi.stubEnv('OPENROUTER_API_KEY', 'sk-or-test');
    vi.spyOn(globalThis, 'fetch')
      .mockImplementation(async () => openRouterAnswer('https://frontaliereticino.ch/calcolo-stipendio'));

    const result = { platforms: {}, citedByAny: false, citedUrls: [], competitorsCited: [] };
    const entry = applyPlatformAnswer(result, 'openrouter', await queryOpenRouter('costo vita Ticino'));

    expect(entry).toMatchObject({ checked: true, cited: true, totalCitations: 1 });
    expect(entry.citedUrls).toContain('https://frontaliereticino.ch/calcolo-stipendio');
    expect(result.citedByAny).toBe(true);
  });

  it('sends the web plugin, without which no citation can ever surface', async () => {
    vi.stubEnv('OPENROUTER_API_KEY', 'sk-or-test');
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockImplementation(async () => openRouterAnswer('https://comparis.ch/x'));

    await queryOpenRouter('costo vita Ticino');

    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body.plugins).toEqual([{ id: 'web', max_results: expect.any(Number) }]);
  });

  it('stops at the per-run request cap (metered web search)', async () => {
    vi.stubEnv('OPENROUTER_API_KEY', 'sk-or-test');
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockImplementation(async () => openRouterAnswer('https://comparis.ch/x'));

    for (let i = 0; i < OPENROUTER_MAX_REQUESTS + 5; i++) await queryOpenRouter(`q${i}`);

    expect(fetchMock).toHaveBeenCalledTimes(OPENROUTER_MAX_REQUESTS);
  });

  it('is absent from platformsChecked without a key, and when switched off', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => openRouterAnswer('https://x.test'));

    vi.stubEnv('OPENROUTER_API_KEY', '');
    expect(listAvailablePlatforms()).not.toContain('openrouter');

    vi.stubEnv('OPENROUTER_API_KEY', 'sk-or-test');
    vi.stubEnv('AI_VISIBILITY_OPENROUTER_DISABLED', '1');
    expect(listAvailablePlatforms()).not.toContain('openrouter');
    expect(await queryOpenRouter('costo vita Ticino')).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();

    vi.stubEnv('AI_VISIBILITY_OPENROUTER_DISABLED', '');
    expect(listAvailablePlatforms()).toContain('openrouter');
  });

  it('never fabricates a miss when the platform is unreachable', async () => {
    vi.stubEnv('OPENROUTER_API_KEY', 'sk-or-test');
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('no credits', { status: 402 }));

    const result = { platforms: {}, citedByAny: false, citedUrls: [], competitorsCited: [] };
    applyPlatformAnswer(result, 'openrouter', await queryOpenRouter('costo vita Ticino'));

    expect(result.platforms.openrouter).toEqual({ checked: false, error: 'API call failed' });
  });
});


/**
 * Issue #7400. Competitors were matched as a substring of the whole answer
 * text, so `ticino.ch` matched inside our OWN `frontaliereticino.ch`: the false
 * positive fired precisely on the queries where we ranked.
 */
describe('competitor matching is bounded to the host', () => {
  it('does not read our own domain as the competitor ticino.ch', () => {
    expect(findCompetitorMentions(
      'Vedi https://frontaliereticino.ch/calcolo-stipendio per il calcolo.',
      ['https://frontaliereticino.ch/calcolo-stipendio'],
    )).toEqual([]);
  });

  it('does not count a competitor merely named in a page title', () => {
    expect(findCompetitorMentions(
      '',
      ['Confronto premi cassa malati: la guida di Comparis.ch spiegata'],
    )).toEqual([]);
  });

  it('still books a competitor cited by URL or as a bare Gemini host', () => {
    expect(findCompetitorMentions('Fonte: https://www.comparis.ch/krankenkassen', []))
      .toEqual(['comparis.ch']);
    // Gemini grounding chunks expose the real host only as `web.title`.
    expect(findCompetitorMentions('', ['ticino.ch'])).toEqual(['ticino.ch']);
    // A subdomain of a competitor is still that competitor.
    expect(findCompetitorMentions('', ['https://www4.ti.ch/x', 'https://red.admin.ch/y']))
      .toEqual(['admin.ch']);
  });
});

/**
 * Issue #7398. MAX_ATTEMPTS bounds ONE call's wait, not the run's: 20 queries x
 * ~120s of `Retry-After: 60` sleep overran the job's 30-minute timeout, so the
 * run emitted neither the honest report nor the committed history.
 */
describe('retry waiting is capped per run, not only per call', () => {
  /** Swallow the sleeps, recording what each one WOULD have waited. */
  const captureWaits = () => {
    const waits: number[] = [];
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void, ms?: number) => {
      waits.push(Number(ms ?? 0));
      fn();
      return 0 as unknown as ReturnType<typeof setTimeout>;
    }) as unknown as typeof setTimeout);
    return waits;
  };

  const rateLimited = async () => new Response('slow down', {
    status: 429,
    headers: { 'retry-after': '60' },
  });

  it('never sleeps more than the run budget, however many calls fail', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(rateLimited);
    const waits = captureWaits();

    // Unbudgeted this is 12 x 120_000 = 1_440_000 ms of sleep.
    for (let i = 0; i < 12; i++) await fetchWithRetry('X', 'https://x.test', {});

    expect(waits.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(RETRY_BUDGET_MS);
  });

  it('returns null without sleeping once the budget is spent', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(rateLimited);
    const waits = captureWaits();

    for (let i = 0; i < 12; i++) await fetchWithRetry('X', 'https://x.test', {});
    const spent = waits.length;

    expect(await fetchWithRetry('X', 'https://x.test', {})).toBeNull();
    expect(waits.length).toBe(spent); // not one further sleep
  });

  it('starts each run with a full budget', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(rateLimited);
    const waits = captureWaits();

    for (let i = 0; i < 12; i++) await fetchWithRetry('X', 'https://x.test', {});
    resetRetryBudget();
    await fetchWithRetry('X', 'https://x.test', {});

    expect(waits.length).toBeGreaterThan(0);
  });
});

/**
 * Issue #7404. The metered cap counted calls to queryOpenRouter, not the HTTP
 * requests fetchWithRetry actually emits, and an unrecognised response shape
 * collapsed into a measured `cited: false`.
 */
describe('OpenRouter spend cap and response shape', () => {
  it('charges the cap per HTTP attempt, retries included', async () => {
    vi.stubEnv('OPENROUTER_API_KEY', 'sk-or-test');
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void) => {
      fn();
      return 0 as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout);
    // Every request is a retryable 429, so one queryOpenRouter burns 3 attempts.
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockImplementation(async () => new Response('slow down', { status: 429 }));

    for (let i = 0; i < OPENROUTER_MAX_REQUESTS + 5; i++) await queryOpenRouter(`q${i}`);

    expect(fetchMock.mock.calls.length).toBeLessThanOrEqual(OPENROUTER_MAX_REQUESTS);
  });

  it('records an unrecognised response as unchecked, never as a miss', async () => {
    vi.stubEnv('OPENROUTER_API_KEY', 'sk-or-test');
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify({
      choices: [{ message: { content: 'Ecco alcune risorse.' } }],
    }), { status: 200 }));

    const result = { platforms: {} as Record<string, unknown>, citedByAny: false, citedUrls: [], competitorsCited: [] };
    applyPlatformAnswer(result, 'openrouter', await queryOpenRouter('costo vita Ticino'));

    expect(result.platforms.openrouter).toEqual({ checked: false, error: 'API call failed' });
  });

  it('keeps a present-but-empty citation list an honest measured zero', async () => {
    vi.stubEnv('OPENROUTER_API_KEY', 'sk-or-test');
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify({
      choices: [{ message: { content: 'Nessuna fonte.', annotations: [] } }],
    }), { status: 200 }));

    const result = { platforms: {} as Record<string, unknown>, citedByAny: false, citedUrls: [], competitorsCited: [] };
    applyPlatformAnswer(result, 'openrouter', await queryOpenRouter('costo vita Ticino'));

    expect(result.platforms.openrouter).toMatchObject({ checked: true, cited: false });
  });

  it('reads the sources from the alternative citations shape', async () => {
    vi.stubEnv('OPENROUTER_API_KEY', 'sk-or-test');
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify({
      choices: [{ message: { content: 'Ecco.' } }],
      citations: ['https://frontaliereticino.ch/calcolo-stipendio'],
    }), { status: 200 }));

    const result = { platforms: {}, citedByAny: false, citedUrls: [], competitorsCited: [] };
    const entry = applyPlatformAnswer(result, 'openrouter', await queryOpenRouter('costo vita Ticino'));

    expect(entry).toMatchObject({ checked: true, cited: true });
  });
});

/**
 * Issue #7489 item 2. A query the spend cap stopped before it was sent used to
 * return the same `null` as a failed call, and the run recorded a visibility
 * outcome for a query nobody had asked. The two must stay distinguishable, both
 * in the per-platform entry and in the rendered report.
 */
describe('cap-skipped queries are not measured, not zero', () => {
  const exhaustBudget = async () => {
    for (let i = 0; i < OPENROUTER_MAX_REQUESTS; i++) await queryOpenRouter(`q${i}`);
  };

  it('returns the unmeasured sentinel once the cap is reached, not a plain null', async () => {
    vi.stubEnv('OPENROUTER_API_KEY', 'sk-or-test');
    vi.spyOn(globalThis, 'fetch')
      .mockImplementation(async () => openRouterAnswer('https://comparis.ch/x'));

    await exhaustBudget();

    expect(await queryOpenRouter('costo vita Ticino')).toEqual(UNMEASURED_BUDGET_CAP);
  });

  it('records it as unchecked with its own reason, never as a measured miss', async () => {
    vi.stubEnv('OPENROUTER_API_KEY', 'sk-or-test');
    vi.spyOn(globalThis, 'fetch')
      .mockImplementation(async () => openRouterAnswer('https://comparis.ch/x'));

    await exhaustBudget();

    const result = { platforms: {} as Record<string, unknown>, citedByAny: false, citedUrls: [], competitorsCited: [] };
    const entry = applyPlatformAnswer(result, 'openrouter', await queryOpenRouter('costo vita Ticino'));

    expect(entry).toEqual({
      checked: false,
      unmeasured: 'openrouter-per-run-cap',
      error: 'not measured: per-run request cap reached',
    });
    // Same score accounting as an unreachable platform: excluded, not a zero.
    expect(entry.cited).toBeUndefined();
    expect(result.citedByAny).toBe(false);
  });

  it('is distinguishable from a real API failure', async () => {
    vi.stubEnv('OPENROUTER_API_KEY', 'sk-or-test');
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('no credits', { status: 402 }));

    const result = { platforms: {} as Record<string, unknown>, citedByAny: false, citedUrls: [], competitorsCited: [] };
    applyPlatformAnswer(result, 'openrouter', await queryOpenRouter('costo vita Ticino'));

    expect(result.platforms.openrouter).toEqual({ checked: false, error: 'API call failed' });
  });

  it('renders the two unchecked reasons with different glyphs', () => {
    const md = generateMarkdown({
      meta: meta({ platformsChecked: ['openrouter'], totalQueries: 2, queriesChecked: 0, scoreMax: 0 }),
      results: [
        query({ query: 'skipped by cap', platforms: { openrouter: { checked: false, unmeasured: 'openrouter-per-run-cap' } } }),
        query({ query: 'platform down', platforms: { openrouter: { checked: false, error: 'API call failed' } } }),
      ],
      competitorSummary: [],
    });

    expect(md).toMatch(/\| 1 \| skipped by cap \|[^|]*\|\s*⏸\s*\|/);
    expect(md).toMatch(/\| 2 \| platform down \|[^|]*\|\s*⚪\s*\|/);
    expect(md).toContain('⏸ not measured');
  });
});
