import { describe, expect, it, vi } from 'vitest';

import {
  fetchErrorDiagnostics,
  fetchErrorPaths,
  resolveZoneId,
  sweepErrorPathsWindowed,
} from '../scripts/lib/cf-analytics.mjs';

const response = (body: unknown) => ({
  status: 200,
  json: async () => body,
});

const graphqlBody = (rows: unknown[]) => ({
  data: { viewer: { zones: [{ httpRequestsAdaptiveGroups: rows }] } },
});

const asFetch = (value: unknown): typeof fetch => value as typeof fetch;

describe('Cloudflare analytics fetch injection', () => {
  it('routes REST zone resolution through the caller fetch implementation', async () => {
    const fetchImpl = vi.fn(async () => response({ success: true, result: [{ id: 'zone-1' }] }));

    await expect(resolveZoneId('token', 'example.test', undefined, asFetch(fetchImpl))).resolves.toBe('zone-1');
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('routes GraphQL paths and diagnostics through the caller fetch implementation', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(response(graphqlBody([
        { count: 4, dimensions: { edgeResponseStatus: 503, clientRequestHTTPHost: 'example.test', clientRequestPath: '/a' } },
      ])))
      .mockResolvedValueOnce(response(graphqlBody([
        {
          count: 2,
          dimensions: {
            datetimeHour: '2026-09-14T10:00:00Z',
            edgeResponseStatus: 503,
            originResponseStatus: 0,
            cacheStatus: 'none',
            clientRequestHTTPHost: 'example.test',
          },
        },
      ])));

    await expect(fetchErrorPaths('token', 'zone-1', { fetchImpl: asFetch(fetchImpl) })).resolves.toEqual([
      { status: 503, host: 'example.test', path: '/a', count: 4 },
    ]);
    await expect(fetchErrorDiagnostics('token', 'zone-1', { fetchImpl: asFetch(fetchImpl) })).resolves.toEqual([
      {
        hour: '2026-09-14T10:00:00Z',
        edgeStatus: 503,
        originStatus: 0,
        cacheStatus: 'none',
        host: 'example.test',
        count: 2,
      },
    ]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('forwards the injected fetch through a windowed sweep', async () => {
    const fetchImpl = vi.fn(async () => response(graphqlBody([
      { count: 1, dimensions: { edgeResponseStatus: 404, clientRequestHTTPHost: 'example.test', clientRequestPath: '/a/' } },
    ])));

    await expect(sweepErrorPathsWindowed('token', 'zone-1', { windowCount: 2, fetchImpl: asFetch(fetchImpl) })).resolves.toMatchObject({
      rows: [{ path: '/a', count: 2 }],
      windowsOk: 2,
      windowCount: 2,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});
