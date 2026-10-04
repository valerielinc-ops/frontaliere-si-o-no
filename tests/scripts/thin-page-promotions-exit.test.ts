import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { main } from '../../scripts/fetch-thin-page-promotions.mjs';
import { fetchGscPageImpressions } from '../../scripts/lib/evidence/gscFetcher.mjs';
import { httpFetchWithRetry } from '../../scripts/lib/transient-fetch.mjs';
import { writeFile } from 'node:fs/promises';
import { appendFileSync } from 'node:fs';

const { priorDate } = vi.hoisted(() => ({ priorDate: new Date(Date.now() - 90 * 86_400_000).toISOString().slice(0, 10) }));

vi.mock('../../scripts/lib/evidence/gscFetcher.mjs', () => ({ fetchGscPageImpressions: vi.fn() }));
vi.mock('../../scripts/lib/transient-fetch.mjs', () => ({ httpFetchWithRetry: vi.fn() }));
vi.mock('../../scripts/lib/ga4-service-account.mjs', async (importOriginal) => ({
  // paginateGa4Report resta quello vero: e' il contratto sotto test.
  ...await importOriginal<typeof import('../../scripts/lib/ga4-service-account.mjs')>(),
  GA4_READONLY_SCOPE: 'test-scope', getServiceAccountToken: vi.fn().mockResolvedValue('test-token'),
}));
vi.mock('node:fs/promises', async (importOriginal) => ({
  ...await importOriginal<typeof import('node:fs/promises')>(),
  readFile: vi.fn().mockResolvedValue(JSON.stringify({ urls: ['/prior'], _seenAt: { '/prior': priorDate } })),
  writeFile: vi.fn().mockResolvedValue(undefined), mkdir: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('node:fs', async (importOriginal) => ({
  ...await importOriginal<typeof import('node:fs')>(),
  existsSync: vi.fn().mockReturnValue(true), appendFileSync: vi.fn(),
}));

beforeEach(() => {
  vi.stubEnv('POSTHOG_PROJECT_ID', 'test');
  vi.stubEnv('POSTHOG_PERSONAL_API_KEY', 'test-key');
  vi.stubEnv('GA4_PROPERTY_ID', 'test');
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); vi.clearAllMocks(); });

describe('thin promotions exit contract', () => {
  it('saves partial observations but fails when every feed reports an error', async () => {
    vi.mocked(httpFetchWithRetry).mockRejectedValue(new Error('unavailable'));
    vi.mocked(fetchGscPageImpressions).mockResolvedValue({ pages: { '/observed/': 6 }, error: 'page: pagination incomplete' });
    expect(await main()).toBe(2);
    const persisted = JSON.parse(String(vi.mocked(writeFile).mock.calls[0][1]));
    expect(persisted.urls).toEqual(['/observed', '/prior']);
    expect(persisted._seenAt['/prior']).toBe(priorDate);
    expect(persisted._seenAt['/observed']).toBe(new Date().toISOString().slice(0, 10));
  });

  it('leaves the active file untouched when every feed fails without observations', async () => {
    vi.mocked(httpFetchWithRetry).mockRejectedValue(new Error('unavailable'));
    vi.mocked(fetchGscPageImpressions).mockResolvedValue({ pages: {}, error: 'page: fetch failed' });
    expect(await main()).toBe(2);
    expect(writeFile).not.toHaveBeenCalled();
  });

  it('returns partial only when at least one feed completed', async () => {
    vi.mocked(httpFetchWithRetry).mockImplementation(async (url) => {
      if (String(url).includes('posthog')) throw new Error('unavailable');
      return { ok: true, status: 200, json: async () => ({ rows: [] }) } as Response;
    });
    vi.mocked(fetchGscPageImpressions).mockResolvedValue({ pages: { '/observed/': 6 }, error: 'page: pagination incomplete' });
    expect(await main()).toBe(3);
    expect(writeFile).toHaveBeenCalledOnce();
  });

  it('succeeds only when all three feeds complete', async () => {
    vi.mocked(httpFetchWithRetry).mockResolvedValue({ ok: true, status: 200, json: async () => ({ rows: [], results: [] }) } as Response);
    vi.mocked(fetchGscPageImpressions).mockResolvedValue({ pages: { '/observed/': 6 }, error: null });
    expect(await main()).toBe(0);
    expect(JSON.parse(String(vi.mocked(writeFile).mock.calls[0][1])).urls).toEqual(['/observed']);
  });

  // Issue 11423, stessa classe: il runReport GA4 a limit fisso senza offset
  // perdeva la coda dei pagePath e dichiarava la fonte completa.
  function ga4Paged(rowCount: number, pageRows: (offset: number, limit: number) => string[]) {
    vi.mocked(httpFetchWithRetry).mockImplementation(async (url, init) => {
      if (!String(url).includes('analyticsdata')) {
        return { ok: true, status: 200, json: async () => ({ results: [] }) } as Response;
      }
      const body = JSON.parse(String((init as RequestInit).body));
      const paths = pageRows(Number(body.offset ?? 0), Number(body.limit));
      return { ok: true, status: 200, json: async () => ({
        rowCount,
        rows: paths.map((p) => ({ dimensionValues: [{ value: p }, { value: 'thin_page_view' }], metricValues: [{ value: '1' }] })),
      }) } as Response;
    });
    vi.mocked(fetchGscPageImpressions).mockResolvedValue({ pages: {}, error: null });
  }

  it('legge la coda GA4 oltre la prima pagina', async () => {
    ga4Paged(100_002, (offset, limit) => (offset === 0
      ? Array.from({ length: limit }, (_, index) => `/head-${index}/`)
      : ['/tail/', '/tail-2/']));
    expect(await main()).toBe(0);
    const persisted = JSON.parse(String(vi.mocked(writeFile).mock.calls[0][1]));
    expect(persisted.urls).toEqual(expect.arrayContaining(['/head-0', '/tail', '/tail-2']));
    expect(JSON.parse(String(vi.mocked(appendFileSync).mock.calls[0][1]))).toMatchObject({ complete: true, errors: [] });
  });

  it('dichiara parziale una risposta GA4 con la coda mancante', async () => {
    ga4Paged(5, () => ['/only/']);
    expect(await main()).toBe(3);
    const persisted = JSON.parse(String(vi.mocked(writeFile).mock.calls[0][1]));
    expect(persisted.urls).toContain('/only');
    const history = JSON.parse(String(vi.mocked(appendFileSync).mock.calls[0][1]));
    expect(history.complete).toBe(false);
    expect(history.errors).toEqual([expect.stringContaining('ga4: incomplete GA4 response (1/5 rows)')]);
  });
});
