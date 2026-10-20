#!/usr/bin/env node

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { isInvokedDirectly } from './lib/is-invoked-directly.mjs';

import {
  buildCreativeReport,
  formatCreativeReport,
  parseInstagramInsightsCsv,
} from './lib/instagram-insights-report.mjs';

function usage() {
  return [
    'instagram-insights-report.mjs — read-only Instagram creative scorecard',
    '',
    'Usage:',
    '  node scripts/instagram-insights-report.mjs --input insights.json',
    '  node scripts/instagram-insights-report.mjs --input dashboard-export.csv --ledger data/instagram-posted.json',
    '  node scripts/instagram-insights-report.mjs --input insights.json --ledger data/instagram-posted.json --json',
    '',
    'The input is a JSON array/object or a comma/semicolon-separated Dashboard CSV.',
    'Use one row per post; comparisons stay within objective, content kind and measurement window (72h by default).',
    'CSV rows can use a media id or queue id; --ledger supplies the creative metadata.',
    'No Meta API call or credential is made by this command.',
  ].join('\n');
}

function parseArgs(argv) {
  const options = { json: false, minimumObservations: 3, windowHours: 72 };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--json') options.json = true;
    else if (arg === '--input') options.input = argv[++index];
    else if (arg.startsWith('--input=')) options.input = arg.slice('--input='.length);
    else if (arg === '--ledger') options.ledger = argv[++index];
    else if (arg.startsWith('--ledger=')) options.ledger = arg.slice('--ledger='.length);
    else if (arg === '--window-hours') options.windowHours = Number(argv[++index]);
    else if (arg.startsWith('--window-hours=')) options.windowHours = Number(arg.slice('--window-hours='.length));
    else if (arg === '--min-observations') options.minimumObservations = Number(argv[++index]);
    else if (arg.startsWith('--min-observations=')) options.minimumObservations = Number(arg.slice('--min-observations='.length));
    else throw new Error(`unknown option: ${arg}`);
  }
  return options;
}

function readInput(file) {
  if (!file) throw new Error('missing input; use --input');
  if (path.extname(file).toLowerCase() === '.csv') {
    return parseInstagramInsightsCsv(readFileSync(file, 'utf8'));
  }
  return readJson(file, 'input');
}

function readJson(file, label) {
  if (!file) throw new Error(`missing ${label}; use --${label}`);
  if (!existsSync(file)) throw new Error(`${label} does not exist: ${file}`);
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error.message}`);
  }
}

export function run(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    console.log(usage());
    return 0;
  }
  const input = readInput(options.input);
  const ledger = options.ledger ? readJson(options.ledger, 'ledger') : null;
  const report = buildCreativeReport(input, {
    ledger,
    minimumObservations: options.minimumObservations,
    windowHours: options.windowHours,
  });
  console.log(options.json ? JSON.stringify(report, null, 2) : formatCreativeReport(report));
  return 0;
}

if (isInvokedDirectly(import.meta.url)) {
  try {
    process.exitCode = run();
  } catch (error) {
    console.error(`❌ Instagram insights report: ${error.message}`);
    process.exitCode = 2;
  }
}
