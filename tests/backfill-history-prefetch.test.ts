import { describe, expect, it } from 'vitest';
import {
  historyBlobOidsFromRevList,
  historyBlobPrefetchArgs,
  historySinceArgs,
} from '../scripts/ci/prefetch-history-blobs.mjs';

describe('prefetch-history-blobs', () => {
  it('selects and deduplicates only active and expired crawler slice blobs', () => {
    const oidA = 'a'.repeat(40);
    const oidB = 'b'.repeat(40);
    const output = [
      `${oidA} data/jobs/by-crawler/acme.json`,
      `${oidA} data/jobs/by-crawler/acme.json`,
      `${oidB} data/jobs/expired/by-crawler/acme.json`,
      `${'c'.repeat(40)} data/jobs.json`,
      `${'d'.repeat(40)} data/jobs/by-crawler`,
      `${'e'.repeat(40)} data/jobs/expired/acme.json`,
      'not-an-object data/jobs/by-crawler/ignored.json',
    ].join('\n');

    expect(historyBlobOidsFromRevList(output)).toEqual([oidA, oidB]);
  });

  it('accepts SHA-256 object ids without widening the path boundary', () => {
    const oid = 'f'.repeat(64);
    expect(historyBlobOidsFromRevList(`${oid} data/jobs/by-crawler/acme.json\n`)).toEqual([oid]);
    expect(historyBlobOidsFromRevList(`${oid} data/jobs/by-crawler/acme.json.bak\n`)).toEqual([]);
  });

  // Run 43320183949 (2026-11-12): the unbounded prefetch hit the 40-minute
  // step cap twice. The walk is bounded to a git date unless "all" is asked.
  it('bounds the history walk with HISTORY_SINCE', () => {
    expect(historySinceArgs('45 days ago')).toEqual(['--since=45 days ago']);
    expect(historySinceArgs('2026-09-20')).toEqual(['--since=2026-09-20']);
    expect(historySinceArgs('all')).toEqual([]);
    expect(historySinceArgs('')).toEqual([]);
    expect(historySinceArgs(undefined)).toEqual([]);
  });

  it('uses Git transport support for the HTTPS prefetch instead of fetch-pack plumbing', () => {
    const remote = 'https://x-access-token:test-token@github.com/owner/repo.git';
    const oids = ['a'.repeat(40), 'b'.repeat(40)];

    expect(historyBlobPrefetchArgs(oids, remote)).toEqual([
      'fetch',
      '--keep',
      '--no-progress',
      '--no-tags',
      '--no-write-fetch-head',
      remote,
      ...oids,
    ]);
  });
});
