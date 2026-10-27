#!/usr/bin/env node

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { isInvokedDirectly } from './lib/is-invoked-directly.mjs';
import {
  buildAutonomousDecisions,
  decisionStateChanges,
  mergeAutonomousDecisionState,
  resolveInstagramDecisionConfig,
} from './lib/instagram-insights-decision.mjs';
import {
  buildCreativeReport,
  parseInstagramInsightsCsv,
} from './lib/instagram-insights-report.mjs';
import { stageRcParamValue, updateRcTemplateWithEtag } from './lib/remote-config-rest.mjs';

const DEFAULT_INPUT = 'data/instagram-insights.json';
const DEFAULT_LEDGER = 'data/instagram-posted.json';

function usage() {
  return [
    'instagram-insights-decision.mjs — decide which Instagram variants to promote',
    '',
    'Usage:',
    '  node scripts/instagram-insights-decision.mjs',
    '  node scripts/instagram-insights-decision.mjs --json --apply',
    '',
    'The default is a read-only dry run. --apply can publish only bounded winner',
    'maps to Firebase Remote Config when the autonomy flag is enabled there.',
    'A winner needs two comparable variants, three observations per variant,',
    'and both a relative and absolute lift over the runner-up.',
    '',
    `  --input PATH                 Insights JSON/CSV (default: ${DEFAULT_INPUT})`,
    `  --ledger PATH                Posted ledger (default: ${DEFAULT_LEDGER})`,
    '  --window-hours N             Decision window (default: Remote Config or 72)',
    '  --min-observations N         Minimum observations per variant',
    '  --min-relative-lift N        Relative lift threshold (0.15 = 15%)',
    '  --min-absolute-lift N        Absolute rate-point threshold (0.005 = 0.5pp)',
    '  --apply                      Publish eligible winner maps to Remote Config',
    '  --json                       Emit machine-readable JSON',
    '  --help                       Show this help',
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

export function parseArgs(argv = []) {
  const options = { input: DEFAULT_INPUT, ledger: DEFAULT_LEDGER, json: false, apply: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--json') options.json = true;
    else if (arg === '--apply') options.apply = true;
    else if (arg === '--input') options.input = nextValue(argv, index++, '--input');
    else if (arg.startsWith('--input=')) options.input = arg.slice('--input='.length);
    else if (arg === '--ledger') options.ledger = nextValue(argv, index++, '--ledger');
    else if (arg.startsWith('--ledger=')) options.ledger = arg.slice('--ledger='.length);
    else if (arg === '--window-hours') options.windowHours = positiveNumber(nextValue(argv, index++, '--window-hours'), '--window-hours', { integer: true });
    else if (arg.startsWith('--window-hours=')) options.windowHours = positiveNumber(arg.slice('--window-hours='.length), '--window-hours', { integer: true });
    else if (arg === '--min-observations') options.minimumObservations = positiveNumber(nextValue(argv, index++, '--min-observations'), '--min-observations', { integer: true });
    else if (arg.startsWith('--min-observations=')) options.minimumObservations = positiveNumber(arg.slice('--min-observations='.length), '--min-observations', { integer: true });
    else if (arg === '--min-relative-lift') options.minimumRelativeLift = positiveNumber(nextValue(argv, index++, '--min-relative-lift'), '--min-relative-lift', { allowZero: true });
    else if (arg.startsWith('--min-relative-lift=')) options.minimumRelativeLift = positiveNumber(arg.slice('--min-relative-lift='.length), '--min-relative-lift', { allowZero: true });
    else if (arg === '--min-absolute-lift') options.minimumAbsoluteLift = positiveNumber(nextValue(argv, index++, '--min-absolute-lift'), '--min-absolute-lift', { allowZero: true });
    else if (arg.startsWith('--min-absolute-lift=')) options.minimumAbsoluteLift = positiveNumber(arg.slice('--min-absolute-lift='.length), '--min-absolute-lift', { allowZero: true });
    else throw new Error(`unknown option: ${arg}`);
  }
  if (!String(options.input).trim()) throw new Error('--input cannot be empty');
  if (!String(options.ledger).trim()) throw new Error('--ledger cannot be empty');
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

function readInput(file) {
  if (path.extname(file).toLowerCase() === '.csv') return parseInstagramInsightsCsv(readFileSync(file, 'utf8'));
  return readJson(file, 'input');
}

function jsonValue(value) {
  return JSON.stringify(value, null, 2);
}

async function publishWinnerMaps(nextState, changes) {
  if (!changes.length) return { published: false, changed: 0 };
  const credentialsPath = String(process.env.GOOGLE_APPLICATION_CREDENTIALS || '').trim();
  if (!credentialsPath) throw new Error('GOOGLE_APPLICATION_CREDENTIALS is required for --apply');
  const credentials = readJson(credentialsPath, 'service account');
  const today = new Date().toISOString().slice(0, 10);
  const result = await updateRcTemplateWithEtag({
    credentials,
    versionDescription: `Autonomous Instagram Insights decision state (set ${today})`,
    stage: (template) => {
      let nextTemplate = template;
      let changed = false;
      for (const change of changes) {
        const staged = stageRcParamValue(
          nextTemplate,
          change.parameter,
          change.value,
          `Autonomous Instagram Insights decision state (set ${today})`,
        );
        if (staged.error) return staged;
        if (staged.changed) {
          changed = true;
          nextTemplate = staged.template;
        }
      }
      return { changed, template: nextTemplate };
    },
  });
  if (!result.ok) throw new Error(result.detail || 'Remote Config update failed');
  return { published: Boolean(result.changed), changed: result.changed ? changes.length : 0 };
}

function formatComparison(comparison) {
  const label = comparison.type === 'background' ? 'sfondo' : 'creatività';
  if (comparison.status === 'winner') {
    const winner = comparison.winner;
    return `   ✅ ${label} ${comparison.winnerKey}: ${winner.backgroundVariant || winner.creativeId} `
      + `(${(winner.primaryRate * 100).toFixed(2)}%, +${(comparison.relativeLift * 100).toFixed(1)}% vs runner-up)`;
  }
  return `   ⏸️  ${label} ${comparison.winnerKey}: ${comparison.status} — ${comparison.reason}`;
}

export async function run(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    console.log(usage());
    return 0;
  }

  const configured = resolveInstagramDecisionConfig(process.env);
  const report = buildCreativeReport(
    readInput(options.input),
    {
      ledger: readJson(options.ledger, 'ledger', { optional: true, fallback: { posted: [] } }),
      minimumObservations: options.minimumObservations ?? configured.minimumObservations,
      windowHours: options.windowHours ?? configured.windowHours,
    },
  );
  const decisions = buildAutonomousDecisions(report, {
    windowHours: options.windowHours ?? configured.windowHours,
    minimumObservations: options.minimumObservations ?? configured.minimumObservations,
    minimumRelativeLift: options.minimumRelativeLift ?? configured.minimumRelativeLift,
    minimumAbsoluteLift: options.minimumAbsoluteLift ?? configured.minimumAbsoluteLift,
  });
  const currentState = {
    creativeWinners: configured.currentCreativeWinners,
    backgroundWinners: configured.currentBackgroundWinners,
  };
  const nextState = mergeAutonomousDecisionState({
    currentCreativeWinners: currentState.creativeWinners,
    currentBackgroundWinners: currentState.backgroundWinners,
    decisions,
  });
  const changes = decisionStateChanges(currentState, nextState);
  const result = {
    schemaVersion: decisions.schemaVersion,
    status: options.apply && !configured.enabled
      ? 'disabled'
      : options.apply ? 'ready-to-apply' : 'dry-run',
    autonomyEnabled: configured.enabled,
    input: {
      path: options.input,
      acceptedRows: report.acceptedRows,
      rejectedRows: report.rejectedRows.length,
    },
    decisions,
    currentState,
    nextState,
    changes,
  };

  if (options.apply && configured.enabled) {
    const published = await publishWinnerMaps(nextState, changes);
    result.status = published.published ? 'published' : 'no-change';
    result.published = published;
  } else {
    result.published = { published: false, changed: 0 };
  }

  if (options.json) {
    console.log(jsonValue(result));
  } else {
    console.log(`📊 Instagram autonomous decision: ${result.status}`);
    console.log(`   Rows: ${report.acceptedRows} accepted · ${report.rejectedRows.length} rejected · window ${decisions.windowHours}h`);
    for (const comparison of [...decisions.creativeComparisons, ...decisions.backgroundComparisons]) {
      console.log(formatComparison(comparison));
    }
    console.log(`   Changes ready: ${changes.length}${result.published?.published ? ' · published to Remote Config' : ''}`);
  }
  return 0;
}

if (isInvokedDirectly(import.meta.url)) {
  try {
    process.exitCode = await run();
  } catch (error) {
    console.error(`❌ Instagram Insights decision: ${String(error?.message || error).replace(/\s+/g, ' ').slice(0, 300)}`);
    process.exitCode = 2;
  }
}
