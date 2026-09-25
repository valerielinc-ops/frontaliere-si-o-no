#!/usr/bin/env node
/**
 * audit-listing-url-fallback.mjs — per-ATS-family loss of the
 * `listing.url || CAREER_URL` fallback (issue #9679).
 *
 * Reads the candidate parsers from `scripts/lib/*-job-parser.mjs` (the static
 * predicate of the issue) and each one's published slice
 * `data/jobs/by-crawler/<key>.json`, then prints, per family: parsers, slices,
 * listings, empty URLs, listings published with url/applyUrl equal to the
 * fallback list page, duplicate ids and duplicate URLs. Logic lives in
 * `scripts/lib/listing-url-fallback-audit.mjs`.
 *
 * Usage:
 *   node scripts/audit-listing-url-fallback.mjs                   # slices from data/jobs/by-crawler
 *   node scripts/audit-listing-url-fallback.mjs --ref origin/main # slices via `git show` (sparse worktrees)
 *   node scripts/audit-listing-url-fallback.mjs --json
 *   node scripts/audit-listing-url-fallback.mjs --fail-on-loss    # exit 1 when any slice carries the fallback
 *
 * Zero network, zero Claude calls. Exit 0 whenever the audit ran, unless
 * `--fail-on-loss` is given and a reproducible loss is found; exit 2 when the
 * audit could not run.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { auditListingUrlFallback, formatMarkdown, PARSER_FILE_RE } from './lib/listing-url-fallback-audit.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SLICE_DIR = 'data/jobs/by-crawler';

export function parseArgs(argv) {
  const opts = { ref: null, json: false, failOnLoss: false, root: ROOT };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--json') opts.json = true;
    else if (a === '--fail-on-loss') opts.failOnLoss = true;
    else if (a === '--ref') opts.ref = argv[++i];
    else if (a.startsWith('--ref=')) opts.ref = a.slice('--ref='.length);
    else if (a === '--root') opts.root = path.resolve(argv[++i]);
    else throw new Error(`unknown argument: ${a}`);
  }
  if (opts.ref === undefined || opts.ref === '') throw new Error('--ref needs a git ref');
  return opts;
}

function readParserFiles(root) {
  const dir = path.join(root, 'scripts/lib');
  return fs.readdirSync(dir)
    .filter((f) => PARSER_FILE_RE.test(f))
    .map((fileName) => ({ fileName, source: fs.readFileSync(path.join(dir, fileName), 'utf8') }));
}

function parseSlice(text) {
  const parsed = JSON.parse(text);
  return Array.isArray(parsed) ? parsed : (Array.isArray(parsed?.jobs) ? parsed.jobs : []);
}

function git(root, args) {
  return execFileSync('git', args, {
    cwd: root, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
  });
}

/**
 * Slices read from a git ref. The ref and the slice directory are checked ONCE
 * up front, and the set of published slices comes from `git ls-tree`: only a
 * key missing from that listing is an absent slice. Any other failure (bad
 * ref, unreadable blob, invalid JSON) throws, so the CLI exits 2 instead of
 * reporting "no loss" over slices it never read.
 */
export function makeGitSliceLoader(root, ref) {
  try {
    git(root, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
  } catch {
    throw new Error(`git ref not found: ${ref}`);
  }
  let listing;
  try {
    listing = git(root, ['ls-tree', '--name-only', `${ref}:${SLICE_DIR}`]);
  } catch (err) {
    throw new Error(`cannot list ${SLICE_DIR} at ${ref}: ${String(err?.stderr || err?.message || err).trim()}`);
  }
  const present = new Set(listing.split('\n').filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -'.json'.length)));
  return (key) => {
    if (!present.has(key)) return null;
    const blob = `${ref}:${SLICE_DIR}/${key}.json`;
    let text;
    try {
      text = git(root, ['show', blob]);
    } catch (err) {
      throw new Error(`cannot read ${blob}: ${String(err?.stderr || err?.message || err).trim()}`);
    }
    try {
      return parseSlice(text);
    } catch (err) {
      throw new Error(`invalid JSON in ${blob}: ${err?.message || err}`);
    }
  };
}

function makeSliceLoader({ root, ref }) {
  if (ref) return makeGitSliceLoader(root, ref);
  return (key) => {
    const file = path.join(root, SLICE_DIR, `${key}.json`);
    if (!fs.existsSync(file)) return null;
    return parseSlice(fs.readFileSync(file, 'utf8'));
  };
}

export function run(argv = process.argv.slice(2)) {
  const opts = parseArgs(argv);
  if (!opts.ref && !fs.existsSync(path.join(opts.root, SLICE_DIR))) {
    throw new Error(`${SLICE_DIR} is not materialized here (sparse worktree?): pass --ref origin/main`);
  }
  const report = auditListingUrlFallback(readParserFiles(opts.root), makeSliceLoader(opts));
  process.stdout.write(`${opts.json ? JSON.stringify(report, null, 2) : formatMarkdown(report)}\n`);
  return opts.failOnLoss && report.lossyParsers.length > 0 ? 1 : 0;
}

/** Exit code contract: 0 ran, 1 loss with --fail-on-loss, 2 the audit could not run. */
export function main(argv = process.argv.slice(2)) {
  try {
    return run(argv);
  } catch (err) {
    console.error(`audit-listing-url-fallback: ${err?.message || err}`);
    return 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main();
}
