/** Build the review patch on the host, before the network-isolated reviewer starts. */
import { TEST_DIFF_EXCLUSIONS } from './review-test-policy.mjs';
import { execFileSync } from 'node:child_process';
import { openSync, closeSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const sha = value => {
  if (!/^[a-f0-9]{40}$/.test(value ?? '')) throw new Error('Expected a pinned commit SHA');
  return value;
};
const run = (command, args, options = {}) => execFileSync(command, args, {
  encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, ...options,
});

export function writeReviewDiff({ base, head, directory, exclusions, incremental = false, cwd = process.cwd() }) {
  sha(base); sha(head);
  // Explicit pathspecs filter generated trees BEFORE Git requests missing blobs
  // from a partial clone. No GitHub diff/compare patch-size or file-count caps.
  const paths = ['.', ...TEST_DIFF_EXCLUSIONS, ...exclusions.map(path => `:(top,exclude)${path}/**`)];
  const args = ['--no-pager', 'diff', '--no-ext-diff', '--no-textconv', '--no-renames', base, head];
  const names = run('git', [...args, '--name-only', '-z', '--', ...paths], { cwd })
    .split('\0').filter(Boolean);
  if (names.some(name => /[\r\n]/.test(name))) throw new Error('Review file list cannot represent newline paths');
  const output = join(directory, incremental ? 'delta.patch' : 'diff.patch');
  const fd = openSync(output, 'w');
  try {
    // Stream the complete patch to disk: never truncate it to a process buffer.
    run('git', [...args, '--', ...paths], { cwd, stdio: ['ignore', fd, 'pipe'] });
  } finally { closeSync(fd); }
  if (incremental) {
    writeFileSync(join(directory, 'delta-files.txt'), names.length ? names.join('\n') + '\n' : '');
    writeFileSync(join(directory, 'diff.patch'), '(incremental review: full PR diff omitted; see delta.patch)\n');
  }
  return names;
}

export function main(env = process.env) {
  const head = sha(env.HEAD_SHA);
  const repo = env.REPO;
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo ?? '')) throw new Error('Invalid repository');
  if (!/^\d+$/.test(env.PR_NUMBER ?? '')) throw new Error('Invalid PR number');
  const api = endpoint => run('gh', ['api', endpoint]).trim();
  const base = env.INCREMENTAL_BASE ? sha(env.INCREMENTAL_BASE)
    : sha(JSON.parse(api(`repos/${repo}/pulls/${env.PR_NUMBER}`)).base.sha);
  // Only use compare metadata. Its patches may be absent/truncated; Git below
  // supplies the complete patch, including deletes and binary-change headers.
  const mergeBase = sha(JSON.parse(api(`repos/${repo}/compare/${base}...${head}`)).merge_base_commit.sha);
  for (const commit of new Set([mergeBase, head])) {
    try { run('git', ['cat-file', '-e', `${commit}^{commit}`], { stdio: 'pipe' }); }
    catch {
      run('git', ['fetch', '--no-tags', '--filter=blob:none', '--depth=1', 'origin', commit], { stdio: 'inherit' });
    }
  }
  const exclusions = (env.REVIEW_DIFF_EXCLUSIONS ?? '').split(',').filter(Boolean);
  if (!exclusions.length || exclusions.some(path => !/^[\w-]+$/.test(path))) throw new Error('Invalid diff exclusions');
  const names = writeReviewDiff({ base: mergeBase, head, directory: env.CTX_DIR, exclusions, incremental: Boolean(env.INCREMENTAL_BASE) });
  console.log(`Complete review diff prepared before sandbox: ${names.length} files (${mergeBase}..${head}).`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();
