#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  buildAtomicItalyDutySnapshots,
  ITALY_DUTY_PROVINCES,
  parseItalyDutySource,
  sourceCoverageModel,
  sourcePublicationClass,
  vcoMirrorUrlError,
} from './lib/pharmacy-italy-duty-parser.mjs';

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = resolve(dirname(__filename), '..');
const SOURCES_PATH = resolve(REPO_ROOT, 'data/pharmacy-duties-italy-sources.json');
const CATALOGUE_PATH = resolve(REPO_ROOT, 'data/pharmacies-italy-border.json');
const DUTIES_PATH = resolve(REPO_ROOT, 'data/pharmacy-duties-italy.json');
const STATUS_PATH = resolve(REPO_ROOT, 'data/pharmacy-duties-italy-status.json');
const USER_AGENT = 'FrontaliereItalyPharmacyDutyBot/1.0 (+https://frontaliereticino.ch/bot)';
const FETCH_TIMEOUT_MS = 30_000;
/**
 * Un tentativo solo trasformava qualunque singhiozzo di rete in una release non
 * pubblicabile. Il retry copre il timeout TRANSITORIO; NON supera il blocco di
 * egress misurato su aslvco.it (HTTP 200 da rete residenziale 3/3, ma
 * UND_ERR_CONNECT_TIMEOUT dai runner GitHub, che filtrano le reti Azure) —
 * quella fonte e' dichiarata `best-effort` nel registry, che e' il meccanismo
 * giusto per un blocco permanente. Qui si usa il `fetch` globale di Node: NON
 * introdurre un `Agent` npm di undici, la combinazione lascia il gzip non
 * decompresso.
 */
const FETCH_ATTEMPTS = 3;
const FETCH_RETRY_BASE_MS = 1_000;

const sleep = (ms) => new Promise((resolve_) => setTimeout(resolve_, ms));

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

async function fetchResponse(url, options = {}, source, label = 'official source', fetchImpl = fetch) {
  let lastError;
  for (let attempt = 1; attempt <= FETCH_ATTEMPTS; attempt += 1) {
    try {
      return await fetchResponseOnce(url, options, source, label, fetchImpl);
    } catch (error) {
      lastError = error;
      // L'URL non ufficiale e il 4xx non sono transitori: ritentarli e' solo
      // tempo speso, e il messaggio di errore deve restare quello vero.
      const message = error instanceof Error ? error.message : String(error);
      if (/must remain official|is not a valid URL|host does not match|vcoMirrorUrl/i.test(message)) throw error;
      if (/^HTTP 4\d\d/.test(message)) throw error;
      if (attempt === FETCH_ATTEMPTS) break;
      await sleep(FETCH_RETRY_BASE_MS * attempt);
    }
  }
  throw lastError;
}

