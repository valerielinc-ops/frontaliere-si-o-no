import { describe, expect, it, vi } from 'vitest';
import {
  HISTORY_BLOB_PREFETCH_BATCH_SIZE,
  historyBlobOidBatches,
  historyBlobOidsFromTreeBatch,
  historyBlobPrefetchArgs,
  historyBlobPrefetchInput,
  historyCommitOidsFromDiffTree,
  historyCommitWalkArgs,
  historyDiffTreeArgs,
  historyMetadataEnv,
  historySafeGitErrorMessage,
  historySinceArgs,
  historySliceTreeRefInput,
  historyTreeOidsFromBatchCheck,
  prefetchAndVerifyBlobs,
} from '../scripts/ci/prefetch-history-blobs.mjs';

function treeEntry(mode: string, name: string, oid: string): Buffer {
  return Buffer.concat([Buffer.from(`${mode} ${name}\0`), Buffer.from(oid, 'hex')]);
}

function treeResponse(treeOid: string, body: Buffer): Buffer {
  return Buffer.concat([
    Buffer.from(`${treeOid} tree ${body.length}\n`),
    body,
    Buffer.from('\n'),
  ]);
}

describe('prefetch-history-blobs', () => {
  it('keeps historical metadata discovery offline in a blobless checkout', () => {
    expect(historyMetadataEnv({ CI: 'true', GIT_NO_LAZY_FETCH: '0' })).toEqual({
      CI: 'true',
      GIT_NO_LAZY_FETCH: '1',
    });
  });

  it('keeps the complete commit window and both slice families in discovery', () => {
    expect(historySinceArgs('2026-09-20')).toEqual(['--since=2026-09-20']);
    expect(historySinceArgs('all')).toEqual([]);
    expect(historySinceArgs('')).toEqual([]);
    expect(historySinceArgs(undefined)).toEqual([]);
    expect(historyCommitWalkArgs('2026-09-20')).toEqual([
      'rev-list',
      '--all',
      '--since=2026-09-20',
    ]);
    expect(historyDiffTreeArgs()).toEqual([
      'diff-tree',
      '--stdin',
      '-r',
      '--root',
      '-m',
      '--name-status',
      '-z',
      '--no-renames',
      '--',
      'data/jobs/by-crawler',
      'data/jobs/expired/by-crawler',
    ]);
  });

  it('selects only commits that changed direct JSON slices in either family', () => {
    const activeCommit = 'a'.repeat(40);
    const expiredCommit = 'b'.repeat(40);
    const ignoredCommit = 'c'.repeat(40);
    const output = [
      activeCommit, 'M', 'data/jobs/by-crawler/acme.json',
      ignoredCommit, 'M', 'data/jobs/by-crawler/acme.json.bak',
      expiredCommit, 'A', 'data/jobs/expired/by-crawler/acme.shard-001.json',
    ].join('\0');

    expect(historyCommitOidsFromDiffTree(output)).toEqual([activeCommit, expiredCommit]);
  });

  it('resolves both directory snapshots for every relevant commit', () => {
    const commit = 'a'.repeat(40);
    expect(historySliceTreeRefInput([commit])).toBe(
      `${commit}:data/jobs/by-crawler\n${commit}:data/jobs/expired/by-crawler\n`,
    );
    expect(historySliceTreeRefInput([])).toBe('');
  });

  it('deduplicates and accepts only resolved directory tree OIDs', () => {
    const sha1Tree = 'd'.repeat(40);
    const sha256Tree = 'e'.repeat(64);
    const checks = [
      `${sha1Tree} tree 128`,
      `${sha1Tree} tree 128`,
      `${sha256Tree} tree 256`,
      'abc:data/jobs/expired/by-crawler missing',
    ].join('\n');

    expect(historyTreeOidsFromBatchCheck(checks)).toEqual([sha1Tree, sha256Tree]);
    expect(() => historyTreeOidsFromBatchCheck('unexpected cat-file output')).toThrow(
      'Could not resolve a historical job-slice directory tree.',
    );
  });

  it('reads only direct JSON blob entries from both slice-family trees', () => {
    const treeOid = 'f'.repeat(40);
    const activeBlob = '1'.repeat(40);
    const expiredBlob = '2'.repeat(40);
    const nestedTree = '3'.repeat(40);
    const body = Buffer.concat([
      treeEntry('100644', 'acme.json', activeBlob),
      treeEntry('100644', 'acme.shard-001.json', expiredBlob),
      treeEntry('100644', 'ignored.json.bak', '4'.repeat(40)),
      treeEntry('040000', 'nested.json', nestedTree),
    ]);

    expect(historyBlobOidsFromTreeBatch(treeResponse(treeOid, body))).toEqual([
      activeBlob,
      expiredBlob,
    ]);
  });

  it('includes an unchanged expired-family blob from a commit selected by an active slice change', () => {
    const commit = 'a'.repeat(40);
    const expiredTreeOid = 'b'.repeat(40);
    const unchangedExpiredBlob = 'c'.repeat(40);
    const changedCommits = historyCommitOidsFromDiffTree(
      `${commit}\0M\0data/jobs/by-crawler/acme.json\0`,
    );
    const refs = historySliceTreeRefInput(changedCommits);
    const expiredTree = treeResponse(
      expiredTreeOid,
      treeEntry('100644', 'acme.json', unchangedExpiredBlob),
    );

    expect(refs).toContain(`${commit}:data/jobs/expired/by-crawler`);
    expect(historyBlobOidsFromTreeBatch(expiredTree)).toContain(unchangedExpiredBlob);
  });

  it('does nothing for empty input and formats no phantom stdin line', () => {
    const fetchBatch = vi.fn();
    const verify = vi.fn();

    expect(historyBlobPrefetchInput([])).toBe('');
    expect(historyBlobOidBatches([])).toEqual([]);
    expect(prefetchAndVerifyBlobs([], { fetchBatch, verify })).toBe(0);
    expect(fetchBatch).not.toHaveBeenCalled();
    expect(verify).not.toHaveBeenCalled();
  });

  it('deduplicates OIDs before applying the bounded fetch size', () => {
    const oidA = 'a'.repeat(40);
    const oidB = 'b'.repeat(40);
    const oidC = 'c'.repeat(40);

    expect(historyBlobOidBatches([oidA, oidB, oidA, oidC, oidB], 2)).toEqual([
      [oidA, oidB],
      [oidC],
    ]);
    const defaultBatchInput = Array.from(
      { length: HISTORY_BLOB_PREFETCH_BATCH_SIZE + 1 },
      (_, index) => index.toString(16).padStart(40, '0'),
    );
    expect(historyBlobOidBatches(defaultBatchInput).map((batch) => batch.length)).toEqual([
      HISTORY_BLOB_PREFETCH_BATCH_SIZE,
      1,
    ]);
  });

  it('fetches every bounded batch before verifying the complete unique OID set', () => {
    const oids = ['a'.repeat(40), 'b'.repeat(40), 'a'.repeat(40), 'c'.repeat(40), 'd'.repeat(40)];
    const events = [];

    expect(prefetchAndVerifyBlobs(oids, {
      batchSize: 2,
      fetchBatch: (batch) => events.push(['fetch', [...batch]]),
      verify: (allOids) => events.push(['verify', [...allOids]]),
    })).toBe(2);

    expect(events).toEqual([
      ['fetch', [oids[0], oids[1]]],
      ['fetch', [oids[3], oids[4]]],
      ['verify', [oids[0], oids[1], oids[3], oids[4]]],
    ]);
  });

  it('stops on fetch failure and propagates verification failure', () => {
    const oids = ['a'.repeat(40), 'b'.repeat(40)];
    const fetchFailure = new Error('fetch failed');
    const verifyFailure = new Error('verification failed');
    const verify = vi.fn();

    expect(() => prefetchAndVerifyBlobs(oids, {
      batchSize: 1,
      fetchBatch: (_batch, batchNumber) => {
        if (batchNumber === 2) throw fetchFailure;
      },
      verify,
    })).toThrow(fetchFailure);
    expect(verify).not.toHaveBeenCalled();
    expect(() => prefetchAndVerifyBlobs(oids, {
      batchSize: 1,
      fetchBatch: vi.fn(),
      verify: () => { throw verifyFailure; },
    })).toThrow(verifyFailure);
  });

  it('uses Git transport support for the HTTPS prefetch', () => {
    const remote = 'https://github.com/owner/repo.git';
    const oids = ['a'.repeat(40), 'b'.repeat(40)];

    expect(historyBlobPrefetchArgs(remote)).toEqual([
      'fetch',
      '--keep',
      '--no-progress',
      '--no-tags',
      '--no-write-fetch-head',
      '--stdin',
      remote,
    ]);
    expect(historyBlobPrefetchInput(oids)).toBe(`${oids.join('\n')}\n`);
  });

  it('redacts authenticated GitHub remotes from fetch errors', () => {
    expect(historySafeGitErrorMessage(
      new Error('Command failed: git fetch https://x-access-token:sample%20value@github.com/owner/repo.git'),
    )).toBe('Command failed: git fetch https://github.com/owner/repo.git');
  });
});
