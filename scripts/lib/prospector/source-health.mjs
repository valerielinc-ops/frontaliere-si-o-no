import fs from 'node:fs';
import path from 'node:path';
import { SOURCE_HEALTH_PATH } from './config.mjs';

export const DISCOVERY_SOURCE_OUTCOMES = Object.freeze([
  'complete',
  'partial',
  'unavailable',
  'malformed',
]);

export const DISCOVERY_SOURCE_NAMES = Object.freeze(['seco', 'osm', 'web']);

const HISTORY_LIMIT = 60;

function emptySourceSummary() {
  return {
    attempts: 0,
    items: 0,
    recordsSeen: 0,
    newCandidatesFiled: 0,
    outcomes: Object.fromEntries(DISCOVERY_SOURCE_OUTCOMES.map((outcome) => [outcome, 0])),
    failureCodes: {},
    lastOutcome: null,
    aggregateOutcome: null,
  };
}

/** @param {{ runId?: string|null, at?: Date|string|number }} [options] */
export function startDiscoveryHealthRun(options = {}) {
  const at = options.at instanceof Date ? options.at : new Date(options.at ?? Date.now());
  return {
    schemaVersion: 2,
    runId: options.runId ?? process.env.GITHUB_RUN_ID ?? null,
    startedAt: at.toISOString(),
    finishedAt: null,
    sources: Object.fromEntries(DISCOVERY_SOURCE_NAMES.map((source) => [source, emptySourceSummary()])),
  };
}

/**
 * Add one bounded, non-sensitive result from a discovery source attempt.
 * Error messages and URLs are deliberately excluded from the persisted report.
 *
 * @param {ReturnType<typeof startDiscoveryHealthRun>} run
 * @param {'seco'|'osm'|'web'} source
 * @param {{ outcome: string, items?: number, recordsSeen?: number, newCandidatesFiled?: number, errorCode?: string|null }} result
 */
export function recordDiscoverySourceOutcome(run, source, result = {}) {
  if (!DISCOVERY_SOURCE_NAMES.includes(source)) throw new Error(`Unknown Prospector discovery source: ${source}`);
  const outcome = DISCOVERY_SOURCE_OUTCOMES.includes(result.outcome) ? result.outcome : 'malformed';
  const summary = run.sources[source] ||= emptySourceSummary();
  summary.attempts++;
  const recordsSeen = result.recordsSeen ?? result.items;
  summary.recordsSeen += Number.isFinite(Number(recordsSeen)) ? Math.max(0, Math.floor(Number(recordsSeen))) : 0;
  summary.items = summary.recordsSeen;
  summary.newCandidatesFiled += Number.isFinite(Number(result.newCandidatesFiled))
    ? Math.max(0, Math.floor(Number(result.newCandidatesFiled)))
    : 0;
  summary.outcomes[outcome]++;
  summary.lastOutcome = outcome;
  summary.aggregateOutcome = aggregateOutcome(summary.outcomes, summary.attempts);
  if (outcome !== 'complete') {
    const rawCode = String(result.errorCode || 'unclassified');
    const code = /^[a-z0-9_.-]{1,60}$/i.test(rawCode) ? rawCode : 'unclassified';
    summary.failureCodes[code] = (summary.failureCodes[code] || 0) + 1;
  }
  return outcome;
}

function aggregateOutcome(outcomes, attempts) {
  if (!attempts) return null;
  if (outcomes.complete === attempts) return 'complete';
  if (outcomes.complete > 0 || outcomes.partial > 0) return 'partial';
  if (outcomes.unavailable === attempts) return 'unavailable';
  if (outcomes.malformed === attempts) return 'malformed';
  return outcomes.unavailable > 0 ? 'unavailable' : 'malformed';
}

/**
 * Load discovery history. A missing history is a first run; malformed history
 * is an error so a subsequent save cannot erase the evidence silently.
 * @param {string} [file]
 * @returns {ReturnType<typeof startDiscoveryHealthRun>[]}
 */
export function loadDiscoveryHealth(file = SOURCE_HEALTH_PATH) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw new Error(`Cannot read Prospector source health at ${file}`, { cause: error });
  }
  let history;
  try {
    history = JSON.parse(text);
  } catch (error) {
    throw new Error(`Malformed Prospector source health at ${file}`, { cause: error });
  }
  if (!Array.isArray(history)) throw new Error(`Invalid Prospector source health shape at ${file}`);
  return history;
}

/**
 * Persist a bounded history atomically; never keep external error payloads.
 * @param {ReturnType<typeof startDiscoveryHealthRun>} run
 * @param {string} [file]
 */
export function appendDiscoveryHealth(run, file = SOURCE_HEALTH_PATH) {
  run.finishedAt ||= new Date().toISOString();
  const history = loadDiscoveryHealth(file);
  history.push(run);
  const bounded = history.slice(-HISTORY_LIMIT);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(bounded, null, 2)}\n`);
    fs.renameSync(temporary, file);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}
