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
const absoluteTool = (name, fallback) => {
  const value = String(process.env[name] || '').trim();
  if (!value) return fallback;
  if (!value.startsWith('/') || value.includes('\0')) {
    throw new Error(`${name} mancante o non assoluto`);
  }
  return value;
};
const run = (command, args, options = {}) => execFileSync(command, args, {
  encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, ...options,
});
const gitCommand = () => absoluteTool('TRUSTED_GIT_BIN', '/usr/bin/git');
const ghCommand = () => absoluteTool('TRUSTED_GH_BIN', 'gh');

// Explicit pathspecs filter generated trees BEFORE Git requests missing blobs
// from a partial clone. No GitHub diff/compare patch-size or file-count caps.
const scopePathspec = exclusions =>
  ['.', ...TEST_DIFF_EXCLUSIONS, ...exclusions.map(path => `:(top,exclude)${path}/**`)];
const diffArgs = (base, head) =>
  ['--no-pager', 'diff', '--no-ext-diff', '--no-textconv', '--no-renames', base, head];

/** Files changed between two pinned commits, under the review scope. */
export function changedNames({ base, head, exclusions, cwd = process.cwd() }) {
  sha(base); sha(head);
  const names = run(gitCommand(), [...diffArgs(base, head), '--name-only', '-z', '--', ...scopePathspec(exclusions)], { cwd })
    .split('\0').filter(Boolean);
  if (names.some(name => /[\r\n]/.test(name))) throw new Error('Review file list cannot represent newline paths');
  return names;
}

/**
 * Files whose PR contribution may have changed since `reviewedFrom`.
 *
 * A contribution is the pair (base content, head content). `reviewedFrom..head`
 * sees only the head side; after a rebase or a `merge origin/main` the base side
 * moves too, and a file kept byte-identical to the reviewed copy then changes
 * meaning: the PR silently reverts what `main` did to it (issue #9321,
 * FU-2026-09-20-030). The reviewed base is the merge-base of `reviewedFrom` with
 * the current PR base; the files `main` moved between the two are added. `main()`
 * asks GitHub for it (a force-pushed `reviewedFrom` is fetched shallow, so a
 * local `git merge-base` cannot see its parents); otherwise it is computed here.
 * When that base cannot be located (unrelated or missing history) convergence is
 * unprovable, so the caller gets `null` and reviews the whole contribution
 * instead of a possibly partial delta.
 */
export function movedSinceReview({
  base, head, reviewedFrom, exclusions, reviewedBase = null, cwd = process.cwd(),
}) {
  sha(base); sha(head); sha(reviewedFrom);
  // `sha()` returns the value it validated, so both branches bind a checked SHA.
  if (reviewedBase) {
    reviewedBase = sha(reviewedBase);
  } else {
    try {
      reviewedBase = sha(run(gitCommand(), ['merge-base', reviewedFrom, base], { cwd, stdio: ['ignore', 'pipe', 'pipe'] }).trim());
    } catch {
      return null;
    }
  }
  const moved = new Set(changedNames({ base: reviewedFrom, head, exclusions, cwd }));
  if (reviewedBase !== base) {
    for (const name of changedNames({ base: reviewedBase, head: base, exclusions, cwd })) moved.add(name);
  }
  return moved;
}

/**
 * `base` MUST be the PR's own merge-base, never a previous head. An incremental
 * review then narrows that same patch to the files whose contribution moved
 * since `reviewedFrom`, so the delta can only ever contain PR-owned content.
 *
 * Anchoring the delta on the previous review's commit is what contaminated it:
 * `merge_base(lastRev, HEAD)` is a commit on `main` as soon as the branch is
 * rebased/force-pushed or a `merge origin/main` lands, so `lastRev..HEAD`
 * sweeps in everything `main` advanced by. Measured on #9141 (2026-09-19): a
 * 3-file PR whose delta held 506 files, `scripts/lib/nord-anglia-job-parser.mjs`
 * among them — merged on `main` by #9175, never touched by #9141, and duly
 * flagged as a finding against it (issue #9189).
 */
