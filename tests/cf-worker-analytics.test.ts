import { describe, expect, it, vi } from 'vitest';

import {
  WORKER_ERROR_STATUSES,
  fetchWorkerInvocationErrors,
} from '../scripts/lib/cf-worker-analytics.mjs';

const response = (body: unknown) => ({
  status: 200,
  json: async () => body,
});

const bodyFor = (rows: unknown[]) => ({
  data: { viewer: { accounts: [{ workersInvocationsAdaptive: rows }] } },
});

describe('Cloudflare Worker invocation metrics', () => {
  it('queries each invocation error status separately and aggregates its rows', async () => {
    const fetchImpl = vi.fn(async (_url, init) => {
      const variables = JSON.parse(String((init as RequestInit).body)).variables;
      const rows = variables.status === 'scriptThrewException'
        ? [
            { sum: { requests: 4, errors: 4 }, dimensions: { datetime: '2026-10-13T05:00:00Z' } },
            { sum: { requests: 2, errors: 2 }, dimensions: { datetime: '2026-10-13T06:00:00Z' } },
          ]
        : [];
      return response(bodyFor(rows));
    });

    const result = await fetchWorkerInvocationErrors('token', 'account', {
      until: '2026-10-13T07:00:00Z',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(fetchImpl).toHaveBeenCalledTimes(WORKER_ERROR_STATUSES.length);
    expect(result.complete).toBe(true);
    expect(result.statuses[0]).toMatchObject({
      status: 'scriptThrewException',
      requests: 6,
      errors: 6,
      firstAt: '2026-10-13T05:00:00.000Z',
      latestAt: '2026-10-13T06:00:00.000Z',
    });
    expect(result.statuses.slice(1).every((item) => item.errors === 0)).toBe(true);
  });

  it('marks a status incomplete when its filtered result reaches the row cap', async () => {
    const fetchImpl = vi.fn(async () => response(bodyFor([
      { sum: { requests: 1, errors: 1 }, dimensions: { datetime: '2026-10-13T06:00:00Z' } },
    ])));

    const result = await fetchWorkerInvocationErrors('token', 'account', {
      limit: 1,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(result.complete).toBe(false);
    expect(result.statuses.every((item) => item.complete === false)).toBe(true);
  });
});
