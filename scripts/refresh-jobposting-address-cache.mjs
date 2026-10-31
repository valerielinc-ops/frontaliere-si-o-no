#!/usr/bin/env node
/** Refresh missing same-city employer addresses from the public Zefix LINDAS dataset. */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import SWISS_LOCALITY_POSTAL_CODES from '../data/swiss-locality-postal-codes.json' with { type: 'json' };
import { writeJsonAtomic } from './lib/atomic-write-json.mjs';
import { withSingleFlightLockAsync } from './lib/single-flight-lock.mjs';
import {
  DEFAULT_JOBPOSTING_ADDRESS_CACHE,
  JOBPOSTING_ADDRESS_CACHE_TTL_MS,
  jobpostingAddressCacheKey,
  normalizeCompanyAddressKeyPart,
  readJobpostingAddressCache,
} from './lib/jobposting-address-cache.mjs';
import { resolveJobPostingStreetAddress } from './lib/jobposting-field-enrichment.mjs';
import { isSourceStreetAddress } from './lib/jobposting-field-provenance.mjs';
import { sameSwissLocalityLabel } from './lib/target-swiss-locations.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CACHE_PATH = path.resolve(ROOT, process.env.JOBPOSTING_ADDRESS_CACHE_PATH || DEFAULT_JOBPOSTING_ADDRESS_CACHE);
const LINDAS_ENDPOINT = 'https://lindas.admin.ch/query';
// The lock is endpoint-scoped, not cache-path- or worktree-scoped, so separate
// clones and diagnostic runs cannot overlap requests against the public service.
const LINDAS_LOCK_PATH = path.join(tmpdir(), 'frontaliere-zefix-address-refresh.lock');
const LOCATION_BATCH_SIZE = 10;
const QUERY_TIMEOUT_MS = 60_000;
const QUERY_MAX_ATTEMPTS = 4;
const QUERY_RETRY_DELAYS_MS = [1_000, 2_000, 4_000];

const LEGAL_FORM_SUFFIXES = new Set([
  'ag', 'sa', 'gmbh', 'sarl', 'sagl', 'ltd', 'limited', 'inc', 'incorporated',
  'corp', 'corporation', 'kg', 'snc', 'sas',
]);

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, 'utf8'));
}

function loadJobs() {
  const assembledPath = path.join(ROOT, 'data', 'jobs.json');
  if (existsSync(assembledPath)) {
    const parsed = readJson(assembledPath);
    return Array.isArray(parsed) ? parsed : parsed.jobs || [];
  }
  const sliceDir = path.join(ROOT, 'data', 'jobs', 'by-crawler');
  if (!existsSync(sliceDir)) throw new Error('Active job inventory is missing; cannot refresh the address cache.');
  const jobs = [];
  for (const file of readdirSync(sliceDir).filter((name) => name.endsWith('.json')).sort()) {
    const parsed = readJson(path.join(sliceDir, file));
    jobs.push(...(Array.isArray(parsed) ? parsed : parsed.jobs || []));
  }
  return jobs;
}

function localityKey(value, region = '') {
  let locality = String(value ?? '').trim();
  const cantonSuffix = locality.match(/\s+\(([a-z]{2})\)$/i);
  if (cantonSuffix && cantonSuffix[1].toUpperCase() === String(region ?? '').trim().toUpperCase()) {
    locality = locality.slice(0, cantonSuffix.index).trim();
  }
  return normalizeCompanyAddressKeyPart(locality);
}

const OFFICIAL_LOCALITIES_BY_KEY = new Map();
const OFFICIAL_LOCALITIES_BY_REGION = new Map();
for (const [region, localities] of Object.entries(SWISS_LOCALITY_POSTAL_CODES.cantons || {})) {
  OFFICIAL_LOCALITIES_BY_REGION.set(region, Object.keys(localities || {}));
  for (const locality of Object.keys(localities || {})) {
    const key = localityKey(locality, region);
    if (!key) continue;
    const mapKey = `${region}|${key}`;
    const values = OFFICIAL_LOCALITIES_BY_KEY.get(mapKey) || new Set();
    values.add(locality);
    OFFICIAL_LOCALITIES_BY_KEY.set(mapKey, values);
  }
}

/** Resolve a decorated job label only when an official locality in its canton confirms it. */
function requestLocalityKey(value, region) {
  const regionCode = String(region ?? '').trim().toUpperCase();
  const rawKey = localityKey(value, regionCode);
  const exactKey = `${regionCode}|${rawKey}`;
  if (OFFICIAL_LOCALITIES_BY_KEY.has(exactKey)) return rawKey;

  for (const officialLocality of OFFICIAL_LOCALITIES_BY_REGION.get(regionCode) || []) {
    if (sameSwissLocalityLabel(value, officialLocality, regionCode)) {
      return localityKey(officialLocality, regionCode);
    }
  }
  return rawKey;
}

