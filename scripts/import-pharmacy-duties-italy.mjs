#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  buildAtomicItalyDutySnapshots,
  ITALY_DUTY_PROVINCES,
  parseItalyDutySource,
} from './lib/pharmacy-italy-duty-parser.mjs';

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = resolve(dirname(__filename), '..');
const SOURCES_PATH = resolve(REPO_ROOT, 'data/pharmacy-duties-italy-sources.json');
const CATALOGUE_PATH = resolve(REPO_ROOT, 'data/pharmacies-italy-border.json');
const DUTIES_PATH = resolve(REPO_ROOT, 'data/pharmacy-duties-italy.json');
const STATUS_PATH = resolve(REPO_ROOT, 'data/pharmacy-duties-italy-status.json');
const USER_AGENT = 'FrontaliereItalyPharmacyDutyBot/1.0 (+https://frontaliereticino.ch/bot)';
const FETCH_TIMEOUT_MS = 30_000;

function argumentValue(prefix) {
  const argument = process.argv.find((value) => value.startsWith(prefix));
  return argument ? argument.slice(prefix.length) : null;
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, 'utf8'));
}

export function assertOfficialItalyUrl(url, source, label = 'official source URL') {
  let parsed;
  let official;
  try {
    parsed = new URL(url);
    official = new URL(source?.officialSourceUrl || '');
  } catch {
    throw new Error(label + ' is not a valid URL');
  }
  if (parsed.protocol !== 'https:' || official.protocol !== 'https:') {
    throw new Error(label + ' must remain official HTTPS');
  }
  if (parsed.host !== official.host) {
    throw new Error(label + ' host does not match the official source host');
  }
  return parsed;
}

async function fetchResponse(url, options = {}, source, label = 'official source') {
  assertOfficialItalyUrl(url, source, label);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      ...options,
      headers: {
        'User-Agent': USER_AGENT,
        'Accept-Language': 'it-IT,it;q=0.9,en;q=0.5',
        ...(options.headers || {}),
      },
      signal: controller.signal,
      redirect: 'follow',
    });
    assertOfficialItalyUrl(response.url || url, source, label + ' final URL');
    if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
    return response;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchPdfBytes(source) {
  if (source.fetchMode === 'halley-post-pdf') {
    const boundary = 'AZazAZ';
    const halley = source.halley || {};
    const body = `--${boundary}\r\n&name="protocollo=https&ser=${new URL(source.officialSourceUrl).host}&en=${halley.engine || 'e1046'}&MESSA=PUBBLICA&DSK=${halley.descriptor || ''}&FORM=pdf&PAGINA="\r\n\r\n--${boundary}--\r\n`;
    const response = await fetchResponse(source.rawUrl, {
      method: 'POST',
      headers: { 'Content-Type': `text/plain;charset=UTF-8; boundary=${boundary}` },
      body,
    }, source, 'official raw URL');
    const result = await response.json();
    if (result?.K !== 'DOWNLOAD' || typeof result.PATH !== 'string') {
      throw new Error('official Halley source did not return a PDF download');
    }
    const pdfResponse = await fetchResponse(
      result.PATH,
      { headers: { Accept: 'application/pdf' } },
      source,
      'official Halley PDF URL',
    );
    return Buffer.from(await pdfResponse.arrayBuffer());
  }
  const response = await fetchResponse(
    source.rawUrl,
    { headers: { Accept: 'application/pdf,application/octet-stream' } },
    source,
    'official raw URL',
  );
  return Buffer.from(await response.arrayBuffer());
}

function pdfToText(bytes, source) {
  try {
    return execFileSync('pdftotext', ['-layout', '-', '-'], {
      input: bytes,
      encoding: 'utf8',
      maxBuffer: 20 * 1024 * 1024,
    });
  } catch (error) {
    const detail = error?.stderr ? String(error.stderr).trim() : error?.message || String(error);
    throw new Error(`${source.key}: pdftotext failed: ${detail}`);
  }
}

async function loadSourceText(source, fixtureDir) {
  if (fixtureDir) {
    const fixturePath = source.fixturePath || source.key;
    return readFile(resolve(fixtureDir, fixturePath, 'source.txt'), 'utf8');
  }
  return pdfToText(await fetchPdfBytes(source), source);
}

function sourceStatus(source, parsed, fetchedAt) {
  const state = parsed.errors.length > 0
    ? (parsed.freshness === 'stale' ? 'stale' : 'partial')
    : (parsed.coverage === 'covered' && parsed.freshness === 'fresh' ? 'fresh' : 'not_published');
  return {
    province: source.province,
    sourceKey: source.key,
    sourceUrl: source.officialSourceUrl,
    fetchedAt,
    dutyCount: parsed.duties.length,
    observedDutyCount: parsed.observedDuties?.length || parsed.duties.length,
    freshness: parsed.freshness,
    coverage: parsed.coverage,
    state,
    errors: parsed.errors,
    warnings: parsed.warnings,
  };
}

