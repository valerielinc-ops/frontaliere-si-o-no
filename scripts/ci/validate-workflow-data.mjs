#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { realpathSync } from 'node:fs';

export const MAX_FUTURE_SKEW_MS = 5 * 60 * 1000;

const ISO_RE = /^(?<year>\d{4})-(?<month>\d{2})-(?<day>\d{2})T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u;
const MONTH_RE = /^\d{4}-(?:0[1-9]|1[0-2])$/u;
const APPEND_ONLY_KINDS = new Set([
  'crawler-generation-ledger',
  'evergreen-pool-history',
  'funnel-metrics-history',
  'telegram-member-count-history',
]);
const SUPPORTED_KINDS = new Set([
  ...APPEND_ONLY_KINDS,
  'crawler-health',
  'pharmacy-google-usage-reservation',
]);
const HEALTH_STATUSES = new Set(['healthy', 'stale', 'broken', 'warming_up', 'unknown']);
const HEALTH_REQUIRED_FIELDS = [
  'lastSuccessfulRunAt',
  'lastNonZeroJobs',
  'consecutiveEmptyRuns',
  'consecutiveEmptyOkRuns',
  'advisory',
  'advisoryReason',
  'lastFailureReason',
  'status',
  '_lastObservedAt',
  '_lastObservedJobs',
  '_lastObservedEmptyOk',
  '_lastObservedFreshnessAt',
  '_lastObservedFreshnessSource',
  '_lastObservedAssembledAt',
  '_lastObservedGeneratedAt',
  '_lastObservedDiscoveredCount',
  '_lastObservedWrittenCount',
  '_autoFilteredEmpty',
];
const HEALTH_TIMESTAMP_FIELDS = [
  'lastSuccessfulRunAt',
  '_lastObservedAt',
  '_lastObservedFreshnessAt',
  '_lastObservedAssembledAt',
  '_lastObservedGeneratedAt',
  '_missingAt',
];
const MAX_GOOGLE_PLACES_REQUESTS = 10_000;

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function add(errors, field, message) {
  errors.push(`${field}: ${message}`);
}

export function isIsoTimestamp(value) {
  if (typeof value !== 'string') return false;
  const match = ISO_RE.exec(value);
  if (!match) return false;
  const year = Number(match.groups.year);
  const month = Number(match.groups.month);
  const day = Number(match.groups.day);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return month >= 1
    && month <= 12
    && day >= 1
    && day <= daysInMonth[month - 1]
    && Number.isFinite(Date.parse(value));
}

function validateTimestamp(value, field, errors, nowMs) {
  if (!isIsoTimestamp(value)) {
    add(errors, field, 'timestamp ISO non valido');
    return;
  }
  if (Date.parse(value) > nowMs + MAX_FUTURE_SKEW_MS) {
    add(errors, field, `timestamp nel futuro oltre la tolleranza di ${MAX_FUTURE_SKEW_MS / 1000}s`);
  }
}

function validateDate(value, field, errors, nowMs) {
  const match = typeof value === 'string' ? /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value) : null;
  const parsed = match ? new Date(`${value}T00:00:00Z`) : null;
  const valid = Boolean(match)
    && parsed
    && Number.isFinite(parsed.getTime())
    && parsed.getUTCFullYear() === Number(match[1])
    && parsed.getUTCMonth() + 1 === Number(match[2])
    && parsed.getUTCDate() === Number(match[3]);
  if (!valid) {
    add(errors, field, 'data YYYY-MM-DD non valida');
    return;
  }
  if (parsed.getTime() > nowMs + MAX_FUTURE_SKEW_MS) {
    add(errors, field, 'data nel futuro');
  }
}

function validateNonNegativeInteger(value, field, errors) {
  if (!Number.isInteger(value) || value < 0) add(errors, field, 'intero non negativo richiesto');
}

function validateNullableNonNegativeInteger(value, field, errors) {
  if (value !== null && value !== undefined) validateNonNegativeInteger(value, field, errors);
}