function queryLocalityValues(requests) {
  const values = new Map();
  for (const request of requests) {
    const locality = String(request.locality ?? '').trim();
    const region = String(request.region ?? '').trim().toUpperCase();
    const key = requestLocalityKey(locality, region);
    if (!locality || !key || !/^[A-Z]{2}$/.test(region)) continue;
    const pairKey = `${region}|${key}`;
    const candidates = new Set([locality, ...(OFFICIAL_LOCALITIES_BY_KEY.get(pairKey) || [])]);
    for (const candidate of candidates) {
      values.set(`${region}|${candidate}`, [candidate, region]);
    }
  }
  return [...values.values()];
}

function registryNameKey(value) {
  const tokens = normalizeCompanyAddressKeyPart(value).split(' ').filter(Boolean);
  while (tokens.length && LEGAL_FORM_SUFFIXES.has(tokens[tokens.length - 1])) tokens.pop();
  return tokens.join(' ');
}

function sameLocality(left, right, region) {
  return localityKey(left, region) === requestLocalityKey(right, region);
}

function collectLookups(jobs, entries, now, limit) {
  const byKey = new Map();
  for (const job of jobs) {
    const companyName = String(job?.company || '').trim();
    const locality = String(job?.addressLocality || job?.city || job?.location || '').trim();
    const region = String(job?.addressRegion || job?.canton || '').trim().toUpperCase();
    const key = jobpostingAddressCacheKey(companyName, locality, region);
    if (!key || companyName.length < 3) continue;
    const cached = entries[key];
    if (cached?.checkedAt && now - Date.parse(cached.checkedAt) < JOBPOSTING_ADDRESS_CACHE_TTL_MS) continue;

    const resolved = resolveJobPostingStreetAddress(job, {
      addressLocality: locality,
      addressRegion: region,
      postalCode: job?.postalCode,
    });
    if (resolved.streetAddressSource !== 'to-enrich') continue;
    if (!byKey.has(key)) byKey.set(key, { key, companyName, locality, region });
  }
  return [...byKey.values()].slice(0, limit);
}

function buildLocationBatches(requests, batchSize = LOCATION_BATCH_SIZE) {
  const byLocation = new Map();
  for (const request of requests) {
    const region = String(request.region ?? '').trim().toUpperCase();
    const key = `${region}|${requestLocalityKey(request.locality, region)}`;
    if (!requestLocalityKey(request.locality, region)) continue;
    const group = byLocation.get(key) || [];
    group.push(request);
    byLocation.set(key, group);
  }
  const locations = [...byLocation.values()];
  const batches = [];
  for (let offset = 0; offset < locations.length; offset += batchSize) {
    batches.push(locations.slice(offset, offset + batchSize).flat());
  }
  return batches;
}

/** Query exact locality/canton literals so the endpoint can use RDF term indexes. */
function buildQuery(requests) {
  const values = queryLocalityValues(requests)
    .map(([locality, region]) => `(${JSON.stringify(locality)} ${JSON.stringify(region)})`)
    .join('\n    ');
  if (!values) throw new Error('Cannot query LINDAS without a canton-scoped locality.');
  return `
PREFIX schema: <http://schema.org/>
PREFIX admin: <https://schema.ld.admin.ch/>
SELECT ?locality ?region ?company ?registeredName ?street ?postalCode
WHERE {
  VALUES (?locality ?region) { ${values} }
  ?company a admin:ZefixOrganisation ;
    schema:legalName ?registeredName ;
    schema:address ?address .
  ?address schema:addressLocality ?locality ;
    schema:addressRegion ?region ;
    schema:streetAddress ?street .
  OPTIONAL { ?address schema:postalCode ?postalCode . }
}`;
}

async function queryLindas(requests) {
  const response = await fetch(LINDAS_ENDPOINT, {
    method: 'POST',
    headers: {
      'content-type': 'application/sparql-query; charset=utf-8',
      accept: 'application/sparql-results+json',
    },
    body: buildQuery(requests),
    signal: AbortSignal.timeout(QUERY_TIMEOUT_MS),
  });
  if (!response.ok) {
    const details = (await response.text()).slice(0, 400);
    throw new Error(`LINDAS returned HTTP ${response.status}${details ? `: ${details}` : ''}`);
  }
  const payload = await response.json();
  if (!Array.isArray(payload?.results?.bindings)) throw new Error('LINDAS returned an invalid SPARQL result.');
  return payload.results.bindings;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Retry one locality batch at a time; the caller never starts a parallel request. */
async function queryLindasWithRetry(requests, {
  query = queryLindas,
  sleep = delay,
  maxAttempts = QUERY_MAX_ATTEMPTS,
  retryDelaysMs = QUERY_RETRY_DELAYS_MS,
} = {}) {
  let lastError;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await query(requests);
    } catch (error) {
      lastError = error;
      if (attempt === maxAttempts) break;
      await sleep(retryDelaysMs[Math.min(attempt - 1, retryDelaysMs.length - 1)]);
    }
  }
  throw new Error(`LINDAS batch failed after ${maxAttempts} attempts: ${lastError?.message || 'unknown error'}`, {
    cause: lastError,
  });
}

