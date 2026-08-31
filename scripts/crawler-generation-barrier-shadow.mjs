#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { writeJsonAtomic } from './lib/atomic-write-json.mjs';
import {
  GROUP_IDS,
  MAX_CYCLE_MANIFEST_BYTES,
  MAX_GROUP_MANIFEST_BYTES,
  evaluateCrawlerGenerationBarrier,
  validateCrawlerGenerationObservationsEnvelope,
} from './lib/crawler-generation-contract.mjs';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const GIT_TIMEOUT_MS = 30_000;
const COMMIT_RE = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;

function isWithin(root, target) {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function canonicalFuturePath(value) {
  let cursor = path.resolve(value);
  const suffix = [];
  while (!fs.existsSync(cursor)) {
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    suffix.unshift(path.basename(cursor));
    cursor = parent;
  }
  return path.join(fs.realpathSync(cursor), ...suffix);
}

function assertSafeReportOutput(repository, reportRoot, output) {
  const canonicalRepository = fs.realpathSync(repository);
  const canonicalRoot = canonicalFuturePath(reportRoot);
  const canonicalOutput = canonicalFuturePath(output);
  if (isWithin(canonicalRepository, canonicalRoot)) throw new TypeError('Report root cannot be inside the source repository');
  if (!isWithin(canonicalRoot, canonicalOutput) || canonicalRoot === canonicalOutput) throw new TypeError('Output must be inside report root');
  let cursor = path.resolve(reportRoot);
  const relative = path.relative(cursor, path.resolve(output));
  if (fs.existsSync(reportRoot) && fs.lstatSync(reportRoot).isSymbolicLink()) throw new TypeError('Report root cannot be a symlink');
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, segment);
    if (fs.existsSync(cursor) && fs.lstatSync(cursor).isSymbolicLink()) throw new TypeError('Report output cannot cross a symlink');
  }
  return canonicalOutput;
}

function parseArguments(argv) {
  const allowed = new Set([
    '--run-registry', '--run-observations', '--manifests-dir', '--roster', '--source-commit',
    '--repository', '--report-root', '--output',
  ]);
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!allowed.has(flag) || typeof value !== 'string' || value.length === 0 || flag in values) {
      throw new TypeError('Invalid crawler generation barrier arguments');
    }
    values[flag] = value;
  }
  for (const flag of allowed) if (!(flag in values)) throw new TypeError(`Missing ${flag}`);
  const repository = path.resolve(values['--repository']);
  const reportRoot = path.resolve(values['--report-root']);
  return {
    runRegistry: path.resolve(values['--run-registry']),
    runObservations: path.resolve(values['--run-observations']),
    manifestsDir: path.resolve(values['--manifests-dir']),
    roster: path.resolve(values['--roster']),
    sourceCommit: values['--source-commit'],
    repository,
    output: assertSafeReportOutput(repository, reportRoot, path.resolve(values['--output'])),
  };
}

function readJson(filePath, maxBytes = MAX_CYCLE_MANIFEST_BYTES) {
  const stat = fs.statSync(filePath);
  if (!stat.isFile() || stat.size > maxBytes + 1) throw new TypeError(`JSON input exceeds byte limit: ${filePath}`);
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function readManifests(directory) {
  const manifests = {};
  for (const group of GROUP_IDS) {
    const filePath = path.join(directory, group, `crawler-group-${group}-terminal.json`);
    try { manifests[group] = readJson(filePath, MAX_GROUP_MANIFEST_BYTES); } catch (error) {
      if (error?.code !== 'ENOENT') manifests[group] = { malformed: true };
    }
  }
  return manifests;
}

function runGit(repository, args, encoding = 'utf8') {
  return execFileSync('git', args, {
    cwd: repository, encoding, stdio: ['ignore', 'pipe', 'pipe'], timeout: GIT_TIMEOUT_MS,
    killSignal: 'SIGTERM', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });
}

function commitIsAncestor(repository, ancestor, descendant) {
  try {
    runGit(repository, ['merge-base', '--is-ancestor', ancestor, descendant]);
    return true;
  } catch (error) {
    if (error?.status === 1) return false;
    throw error;
  }
}

function loadSourceSnapshot(repository, commit, groupCommits) {
  const ancestorMembership = new Map(groupCommits.map((groupCommit) => [
    groupCommit,
    commitIsAncestor(repository, groupCommit, commit),
  ]));
  const tree = runGit(repository, ['ls-tree', '-r', '-z', commit, '--', 'data/jobs/by-crawler'], null);
  const blobOids = new Map();
  for (const record of tree.toString('utf8').split('\0').filter(Boolean)) {
    const separator = record.indexOf('\t');
    const [mode, type, blobOid] = record.slice(0, separator).split(' ');
    const filePath = record.slice(separator + 1);
    if (separator < 0 || !/^[0-7]{6}$/.test(mode ?? '') || type !== 'blob' ||
        !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(blobOid ?? '') || blobOids.has(filePath)) {
      throw new TypeError('Invalid immutable source tree snapshot');
    }
    blobOids.set(filePath, blobOid);
  }
  return {
    isAncestor: (ancestor, descendant) => descendant === commit && ancestorMembership.get(ancestor) === true,
    sourceFileMatches: (targetCommit, slice) => {
      if (targetCommit !== commit) throw new TypeError('Source snapshot commit mismatch');
      const blobOid = blobOids.get(slice.path) ?? null;
      return slice.state === 'absent'
        ? blobOid === null && slice.blobOid === null
        : blobOid === slice.blobOid;
    },
  };
}

export function runCrawlerGenerationBarrierShadowCli(argv) {
  const paths = parseArguments(argv);
  const runRegistry = readJson(paths.runRegistry);
  const observations = readJson(paths.runObservations);
  const observationsValidation = validateCrawlerGenerationObservationsEnvelope(observations);
  if (!observationsValidation.valid) throw new TypeError(observationsValidation.errors.join(','));
  const roster = readJson(paths.roster);
  const manifests = readManifests(paths.manifestsDir);
  // The group finalizer already proves every receipt commit is an ancestor of
  // its immutable group tip. The central observer therefore needs at most 23
  // ancestry checks: one unique remote group commit per manifest. Never load
  // the repository's unbounded full history into memory.
  const groupCommits = [...new Set(GROUP_IDS.map((group) => manifests[group]?.remote?.commit)
    .filter((commit) => COMMIT_RE.test(commit ?? '')))];
  let sourceSnapshot = null;
  try { sourceSnapshot = loadSourceSnapshot(paths.repository, paths.sourceCommit, groupCommits); } catch { /* fail closed in evaluator */ }
  const report = evaluateCrawlerGenerationBarrier({
    cycleId: runRegistry.cycleId,
    runRegistry,
    runObservations: observations.groups,
    manifests,
    roster,
    sourceCommit: paths.sourceCommit,
    evaluatedAt: observations.evaluatedAt,
    timedOut: observations.timedOut,
    isAncestor: (ancestor, descendant) => {
      if (!sourceSnapshot) throw new TypeError('Source snapshot unavailable');
      return sourceSnapshot.isAncestor(ancestor, descendant);
    },
    sourceFileMatches: (commit, slice) => {
      if (!sourceSnapshot) throw new TypeError('Source snapshot unavailable');
      return sourceSnapshot.sourceFileMatches(commit, slice);
    },
  });
  writeJsonAtomic(paths.output, report);
  process.stdout.write(`${JSON.stringify(report.barrier)}\n`);
  return report;
}

if (path.resolve(process.argv[1] ?? '') === SCRIPT_PATH) {
  try { runCrawlerGenerationBarrierShadowCli(process.argv.slice(2)); } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
