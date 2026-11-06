import { describe, expect, it } from 'vitest';

import {
  aggregateTrafficHistoryDocuments,
  PUBLIC_TRAFFIC_HISTORY_MIN_SNAPSHOTS,
  PUBLIC_TRAFFIC_HISTORY_PAGE_SIZE,
  PUBLIC_TRAFFIC_HISTORY_TARGETS,
} from '../functions/src/publicTrafficHistoryData.js';
import { readPublicTrafficHistory } from '../functions/src/publicTrafficHistory.js';

function historyDocument(dayOfWeek: number, hour: number, totalCrossingMinutes: number) {
  return { data: () => ({ dayOfWeek, hour, totalCrossingMinutes }) };
}

describe('public traffic history read model', () => {
  it('keeps the minimum sample and averages only valid readings', () => {
    const documents = [
      ...Array.from({ length: PUBLIC_TRAFFIC_HISTORY_MIN_SNAPSHOTS - 1 }, () => historyDocument(1, 7, 10)),
      historyDocument(1, 7, 20),
      historyDocument(1, 7, 30),
      historyDocument(9, 25, 999),
      historyDocument(1, 8, Number.NaN),
    ];

    expect(aggregateTrafficHistoryDocuments(documents)).toEqual({ 1: { 7: 11 } });
    expect(aggregateTrafficHistoryDocuments(documents.slice(0, PUBLIC_TRAFFIC_HISTORY_MIN_SNAPSHOTS - 1))).toBeNull();
  });

  it('reads one bounded sample per configured crossing', async () => {
    const calls: Array<{ path: string[]; orderBy: string; limit: number }> = [];
    const db = {
      collection: (...path: string[]) => ({
        orderBy: (field: string) => ({
          limit: (limit: number) => ({
            get: async () => {
              calls.push({ path, orderBy: field, limit });
              return {
                docs: Array.from(
                  { length: PUBLIC_TRAFFIC_HISTORY_MIN_SNAPSHOTS },
                  (_, index) => historyDocument(1, 7, index + 1),
                ),
              };
            },
          }),
        }),
      }),
    };

    const result = await readPublicTrafficHistory(db);

    expect(calls).toHaveLength(PUBLIC_TRAFFIC_HISTORY_TARGETS.length);
    expect(calls.every(call => call.path[0] === 'trafficHistory' && call.path[2] === 'snapshots')).toBe(true);
    expect(calls.every(call => call.orderBy === 'lastUpdate' && call.limit === PUBLIC_TRAFFIC_HISTORY_PAGE_SIZE)).toBe(true);
    expect(Object.keys(result)).toEqual(PUBLIC_TRAFFIC_HISTORY_TARGETS.map(target => target.name));
    expect(result['Chiasso - Strada']).toEqual({ 1: { 7: 11 } });
  });
});
