#!/usr/bin/env node
/** Refresh missing same-city employer addresses from the public Zefix LINDAS dataset. */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
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
import { inferAnyCanton } from './lib/target-swiss-locations.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CACHE_PATH = path.resolve(ROOT, process.env.JOBPOSTING_ADDRESS_CACHE_PATH || DEFAULT_JOBPOSTING_ADDRESS_CACHE);
const LINDAS_ENDPOINT = 'https://lindas.admin.ch/query';
const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const limitArg = args.find((arg) => arg.startsWith('--limit='));
const limit = Math.max(1, Math.min(500, Number(limitArg?.slice('--limit='.length) || 100)));

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

function registryNameKey(value) {
  return normalizeCompanyAddressKeyPart(value)
    .replace(/\b(?:ag|sa|gmbh|sarl|sagl|ltd|limited|inc|incorporated|corp|corporation|kg|snc|sas|schweiz|switzerland|suisse|svizzera)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function sameLocality(left, right) {
  return normalizeCompanyAddressKeyPart(left) === normalizeCompanyAddressKeyPart(right);
}

function collectLookups(jobs, entries, now) {
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

function buildQuery(requests) {
  const values = requests.map(({ companyName }) => JSON.stringify(registryNameKey(companyName))).join(' ');
  return `
PREFIX schema: <http://schema.org/>
PREFIX admin: <https://schema.ld.admin.ch/>
SELECT ?requestedName ?registeredName ?street ?postalCode ?locality
WHERE {
  VALUES ?requestedName { ${values} }
  ?company a admin:ZefixOrganisation ;
    schema:name ?registeredName ;
    schema:address ?address .
  ?address schema:streetAddress ?street ;
    schema:addressLocality ?locality .
  OPTIONAL { ?address schema:postalCode ?postalCode . }
  FILTER (CONTAINS(LCASE(STR(?registeredName)), LCASE(?requestedName)))
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
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`LINDAS returned HTTP ${response.status}`);
  const payload = await response.json();
  return payload?.results?.bindings || [];
}

function value(binding, key) {
  return String(binding?.[key]?.value || '').trim();
}

function matchAddress(request, bindings, jobPostalCodes) {
  const requestedName = registryNameKey(request.companyName);
  const candidates = bindings.filter((binding) => (
    registryNameKey(value(binding, 'registeredName')) === requestedName
    && sameLocality(value(binding, 'locality'), request.locality)
    && inferAnyCanton(value(binding, 'locality')) === request.region
    && isSourceStreetAddress(value(binding, 'street'), request.locality)
  ));
  const unique = new Map();
  for (const binding of candidates) {
    const streetAddress = value(binding, 'street');
    const postalCode = value(binding, 'postalCode');
    const observedPostal = jobPostalCodes.get(request.key);
    if (!/^\d{4,5}$/.test(postalCode)) continue;
    if (observedPostal && postalCode !== observedPostal) continue;
    const key = `${streetAddress}|${postalCode}|${request.locality}|${request.region}`;
    unique.set(key, { streetAddress, postalCode });
  }
  if (unique.size !== 1) return null;
  const address = [...unique.values()][0];
  return {
    status: 'matched',
    source: 'zefix-lindas',
    companyName: request.companyName,
    streetAddress: address.streetAddress,
    postalCode: address.postalCode,
    addressLocality: request.locality,
    addressRegion: request.region,
    checkedAt: new Date().toISOString(),
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
    if (requestedKeys.has(key) && /^\d{4,5}$/.test(postalCode)) result.set(key, postalCode);
  }
  return result;
}

const jobs = loadJobs();
const nowMs = Date.now();
const cacheEntries = readJobpostingAddressCache({ root: ROOT, filePath: CACHE_PATH });
const requests = collectLookups(jobs, cacheEntries, nowMs);
if (dryRun) {
  console.log(JSON.stringify({ jobs: jobs.length, uncachedLookups: requests.length, limit, cache: path.relative(ROOT, CACHE_PATH) }, null, 2));
} else {
  await withSingleFlightLockAsync(`${CACHE_PATH}.lock`, async () => {
    const entries = { ...cacheEntries };
    const postalCodes = jobPostalCodeMap(jobs, requests);
    let matched = 0;
    for (let offset = 0; offset < requests.length; offset += 10) {
      const batch = requests.slice(offset, offset + 10);
      const bindings = await queryLindas(batch);
      for (const request of batch) {
        const result = matchAddress(request, bindings, postalCodes);
        entries[request.key] = result || {
          status: 'not-found-or-ambiguous',
          source: 'zefix-lindas',
          companyName: request.companyName,
          addressLocality: request.locality,
          addressRegion: request.region,
          checkedAt: new Date().toISOString(),
        };
        if (result) matched++;
      }
      if (offset + 10 < requests.length) await new Promise((resolve) => setTimeout(resolve, 250));
    }
    writeJsonAtomic(CACHE_PATH, {
      version: 1,
      source: 'Zefix via LINDAS',
      updatedAt: new Date().toISOString(),
      entries,
    });
    console.log(JSON.stringify({ jobs: jobs.length, queried: requests.length, matched, cache: path.relative(ROOT, CACHE_PATH) }, null, 2));
  });
}
