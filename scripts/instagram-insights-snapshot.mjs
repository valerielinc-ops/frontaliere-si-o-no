#!/usr/bin/env node

/**
 * Legacy Graph collector for one stable Instagram Insights observation per
 * eligible creative post. The Mac launch agent uses the Chrome collector in
 * scripts/social-robot/run.mjs by default; this command remains available for
 * explicit compatibility and diagnostics.
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

import { isInvokedDirectly } from './lib/is-invoked-directly.mjs';
import {
  buildSnapshotDocument,
  collectSnapshots,
  DEFAULT_MEDIA_MATCH_MINUTES,
  DEFAULT_WINDOW_HOURS,
  DEFAULT_WINDOW_TOLERANCE_HOURS,
} from './lib/instagram-insights-snapshot.mjs';

const DEFAULT_LEDGER = 'data/instagram-posted.json';
const DEFAULT_OUTPUT = 'data/instagram-insights.json';

function usage() {
  return [
    'instagram-insights-snapshot.mjs — collect read-only Instagram Insights snapshots',
    '',
    'Usage:',
    '  node scripts/instagram-insights-snapshot.mjs',
    '  node scripts/instagram-insights-snapshot.mjs --dry-run --json',
    '',
    'The command reads data/instagram-posted.json and writes',
    'data/instagram-insights.json after a successful 72h snapshot.',
    'It needs the explicit Graph credentials loaded by the caller.',
    'Missing credentials or unmatchable posts are a clean, non-writing skip.',
    '',
    'Options:',
    '  --ledger PATH              Posted ledger (default: data/instagram-posted.json)',
    '  --output PATH              Snapshot file (default: data/instagram-insights.json)',
    '  --window-hours N           Target measurement window (default: 72)',
    '  --tolerance-hours N        Early collection tolerance (default: 0)',
    '  --max-distance-minutes N  Timestamp matching tolerance (default: 30)',
    '  --as-of ISO                Evaluate the window at a fixed time',
    '  --dry-run[=true|false]     Fetch/read but do not write the snapshot file',
    '  --json                     Emit a machine-readable result on stdout',
    '  --help                     Show this help',
  ].join('\n');
}
function nextValue(argv, index, option) {
  const value = argv[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${option} needs a value`);
  return value;
}

function positiveNumber(value, option, { integer = false, allowZero = false } = {}) {
  const parsed = Number(value);
  const valid = Number.isFinite(parsed)
    && (allowZero ? parsed >= 0 : parsed > 0)
    && (!integer || Number.isInteger(parsed));
  if (!valid) throw new Error(`${option} must be ${allowZero ? 'a non-negative' : 'a positive'} number`);
  return parsed;
}

function booleanValue(value, option) {
  if (value === undefined) return true;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new Error(`${option} must be true or false`);
}

export function parseArgs(argv = []) {
  const options = {
    ledger: DEFAULT_LEDGER,
    output: DEFAULT_OUTPUT,
    windowHours: DEFAULT_WINDOW_HOURS,
    toleranceHours: DEFAULT_WINDOW_TOLERANCE_HOURS,
    maxDistanceMinutes: DEFAULT_MEDIA_MATCH_MINUTES,
    dryRun: false,
    json: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--json') options.json = true;
    else if (arg === '--dry-run') options.dryRun = true;
    else if (arg.startsWith('--dry-run=')) options.dryRun = booleanValue(arg.slice('--dry-run='.length), '--dry-run');
    else if (arg === '--ledger') options.ledger = nextValue(argv, index++, '--ledger');
    else if (arg.startsWith('--ledger=')) options.ledger = arg.slice('--ledger='.length);
    else if (arg === '--output') options.output = nextValue(argv, index++, '--output');
    else if (arg.startsWith('--output=')) options.output = arg.slice('--output='.length);
    else if (arg === '--window-hours') options.windowHours = positiveNumber(nextValue(argv, index++, '--window-hours'), '--window-hours');
    else if (arg.startsWith('--window-hours=')) options.windowHours = positiveNumber(arg.slice('--window-hours='.length), '--window-hours');
    else if (arg === '--tolerance-hours') options.toleranceHours = positiveNumber(nextValue(argv, index++, '--tolerance-hours'), '--tolerance-hours', { allowZero: true });
    else if (arg.startsWith('--tolerance-hours=')) options.toleranceHours = positiveNumber(arg.slice('--tolerance-hours='.length), '--tolerance-hours', { allowZero: true });
    else if (arg === '--max-distance-minutes') options.maxDistanceMinutes = positiveNumber(nextValue(argv, index++, '--max-distance-minutes'), '--max-distance-minutes');
    else if (arg.startsWith('--max-distance-minutes=')) options.maxDistanceMinutes = positiveNumber(arg.slice('--max-distance-minutes='.length), '--max-distance-minutes');
    else if (arg === '--as-of') options.asOf = nextValue(argv, index++, '--as-of');
    else if (arg.startsWith('--as-of=')) options.asOf = arg.slice('--as-of='.length);
    else throw new Error(`unknown option: ${arg}`);
  }
  if (!String(options.ledger).trim()) throw new Error('--ledger cannot be empty');
  if (!String(options.output).trim()) throw new Error('--output cannot be empty');
  if (options.asOf !== undefined && !Number.isFinite(Date.parse(options.asOf))) {
    throw new Error('--as-of must be an ISO timestamp');
  }
  return options;
}

function absolute(file) {
  return path.isAbsolute(file) ? file : path.resolve(process.cwd(), file);
}

function readJson(file, label, { optional = false, fallback = null } = {}) {
  const resolved = absolute(file);
  if (!existsSync(resolved)) {
    if (optional) return fallback;
    throw new Error(`${label} does not exist: ${file}`);
  }
  try {
    return JSON.parse(readFileSync(resolved, 'utf8'));
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error.message}`);
  }
}

function writeJsonAtomically(file, value) {
  const resolved = absolute(file);
  mkdirSync(path.dirname(resolved), { recursive: true });
  const temporary = `${resolved}.tmp-${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  renameSync(temporary, resolved);
}

function credential(name) {
  const value = String(process.env[name] || '').trim();
  return value || null;
}

function safeError(error) {
  return String(error?.message || error).replace(/\s+/g, ' ').slice(0, 300);
}

function printResult(result, options) {
  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  const mode = options.dryRun ? 'dry-run' : 'write';
  console.log(`Instagram Insights snapshot (${mode}): ${result.status}`);
  console.log(`candidates=${result.candidates ?? 0} matched=${result.matched ?? 0} added=${result.additions?.length ?? 0}`);
  if (result.output) console.log(`written=${result.output}`);
  if (result.skipped?.length) console.log(`skipped=${result.skipped.length}`);
  if (result.error) console.error(`warning=${result.error}`);
}

export async function run(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    console.log(usage());
    return 0;
  }

  const ledger = readJson(options.ledger, 'ledger', { optional: true, fallback: { posted: [] } });
  const existing = readJson(options.output, 'existing snapshot', { optional: true, fallback: null });
  const accountId = credential('INSTAGRAM_BUSINESS_ACCOUNT_ID');
  const accessToken = credential('INSTAGRAM_ACCESS_TOKEN');
  const asOf = options.asOf || new Date().toISOString();
  let result;
  try {
    result = await collectSnapshots({
      ledger,
      existing,
      accountId,
      accessToken,
      asOf,
      windowHours: options.windowHours,
      toleranceHours: options.toleranceHours,
      maxDistanceMinutes: options.maxDistanceMinutes,
    });
  } catch (error) {
    result = {
      status: 'api-error',
      additions: [],
      candidates: 0,
      skipped: [],
      error: safeError(error),
    };
  }

  if (result.additions.length > 0 && !options.dryRun) {
    const document = buildSnapshotDocument(existing, result.additions, {
      generatedAt: new Date(),
      windowHours: options.windowHours,
    });
    writeJsonAtomically(options.output, document);
    result.output = options.output;
  }
  printResult(result, options);
  return 0;
}

if (isInvokedDirectly(import.meta.url)) {
  try {
    process.exitCode = await run();
  } catch (error) {
    console.error(`❌ Instagram Insights snapshot: ${safeError(error)}`);
    process.exitCode = 2;
  }
}