function parseJsonLines(raw, file) {
  const errors = [];
  const lines = String(raw).split(/\r?\n/u);
  if (lines.at(-1) === '') lines.pop();
  if (lines.length === 0) {
    add(errors, '$', 'file JSONL vuoto');
    return { value: [], errors };
  }
  const value = [];
  for (const [index, line] of lines.entries()) {
    if (line.trim() === '') {
      add(errors, `line ${index + 1}`, 'riga vuota: ogni riga deve essere un JSON valido');
      continue;
    }
    try {
      value.push(JSON.parse(line));
    } catch (error) {
      add(errors, `line ${index + 1}`, `JSON non valido (${error.message})`);
    }
  }
  if (value.length === 0 && errors.length === 0) add(errors, '$', `${file}: nessun record JSONL`);
  return { value, errors };
}

export function parseWorkflowData(kind, raw, file = kind) {
  if (kind === 'crawler-generation-ledger' || kind === 'telegram-member-count-history') {
    return parseJsonLines(raw, file);
  }
  try {
    return { value: JSON.parse(raw), errors: [] };
  } catch (error) {
    return { value: null, errors: [`$: JSON non leggibile (${error.message})`] };
  }
}

async function validateCrawlerGenerationLedger(records, errors, nowMs) {
  const { validateCrawlerGenerationLedgerEntry } = await import('../lib/crawler-generation-ledger.mjs');
  if (!Array.isArray(records) || records.length === 0) {
    add(errors, '$', 'ledger JSONL senza record');
    return;
  }
  for (const [index, record] of records.entries()) {
    const field = `line ${index + 1}`;
    const validation = validateCrawlerGenerationLedgerEntry(record);
    if (!validation.valid) add(errors, field, validation.errors.join(', '));
    validateTimestamp(record?.checkedAt, `${field}.checkedAt`, errors, nowMs);
  }
}

async function validateHistory(kind, value, errors, nowMs) {
  const { validateGeneratedData } = await import('./validate-generated-data.mjs');
  const generatedKind = kind === 'evergreen-pool-history' ? 'evergreen' : 'funnel';
  for (const error of validateGeneratedData(generatedKind, value)) add(errors, '$', error);
  if (!isObject(value)) return;
  validateTimestamp(value.updatedAt, 'updatedAt', errors, nowMs);
  for (const [index, entry] of (Array.isArray(value.entries) ? value.entries : []).entries()) {
    validateDate(entry?.date, `entries[${index}].date`, errors, nowMs);
    if (kind === 'funnel-metrics-history') {
      validateTimestamp(entry?.generatedAt, `entries[${index}].generatedAt`, errors, nowMs);
    }
  }
}

function validateCrawlerHealth(value, errors, nowMs) {
  if (!isObject(value)) {
    add(errors, '$', 'snapshot crawler health deve essere un oggetto');
    return;
  }
  validateTimestamp(value._lastCheckedAt, '_lastCheckedAt', errors, nowMs);
  if (!isObject(value.crawlers)) {
    add(errors, 'crawlers', 'oggetto richiesto');
    return;
  }
  for (const [slug, state] of Object.entries(value.crawlers)) {
    const field = `crawlers.${slug}`;
    if (!isObject(state)) {
      add(errors, field, 'stato crawler non valido');
      continue;
    }
    for (const required of HEALTH_REQUIRED_FIELDS) {
      if (!Object.hasOwn(state, required)) add(errors, `${field}.${required}`, 'campo obbligatorio mancante');
    }
    if (typeof state.status !== 'string' || !HEALTH_STATUSES.has(state.status)) {
      add(errors, `${field}.status`, 'stato non ammesso');
    }
    for (const counter of ['lastNonZeroJobs', 'consecutiveEmptyRuns', 'consecutiveEmptyOkRuns', '_lastObservedJobs']) {
      validateNonNegativeInteger(state[counter], `${field}.${counter}`, errors);
    }
    for (const counter of ['_lastObservedDiscoveredCount', '_lastObservedWrittenCount']) {
      validateNullableNonNegativeInteger(state[counter], `${field}.${counter}`, errors);
    }
    for (const booleanField of ['advisory', '_lastObservedEmptyOk', '_autoFilteredEmpty']) {
      if (typeof state[booleanField] !== 'boolean') add(errors, `${field}.${booleanField}`, 'boolean richiesto');
    }
    if (typeof state._lastObservedFreshnessSource !== 'string' || !state._lastObservedFreshnessSource.trim()) {
      add(errors, `${field}._lastObservedFreshnessSource`, 'stringa non vuota richiesta');
    }
    for (const timestampField of HEALTH_TIMESTAMP_FIELDS) {
      if (Object.hasOwn(state, timestampField) && state[timestampField] !== null && state[timestampField] !== undefined) {
        validateTimestamp(state[timestampField], `${field}.${timestampField}`, errors, nowMs);
      }
    }
    for (const nullableString of ['advisoryReason', 'lastFailureReason']) {
      if (state[nullableString] !== null && typeof state[nullableString] !== 'string') {
        add(errors, `${field}.${nullableString}`, 'stringa o null richiesto');
      }
    }
  }
}

