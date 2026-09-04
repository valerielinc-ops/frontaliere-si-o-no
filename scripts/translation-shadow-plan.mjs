#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeJsonAtomic } from './lib/atomic-write-json.mjs';
import { planTranslationShadow } from './lib/translation-shadow-planner.mjs';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(SCRIPT_PATH), '..');
const ALLOWED_REPO_OUTPUT_ROOTS = [
  path.join(REPO_ROOT, '.tmp', 'translation-shadow'),
];

function usage() {
  return 'Usage: node scripts/translation-shadow-plan.mjs --input <units.json> --memory <memory.json> --output <plan.json>';
}

function parseArguments(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!['--input', '--memory', '--output'].includes(flag) || typeof value !== 'string' || value.length === 0) {
      throw new TypeError(usage());
    }
    const name = flag.slice(2);
    if (name in result) throw new TypeError(`Duplicate ${flag}\n${usage()}`);
    result[name] = path.resolve(value);
  }
  if (!result.input || !result.memory || !result.output) throw new TypeError(usage());
  return result;
}

function canonicalSafetyPath(filePath) {
  const absolute = path.resolve(filePath);
  const suffix = [];
  let cursor = absolute;
  while (!fs.existsSync(cursor)) {
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    suffix.unshift(path.basename(cursor));
    cursor = parent;
  }
  const canonicalParent = fs.existsSync(cursor) ? fs.realpathSync(cursor) : cursor;
  return path.join(canonicalParent, ...suffix);
}

function isWithin(candidate, directory) {
  const relative = path.relative(directory, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function hasGitAncestor(directory) {
  let cursor = directory;
  while (true) {
    if (fs.existsSync(path.join(cursor, '.git'))) return true;
    const parent = path.dirname(cursor);
    if (parent === cursor) return false;
    cursor = parent;
  }
}

function hasSymlinkComponentWithinRepo(candidate) {
  const relative = path.relative(REPO_ROOT, candidate);
  if (relative.startsWith('..') || path.isAbsolute(relative)) return true;
  let cursor = REPO_ROOT;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, segment);
    try {
      if (fs.lstatSync(cursor).isSymbolicLink()) return true;
    } catch (error) {
      if (error.code === 'ENOENT') return false;
      throw error;
    }
  }
  return false;
}

function safeRepositoryShadowRoots() {
  const canonicalRepoRoot = canonicalSafetyPath(REPO_ROOT);
  return ALLOWED_REPO_OUTPUT_ROOTS.flatMap((root) => {
    if (hasSymlinkComponentWithinRepo(root)) return [];
    const expected = path.join(canonicalRepoRoot, path.relative(REPO_ROOT, root));
    const canonical = canonicalSafetyPath(root);
    return canonical === expected && isWithin(canonical, canonicalRepoRoot) ? [canonical] : [];
  });
}

function safeRunnerTempRoot() {
  if (!process.env.RUNNER_TEMP) return null;
  const runnerTemp = canonicalSafetyPath(process.env.RUNNER_TEMP);
  const filesystemRoot = path.parse(runnerTemp).root;
  const canonicalRepoRoot = canonicalSafetyPath(REPO_ROOT);
  if (
    runnerTemp === filesystemRoot
    || !fs.existsSync(runnerTemp)
    || !fs.statSync(runnerTemp).isDirectory()
    || hasGitAncestor(runnerTemp)
    || isWithin(canonicalRepoRoot, runnerTemp)
  ) {
    return null;
  }
  return runnerTemp;
}

function assertSafeOutput(paths) {
  const input = canonicalSafetyPath(paths.input);
  const memory = canonicalSafetyPath(paths.memory);
  const output = canonicalSafetyPath(paths.output);
  if (output === input || output === memory) {
    throw new TypeError('Output must not overwrite an input or translation memory');
  }
  const runnerTemp = safeRunnerTempRoot();
  const allowedRoots = [
    ...safeRepositoryShadowRoots(),
    ...(runnerTemp ? [runnerTemp] : []),
  ];
  if (!allowedRoots.some((root) => isWithin(output, root))) {
    throw new TypeError('Output is allowed only in a safe runner temp or repository translation-shadow temporary directory');
  }
  if (fs.existsSync(output) && fs.statSync(output).isDirectory()) {
    throw new TypeError('Output must be a file path');
  }
  return output;
}

function readJson(filePath, label) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    throw new Error(`Cannot read ${label}: ${error.message}`);
  }
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(`Invalid JSON in ${label}: ${error.message}`);
  }
}

function validateUnitsDocument(document) {
  if (
    document === null
    || typeof document !== 'object'
    || Array.isArray(document)
    || Object.keys(document).sort().join(',') !== 'schemaVersion,units'
    || document.schemaVersion !== 1
    || !Array.isArray(document.units)
  ) {
    throw new TypeError('Input units document has an unsupported schema');
  }
  return document.units;
}

export function runTranslationShadowPlanCli(argv) {
  const paths = parseArguments(argv);
  const outputPath = assertSafeOutput(paths);
  const units = validateUnitsDocument(readJson(paths.input, 'input units'));
  const memory = readJson(paths.memory, 'translation memory');
  const report = planTranslationShadow({ units, memory });
  writeJsonAtomic(outputPath, report);
  return report;
}

if (path.resolve(process.argv[1] ?? '') === SCRIPT_PATH) {
  try {
    const report = runTranslationShadowPlanCli(process.argv.slice(2));
    process.stdout.write(`${JSON.stringify(report.summary)}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
