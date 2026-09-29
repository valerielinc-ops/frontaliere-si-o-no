#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  JURA_SOURCE_URL,
  parseJuraCalendars,
  parseMoutierCalendar,
} from './lib/pharmacy-swiss-canton-parser.mjs';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const REPO_ROOT = resolve(dirname(SCRIPT_PATH), '..');
const REGISTRY_PATH = resolve(REPO_ROOT, 'data/pharmacy-sources-registry.json');
const OUTPUT_PATH = resolve(REPO_ROOT, 'data/pharmacy-duties-swiss-cantons.json');
const FETCH_TIMEOUT_MS = 30_000;
const USER_AGENT = 'FrontaliereSwissPharmacyDutyBot/1.0 (+https://frontaliereticino.ch/bot)';
const JURA_SOURCE_KEY = 'jura';
const JURA_SCOPE = 'JU';
const JURA_PAGE_HOST = 'www.jura.ch';

function argumentValue(prefix) {
  const argument = process.argv.find((value) => value.startsWith(prefix));
  return argument ? argument.slice(prefix.length) : null;
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, 'utf8'));
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function sha256(value) {
  return createHash('sha256').update(stableJson(value)).digest('hex');
}

function sourceFromRegistry(registry) {
  const source = registry?.sources?.[JURA_SOURCE_KEY];
  if (!source || source.officialSourceUrl !== JURA_SOURCE_URL) {
    throw new Error('Jura source registry is missing the allowlisted official page');
  }
  if (source.status !== 'active') throw new Error(`Jura source is not active: ${source.status || 'unknown'}`);
  return source;
}

function absoluteJuraUrl(value) {
  const url = new URL(value, JURA_SOURCE_URL);
  if (url.protocol !== 'https:' || url.hostname !== JURA_PAGE_HOST || !url.pathname.toLocaleLowerCase('en-US').endsWith('.pdf')) {
    return null;
  }
  return url.href;
}

function stripHtml(value) {
  return String(value || '').replace(/<[^>]+>/g, ' ').replace(/&(?:amp|#38);/g, '&').replace(/&(?:quot|#34);/g, '"').replace(/&(?:apos|#39);/g, "'").replace(/\s+/g, ' ').trim();
}

function discoverJuraPdfUrls(html) {
  const candidates = [];
  const linkPattern = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let match;
  while ((match = linkPattern.exec(html))) {
    const url = absoluteJuraUrl(match[1]);
    if (!url) continue;
    const description = `${url} ${stripHtml(match[2])}`.toLocaleLowerCase('fr');
    candidates.push({ url, description });
  }
  // Jura sometimes leaves an expired PDF link beside the replacement. The
  // page orders the current replacement last; prefer it while retaining the
  // host/path allowlist above.
  const pick = (needle) => [...candidates].reverse().find((candidate) => candidate.description.includes(needle))?.url || null;
  const result = {
    delemont: pick('delemont'),
    ajoie: pick('ajoie'),
    moutier: pick('moutier'),
  };
  const missing = Object.entries(result).filter(([, value]) => !value).map(([key]) => key);
  if (missing.length > 0) throw new Error(`Jura page did not expose the expected PDF plans: ${missing.join(', ')}`);
  return result;
}

async function fetchResponse(url, { binary = false } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': USER_AGENT,
        'Accept-Language': 'fr-CH,fr;q=0.9,en;q=0.5',
      },
      redirect: 'follow',
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
    return binary ? Buffer.from(await response.arrayBuffer()) : response.text();
  } finally {
    clearTimeout(timer);
  }
}

function pdfToText(buffer, mode = 'layout') {
  return execFileSync('pdftotext', [`-${mode}`, '-', '-'], {
    input: buffer,
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024,
  });
}

