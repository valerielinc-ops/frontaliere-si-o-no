#!/usr/bin/env node

/**
 * Misura le letture REST del percorso L4 confrontando origin/main e HEAD.
 *
 * Il comando e' sola lettura: esegue due volte l'export con lo stesso `now`,
 * conta le risposte delle cinque query Firestore e non stampa righe o dati
 * identificativi. La baseline viene estratta con git archive in una cartella
 * temporanea del worktree e quella cartella viene sempre rimossa.
 *
 *   node scripts/measure-loop-l4-reads.mjs \
 *     --baseline-ref origin/main \
 *     --out /percorso/locale/l4-reads.json
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isInvokedDirectly } from './lib/is-invoked-directly.mjs';
import * as headExporter from './ci/export-loop-outcomes.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const QUERY_NAMES = Object.freeze([
  'alerts',
  'job_alert_subscribers',
  'newsletter_subscribers',
  'campaign_deliveries',
  'events',
]);

function emptyQueryStats() {
  return Object.fromEntries(QUERY_NAMES.map((name) => [name, {
    firestore_calls: 0,
    docs_read: 0,
    elapsed_ms: 0,
  }]));
}

function queryName(collectionId) {
  if (QUERY_NAMES.includes(collectionId)) return collectionId;
  throw new Error(`exportL4 ha emesso una query Firestore inattesa: ${String(collectionId)}`);
}

/** Avvolge il client REST senza conservare o stampare i documenti restituiti. */
export function measuredFirestoreClient(client) {
  const stats = emptyQueryStats();
  return {
    stats,
    client: {
      async runQuery(query) {
        const name = queryName(query?.collectionId);
        const bucket = stats[name];
        const started = performance.now();
        bucket.firestore_calls += 1;
        try {
          const rows = await client.runQuery(query);
          bucket.docs_read += Array.isArray(rows) ? rows.length : 0;
          return rows;
        } finally {
          bucket.elapsed_ms += Math.round(performance.now() - started);
        }
      },
    },
  };
}

function silenceExporterLogs(fn) {
  const originalLog = console.log;
  const originalWarn = console.warn;
  console.log = () => {};
  console.warn = () => {};
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      console.log = originalLog;
      console.warn = originalWarn;
    });
}

/** Estrae esattamente il modulo esportatore della revisione richiesta. */
export async function loadBaseline(baselineRef = 'origin/main', root = ROOT) {
  const sha = execFileSync('git', ['rev-parse', baselineRef], { cwd: root }).toString().trim();
  const directory = fs.mkdtempSync(path.join(root, '.measure-loop-l4-baseline-'));
  try {
    const archive = execFileSync('git', [
      'archive',
      sha,
      'scripts/ci/export-loop-outcomes.mjs',
      'scripts/lib/ga4-service-account.mjs',
      'scripts/lib/analytics-settled-window.mjs',
      'functions/src',
    ], { cwd: root, maxBuffer: 1 << 30 });
    execFileSync('tar', ['-x', '-C', directory], { input: archive });
    const modulePath = path.join(directory, 'scripts/ci/export-loop-outcomes.mjs');
    const module = await import(`${pathToFileURL(modulePath).href}?baseline=${sha}`);
    return { sha, directory, module };
  } catch (error) {
    fs.rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}

function replayAnalyticsClient(client) {
  let responsePromise = null;
  return {
    request(...args) {
      if (!responsePromise) responsePromise = Promise.resolve().then(() => client.request(...args));
      return responsePromise;
    },
  };
}

async function runExporter({ exporter, firestore, analyticsClient, outputPath, configPath, snoozesPath, now }) {
  const counted = measuredFirestoreClient(firestore);
  const outcome = await silenceExporterLogs(() => exporter.exportL4({
    configPath,
    snoozesPath,
    outputPath,
    now,
    client: counted.client,
    analyticsClient,
  }));
  return { outcome, stats: counted.stats };
}

/** Rimuove soltanto le chiavi di generazione, non le date della finestra misurata. */
export function withoutGenerationDates(value) {
  if (Array.isArray(value)) return value.map(withoutGenerationDates);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => key !== 'generatedAt')
    .map(([key, item]) => [key, withoutGenerationDates(item)]));
}