async function fetchResponseOnce(url, options = {}, source, label = 'official source', fetchImpl = fetch) {
  assertOfficialItalyUrl(url, source, label);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetchImpl(url, {
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

export function assertVcoMirrorUrl(url, source, label = 'VCO mirror URL') {
  const error = vcoMirrorUrlError({ ...source, vcoMirrorUrl: url });
  if (error) throw new Error(`${label}: ${error}`);
  return new URL(url);
}

async function fetchMirrorResponse(source, { fetchImpl = fetch } = {}) {
  assertVcoMirrorUrl(source.vcoMirrorUrl, source);
  const response = await fetchImpl(source.vcoMirrorUrl, {
    headers: {
      'User-Agent': USER_AGENT,
      'Accept': 'text/markdown,text/plain,application/pdf;q=0.9,*/*;q=0.1',
      'X-Return-Format': 'markdown',
    },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    redirect: 'follow',
  });
  assertVcoMirrorUrl(response.url || source.vcoMirrorUrl, source, 'VCO mirror final URL');
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${source.vcoMirrorUrl}`);
  return response;
}

async function fetchMirrorText(source, { fetchImpl = fetch } = {}) {
  const response = await fetchMirrorResponse(source, { fetchImpl });
  const contentType = response.headers.get('content-type') || '';
  const bytes = Buffer.from(await response.arrayBuffer());
  if (contentType.includes('application/pdf') || bytes.subarray(0, 4).toString() === '%PDF') {
    return pdfToText(bytes, source);
  }
  const text = bytes.toString('utf8');
  if (!text.trim()) throw new Error(`VCO mirror returned an empty document for ${source.vcoMirrorUrl}`);
  return text;
}

async function fetchPdfBytes(source, { fetchImpl = fetch } = {}) {
  if (source.fetchMode === 'halley-post-pdf') {
    const boundary = 'AZazAZ';
    const halley = source.halley || {};
    const body = `--${boundary}\r\n&name="protocollo=https&ser=${new URL(source.officialSourceUrl).host}&en=${halley.engine || 'e1046'}&MESSA=PUBBLICA&DSK=${halley.descriptor || ''}&FORM=pdf&PAGINA="\r\n\r\n--${boundary}--\r\n`;
    const response = await fetchResponse(source.rawUrl, {
      method: 'POST',
      headers: { 'Content-Type': `text/plain;charset=UTF-8; boundary=${boundary}` },
      body,
    }, source, 'official raw URL', fetchImpl);
    const result = await response.json();
    if (result?.K !== 'DOWNLOAD' || typeof result.PATH !== 'string') {
      throw new Error('official Halley source did not return a PDF download');
    }
    const pdfResponse = await fetchResponse(
      result.PATH,
      { headers: { Accept: 'application/pdf' } },
      source,
      'official Halley PDF URL',
      fetchImpl,
    );
    return Buffer.from(await pdfResponse.arrayBuffer());
  }
  const response = await fetchResponse(
    source.rawUrl,
    { headers: { Accept: 'application/pdf,application/octet-stream' } },
    source,
    'official raw URL',
    fetchImpl,
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

function describeError(error) {
  const message = error instanceof Error ? error.message : String(error);
  const causeCode = error?.cause?.code ? ` (${error.cause.code})` : '';
  return message + causeCode;
}

const OFFICIAL_TRANSPORT_ERROR_CODES = new Set([
  'ABORT_ERR',
  'ECONNABORTED',
  'ECONNREFUSED',
  'ECONNRESET',
  'EHOSTUNREACH',
  'EAI_AGAIN',
  'ENETDOWN',
  'ENETUNREACH',
  'ENOTFOUND',
  'EPIPE',
  'ETIMEDOUT',
  'ERR_SOCKET_TIMEOUT',
  'UND_ERR_ABORTED',
  'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_SOCKET',
]);

const OFFICIAL_TRANSPORT_ERROR_NAMES = new Set([
  'AbortError',
  'BodyTimeoutError',
  'ConnectTimeoutError',
  'HeadersTimeoutError',
  'SocketError',
  'TimeoutError',
]);

function isOfficialTransportError(error, seen = new Set()) {
  if (!error || typeof error !== 'object' || seen.has(error)) return false;
  seen.add(error);
  if (OFFICIAL_TRANSPORT_ERROR_NAMES.has(error.name)) return true;
  if (typeof error.code === 'string' && OFFICIAL_TRANSPORT_ERROR_CODES.has(error.code)) return true;
  // Node's native fetch reports an unwrapped network failure as this exact
  // TypeError; when available, its `cause.code` is checked above/below.
  if (error instanceof TypeError && error.message === 'fetch failed') return true;
  return isOfficialTransportError(error.cause, seen);
}

export async function loadSourceText(source, fixtureDir, { fetchImpl = fetch } = {}) {
  if (fixtureDir) {
    const fixturePath = source.fixturePath || source.key;
    return {
      text: await readFile(resolve(fixtureDir, fixturePath, 'source.txt'), 'utf8'),
      fetchedVia: 'fixture',
    };
  }
  try {
    return {
      text: pdfToText(await fetchPdfBytes(source, { fetchImpl }), source),
      fetchedVia: 'official',
    };
  } catch (officialError) {
    if (vcoMirrorUrlError(source)) throw officialError;
    if (!source.vcoMirrorUrl) throw officialError;
    if (!isOfficialTransportError(officialError)) throw officialError;
    try {
      return {
        text: await fetchMirrorText(source, { fetchImpl }),
        fetchedVia: 'vco-mirror',
        officialError,
      };
    } catch (mirrorError) {
      const officialMessage = describeError(officialError);
      const mirrorMessage = describeError(mirrorError);
      throw new Error(`${officialMessage}; VCO mirror failed: ${mirrorMessage}`);
    }
  }
}

function sourceStatus(source, parsed, fetchedAt, fetchedVia = 'official') {
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
    // La classe viaggia anche nello status per rendere osservabile la decisione,
    // ma `releaseState` e il checker usano il registry come fonte autorevole.
    publication: sourcePublicationClass(source),
    coverageModel: sourceCoverageModel(source),
    observedCalendarDays: parsed.observedCalendarDays ?? null,
    minimumCalendarDays: parsed.minimumCalendarDays ?? null,
    errors: parsed.errors,
    warnings: parsed.warnings,
    fetchedVia,
  };
}

function buildDatasets({ attemptedAt, duties, sourceStatuses, errors, bestEffortErrors, warnings }) {
  const successfulProvinces = sourceStatuses
    .filter((source) => source.state === 'fresh' && source.coverage === 'covered')
    .map((source) => source.province);
  // Le province che DEVONO pubblicare. `_allSourcesFailed` e
  // `_lastSuccessfulFetchAt` si misurano su queste: con VB best-effort e
  // irraggiungibile, pretendere 3 province su 3 teneva
  // `_lastSuccessfulFetchAt` eternamente null.
  const requiredProvinces = sourceStatuses
    .filter((source) => source.publication !== 'best-effort')
    .map((source) => source.province);
  const successfulRequired = requiredProvinces.filter((province) => successfulProvinces.includes(province));
  const status = {
    _source: 'official Italian provincial duty calendars',
    _sourceKeys: sourceStatuses.map((source) => source.sourceKey),
    _fetchedAt: attemptedAt,
    _attemptedAt: attemptedAt,
    _lastSuccessfulFetchAt: requiredProvinces.length > 0 && successfulRequired.length === requiredProvinces.length
      ? attemptedAt
      : null,
    _timezone: 'Europe/Rome',
    _scope: { country: 'IT', provinces: [...ITALY_DUTY_PROVINCES] },
    _successfulProvinces: successfulProvinces,
    _requiredProvinces: requiredProvinces,
    _allSourcesFailed: successfulRequired.length === 0,
    _provinces: Object.fromEntries(sourceStatuses.map((source) => [source.province, source])),
    _errors: errors,
    // Errori delle fonti `best-effort`: NON decidono lo stato della release, ma
    // restano nello snapshot e nell'output del workflow. Toglierli del tutto
    // sarebbe silenziare il difetto; tenerli in `_errors` azzerava le province
    // sane. Questa e' la distinzione, non una scorciatoia per il verde.
    _bestEffortErrors: bestEffortErrors,
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
    _bestEffortErrors: bestEffortErrors,
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
  fetchImpl = fetch,
} = {}) {
  const sourceData = await readJson(SOURCES_PATH);
  const catalogue = await readJson(CATALOGUE_PATH);
  const allDuties = [];
  const allErrors = [];
  const allBestEffortErrors = [];
  const allWarnings = [];
  const statuses = [];

  for (const source of sourceData.sources || []) {
    try {
      const loaded = await loadSourceText(source, fixtureDir, { fetchImpl });
      const rawText = loaded.text;
      const parsed = parseItalyDutySource(rawText, source, {
        fetchedAt: attemptedAt,
        asOf: attemptedAt,
        catalogue,
      });
      allDuties.push(...parsed.duties);
      const bucket = sourcePublicationClass(source) === 'best-effort' ? allBestEffortErrors : allErrors;
      bucket.push(...parsed.errors.map((error) => `${source.key}: ${error}`));
      allWarnings.push(...parsed.warnings.map((warning) => `${source.key}: ${warning}`));
      if (loaded.fetchedVia === 'vco-mirror') {
        const detail = loaded.officialError ? ` after official fetch failure (${describeError(loaded.officialError)})` : '';
        allWarnings.push(`${source.key}: fetched via configured vcoMirrorUrl${detail}`);
      }
      statuses.push(sourceStatus(source, parsed, attemptedAt, loaded.fetchedVia));
    } catch (error) {
      const message = source.key + ': ' + describeError(error);
      const publication = sourcePublicationClass(source);
      (publication === 'best-effort' ? allBestEffortErrors : allErrors).push(message);
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
        publication,
        coverageModel: sourceCoverageModel(source),
        observedCalendarDays: null,
        minimumCalendarDays: null,
        errors: [message],
        warnings: [],
        fetchedVia: 'unavailable',
      });
    }
  }

  const { dataset, status } = buildDatasets({
    attemptedAt,
    duties: allDuties,
    sourceStatuses: statuses,
    errors: allErrors,
    bestEffortErrors: allBestEffortErrors,
    warnings: allWarnings,
  });
  const atomic = buildAtomicItalyDutySnapshots({ duties: dataset, status, evaluatedAt: attemptedAt, sources: sourceData });
  if (write) {
    await writeJson(DUTIES_PATH, atomic.duties);
    await writeJson(STATUS_PATH, atomic.status);
  }
  return {
    ...atomic,
    sourceStatuses: statuses,
    errors: allErrors,
    bestEffortErrors: allBestEffortErrors,
    warnings: allWarnings,
  };
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
    provinces: result.sourceStatuses.map(({ province, dutyCount, state, publication, observedCalendarDays }) => ({
      province, dutyCount, state, publication, observedCalendarDays,
    })),
    errors: result.errors,
    // Stampati sempre: una provincia best-effort degradata non deve diventare
    // invisibile solo perche' non fa piu' fallire la run.
    bestEffortErrors: result.bestEffortErrors,
  }, null, 2));
  if (result.release.state !== 'fresh') process.exitCode = 1;
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
