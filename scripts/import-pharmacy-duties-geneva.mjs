#!/usr/bin/env node

import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  buildAtomicGenevaDutySnapshots,
  GENEVA_DUTY_RELEASE_CANTON,
  GENEVA_DUTY_RELEASE_SOURCE_KEY,
  GENEVA_DUTY_RELEASE_SOURCE_URL,
  GENEVA_DUTY_RELEASE_TIMEZONE,
  GENEVA_DUTY_RELEASE_VALID_FROM,
  GENEVA_DUTY_RELEASE_VALID_TO,
  validateGenevaDutySourceRegistry,
} from '../services/pharmacies/genevaReleaseContract.mjs';
import { parseGenevaDutySource } from './lib/pharmacy-geneva-duty-parser.mjs';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const REPO_ROOT = resolve(dirname(SCRIPT_PATH), '..');
const SOURCES_PATH = resolve(REPO_ROOT, 'data/pharmacy-duties-geneva-sources.json');
const DUTIES_PATH = resolve(REPO_ROOT, 'data/pharmacy-duties-geneva.json');
const STATUS_PATH = resolve(REPO_ROOT, 'data/pharmacy-duties-geneva-status.json');
const USER_AGENT = 'FrontaliereGenevaPharmacyDutyBot/1.0 (+https://frontaliereticino.ch/bot)';
const FETCH_TIMEOUT_MS = 30_000;

function argumentValue(prefix) {
  const argument = process.argv.find((value) => value.startsWith(prefix));
  return argument ? argument.slice(prefix.length) : null;
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, 'utf8'));
}

function sourceFromRegistry(sourceData) {
  return sourceData && Array.isArray(sourceData.sources) && sourceData.sources.length === 1
    ? sourceData.sources[0]
    : null;
}

function assertAllowlistedGenevaUrl(url, source) {
  if (url !== GENEVA_DUTY_RELEASE_SOURCE_URL || source?.officialSourceUrl !== GENEVA_DUTY_RELEASE_SOURCE_URL) {
    throw new Error('Geneva source URL is not the allowlisted Pharma Genève page');
  }
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:' || parsed.hostname !== 'pharmageneve.swiss' || parsed.pathname !== '/pharmacie-de-garde/') {
    throw new Error('Geneva source URL does not match the allowlisted host and path');
  }
}

async function fetchSource(source) {
  assertAllowlistedGenevaUrl(source?.officialSourceUrl, source);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(source.officialSourceUrl, {
      headers: {
        'User-Agent': USER_AGENT,
        'Accept-Language': 'fr-CH,fr;q=0.9,en;q=0.5',
      },
      redirect: 'error',
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`HTTP ${response.status} for ${source.officialSourceUrl}`);
    if (response.url !== GENEVA_DUTY_RELEASE_SOURCE_URL) throw new Error('Geneva source final URL is not allowlisted');
    return response.text();
  } finally {
    clearTimeout(timer);
  }
}

async function loadSource(source, fixtureDir) {
  if (fixtureDir) return readFile(resolve(fixtureDir, 'geneva/source.html'), 'utf8');
  return fetchSource(source);
}

function coverageFromParsed(parsed, sourceData) {
  const declaredCoverage = sourceData?.coverage || {};
  return {
    validFrom: declaredCoverage.validFrom || GENEVA_DUTY_RELEASE_VALID_FROM,
    validTo: declaredCoverage.validTo || GENEVA_DUTY_RELEASE_VALID_TO,
    minimumCalendarDays: Number.isInteger(declaredCoverage.minimumCalendarDays)
      ? declaredCoverage.minimumCalendarDays
      : 0,
    observedCalendarDays: parsed.observedCalendarDays,
    uncoveredCalendarDays: parsed.uncoveredCalendarDays,
    coverage: parsed.coverage,
  };
}