function value(binding, key) {
  return String(binding?.[key]?.value || '').trim();
}

function isZefixSwissPostalCode(value) {
  // The LINDAS Zefix graph contains Swiss registered addresses only (4-digit
  // postcodes); JobPosting's shared validator also accepts 5-digit EU codes.
  return /^\d{4}$/.test(String(value ?? '').trim());
}

function addressMatchKey(name, locality, region) {
  const regionCode = String(region ?? '').trim().toUpperCase();
  return `${regionCode}|${localityKey(locality, regionCode)}|${name}`;
}

function requestAddressMatchKey(name, locality, region) {
  const regionCode = String(region ?? '').trim().toUpperCase();
  return `${regionCode}|${requestLocalityKey(locality, regionCode)}|${name}`;
}

function indexAddressBindings(bindings) {
  const index = new Map();
  for (const binding of bindings) {
    const name = registryNameKey(value(binding, 'registeredName'));
    const locality = value(binding, 'locality');
    const region = value(binding, 'region').toUpperCase();
    if (!name || !locality || !region) continue;
    const key = addressMatchKey(name, locality, region);
    const candidates = index.get(key) || [];
    candidates.push(binding);
    index.set(key, candidates);
  }
  return index;
}

function matchAddress(request, bindings, jobPostalCodes = new Set()) {
  const requestedName = registryNameKey(request.companyName);
  if (!requestedName) return { status: 'not-found', companyFound: false, ambiguous: false };
  const expectedKey = requestAddressMatchKey(requestedName, request.locality, request.region);
  const candidates = Array.isArray(bindings)
    ? bindings.filter((binding) => (
      registryNameKey(value(binding, 'registeredName')) === requestedName
      && registryNameKey(value(binding, 'registeredName')) !== ''
      && sameLocality(value(binding, 'locality'), request.locality, request.region)
      && value(binding, 'region').toUpperCase() === request.region
    ))
    : bindings.get(expectedKey) || [];
  const companies = new Map();
  for (const binding of candidates) {
    const companyUri = value(binding, 'company');
    if (!companyUri) continue;
    const rows = companies.get(companyUri) || [];
    rows.push(binding);
    companies.set(companyUri, rows);
  }
  if (companies.size === 0) return { status: 'not-found', companyFound: false, ambiguous: false };
  if (companies.size > 1) {
    return { status: 'ambiguous', companyFound: true, ambiguous: true, reason: 'multiple-companies' };
  }

  const addresses = new Map();
  let postalCodeConflict = false;
  for (const binding of companies.values().next().value) {
    const streetAddress = value(binding, 'street');
    const postalCode = value(binding, 'postalCode');
    if (!isZefixSwissPostalCode(postalCode)) continue;
    if (jobPostalCodes.size && !jobPostalCodes.has(postalCode)) {
      postalCodeConflict = true;
      continue;
    }
    if (!isSourceStreetAddress(streetAddress, request.locality)) continue;
    const key = `${streetAddress}|${postalCode}|${value(binding, 'locality')}|${value(binding, 'region')}`;
    addresses.set(key, { streetAddress, postalCode });
  }

  if (addresses.size === 0) {
    if (postalCodeConflict) {
      return { status: 'ambiguous', companyFound: true, ambiguous: true, reason: 'postal-code-conflict' };
    }
    return { status: 'address-unavailable', companyFound: true, ambiguous: false };
  }
  if (addresses.size > 1) {
    return { status: 'ambiguous', companyFound: true, ambiguous: true, reason: 'multiple-addresses' };
  }
  return {
    status: 'matched',
    companyFound: true,
    ambiguous: false,
    address: [...addresses.values()][0],
  };
}

function jobPostalCodeMap(jobs, requests) {
  const requestedKeys = new Set(requests.map(({ key }) => key));
  const result = new Map();
  for (const job of jobs) {
    const key = jobpostingAddressCacheKey(
      job?.company,
      job?.addressLocality || job?.city || job?.location,
      job?.addressRegion || job?.canton,
    );
    const postalCode = String(job?.postalCode || '').trim();
    if (!requestedKeys.has(key) || !/^\d{4,5}$/.test(postalCode)) continue;
    const values = result.get(key) || new Set();
    values.add(postalCode);
    result.set(key, values);
  }
  return result;
}

