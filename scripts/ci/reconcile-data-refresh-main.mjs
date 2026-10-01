#!/usr/bin/env node
// Run only in the publisher's isolated worktree. An explicit merge base lets
// shallow runners merge the two trees without downloading the entire history.
import { execFileSync, spawnSync } from 'node:child_process';
import { readGitBlob } from '../lib/read-git-blob.mjs';
import { EVENT_CACHE_PATHS, mergeRefreshContent } from './open-data-refresh-merge.mjs';

const options = {};
for (let i = 2; i < process.argv.length; i += 2) {
  const flag = process.argv[i];
  if (!['--base', '--main', '--message'].includes(flag) || !process.argv[i + 1]) {
    throw new Error('Usage: reconcile-data-refresh-main.mjs --base SHA --main SHA --message TEXT');
  }
  options[flag.slice(2)] = process.argv[i + 1];
}
if (!options.base || !options.main || !options.message) throw new Error('Missing main reconciliation arguments');

function git(args, input) {
  return execFileSync('git', args, {
    encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], input,
  }).trim();
}

function blob(ref, file) {
  try {
    return readGitBlob(ref, file);
  } catch (error) {
    if (error?.status === 128) return null;
    throw error;
  }
}

const head = git(['rev-parse', 'HEAD']);
const merge = spawnSync('git', [
  'merge-tree', '--write-tree', '--name-only', '--no-messages',
  `--merge-base=${options.base}`, head, options.main,
], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
if (merge.status !== 0 && merge.status !== 1) {
  throw new Error(`Unable to merge main: ${merge.error?.message || merge.stderr}`);
}
const [tree, ...conflicts] = merge.stdout.trim().split('\n');
if (conflicts.some(file => !EVENT_CACHE_PATHS.has(file))) {
  throw new Error(`Unresolved refresh conflict outside event caches: ${conflicts.join(', ')}`);
}

git(['read-tree', tree]);
for (const file of conflicts) {
  const content = mergeRefreshContent(file, blob(options.base, file), blob(options.main, file), blob(head, file));
  if (content === null) throw new Error(`Cannot resolve missing cache ${file}`);
  const oid = git(['hash-object', '-w', '--stdin'], content);
  git(['update-index', '--add', '--cacheinfo', `100644,${oid},${file}`]);
}
const mergedTree = git(['write-tree']);
const commit = git(['commit-tree', mergedTree, '-p', head, '-p', options.main, '-m', options.message]);
git(['update-ref', 'HEAD', commit, head]);
process.stdout.write(`[reconcile-data-refresh-main] merged main; resolved ${conflicts.length} cache conflict(s)\n`);