function baseSnapshot({ attemptedAt, source, sourceData, parsed, fetchedAt = attemptedAt, allSourcesFailed = false }) {
  const coverage = parsed
    ? coverageFromParsed(parsed, sourceData)
    : {
      validFrom: GENEVA_DUTY_RELEASE_VALID_FROM,
      validTo: GENEVA_DUTY_RELEASE_VALID_TO,
      minimumCalendarDays: sourceData?.coverage?.minimumCalendarDays || 0,
      observedCalendarDays: 0,
      uncoveredCalendarDays: 365,
      coverage: 'not_published',
    };
  const errors = parsed?.errors || [];
  const warnings = parsed?.warnings || [];
  const unresolvedIdentities = parsed?.unresolvedIdentities || [];
  const duties = parsed?.duties || [];
  const releaseReady = source?.status === 'active'
    && duties.length > 0
    && errors.length === 0
    && coverage.coverage === 'covered';
  const state = releaseReady
    ? 'fresh'
    : 'not_published';
  return {
    _source: source?.officialSourceUrl || GENEVA_DUTY_RELEASE_SOURCE_URL,
    _sourceKey: source?.key || GENEVA_DUTY_RELEASE_SOURCE_KEY,
    _fetchedAt: fetchedAt,
    _attemptedAt: attemptedAt,
    _timezone: GENEVA_DUTY_RELEASE_TIMEZONE,
    _scope: { country: 'CH', canton: GENEVA_DUTY_RELEASE_CANTON },
    _coverage: coverage,
    _observedEntryCount: parsed?.observations?.filter((entry) => entry.kind === 'dated').length || 0,
    _resolvedDutyCount: duties.length,
    _unresolvedIdentities: unresolvedIdentities,
    _allSourcesFailed: allSourcesFailed,
    _releaseReady: releaseReady,
    _state: state,
    _errors: errors,
    _warnings: warnings,
  };
}

function fetchFailureSnapshots({ attemptedAt, source, sourceData, error }) {
  const message = `pharmageneve-garde-2026: ${error instanceof Error ? error.message : String(error)}`;
  const base = baseSnapshot({
    attemptedAt,
    source,
    sourceData,
    fetchedAt: null,
    allSourcesFailed: true,
    parsed: {
      errors: [message],
      warnings: [],
      unresolvedIdentities: [],
      duties: [],
      observations: [],
      observedCalendarDays: 0,
      uncoveredCalendarDays: 365,
      coverage: 'not_published',
    },
  });
  return { duties: { ...base, duties: [] }, status: base };
}

export function buildGenevaDutyDatasets({ sourceData, html, attemptedAt, catalogue } = {}) {
  const source = sourceFromRegistry(sourceData);
  const registryErrors = validateGenevaDutySourceRegistry(sourceData);
  if (registryErrors.length > 0) throw new Error(`Geneva source registry is invalid: ${registryErrors.join('; ')}`);
  const parsed = parseGenevaDutySource(html, sourceData, {
    fetchedAt: attemptedAt,
    asOf: attemptedAt,
    ...(catalogue === undefined ? {} : { catalogue }),
  });
  const base = baseSnapshot({ attemptedAt, source, sourceData, parsed });
  const duties = { ...base, duties: parsed.duties };
  const status = { ...base };
  return buildAtomicGenevaDutySnapshots({ duties, status, sources: sourceData, evaluatedAt: attemptedAt });
}

async function writeJson(filePath, value) {
  await mkdir(dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await rename(temporaryPath, filePath);
  } catch (error) {
    await unlink(temporaryPath).catch(() => {});
    throw error;
  }
}

export async function importGenevaPharmacyDuties({
  fixtureDir = process.env.PHARMACY_DUTY_GENEVA_FIXTURE_DIR || null,
  attemptedAt = new Date().toISOString(),
  write = true,
  catalogue,
} = {}) {
  const sourceData = await readJson(SOURCES_PATH);
  const source = sourceFromRegistry(sourceData);
  const registryErrors = validateGenevaDutySourceRegistry(sourceData);
  if (registryErrors.length > 0) throw new Error(`Geneva source registry is invalid: ${registryErrors.join('; ')}`);

  let atomic;
  let fetchError = null;
  try {
    const html = await loadSource(source, fixtureDir);
    atomic = buildGenevaDutyDatasets({ sourceData, html, attemptedAt, catalogue });
  } catch (error) {
    fetchError = error;
    const failed = fetchFailureSnapshots({ attemptedAt, source, sourceData, error });
    atomic = buildAtomicGenevaDutySnapshots({
      duties: failed.duties,
      status: failed.status,
      sources: sourceData,
      evaluatedAt: attemptedAt,
    });
  }

  if (write) {
    await writeJson(DUTIES_PATH, atomic.duties);
    await writeJson(STATUS_PATH, atomic.status);
  }
  return { ...atomic, source, fetchError };
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const fixtureDir = argumentValue('--fixtures=') || undefined;
  const attemptedAt = argumentValue('--at=') || process.env.PHARMACY_GENEVA_DUTY_FETCHED_AT || undefined;
  const result = await importGenevaPharmacyDuties({ fixtureDir, attemptedAt, write: !dryRun });
  console.log(JSON.stringify({
    releaseId: result.release.releaseId,
    state: result.release.state,
    publishable: result.release.state === 'fresh',
    duties: result.duties.duties.length,
    coverage: result.status._coverage,
    errors: result.status._errors,
  }, null, 2));
  if (result.release.state !== 'fresh') process.exitCode = 1;
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