function cacheEntry(request, outcome, checkedAt) {
  return {
    status: outcome.status,
    source: 'zefix-lindas',
    companyName: request.companyName,
    ...(outcome.address || {}),
    addressLocality: request.locality,
    addressRegion: request.region,
    ...(outcome.reason ? { reason: outcome.reason } : {}),
    checkedAt,
  };
}

/** Process and persist each successful city batch before moving to the next one. */
async function processLookupBatches(requests, {
  entries = {},
  postalCodes = new Map(),
  queryBatch = (batch) => queryLindasWithRetry(batch),
  saveBatch = async () => {},
  checkedAt = () => new Date().toISOString(),
} = {}) {
  const nextEntries = { ...entries };
  const summary = {
    searchedCompanies: requests.length,
    companiesFound: 0,
    sameCityAddresses: 0,
    notFound: 0,
    ambiguous: 0,
    addressUnavailable: 0,
    failedBatches: 0,
    failedCompanies: 0,
    failedBatchDetails: [],
  };

  for (const batch of buildLocationBatches(requests)) {
    let bindings;
    try {
      bindings = await queryBatch(batch);
    } catch (error) {
      summary.failedBatches++;
      summary.failedCompanies += batch.length;
      summary.failedBatchDetails.push({
        localities: [...new Set(batch.map(({ locality }) => locality))],
        regions: [...new Set(batch.map(({ region }) => region))],
        error: error?.message || String(error),
      });
      continue;
    }

    const timestamp = checkedAt();
    const bindingsIndex = indexAddressBindings(bindings);
    for (const request of batch) {
      const outcome = matchAddress(request, bindingsIndex, postalCodes.get(request.key) || new Set());
      nextEntries[request.key] = cacheEntry(request, outcome, timestamp);
      if (outcome.companyFound) summary.companiesFound++;
      if (outcome.status === 'matched') summary.sameCityAddresses++;
      if (!outcome.companyFound) summary.notFound++;
      if (outcome.ambiguous) summary.ambiguous++;
      if (outcome.status === 'address-unavailable') summary.addressUnavailable++;
    }
    await saveBatch(nextEntries);
  }

  return { entries: nextEntries, summary };
}

function parseLimit(args) {
  const limitArg = args.find((arg) => arg.startsWith('--limit='));
  return Math.max(1, Math.min(500, Number(limitArg?.slice('--limit='.length) || 100)));
}

async function main({ args = process.argv.slice(2) } = {}) {
  const dryRun = args.includes('--dry-run');
  const limit = parseLimit(args);
  const jobs = loadJobs();
  const cacheEntries = readJobpostingAddressCache({ root: ROOT, filePath: CACHE_PATH });
  const requests = collectLookups(jobs, cacheEntries, Date.now(), limit);
  if (dryRun) {
    console.log(JSON.stringify({
      jobs: jobs.length,
      uncachedLookups: requests.length,
      localityBatches: buildLocationBatches(requests).length,
      limit,
      cache: path.relative(ROOT, CACHE_PATH),
    }, null, 2));
    return;
  }

  if (requests.length === 0) {
    console.log(JSON.stringify({
      searchedCompanies: 0,
      companiesFound: 0,
      sameCityAddresses: 0,
      notFound: 0,
      ambiguous: 0,
      failedBatches: 0,
      cache: path.relative(ROOT, CACHE_PATH),
    }, null, 2));
    return;
  }

  const lock = await withSingleFlightLockAsync(LINDAS_LOCK_PATH, async () => {
    const result = await processLookupBatches(requests, {
      entries: cacheEntries,
      postalCodes: jobPostalCodeMap(jobs, requests),
      saveBatch: (entries) => writeJsonAtomic(CACHE_PATH, {
        version: 1,
        source: 'Zefix via LINDAS',
        updatedAt: new Date().toISOString(),
        entries,
      }),
    });
    console.log(JSON.stringify({ ...result.summary, cache: path.relative(ROOT, CACHE_PATH) }, null, 2));
    return result.summary;
  });
  if (!lock.acquired) throw new Error('A Zefix/LINDAS address refresh is already running; no request was sent.');
  if (lock.value.failedCompanies) {
    throw new Error(`${lock.value.failedCompanies} lookup(s) remain unresolved after retrying their LINDAS batch.`);
  }
}

export {
  buildLocationBatches,
  buildQuery,
  collectLookups,
  jobPostalCodeMap,
  matchAddress,
  processLookupBatches,
  queryLindasWithRetry,
  registryNameKey,
  sameLocality,
};

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
