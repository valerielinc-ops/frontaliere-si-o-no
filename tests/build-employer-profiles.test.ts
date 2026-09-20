// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { buildTrendMap } from '../scripts/build-employer-profiles.mjs';

describe('build-employer-profiles trend map', () => {
  it('preserves removedCount when compacted company arrays are empty', () => {
    const now = new Date();
    const date = (daysFromNow: number) =>
      new Date(now.getTime() + daysFromNow * 24 * 60 * 60 * 1000)
        .toISOString()
        .slice(0, 10);

    const trend = buildTrendMap({
      entries: [
        {
          date: date(-1),
          companyStats: [{
            key: 'acme',
            name: 'Acme',
            addedKeys: [],
            removedKeys: [],
            removedCount: 25117,
          }],
        },
        {
          date: date(0),
          companyStats: [{
            key: 'acme',
            name: 'Acme',
            addedKeys: [],
            removedKeys: Array.from({ length: 3591 }, (_, i) => `job-${i}`),
            removedCount: 3591,
          }],
        },
      ],
    });

    expect(trend.get('acme')).toEqual({
      added: 0,
      removed: 28708,
      net: -28708,
      windowDays: 28,
    });
  });
});