function validateTelegramHistory(records, errors, nowMs) {
  if (!Array.isArray(records) || records.length === 0) {
    add(errors, '$', 'history Telegram senza record');
    return;
  }
  const seen = new Set();
  let previous = '';
  for (const [index, record] of records.entries()) {
    const field = `line ${index + 1}`;
    if (!isObject(record)) {
      add(errors, field, 'record non valido');
      continue;
    }
    if (!Object.hasOwn(record, 'date')) add(errors, `${field}.date`, 'campo obbligatorio mancante');
    if (!Object.hasOwn(record, 'count')) add(errors, `${field}.count`, 'campo obbligatorio mancante');
    validateDate(record.date, `${field}.date`, errors, nowMs);
    validateNonNegativeInteger(record.count, `${field}.count`, errors);
    if (seen.has(record.date)) add(errors, `${field}.date`, 'data duplicata');
    if (previous && typeof record.date === 'string' && record.date < previous) add(errors, `${field}.date`, 'date non ordinate');
    seen.add(record.date);
    previous = typeof record.date === 'string' ? record.date : previous;
  }
}

function validatePharmacyReservation(value, errors, nowMs) {
  if (!isObject(value)) {
    add(errors, '$', 'reservation farmacia deve essere un oggetto');
    return;
  }
  if (value.schemaVersion !== 1) add(errors, 'schemaVersion', 'deve essere 1');
  if (typeof value.month !== 'string' || !MONTH_RE.test(value.month)) {
    add(errors, 'month', 'mese YYYY-MM non valido');
  } else {
    const currentMonth = new Date(nowMs).toISOString().slice(0, 7);
    if (value.month > currentMonth) add(errors, 'month', 'mese nel futuro');
  }
  if (!isObject(value.googlePlaces)) {
    add(errors, 'googlePlaces', 'oggetto richiesto');
    return;
  }
  if (!Number.isInteger(value.googlePlaces.requests)
    || value.googlePlaces.requests < 0
    || value.googlePlaces.requests > MAX_GOOGLE_PLACES_REQUESTS) {
    add(errors, 'googlePlaces.requests', `intero tra 0 e ${MAX_GOOGLE_PLACES_REQUESTS} richiesto`);
  }
}

function recordCount(kind, value) {
  if (kind === 'crawler-generation-ledger' || kind === 'telegram-member-count-history') {
    return Array.isArray(value) ? value.length : 0;
  }
  if (kind === 'crawler-health') return isObject(value?.crawlers) ? Object.keys(value.crawlers).length : 0;
  if (kind === 'pharmacy-google-usage-reservation') return isObject(value) ? 1 : 0;
  return Array.isArray(value?.entries) ? value.entries.length : 0;
}

