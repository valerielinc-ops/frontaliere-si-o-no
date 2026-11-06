// @vitest-environment node
/**
 * `git write-tree` without `--missing-ok` checks that every blob named by the
 * index is in the local object store. On a partial clone git makes the check
 * pass by downloading them: all of them, in one fetch from the promisor.
 *
 * Every script here that writes a tree does it on an index seeded from a
 * remote tree plus the few blobs it has just written, so the check buys
 * nothing and, on a blobless checkout, costs the whole repository (298 s and
 * 321 s measured on unsubscribe-credential-monitor, to commit one file).
 */
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');

// The call sites as of this test: naming them keeps the test selected when
// one of them changes. The scan below covers the files that are not listed.
const KNOWN_CALL_SITES = [
  'scripts/ci/reconcile-data-refresh-main.mjs',
  'scripts/lib/git-commit-data.sh',
  'scripts/lib/push-article-shard-incremental.sh',
  'scripts/lib/push-locale-shard.sh',
  'scripts/lib/push-section-shard.sh',
  'scripts/lib/translation-state-drainer-v2.mjs',
  'scripts/lib/translation-state-store-v2.mjs',
];

const COMMENT_OR_MESSAGE = /^\s*(#|\/\/|\*|echo )/u;
// `git … write-tree` in a shell line, or the 'write-tree' argument of a spawn.
const WRITE_TREE_CALL = /(['"]write-tree['"]|\bgit\b[^|;&\n]*\swrite-tree\b)/u;

function plainWriteTreeCalls(file: string): string[] {
  let text: string;
  try {
    text = readFileSync(join(ROOT, file), 'utf8');
  } catch {
    return []; // not materialised in a sparse worktree
  }
  return text.split('\n').flatMap((line, index) => {
    if (COMMENT_OR_MESSAGE.test(line) || !WRITE_TREE_CALL.test(line)) return [];
    // `merge-tree --write-tree` is a different command: it has no index.
    if (line.includes('merge-tree') || line.includes('--missing-ok')) return [];
    return [`${file}:${index + 1}`];
  });
}

describe('git write-tree on a partial clone', () => {
  it('is never called without --missing-ok by the repository scripts', () => {
    const tracked = execFileSync('git', ['ls-files', '--', 'scripts', '.github/workflows', '.githooks'], {
      cwd: ROOT,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    }).split('\n').filter((file) => /\.(sh|mjs|cjs|js|ts|ya?ml)$/u.test(file) || file.startsWith('.githooks/'));

    expect(tracked.length).toBeGreaterThan(KNOWN_CALL_SITES.length);
    expect([...new Set([...KNOWN_CALL_SITES, ...tracked])].flatMap(plainWriteTreeCalls)).toEqual([]);
  });

  it('still finds the call sites it was written for', () => {
    // A scan that matches nothing would pass forever.
    for (const file of KNOWN_CALL_SITES) {
      const text = readFileSync(join(ROOT, file), 'utf8');
      const calls = text.split('\n').filter((line) => !COMMENT_OR_MESSAGE.test(line)
        && WRITE_TREE_CALL.test(line) && !line.includes('merge-tree'));
      expect(calls.length, file).toBeGreaterThan(0);
    }
  });
});
