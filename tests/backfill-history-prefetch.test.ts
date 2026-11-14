import { describe, expect, it } from 'vitest';
import {
  HISTORY_BACKFILL_MIN_BATCH_SIZE,
  historyBlobOidsFromTreeBatch,
  historyBlobPrefetchInput,
  historyBackfillArgs,
  historyCommitOidsFromDiffTree,
  historyCommitWalkArgs,
  historyDiffTreeArgs,
  historyMetadataEnv,
  historySafeGitErrorMessage,
  historySinceArgs,
  historySliceTreeRefInput,
  historyTreeOidsFromBatchCheck,
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

  it('formats no phantom stdin line for an empty object batch', () => {
    expect(historyBlobPrefetchInput([])).toBe('');
  });

  it('uses promisor-aware Git backfill with the same history window and slice paths', () => {
    expect(historyBackfillArgs({ since: '2026-09-20' })).toEqual([
      'backfill',
      `--min-batch-size=${HISTORY_BACKFILL_MIN_BATCH_SIZE}`,
      '--no-sparse',
      '--include-edges',
      '--all',
      '--since=2026-09-20',
      '--',
      'data/jobs/by-crawler',
      'data/jobs/expired/by-crawler',
    ]);
  });

  it('keeps the observer range explicit while including its base boundary', () => {
    expect(historyBackfillArgs({ revisionRange: 'base^..head' })).toEqual([
      'backfill',
      `--min-batch-size=${HISTORY_BACKFILL_MIN_BATCH_SIZE}`,
      '--no-sparse',
      '--include-edges',
      'base^..head',
      '--',
      'data/jobs/by-crawler',
      'data/jobs/expired/by-crawler',
    ]);
  });

  it('keeps object input suitable for Git batch verification', () => {
    const oids = ['a'.repeat(40), 'b'.repeat(40)];
    expect(historyBlobPrefetchInput(oids)).toBe(`${oids.join('\n')}\n`);
  });

  it('redacts authenticated GitHub remotes from fetch errors', () => {
    expect(historySafeGitErrorMessage(
      new Error('Command failed: git fetch https://x-access-token:sample%20value@github.com/owner/repo.git'),
    )).toBe('Command failed: git fetch https://github.com/owner/repo.git');
  });
});