export function writeReviewDiff({
  base, head, directory, exclusions, incremental = false, reviewedFrom = null, reviewedBase = null,
  cwd = process.cwd(),
}) {
  sha(base); sha(head);
  const owned = changedNames({ base, head, exclusions, cwd });
  const moved = reviewedFrom
    ? movedSinceReview({ base, head, reviewedFrom, exclusions, reviewedBase, cwd }) ?? new Set(owned)
    : null;
  const names = moved ? owned.filter(name => moved.has(name)) : owned;
  // A restricted patch is addressed by explicit pathspecs. An EMPTY restriction
  // must stay empty: `git diff --` with no pathspec means "everything", so the
  // one case where nothing moved would silently serve the whole PR diff.
  const paths = moved ? names.map(name => `:(top,literal)${name}`) : scopePathspec(exclusions);
  const output = join(directory, incremental ? 'delta.patch' : 'diff.patch');
  const fd = openSync(output, 'w');
  try {
    // Stream the complete patch to disk: never truncate it to a process buffer.
    if (paths.length) run(gitCommand(), [...diffArgs(base, head), '--', ...paths], { cwd, stdio: ['ignore', fd, 'pipe'] });
  } finally { closeSync(fd); }
  if (incremental) {
    writeFileSync(join(directory, 'delta-files.txt'), names.length ? names.join('\n') + '\n' : '');
    writeFileSync(join(directory, 'diff.patch'), '(incremental review: full PR diff omitted; see delta.patch)\n');
  }
  return names;
}

export function main(env = process.env, { api: injectedApi, cwd = process.cwd() } = {}) {
  const head = sha(env.HEAD_SHA);
  const repo = env.REPO;
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo ?? '')) throw new Error('Invalid repository');
  if (!/^\d+$/.test(env.PR_NUMBER ?? '')) throw new Error('Invalid PR number');
  const api = injectedApi ?? (endpoint => run(ghCommand(), ['api', endpoint]).trim());
  // Only use compare metadata. Its patches may be absent/truncated; Git below
  // supplies the complete patch, including deletes and binary-change headers.
  const mergeBaseWith = from =>
    sha(JSON.parse(api(`repos/${repo}/compare/${from}...${head}`)).merge_base_commit.sha);
  const incremental = Boolean(env.INCREMENTAL_BASE);
  // The PR's own contribution boundary — the same merge-base form `tests.yml`
  // already uses for `changed-paths.txt`. EVERY patch is anchored here, so no
  // patch can contain a commit that reached `main` outside this PR.
  const prBase = sha(JSON.parse(api(`repos/${repo}/pulls/${env.PR_NUMBER}`)).base.sha);
  const mergeBase = mergeBaseWith(prBase);
  // The reviewed tree itself, NOT its merge-base: `lastRev..HEAD` names exactly
  // the files whose content differs from what was reviewed. Its own merge-base
  // would be a point on `main` and would re-list every file the branch has ever
  // touched. Used only to NARROW the PR-anchored patch above, never to anchor
  // it, so the foreign files it also names are filtered out by the intersection.
  const reviewedFrom = incremental ? sha(env.INCREMENTAL_BASE) : null;
  // Where the reviewed contribution was anchored. Best effort: without it the
  // local merge-base is tried, and failing that the whole contribution is
  // reviewed — never a narrower delta.
  let reviewedBase = null;
  if (reviewedFrom) {
    try {
      reviewedBase = sha(JSON.parse(api(`repos/${repo}/compare/${mergeBase}...${reviewedFrom}`)).merge_base_commit.sha);
    } catch { reviewedBase = null; }
  }
  for (const commit of new Set([mergeBase, ...(reviewedFrom ? [reviewedFrom] : []), ...(reviewedBase ? [reviewedBase] : []), head])) {
    try { run(gitCommand(), ['cat-file', '-e', `${commit}^{commit}`], { stdio: 'pipe', cwd }); }
    catch {
      run(gitCommand(), ['fetch', '--no-tags', '--filter=blob:none', '--depth=1', 'origin', commit], { stdio: 'inherit', cwd });
    }
  }
  const exclusions = (env.REVIEW_DIFF_EXCLUSIONS ?? '').split(',').filter(Boolean);
  if (!exclusions.length || exclusions.some(path => !/^[\w-]+$/.test(path))) throw new Error('Invalid diff exclusions');
  const names = writeReviewDiff({
    base: mergeBase, head, directory: env.CTX_DIR, exclusions, incremental, reviewedFrom, reviewedBase, cwd,
  });
  console.log(`Complete review diff prepared before sandbox: ${names.length} files (${mergeBase}..${head}`
    + `${reviewedFrom ? `, narrowed to what moved since ${reviewedFrom}` : ''}).`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();