function buildDatasets({ attemptedAt, duties, sourceStatuses, errors, warnings }) {
  const successfulProvinces = sourceStatuses
    .filter((source) => source.state === 'fresh' && source.coverage === 'covered')
    .map((source) => source.province);
  const status = {
    _source: 'official Italian provincial duty calendars',
    _sourceKeys: sourceStatuses.map((source) => source.sourceKey),
    _fetchedAt: attemptedAt,
    _attemptedAt: attemptedAt,
    _lastSuccessfulFetchAt: successfulProvinces.length === ITALY_DUTY_PROVINCES.length ? attemptedAt : null,
    _timezone: 'Europe/Rome',
    _scope: { country: 'IT', provinces: [...ITALY_DUTY_PROVINCES] },
    _successfulProvinces: successfulProvinces,
    _allSourcesFailed: successfulProvinces.length === 0,
    _provinces: Object.fromEntries(sourceStatuses.map((source) => [source.province, source])),
    _errors: errors,
    _warnings: warnings,
  };
  const dataset = {
    _source: 'official Italian provincial duty calendars',
    _sourceKeys: status._sourceKeys,
    _fetchedAt: attemptedAt,
    _asOf: attemptedAt.slice(0, 10),
    _timezone: 'Europe/Rome',
    _scope: { country: 'IT', provinces: [...ITALY_DUTY_PROVINCES] },
    _errors: errors,
    _warnings: warnings,
    duties,
  };
  return { dataset, status };
}

async function writeJson(filePath, value) {
  await mkdir(dirname(filePath), { recursive: true });
  const temporaryPath = filePath + '.' + process.pid + '.tmp';
  try {
    await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await rename(temporaryPath, filePath);
  } catch (error) {
    await unlink(temporaryPath).catch(() => {});
    throw error;
  }
}

export async function importItalyPharmacyDuties({
  fixtureDir = process.env.PHARMACY_DUTY_ITALY_FIXTURE_DIR
    || process.env.PHARMACY_ITALY_DUTY_FIXTURE_DIR
    || null,
  attemptedAt = new Date().toISOString(),
  write = true,
} = {}) {
  const sourceData = await readJson(SOURCES_PATH);
  const catalogue = await readJson(CATALOGUE_PATH);
  const allDuties = [];
  const allErrors = [];
  const allWarnings = [];
  const statuses = [];

  for (const source of sourceData.sources || []) {
    try {
      const rawText = await loadSourceText(source, fixtureDir);
      const parsed = parseItalyDutySource(rawText, source, {
        fetchedAt: attemptedAt,
        asOf: attemptedAt,
        catalogue,
      });
      allDuties.push(...parsed.duties);
      allErrors.push(...parsed.errors.map((error) => `${source.key}: ${error}`));
      allWarnings.push(...parsed.warnings.map((warning) => `${source.key}: ${warning}`));
      statuses.push(sourceStatus(source, parsed, attemptedAt));
    } catch (error) {
      const baseMessage = error instanceof Error ? error.message : String(error);
      const causeCode = error?.cause?.code ? ' (' + error.cause.code + ')' : '';
      const message = source.key + ': ' + baseMessage + causeCode;
      allErrors.push(message);
      statuses.push({
        province: source.province,
        sourceKey: source.key,
        sourceUrl: source.officialSourceUrl,
        fetchedAt: attemptedAt,
        dutyCount: 0,
        observedDutyCount: 0,
        freshness: 'unknown',
        coverage: 'not_published',
        state: 'not_published',
        errors: [message],
        warnings: [],
      });
    }
  }

  const { dataset, status } = buildDatasets({
    attemptedAt,
    duties: allDuties,
    sourceStatuses: statuses,
    errors: allErrors,
    warnings: allWarnings,
  });
  const atomic = buildAtomicItalyDutySnapshots({ duties: dataset, status, evaluatedAt: attemptedAt });
  if (write) {
    await writeJson(DUTIES_PATH, atomic.duties);
    await writeJson(STATUS_PATH, atomic.status);
  }
  return { ...atomic, sourceStatuses: statuses, errors: allErrors, warnings: allWarnings };
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const fixtureDir = argumentValue('--fixtures=') || undefined;
  const attemptedAt = argumentValue('--at=') || process.env.PHARMACY_ITALY_DUTY_FETCHED_AT || undefined;
  const result = await importItalyPharmacyDuties({ fixtureDir, attemptedAt, write: !dryRun });
  console.log(JSON.stringify({
    releaseId: result.release.releaseId,
    state: result.release.state,
    publishable: result.release.state === 'fresh',
    duties: result.duties.duties.length,
    provinces: result.sourceStatuses.map(({ province, dutyCount, state }) => ({ province, dutyCount, state })),
    errors: result.errors,
  }, null, 2));
  if (result.release.state !== 'fresh') process.exitCode = 1;
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
