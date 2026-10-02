import { describe, expect, it, vi } from 'vitest';
import { fetchRuntimeIncidentHistory } from '../scripts/lib/runtime-incident-history.mjs';

const day = (daysAgo: number) => new Date(Date.now() - daysAgo * 86_400_000).toISOString().slice(0, 10);
const window = () => ({ startDate: day(29), endDate: day(0), recentDays: 7 });

describe('runtime incident history', () => {
  it('separates historical signatures from recent observations without adding daily unique users', async () => {
    const runQuery = vi.fn(async (_query: string) => ({ results: [
      [day(20), 'newsletter_chunk', 12, 3, `${day(20)} 12:00:00`],
      [day(19), 'newsletter_chunk', 8, 3, `${day(19)} 12:00:00`],
      [day(0), 'firebase_api_key', 2, 1, `${day(0)} 10:00:00`],
    ] }));
    const result = await fetchRuntimeIncidentHistory({ ...window(), runQuery });
    expect(result.status).toBe('available');
    expect(result.signatures[0]).toMatchObject({ eventCount: 20, recentEventCount: 0, status: 'historical_only', lastOccurrence: `${day(19)} 12:00:00` });
    expect(result.signatures[1]).toMatchObject({ eventCount: 2, recentEventCount: 2, status: 'observed_recently' });
    expect(result.signatures[0]).not.toHaveProperty('affectedUsers');
    expect(result.signatures[0].daily).toHaveLength(30);
    expect(runQuery.mock.calls[0][0]).toContain("properties.$host = 'frontaliereticino.ch'");
    expect(runQuery.mock.calls[0][0]).toContain("event = 'app_error'");
    expect(runQuery.mock.calls[0][0]).not.toContain('error_type !=');
  });

  it('reports zeros only for a complete successful query and does not call them healthy', async () => {
    const result = await fetchRuntimeIncidentHistory({ ...window(), runQuery: async () => ({ results: [] }) });
    expect(result.signatures.map((signature) => signature.status)).toEqual(['not_observed', 'not_observed']);
    expect(result.interpretation).toContain('does not prove');
  });

  it.each([{ results: [], hasMore: true }, { error: 'upstream error' }, { results: [['invalid', 'newsletter_chunk', 1, 1, null]] }])('does not turn an incomplete response into zero errors', async (response) => {
    const result = await fetchRuntimeIncidentHistory({ ...window(), runQuery: async () => response });
    expect(result.status).toBe('unavailable');
    expect(result.signatures).toEqual([]);
  });

  it('redacts upstream failure details and rejects unsafe date input before querying', async () => {
    const runQuery = vi.fn(async () => { throw new Error('sensitive upstream response'); });
    const result = await fetchRuntimeIncidentHistory({ ...window(), runQuery });
    expect(result).toMatchObject({ status: 'unavailable', reason: 'query_failed' });
    expect(JSON.stringify(result)).not.toContain('sensitive');
    await expect(fetchRuntimeIncidentHistory({ ...window(), startDate: "x' OR 1=1", runQuery })).rejects.toThrow('ISO calendar');
    expect(runQuery).toHaveBeenCalledTimes(1);
  });
});