export async function validateWorkflowData(kind, value, { baselineValue = null, now = new Date() } = {}) {
  if (!SUPPORTED_KINDS.has(kind)) return [`$: kind non supportato: ${kind}`];
  const errors = [];
  const nowMs = now instanceof Date ? now.getTime() : new Date(now).getTime();
  if (!Number.isFinite(nowMs)) return ['$: orologio di validazione non valido'];

  switch (kind) {
    case 'crawler-generation-ledger':
      await validateCrawlerGenerationLedger(value, errors, nowMs);
      break;
    case 'evergreen-pool-history':
    case 'funnel-metrics-history':
      await validateHistory(kind, value, errors, nowMs);
      break;
    case 'crawler-health':
      validateCrawlerHealth(value, errors, nowMs);
      break;
    case 'telegram-member-count-history':
      validateTelegramHistory(value, errors, nowMs);
      break;
    case 'pharmacy-google-usage-reservation':
      validatePharmacyReservation(value, errors, nowMs);
      break;
    default:
      break;
  }

  if (APPEND_ONLY_KINDS.has(kind) && baselineValue !== null
      && recordCount(kind, value) < recordCount(kind, baselineValue)) {
    add(errors, '$', `storico accorciato: ${recordCount(kind, value)} record contro ${recordCount(kind, baselineValue)} su HEAD`);
  }
  return errors;
}

function arg(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}

function repositoryRoot() {
  return execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
}

function relativeRepositoryPath(root, file) {
  const absolute = path.resolve(process.cwd(), file);
  const relative = path.relative(root, absolute).split(path.sep).join('/');
  if (!relative || relative.startsWith('../') || path.isAbsolute(relative)) {
    throw new Error(`file fuori dal repository: ${file}`);
  }
  return relative;
}

function readHeadFile(root, relative) {
  try {
    return execFileSync('git', ['show', `HEAD:${relative}`], { cwd: root, encoding: 'utf8' });
  } catch {
    return null;
  }
}

async function main() {
  const kind = arg('--kind');
  const file = arg('--file');
  if (!kind || !file || !SUPPORTED_KINDS.has(kind)) {
    console.error(`Uso: node scripts/ci/validate-workflow-data.mjs --kind <${[...SUPPORTED_KINDS].join('|')}> --file <path>`);
    process.exitCode = 2;
    return;
  }

  const root = repositoryRoot();
  const absoluteFile = path.resolve(process.cwd(), file);
  let raw;
  try {
    raw = fs.readFileSync(absoluteFile, 'utf8');
  } catch (error) {
    console.error(`❌ ${file}: file non leggibile (${error.message})`);
    process.exitCode = 1;
    return;
  }
  const parsed = parseWorkflowData(kind, raw, file);
  const errors = [...parsed.errors];
  let baselineValue = null;
  if (APPEND_ONLY_KINDS.has(kind)) {
    const baselineFile = arg('--baseline-file');
    const relative = baselineFile ? null : relativeRepositoryPath(root, file);
    const baselineRaw = baselineFile
      ? fs.readFileSync(path.resolve(process.cwd(), baselineFile), 'utf8')
      : readHeadFile(root, relative);
    if (baselineRaw !== null) {
      const baseline = parseWorkflowData(kind, baselineRaw, baselineFile ? baselineFile : `HEAD:${relative}`);
      if (baseline.errors.length > 0) errors.push(...baseline.errors.map((error) => `baseline ${error}`));
      else baselineValue = baseline.value;
    }
  }
  if (errors.length === 0) errors.push(...await validateWorkflowData(kind, parsed.value, { baselineValue }));
  if (errors.length > 0) {
    console.error(`❌ ${file}: ${errors.length} errore/i di coerenza (${kind})`);
    for (const error of errors) console.error(`   - ${error}`);
    process.exitCode = 1;
    return;
  }
  console.log(`✅ ${file}: validazione ${kind} superata (${recordCount(kind, parsed.value)} record)`);
}

if (process.argv[1] && (() => {
  try { return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href; } catch { return false; }
})()) main().catch((error) => {
  console.error(`❌ ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
