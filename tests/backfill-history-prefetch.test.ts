import { describe, expect, it } from 'vitest';
import { historyBlobOidsFromRevList } from '../scripts/ci/prefetch-history-blobs.mjs';

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
});
