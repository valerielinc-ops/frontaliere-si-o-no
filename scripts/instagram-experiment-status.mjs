#!/usr/bin/env node

import { existsSync, readFileSync } from 'node:fs';

import { isInvokedDirectly } from './lib/is-invoked-directly.mjs';
import {
  buildExperimentStatus,
  DEFAULT_MINIMUM_OBSERVATIONS,
  DEFAULT_WINDOW_HOURS,
  formatExperimentStatus,
  resolveInstagramInsightsSource,
} from './lib/instagram-experiment-status.mjs';

const DEFAULT_LEDGER = 'data/instagram-posted.json';
const DEFAULT_QUEUE = 'data/instagram-queue.json';
const DEFAULT_INSIGHTS = 'data/instagram-insights.json';

function usage() {
  return [
    'instagram-experiment-status.mjs — show the Instagram creative test status',
    '',
    'Usage:',
    '  node scripts/instagram-experiment-status.mjs',
    '  node scripts/instagram-experiment-status.mjs --json',
    '',
    'The report counts one observation per published Instagram post/media,',
    'not one observation per carousel card. It never calls Meta and never prints credentials.',
    '',
    'Options:',
    `  --ledger PATH              Posted ledger (default: ${DEFAULT_LEDGER})`,
    `  --queue PATH               Instagram queue (default: ${DEFAULT_QUEUE})`,
    `  --insights PATH            Insights snapshot (default: ${DEFAULT_INSIGHTS})`,
    `  --window-hours N           Target measurement window (default: ${DEFAULT_WINDOW_HOURS})`,
    `  --min-observations N       Minimum comparable posts (default: ${DEFAULT_MINIMUM_OBSERVATIONS})`,
    '  --as-of ISO                Evaluate age and 72h windows at a fixed time',
    '  --json                     Emit machine-readable JSON',
    '  --help                     Show this help',
  ].join('\n');
}

function nextValue(argv, index, option) {
  const value = argv[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${option} needs a value`);
  return value;
}

function positiveNumber(value, option, { integer = false } = {}) {
  const parsed = Number(value);
  const valid = Number.isFinite(parsed) && parsed > 0 && (!integer || Number.isInteger(parsed));
  if (!valid) throw new Error(`${option} must be a positive ${integer ? 'integer' : 'number'}`);
  return parsed;
}

export function parseArgs(argv = []) {
  const options = {
    ledger: DEFAULT_LEDGER,
    queue: DEFAULT_QUEUE,
    insights: DEFAULT_INSIGHTS,
    windowHours: DEFAULT_WINDOW_HOURS,
    minimumObservations: DEFAULT_MINIMUM_OBSERVATIONS,
    json: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--json') options.json = true;
    else if (arg === '--ledger') options.ledger = nextValue(argv, index++, '--ledger');
    else if (arg.startsWith('--ledger=')) options.ledger = arg.slice('--ledger='.length);
    else if (arg === '--queue') options.queue = nextValue(argv, index++, '--queue');
    else if (arg.startsWith('--queue=')) options.queue = arg.slice('--queue='.length);
    else if (arg === '--insights') options.insights = nextValue(argv, index++, '--insights');
    else if (arg.startsWith('--insights=')) options.insights = arg.slice('--insights='.length);
    else if (arg === '--window-hours') options.windowHours = positiveNumber(nextValue(argv, index++, '--window-hours'), '--window-hours');
    else if (arg.startsWith('--window-hours=')) options.windowHours = positiveNumber(arg.slice('--window-hours='.length), '--window-hours');
    else if (arg === '--min-observations') options.minimumObservations = positiveNumber(nextValue(argv, index++, '--min-observations'), '--min-observations', { integer: true });
    else if (arg.startsWith('--min-observations=')) options.minimumObservations = positiveNumber(arg.slice('--min-observations='.length), '--min-observations', { integer: true });
    else if (arg === '--as-of') options.asOf = nextValue(argv, index++, '--as-of');
    else if (arg.startsWith('--as-of=')) options.asOf = arg.slice('--as-of='.length);
    else throw new Error(`unknown option: ${arg}`);
  }
  if (options.asOf !== undefined && !Number.isFinite(Date.parse(options.asOf))) {
    throw new Error('--as-of must be an ISO timestamp');
  }
  return options;
}

function readJson(file, label, { optional = false, fallback = null } = {}) {
  if (!existsSync(file)) {
    if (optional) return fallback;
    throw new Error(`${label} does not exist: ${file}`);
  }
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error.message}`);
  }
}

function configuredCredentials() {
  if (resolveInstagramInsightsSource() === 'browser') return true;
  if (resolveInstagramInsightsSource() === 'off') return false;
  return Boolean(
    String(process.env.INSTAGRAM_BUSINESS_ACCOUNT_ID || '').trim()
    && String(process.env.INSTAGRAM_ACCESS_TOKEN || '').trim(),
  );
}

export function run(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    console.log(usage());
    return 0;
  }
  const ledger = readJson(options.ledger, 'ledger', { optional: true, fallback: { posted: [] } });
  const queue = readJson(options.queue, 'queue', { optional: true, fallback: { pending: [] } });
  const insights = readJson(options.insights, 'insights snapshot', { optional: true, fallback: null });
  const status = buildExperimentStatus({
    ledger,
    queue,
    insights,
    asOf: options.asOf || new Date(),
    minimumObservations: options.minimumObservations,
    windowHours: options.windowHours,
    hasCredentials: configuredCredentials(),
  });
  console.log(options.json ? JSON.stringify(status, null, 2) : formatExperimentStatus(status));
  return 0;
}

if (isInvokedDirectly(import.meta.url)) {
  try {
    process.exitCode = run();
  } catch (error) {
    console.error(`❌ Instagram experiment status: ${error.message}`);
    process.exitCode = 2;
  }
}
