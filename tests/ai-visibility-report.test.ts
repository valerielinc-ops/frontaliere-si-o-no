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
