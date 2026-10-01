#!/usr/bin/env node
/**
 * Apply one generated refresh commit to an already-published stable branch.
 *
 * A scheduled job starts from `main`, while the stable refresh branch may
 * still contain an unmerged run.  The helper commits the new work first and
 * calls this script after checking out that stable branch.  The three-way
 * comparison keeps the stable tree as the base and applies the current run's
 * changes on top of it.  Append-only histories and posted ledgers need a
 * semantic union; replacing either one wholesale would silently lose the
 * earlier run.
 */
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { resolveGitAddPaths } from '../lib/resolve-git-add-path.mjs';
import { mergeRefreshContent } from './open-data-refresh-merge.mjs';

const GIT_OUTPUT_MAX_BUFFER = 256 * 1024 * 1024;

function usage(message) {
  if (message) process.stderr.write(`::error::${message}\n`);
  process.stderr.write(
    'Usage: merge-open-data-refresh.mjs --base <ref> --remote <ref> --refresh <ref> --path <path> [...]\n',
  );
  process.exit(2);
}

const options = { base: '', remote: '', refresh: '', paths: [] };
for (let i = 2; i < process.argv.length; i += 2) {
  const flag = process.argv[i];
  if (!['--base', '--remote', '--refresh', '--path'].includes(flag)) {
    usage(`unknown argument: ${flag}`);
  }
  const value = process.argv[i + 1];
  if (!value) usage(`${flag} requires a value`);
  if (flag === '--path') options.paths.push(value);
  else options[flag.slice(2)] = value;
}

if (!options.base || !options.remote || !options.refresh || options.paths.length === 0) {
  usage('base, remote, refresh and at least one path are required');
}

function git(args) {
  return execFileSync('git', args, {
    encoding: 'utf8',
    maxBuffer: GIT_OUTPUT_MAX_BUFFER,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function gitShow(ref, file) {
  try {
    return git(['show', `${ref}:${file}`]);
  } catch (error) {
    // A missing path is a normal three-way state (add/delete). Invalid refs
    // have already been ruled out by the caller's fetch/checkout, so surface
    // any other failure rather than treating it as an empty file.
    if (error?.status === 128) return null;
    throw error;
  }
}

// Article surfaces are published through their historical symlinked paths
// (`services/locales/blog-body/<locale>/…` behind a symlinked directory,
// `data/blog-articles-data.ts` as a file symlink). `git diff -- <path>` is
// silent for an edit made through a symlink: git tracks the real blob under
// packages/articles/content/, so the current run's article update would be
// dropped while the stable tree is reported as merged. Resolve the pathspecs
// the same way scripts/lib/git-add-resolved.mjs does for staging.
const repoRoot = git(['rev-parse', '--show-toplevel']).trim();
const diffPaths = resolveGitAddPaths(repoRoot, options.paths);

function changedFiles() {
  return git(['diff', '--name-only', options.base, options.refresh, '--', ...diffPaths])
    .split('\n')
    .map((file) => file.trim())
    .filter(Boolean);
}

const files = changedFiles();
for (const file of files) {
  const baseRaw = gitShow(options.base, file);
  const remoteRaw = gitShow(options.remote, file);
  const refreshRaw = gitShow(options.refresh, file);
  const mergedRaw = mergeRefreshContent(file, baseRaw, remoteRaw, refreshRaw);

  const absolute = path.resolve(process.cwd(), file);
  if (mergedRaw === null) {
    if (existsSync(absolute)) unlinkSync(absolute);
    continue;
  }
  mkdirSync(path.dirname(absolute), { recursive: true });
  writeFileSync(absolute, mergedRaw, 'utf8');
}

process.stdout.write(`[merge-open-data-refresh] preserved stable tree and applied ${files.length} path(s)\n`);