export function differingKeys(left, right, prefix = '') {
  if (Object.is(left, right)) return [];
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right)) return [prefix || '(root)'];
    const keys = new Set([...left.keys(), ...right.keys()].map(String));
    return [...keys].flatMap((key) => differingKeys(left[key], right[key], `${prefix}[${key}]`));
  }
  if (left && typeof left === 'object' && right && typeof right === 'object') {
    const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
    return [...keys].flatMap((key) => differingKeys(
      left[key],
      right[key],
      prefix ? `${prefix}.${key}` : key,
    ));
  }
  return [prefix || '(root)'];
}

function assertEquivalentOutcomes(baseline, head) {
  const left = withoutGenerationDates(baseline);
  const right = withoutGenerationDates(head);
  const keys = differingKeys(left, right);
  if (keys.length) {
    throw new Error(`exportL4 baseline e HEAD differiscono alle chiavi: ${keys.join(', ')}`);
  }
}

export async function measure({
  baselineRef = 'origin/main',
  now = new Date(),
  root = ROOT,
  baselineLoader = loadBaseline,
  head = headExporter,
  firestore = new head.GoogleDataClient(),
  analytics = new head.GoogleDataClient({ oauthScope: head.GA4_READONLY_SCOPE }),
} = {}) {
  const baseline = await baselineLoader(baselineRef, root);
  const runDirectory = fs.mkdtempSync(path.join(root, '.measure-loop-l4-run-'));
  const configPath = path.join(root, 'data/alert-config.json');
  const snoozesPath = path.join(root, 'data/alert-snoozes.json');
  const analyticsClient = replayAnalyticsClient(analytics);
  try {
    const baselineRun = await runExporter({
      exporter: baseline.module,
      firestore,
      analyticsClient,
      outputPath: path.join(runDirectory, 'baseline-outcomes.json'),
      configPath,
      snoozesPath,
      now,
    });
    const headRun = await runExporter({
      exporter: head,
      firestore,
      analyticsClient,
      outputPath: path.join(runDirectory, 'head-outcomes.json'),
      configPath,
      snoozesPath,
      now,
    });
    assertEquivalentOutcomes(baselineRun.outcome, headRun.outcome);
    return {
      _what: 'Letture Firestore REST del loop L4: baseline contro HEAD, solo aggregati.',
      _how: 'node scripts/measure-loop-l4-reads.mjs --baseline-ref origin/main --out <file>',
      generated_at: now.toISOString(),
      baseline_ref: baselineRef,
      baseline_sha: baseline.sha,
      outcomes_equal_ignoring_generatedAt: true,
      queries: Object.fromEntries(QUERY_NAMES.map((name) => [name, {
        baseline: baselineRun.stats[name],
        head: headRun.stats[name],
      }])),
    };
  } finally {
    fs.rmSync(runDirectory, { recursive: true, force: true });
    if (baseline.directory) fs.rmSync(baseline.directory, { recursive: true, force: true });
  }
}

function argumentValue(name, fallback = null) {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1] ?? fallback;
}

async function main() {
  const baselineRef = argumentValue('--baseline-ref', 'origin/main');
  const out = argumentValue('--out', null);
  const report = await measure({ baselineRef });
  const json = `${JSON.stringify(report, null, 2)}\n`;
  if (/@/.test(json)) throw new Error('il report aggregato contiene una chiocciola; nessun file scritto');
  if (out) fs.writeFileSync(path.resolve(out), json);
  process.stdout.write(json);
}

if (isInvokedDirectly(import.meta.url)) {
  main().catch((error) => {
    console.error(error?.message || error);
    process.exit(1);
  });
}