async function parseJuraSource({ source, fetchedAt }) {
  const calendarYear = new Date(fetchedAt).getUTCFullYear();
  if (!Number.isInteger(calendarYear)) throw new Error(`Invalid fetch timestamp for Jura calendar: ${fetchedAt}`);
  const html = await fetchResponse(source.officialSourceUrl);
  const urls = discoverJuraPdfUrls(html);
  const [delemontPdf, ajoiePdf, moutierPdf] = await Promise.all([
    fetchResponse(urls.delemont, { binary: true }),
    fetchResponse(urls.ajoie, { binary: true }),
    fetchResponse(urls.moutier, { binary: true }),
  ]);
  const temporaryDir = await mkdtemp(resolve(tmpdir(), 'frontaliere-swiss-pharmacy-'));
  const moutierPdfPath = resolve(temporaryDir, 'moutier.pdf');
  const moutierImagePrefix = resolve(temporaryDir, 'moutier');
  try {
    await writeFile(moutierPdfPath, moutierPdf);
    execFileSync('pdftoppm', ['-png', '-r', '144', '-singlefile', moutierPdfPath, moutierImagePrefix], {
      maxBuffer: 4 * 1024 * 1024,
    });
    const moutier = await parseMoutierCalendar({
      bboxHtml: pdfToText(moutierPdf, 'bbox-layout'),
      imagePath: `${moutierImagePrefix}.png`,
      sourceUrl: urls.moutier,
      fetchedAt,
      calendarYear,
    });
    return parseJuraCalendars({
      delemontText: pdfToText(delemontPdf),
      delemontSourceUrl: urls.delemont,
      ajoieText: pdfToText(ajoiePdf),
      ajoieSourceUrl: urls.ajoie,
      fetchedAt,
      calendarYear,
      moutier: {
        ...moutier,
        meta: { sourceUrl: urls.moutier, fetchedAt },
      },
    });
  } finally {
    await rm(temporaryDir, { recursive: true, force: true });
  }
}

function isoDate(value) {
  const match = /^(\d{4}-\d{2}-\d{2})T/.exec(String(value || ''));
  return match ? match[1] : null;
}

function calendarDate(value) {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString().slice(0, 10) : null;
}

function calendarDays(year) {
  return Math.round((Date.UTC(year + 1, 0, 1) - Date.UTC(year, 0, 1)) / 86_400_000);
}

function buildSnapshot({ source, fetchedAt, parsed }) {
  const rows = parsed.rows;
  const pharmacies = parsed.pharmacies;
  const calendarYear = new Date(fetchedAt).getUTCFullYear();
  const timestamps = rows.flatMap((row) => [Date.parse(row.startsAt), Date.parse(row.endsAt)]).filter(Number.isFinite);
  const validFrom = calendarDate(new Date(Math.min(...timestamps)).toISOString());
  const validTo = calendarDate(new Date(Math.max(...timestamps)).toISOString());
  if (!validFrom || !validTo || !Number.isInteger(calendarYear)) throw new Error('Jura parsed rows have no valid calendar bounds');
  const payload = {
    _schemaVersion: 1,
    _source: source.officialSourceUrl,
    _sourceKey: JURA_SOURCE_KEY,
    _fetchedAt: fetchedAt,
    _attemptedAt: fetchedAt,
    _timezone: 'Europe/Zurich',
    _scope: { country: 'CH', canton: JURA_SCOPE, coverageType: 'canton' },
    _coverage: {
      validFrom,
      validTo,
      observedCalendarDays: calendarDays(calendarYear),
      uncoveredCalendarDays: 0,
      coverage: 'covered',
    },
    _releaseReady: true,
    _state: 'fresh',
    _errors: [],
    _warnings: ['Moutier è pubblicato dalla pagina ufficiale del Giura come distretto di servizio; la card mantiene il perimetro regionale dichiarato dalla fonte.'],
    _unresolvedIdentities: [],
    coverageName: 'Delémont, Ajoie e Moutier',
    pharmacies,
    duties: rows,
  };
  const release = {
    version: 1,
    releaseId: `pharmacy-swiss-canton-v1-${sha256(payload)}`,
    evaluatedAt: fetchedAt,
    state: 'fresh',
    source: { key: JURA_SOURCE_KEY, url: source.officialSourceUrl },
    scope: payload._scope,
    coverage: payload._coverage,
  };
  return { ...payload, _release: release };
}

