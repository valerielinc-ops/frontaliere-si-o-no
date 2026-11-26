// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { untrackedSlicePathsFromStatus } from '../../scripts/backfill-active-locale-routes.mjs';

describe('active locale route backfill head validation', () => {
  it('rejects untracked active and expired slice inputs', () => {
    const status = [
      '?? data/jobs/by-crawler/x.json',
      '?? data/jobs/expired/by-crawler/x.shard-001.json',
      '?? data/jobs/by-crawler/x-locale-cache.json',
      ' M data/jobs/by-crawler/committed.json',
    ].join('\n');

    expect(untrackedSlicePathsFromStatus(status)).toEqual([
      'data/jobs/by-crawler/x.json',
      'data/jobs/expired/by-crawler/x.shard-001.json',
    ]);
  });
});