function failedSnapshot(previous, attemptedAt, error) {
  const message = `jura-duty: ${error instanceof Error ? error.message : String(error)}`;
  const calendarYear = new Date(attemptedAt).getUTCFullYear();
  const validYear = Number.isInteger(calendarYear) ? calendarYear : new Date().getUTCFullYear();
  const base = previous && typeof previous === 'object' ? previous : {
    _schemaVersion: 1,
    _source: JURA_SOURCE_URL,
    _sourceKey: JURA_SOURCE_KEY,
    _fetchedAt: null,
    _timezone: 'Europe/Zurich',
    _scope: { country: 'CH', canton: JURA_SCOPE, coverageType: 'canton' },
    _coverage: { validFrom: `${validYear}-01-01`, validTo: `${validYear}-12-31`, observedCalendarDays: 0, uncoveredCalendarDays: calendarDays(validYear), coverage: 'not_published' },
    _errors: [],
    _warnings: [],
    _unresolvedIdentities: [],
    coverageName: 'Delémont, Ajoie e Moutier',
    pharmacies: [],
    duties: [],
  };
  const release = {
    ...(base._release || {}),
    version: 1,
    releaseId: typeof base._release?.releaseId === 'string' ? base._release.releaseId : `pharmacy-swiss-canton-failed-${sha256({ attemptedAt, message })}`,
    evaluatedAt: attemptedAt,
    state: 'stale',
    source: { key: JURA_SOURCE_KEY, url: JURA_SOURCE_URL },
    scope: base._scope,
    coverage: base._coverage,
  };
  return {
    ...base,
    _attemptedAt: attemptedAt,
    _releaseReady: false,
    _state: 'stale',
    _errors: [...(Array.isArray(base._errors) ? base._errors : []), message],
    _release: release,
  };
}

async function writeJson(filePath, value) {
  await mkdir(dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await rename(temporaryPath, filePath);
}

export async function importSwissCantonPharmacyDuties({ attemptedAt = new Date().toISOString(), write = true } = {}) {
  const registry = await readJson(REGISTRY_PATH);
  const source = sourceFromRegistry(registry);
  let previous = null;
  try {
    previous = (await readJson(OUTPUT_PATH))?.snapshots?.[JURA_SCOPE] || null;
  } catch {
    previous = null;
  }
  let snapshot;
  let fetchError = null;
  try {
    const parsed = await parseJuraSource({ source, fetchedAt: attemptedAt });
    snapshot = buildSnapshot({ source, fetchedAt: attemptedAt, parsed });
  } catch (error) {
    fetchError = error;
    snapshot = failedSnapshot(previous, attemptedAt, error);
  }
  const output = {
    schemaVersion: 1,
    generatedAt: attemptedAt,
    snapshots: { [JURA_SCOPE]: snapshot },
  };
  const updatedRegistry = !fetchError
    ? {
      ...registry,
      generatedAt: attemptedAt,
      sources: {
        ...registry.sources,
        [JURA_SOURCE_KEY]: { ...source, sourceFetchedAt: attemptedAt },
      },
    }
    : registry;
  if (write) {
    await writeJson(OUTPUT_PATH, output);
    if (!fetchError) await writeJson(REGISTRY_PATH, updatedRegistry);
  }
  return { output, snapshot, source, fetchError, registry: updatedRegistry };
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const attemptedAt = argumentValue('--at=') || process.env.PHARMACY_SWISS_CANTON_FETCHED_AT || undefined;
  const result = await importSwissCantonPharmacyDuties({ attemptedAt, write: !dryRun });
  console.log(JSON.stringify({
    canton: JURA_SCOPE,
    state: result.snapshot._state,
    releaseReady: result.snapshot._releaseReady,
    pharmacies: result.snapshot.pharmacies.length,
    duties: result.snapshot.duties.length,
    errors: result.snapshot._errors,
  }, null, 2));
  if (result.fetchError || !result.snapshot._releaseReady) process.exitCode = 1;
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
