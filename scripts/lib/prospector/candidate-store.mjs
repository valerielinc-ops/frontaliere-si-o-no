/**
 * The candidate queue — one JSON document plus an append-only ledger.
 *
 * Deliberately a file, not a database: the queue has to be reviewable in a
 * pull request and replayable from a checkout, and at the scale that matters
 * (tens of thousands of employers) a keyed object costs nothing to load.
 *
 * A candidate advances through states, and each stage script only ever reads
 * the states it can act on:
 *
 *   new         -> discovered, nothing resolved yet
 *   resolved    -> employer domain known and verified
 *   traced      -> careers trail followed; platform or self-hosted known
 *   dead        -> no site, no careers page, or no vacancies anywhere
 *   synthesized -> a crawler exists for it
 *   validated   -> extraction graded against the live page
 *   promoted    -> graded good; eligible for the promotion gate
 *   promoting   -> shipped into an OPEN promotion PR, not merged yet
 *   awaiting_first_crawl -> promotion PR merged; waiting for a fresh non-empty jobs slice
 *   production  -> first fresh public jobs slice verified after the merge
 *   rejected    -> measured and dismissed, with a reason
 *
 * The ledger records every transition so a later run can answer "why is this
 * employer not in production" without re-crawling anything.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { CANDIDATES_PATH, LEDGER_PATH } from './config.mjs';
import { normalizeHost, registrableDomain, tenantLabel } from './registrable.mjs';
import { normalizeCompanyName } from './coverage.mjs';
import { loadRegistry } from './platform-registry.mjs';

/** @typedef {'new'|'resolved'|'traced'|'dead'|'synthesized'|'validated'|'promoted'|'promoting'|'awaiting_first_crawl'|'production'|'rejected'} CandidateStatus */

/**
 * Stable key for an employer. Use an employer-owned domain when we can identify
 * one; a shared ATS/vendor host or a URL containing a tenant path is not an
 * employer identity. Otherwise use the normalised name plus town, which keeps
 * two "Ristorante Centrale" in different villages apart.
 *
 * @param {{ name?: string, domain?: string, city?: string }} c
 * @returns {string}
 */
export function candidateKey(c) {
  // Do not reduce a candidate URL to its registrable host here: that discards
  // a shared ATS tenant path and can make different employers share one key.
  const employerDomain = candidateEmployerDomain(c?.domain);
  if (employerDomain) return employerDomain;
  const n = normalizeCompanyName(c.name || '').replace(/\s+/g, '-');
  const city = String(c.city || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return [n, city].filter(Boolean).join('@') || `unknown-${Math.abs(hash(JSON.stringify(c)))}`;
}

let platformEntriesByDomain;

function platformEntryForDomain(domain) {
  if (!platformEntriesByDomain) {
    const registry = loadRegistry();
    platformEntriesByDomain = new Map(Object.entries(registry.platforms || {})
      .map(([key, platform]) => [registrableCandidateDomain(platform?.domain || key), platform])
      .filter(([registrable]) => Boolean(registrable)));
  }
  return platformEntriesByDomain.get(domain);
}

function isKnownSharedPlatformDomain(domain) {
  const platform = platformEntryForDomain(domain);
  // A candidate registry entry is deliberately unproven: it may be a vendor
  // host seen only once, so reducing it to an employer key can merge unrelated
  // tenants before the registry has enough evidence to classify the host.
  // Treat every non-rejected registry entry as shared until an evidence-bound
  // employer identity is available on the candidate itself.
  return Boolean(platform && platform.status !== 'rejected');
}

function candidateEmployerDomain(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return '';
  let url;
  try {
    url = new URL(raw.startsWith('//') ? `https:${raw}` : raw.includes('://') ? raw : `https://${raw}`);
  } catch {
    return '';
  }
  if (!/^https?:$/.test(url.protocol) || url.pathname !== '/' || url.search || url.hash) return '';
  const domain = registrableCandidateDomain(url.hostname);
  return domain && !isKnownSharedPlatformDomain(domain) ? domain : '';
}

const GENERIC_TENANT_NAMES = new Set([
  'job', 'jobs', 'career', 'careers', 'career page', 'careers page', 'hiring', 'recruiting',
  'vacancy', 'vacancies', 'apply', 'application', 'applications', 'board', 'boards',
  'job board', 'job boards', 'jobboard', 'jobboards', 'company', 'home', 'www', 'api', 'ats',
  'wd1', 'wd2', 'wd3', 'wd4', 'wd5', 'wd6', 'wd10', 'fa', 'ocs',
  'eu', 'us', 'uk', 'ca', 'de', 'apac', 'emea', 'global', 'ch',
]);

/**
 * `prospect-expand` supplies `<tenant label>@<platform domain>` as a candidate
 * key. That is a valid identity for a tenant on its own subdomain (for example
 * `recruitingapp-2761@umantis.com`), but a shared/path ATS host can produce the
 * same label for every tenant (`jobs@smartrecruiters.com`). Only trust this
 * generated key when the tenant host proves a pathless, single-label
 * subdomain belonging to that platform.
 */
function hasVerifiedSubdomainTenantKey(suppliedKey, candidate, source) {
  if (!String(source || '').startsWith('tenant:')) return true;
  // Plain keys still occur in older/general tenant-source updates. Once a key
  // uses the composed `label@...` form, however, it must prove its platform and
  // tenant host instead of bypassing the host check merely because it has `@`.
  if (!suppliedKey.includes('@')) return true;
  const separator = suppliedKey.lastIndexOf('@');
  if (separator <= 0 || separator === suppliedKey.length - 1
    || suppliedKey.indexOf('@') !== separator) return false;

  const keyLabel = suppliedKey.slice(0, separator);
  const keyPlatform = suppliedKey.slice(separator + 1);
  if (GENERIC_TENANT_NAMES.has(normalizeCompanyName(keyLabel))) return false;
  const sourcePlatform = String(source).slice('tenant:'.length);
  const platform = registrableCandidateDomain(candidate?.platform || sourcePlatform);
  const keyPlatformDomain = registrableCandidateDomain(keyPlatform);
  if (!platform || keyPlatform !== platform || keyPlatformDomain !== platform
    || registrableCandidateDomain(sourcePlatform) !== platform) return false;

  const platformEntry = platformEntryForDomain(platform);
  if (!platformEntry || !['subdomain', 'mixed'].includes(platformEntry.tenantShape)) return false;

  const rawTenantHost = String(candidate?.tenantHost || '').trim();
  if (!rawTenantHost) return false;
  let tenantUrl;
  try {
    tenantUrl = new URL(rawTenantHost.startsWith('//') ? `https:${rawTenantHost}`
      : rawTenantHost.includes('://') ? rawTenantHost : `https://${rawTenantHost}`);
  } catch {
    return false;
  }
  if (!/^https?:$/.test(tenantUrl.protocol) || tenantUrl.pathname !== '/'
    || tenantUrl.search || tenantUrl.hash) return false;

  const host = normalizeHost(tenantUrl.hostname);
  const hostPlatform = registrableCandidateDomain(host);
  const hostPrefix = host && host.endsWith(`.${platform}`) ? host.slice(0, -(platform.length + 1)) : '';
  if (platformEntry.hostEmployerUnknown?.[host] === true) return false;
  const hostEmployers = platformEntry.hostEmployers?.[host];
  if (!Array.isArray(hostEmployers) || !hostEmployers.length) return false;
  const verifiedOwners = hostEmployers.map(registrableCandidateDomain);
  if (verifiedOwners.some((owner) => !owner || !owner.includes('.'))
    || new Set(verifiedOwners).size !== 1) return false;
  const candidateDomain = candidateIdentityDomain(candidate);
  if (candidateDomain && candidateDomain !== verifiedOwners[0]) return false;
  return hostPlatform === platform && host !== platform
    && hostPrefix && !hostPrefix.includes('.') && tenantLabel(host) === keyLabel;
}

function hasEmployerSpecificTenantName(candidate) {
  const employerName = normalizeCompanyName(candidate?.name || '');
  const tenantHostLabel = normalizeCompanyName(tenantLabel(candidate?.tenantHost || ''));
  return Boolean(employerName && employerName !== tenantHostLabel && !GENERIC_TENANT_NAMES.has(employerName));
}

function subdomainTenantFallbackKey(candidate, source) {
  if (!String(source || '').startsWith('tenant:')) return '';
  const sourcePlatform = String(source).slice('tenant:'.length);
  const platform = registrableCandidateDomain(candidate?.platform || sourcePlatform);
  if (!platform || registrableCandidateDomain(sourcePlatform) !== platform) return '';
  const platformEntry = platformEntryForDomain(platform);
  if (!['subdomain', 'mixed'].includes(platformEntry?.tenantShape)) return '';

  const rawTenantHost = typeof candidate?.tenantHost === 'string' ? candidate.tenantHost.trim() : '';
  if (!rawTenantHost) return '';
  let tenantUrl;
  try {
    tenantUrl = new URL(rawTenantHost.startsWith('//') ? `https:${rawTenantHost}`
      : rawTenantHost.includes('://') ? rawTenantHost : `https://${rawTenantHost}`);
  } catch {
    return '';
  }
  if (!/^https?:$/.test(tenantUrl.protocol) || tenantUrl.pathname !== '/'
    || tenantUrl.search || tenantUrl.hash) return '';

  const host = normalizeHost(tenantUrl.hostname);
  const hostPrefix = host && host.endsWith(`.${platform}`) ? host.slice(0, -(platform.length + 1)) : '';
  if (registrableCandidateDomain(host) !== platform || !hostPrefix) return '';
  const hostLabels = hostPrefix.split('.').map(normalizeCompanyName);
  if (!hostLabels.some((label) => label && !GENERIC_TENANT_NAMES.has(label))) return '';
  // Localised Umantis recruitingapp hosts have a stable tenant id even when
  // the registry has not yet verified the employer behind that host.
  const stableUmantisTenantHost = platform === 'umantis.com'
    && /^recruitingapp-\d+(?:\.de)?$/.test(hostPrefix);
  if (platformEntry.hostEmployerUnknown?.[host] === true && !stableUmantisTenantHost) return '';
  const owners = platformEntry.hostEmployers?.[host];
  if (Array.isArray(owners) && owners.length) {
    const verifiedOwners = owners.map(registrableCandidateDomain);
    if (verifiedOwners.some((owner) => !owner || !owner.includes('.'))
      || new Set(verifiedOwners).size !== 1) return '';
  } else if (!stableUmantisTenantHost) {
    // Unknown hosts on a mixed platform can still be shared front doors
    // (`api.vendor.com`, `ats.vendor.com`). Their hostname alone cannot name
    // an employer. Umantis tenant IDs have a stable, provider-specific shape.
    return '';
  }
  return `tenant-host-${host.replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}`;
}

function normalizeTenantPathSegment(value) {
  let decoded = String(value || '');
  try { decoded = decodeURIComponent(decoded); } catch { /* preserve malformed escapes */ }
  return decoded.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function pathTenantFallbackKey(candidate, source) {
  if (!String(source || '').startsWith('tenant:')) return '';
  const sourcePlatform = String(source).slice('tenant:'.length);
  const platform = registrableCandidateDomain(candidate?.platform || sourcePlatform);
  if (!platform || registrableCandidateDomain(sourcePlatform) !== platform) return '';

  const platformEntry = platformEntryForDomain(platform);
  const rawTenantHost = typeof candidate?.tenantHost === 'string' ? candidate.tenantHost.trim() : '';
  let expectedHost = '';
  if (rawTenantHost) {
    try {
      const tenantUrl = new URL(rawTenantHost.startsWith('//') ? `https:${rawTenantHost}`
        : rawTenantHost.includes('://') ? rawTenantHost : `https://${rawTenantHost}`);
      if (!/^https?:$/.test(tenantUrl.protocol)) return '';
      expectedHost = normalizeHost(tenantUrl.hostname);
    } catch {
      return '';
    }
  }
  // The enumerator supplies the tenant host separately from the candidate URL.
  // On shared ATS hosts, the URL path carries the employer tenant id; on
  // subdomain hosts, routes such as `/Jobs/All` are merely listing paths.
  const pathSources = rawTenantHost ? [rawTenantHost, candidate?.careersUrl] : [candidate?.careersUrl];
  for (const raw of pathSources) {
    if (typeof raw !== 'string' || !raw.trim()) continue;
    let url;
    try {
      url = new URL(raw.startsWith('//') ? `https:${raw}` : raw.includes('://') ? raw : `https://${raw}`);
    } catch {
      continue;
    }
    const host = normalizeHost(url.hostname);
    if (!/^https?:$/.test(url.protocol) || registrableCandidateDomain(host) !== platform
      || (expectedHost && host !== expectedHost)) continue;
    const owners = platformEntry?.hostEmployers?.[host];
    const distinctOwners = Array.isArray(owners)
      ? new Set(owners.map(registrableCandidateDomain).filter((owner) => owner && owner.includes('.')))
      : new Set();
    const hostObserved = platformEntry?.hostSamples?.includes(host)
      || Object.prototype.hasOwnProperty.call(platformEntry?.hostHits || {}, host)
      || Object.prototype.hasOwnProperty.call(platformEntry?.hostEmployerUnknown || {}, host)
      || Object.prototype.hasOwnProperty.call(platformEntry?.hostEmployers || {}, host);
    const hostCarriesTenantPaths = platformEntry?.tenantShape === 'shared'
      || (platformEntry?.tenantShape === 'mixed' && distinctOwners.size > 1);
    if (!hostObserved || !hostCarriesTenantPaths) continue;
    const pathSegment = url.pathname.split('/').filter(Boolean)[0];
    if (!pathSegment) continue;

    const slug = normalizeTenantPathSegment(pathSegment);
    const hostScope = host.replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    if (slug && hostScope) return `tenant-${slug}@${hostScope}`;
  }
  return '';
}

function normalizeIdentityCity(value) {
  return String(value || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function identityGroupKey(candidate) {
  const name = normalizeCompanyName(candidate?.name || '').replace(/\s+/g, ' ').trim();
  const city = normalizeIdentityCity(candidate?.city);
  return name && city ? `${name}@${city}` : '';
}

function inferredLedgerPhase() {
  const script = path.basename(process.argv[1] || '');
  return script.match(/^prospect-(discover|trace|expand|synthesize|validate|promote)\.mjs$/)?.[1] || 'unknown';
}

function currentLedgerContext() {
  const runAttemptRaw = process.env.GITHUB_RUN_ATTEMPT || process.env.PROSPECTOR_RUN_ATTEMPT || '1';
  const runAttempt = Number.parseInt(runAttemptRaw, 10);
  return {
    runId: String(process.env.GITHUB_RUN_ID || process.env.PROSPECTOR_RUN_ID || LOCAL_RUN_ID),
    runAttempt: Number.isSafeInteger(runAttempt) && runAttempt > 0 ? runAttempt : 1,
    phase: inferredLedgerPhase(),
    disabled: false,
    file: undefined,
  };
}

/** Begin a ledger scope for one Prospector stage. */
export function startLedgerPhase(phase, options = {}) {
  const current = currentLedgerContext();
  activeLedgerContext = {
    ...current,
    ...options,
    phase: String(phase || current.phase),
    runId: String(options.runId || current.runId),
    runAttempt: Number(options.runAttempt || current.runAttempt),
    disabled: options.dryRun === true,
    file: options.ledgerFile,
    startedAtMs: Date.now(),
  };
  appendLedger({ eventType: 'phase_started', at: new Date(activeLedgerContext.startedAtMs).toISOString() });
  if (!ledgerExitHookInstalled) {
    ledgerExitHookInstalled = true;
    process.once('exit', (code) => finishLedgerPhase(code ? 'failed' : 'complete'));
  }
  return { phase: activeLedgerContext.phase, startedAtMs: activeLedgerContext.startedAtMs };
}

/** Finish the current ledger scope and record its bounded run outcome. */
export function finishLedgerPhase(outcome = 'complete', details = {}) {
  if (!activeLedgerContext) return;
  const context = activeLedgerContext;
  appendLedger({
    eventType: 'phase_finished',
    at: new Date().toISOString(),
    outcome: String(outcome || 'complete'),
    durationMs: Math.max(0, Date.now() - context.startedAtMs),
    ...(Number.isSafeInteger(details?.inputCount) ? { inputCount: details.inputCount } : {}),
    ...(Number.isSafeInteger(details?.successCount) ? { successCount: details.successCount } : {}),
    ...(Number.isSafeInteger(details?.retryCount) ? { retryCount: details.retryCount } : {}),
  });
  activeLedgerContext = null;
}

/** Record an attempt even when the candidate status does not change. */
export function recordCandidateAttempt(key, { outcome, reasonCode, reason } = {}, file) {
  appendLedger({
    eventType: 'candidate_attempt',
    key,
    outcome: String(outcome || 'unknown'),
    ...(reasonCode ? { reasonCode: String(reasonCode) } : {}),
    ...(reason ? { reason: String(reason).slice(0, 300) } : {}),
    at: new Date().toISOString(),
  }, file);
}

/** @param {string} s */
function hash(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) { h = (h * 31 + s.charCodeAt(i)) | 0; }
  return h;
}

const STORE_VERSION = 2;

/**
 * Rejected candidates are terminal verdicts, so their full diagnostic record
 * may age out without making the same key eligible again. The inventory is
 * deliberately capped: it is a dedupe guard, not a second diagnostic store.
 */
export const MAX_REJECTED_TOMBSTONES = 10_000;

/**
 * A trace failure caused by transport or source discovery is not proof that
 * the employer has no careers surface. Keep the candidate in `new` and let a
 * later run retry it instead of turning one outage into a 90-day tombstone.
 */
const RETRYABLE_TRACE_REASON_RX = /(?:sito|dominio|pagina|rete|host|dns|timeout|http|fetch).*(?:irraggiungibile|non risolto|non raggiungibile|tempor|errore|blocc|timeout)|(?:irraggiungibile|non raggiungibile|timeout)/i;
const STAGE_RETRY_DELAYS_DAYS = [1, 3, 7, 14, 30];
const MAX_SYNTHESIS_RETRIES = 5;
const DOMAIN_RETRY_FRESH_OBSERVATION_AFTER = 4;
const SECO_SIGNAL_FIELDS = new Set(['adCount', 'sampleTitles', 'applyHosts']);
const SECO_IDENTITY_FIELDS = new Set(['secoEmployerName']);
const TRACE_RETRY_EVIDENCE_FIELDS = ['name', 'domain', 'careersUrl', 'city', 'zip', 'country'];
const TRACE_RETRY_DISCOVERY_SOURCES = new Set(['own', 'seco', 'osm', 'web']);
const TRACE_RETRY_EVIDENCE_FIELDS_BY_SOURCE = new Map([
  ['own', new Set()],
  ['seco', new Set(['name', 'domain', 'city', 'zip', 'country'])],
  ['osm', new Set(['name', 'domain', 'city', 'country'])],
  // Common Crawl's company label is only a host fragment; its actionable
  // evidence is the employer host and careers URL.
  ['web', new Set(['domain', 'careersUrl', 'country'])],
]);
const TRACE_EVIDENCE_SNAPSHOT_VERSION = 2;

const EMPTY = { version: STORE_VERSION, updatedAt: null, candidates: {}, rejectedTombstones: {}, candidateAliases: {} };
const TOMBSTONE_COUNTS = new WeakMap();
const IDENTITY_INDEXES = new WeakMap();
// One bounded legacy recovery batch per in-memory store; a later process load
// gets a fresh store and can continue with the next candidates.
const LEGACY_RECOVERY_BATCHES = new WeakSet();

const LOCAL_RUN_ID = `local-${process.pid}-${Math.floor(Date.now() / 1000)}`;
let activeLedgerContext = null;
let ledgerExitHookInstalled = false;

/** @param {unknown} value */
function isObjectMap(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function aliasesFor(store) {
  if (!isObjectMap(store.candidateAliases)) store.candidateAliases = {};
  return store.candidateAliases;
}

/** Resolve a historical key retained by cross-source candidate reconciliation. */
export function resolveCandidateKey(store, key) {
  let resolved = String(key || '');
  const aliases = aliasesFor(store);
  const visited = new Set();
  while (aliases[resolved] && !visited.has(resolved)) {
    visited.add(resolved);
    resolved = String(aliases[resolved]);
  }
  return resolved;
}

export function candidateForKey(store, key) {
  return store.candidates[resolveCandidateKey(store, key)] || null;
}

function identityIndexFor(store) {
  let index = IDENTITY_INDEXES.get(store);
  if (index) return index;
  index = new Map();
  for (const [key, candidate] of Object.entries(store.candidates || {})) {
    const group = identityGroupKey(candidate);
    if (!group || resolveCandidateKey(store, key) !== key) continue;
    if (!index.has(group)) index.set(group, new Set());
    index.get(group).add(key);
  }
  IDENTITY_INDEXES.set(store, index);
  return index;
}

function addToIdentityIndex(store, key, candidate) {
  const group = identityGroupKey(candidate);
  if (!group) return;
  const index = identityIndexFor(store);
  if (!index.has(group)) index.set(group, new Set());
  index.get(group).add(key);
}

function distinctSources(candidates) {
  return new Set(candidates.flatMap((candidate) => Array.isArray(candidate?.sources) ? candidate.sources : [])).size;
}

function registrableCandidateDomain(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return '';
  let host = '';
  try {
    const url = new URL(raw.startsWith('//') ? `https:${raw}` : raw.includes('://') ? raw : `https://${raw}`);
    if (!/^https?:$/.test(url.protocol)) return '';
    host = normalizeHost(url.hostname);
  } catch {
    return '';
  }
  if (!host.includes('.') || /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host)) return '';
  const domain = registrableDomain(host);
  if (!domain.includes('.')) return '';
  // For a known multi-label public suffix, adding one label produces a new
  // registrable domain (for example `candidate.com.co`). A real eTLD+1 such
  // as `acme.co` or `acme.co.uk` stays unchanged, so bare suffixes fail here.
  return registrableDomain(`candidate.${domain}`) === domain ? domain : '';
}

function candidateIdentityDomain(candidate) {
  const explicitDomain = candidateEmployerDomain(candidate?.domain);
  if (explicitDomain) return explicitDomain;

  // Domainless records can prove their employer identity through a company
  // homepage. Careers URLs may point to a third-party ATS and are not identity
  // evidence, even when their host happens to resemble the employer's name.
  const urlFields = ['website', 'homepage', 'homePage', 'homepageUrl', 'homeUrl'];
  const urls = urlFields.map((field) => candidate?.[field])
    .filter((value) => typeof value === 'string' && value.trim());
  if (!urls.length) return '';
  const domains = urls.map((url) => {
    const domain = registrableCandidateDomain(url);
    return domain && !isKnownSharedPlatformDomain(domain) ? domain : '';
  });
  if (domains.some((domain) => !domain)) return '';
  const unique = new Set(domains);
  return unique.size === 1 ? [...unique][0] : '';
}

function candidateDomains(candidates) {
  const domains = candidates.map(candidateIdentityDomain);
  // A missing/invalid domain is unknown evidence, not evidence that the
  // record belongs to the one known domain in the group.
  if (domains.some((domain) => !domain)) return new Set();
  return new Set(domains);
}

function normalizedSecoSignalList(value) {
  return Array.isArray(value)
    ? value.map((item) => String(item ?? '').trim().replace(/\s+/g, ' ').toLowerCase())
      .filter(Boolean).sort()
    : [];
}

function hasFreshSecoEvidence(candidate, incoming) {
  const incomingAdCount = Number(incoming?.adCount);
  if (!Number.isSafeInteger(incomingAdCount) || incomingAdCount <= 0) return false;

  const currentAdCount = Number(candidate?.adCount);
  if (!Number.isSafeInteger(currentAdCount) || currentAdCount !== incomingAdCount) return true;

  return ['sampleTitles', 'applyHosts'].some((field) => {
    if (!Array.isArray(incoming?.[field])) return false;
    const incomingSignals = normalizedSecoSignalList(incoming[field]);
    if (!incomingSignals.length) return false;
    return JSON.stringify(normalizedSecoSignalList(candidate?.[field])) !== JSON.stringify(incomingSignals);
  });
}

/** @param {Record<string, any>} candidate */
function synthesisSeedFor(candidate) {
  if (candidate?.careersUrl) return String(candidate.careersUrl);
  if (candidate?.tenantHost) return `https://${candidate.tenantHost}/`;
  if (candidate?.domain) return `https://${candidate.domain}/`;
  return '';
}

/** @param {Record<string, any>} candidate */
function recordSourceObservation(candidate, source, at) {
  const current = isObjectMap(candidate.sourceSeenAt) ? candidate.sourceSeenAt : {};
  candidate.sourceSeenAt = { ...current, [source]: at };
}

/**
 * Snapshot only evidence TRACE can use to resolve or directly visit an
 * employer. Source timestamps are intentionally excluded: recurring discovery
 * runs must not make an identical name/location guess look newly actionable.
 *
 * @param {Record<string, any>} candidate
 * @returns {Record<string, any>}
 */
function traceEvidenceSnapshot(candidate) {
  const evidence = Object.fromEntries(TRACE_RETRY_EVIDENCE_FIELDS.map((field) => [
    field,
    normalizeTraceEvidenceField(field, candidate?.[field]),
  ]));
  const sourceSeenAt = isObjectMap(candidate?.sourceSeenAt) ? Object.keys(candidate.sourceSeenAt) : [];
  evidence.version = TRACE_EVIDENCE_SNAPSHOT_VERSION;
  evidence.sources = [...new Set([
    ...(Array.isArray(candidate?.sources) ? candidate.sources : []),
    ...sourceSeenAt,
  ].filter((source) => TRACE_RETRY_DISCOVERY_SOURCES.has(source)))].sort();
  return evidence;
}

/** @param {string} field @param {unknown} rawValue */
function normalizeTraceEvidenceField(field, rawValue) {
  const value = String(rawValue ?? '').trim().replace(/\s+/g, ' ');
  if (field === 'domain') return value ? registrableDomain(value) : '';
  if (field === 'careersUrl') {
    if (!value) return '';
    try {
      const url = new URL(value);
      url.hash = '';
      // URL canonicalizes scheme/host while preserving case-sensitive path
      // and query components, which may distinguish a different careers page.
      return url.toString();
    } catch {
      return value;
    }
  }
  return value.toLowerCase();
}

/** @param {unknown} value */
function isTraceEvidenceSnapshot(value) {
  if (!isObjectMap(value)
    || value.version !== TRACE_EVIDENCE_SNAPSHOT_VERSION
    || !TRACE_RETRY_EVIDENCE_FIELDS.every((field) => typeof value[field] === 'string')
    || !Array.isArray(value.sources)
    || !value.sources.every((source) => typeof source === 'string' && TRACE_RETRY_DISCOVERY_SOURCES.has(source))) {
    return false;
  }
  const canonicalSources = [...new Set(value.sources)].sort();
  return TRACE_RETRY_EVIDENCE_FIELDS.every((field) => value[field] === normalizeTraceEvidenceField(field, value[field]))
    && JSON.stringify(value.sources) === JSON.stringify(canonicalSources);
}

/**
 * @param {Record<string, any>} candidate
 * @param {Record<string, any>} snapshot
 */
function matchesTraceEvidenceSnapshot(candidate, snapshot) {
  const current = traceEvidenceSnapshot(candidate);
  return TRACE_RETRY_EVIDENCE_FIELDS.every((field) => current[field] === snapshot[field])
    && JSON.stringify(current.sources) === JSON.stringify([...snapshot.sources].sort());
}

/** @param {Record<string, any>} candidate */
function hasExhaustedDomainResolution(candidate) {
  return Number(candidate?.traceAttempts) >= DOMAIN_RETRY_FRESH_OBSERVATION_AFTER
    && String(candidate?.reason || '') === 'dominio non risolto';
}

/** @param {ReturnType<typeof loadCandidates>} store */
function tombstonesFor(store) {
  if (!isObjectMap(store.rejectedTombstones)) {
    store.rejectedTombstones = {};
    TOMBSTONE_COUNTS.set(store.rejectedTombstones, 0);
  }
  return store.rejectedTombstones;
}

/** @param {Record<string, any>} tombstones */
function tombstoneCount(tombstones) {
  const known = TOMBSTONE_COUNTS.get(tombstones);
  if (known !== undefined) return known;
  const count = Object.keys(tombstones).length;
  TOMBSTONE_COUNTS.set(tombstones, count);
  return count;
}

/** @param {Record<string, any>} candidate */
function rejectionDate(candidate) {
  return String(candidate.rejectedAt || candidate.updatedAt || candidate.firstSeenAt || new Date().toISOString());
}

function normalizeTenantCoordinate(value) {
  const tenantHost = normalizeHost(value?.tenantHost || '');
  if (!tenantHost || !tenantHost.includes('.')) return null;
  const rawPath = String(value?.tenantPath || '').trim();
  let tenantPath = '';
  if (rawPath) {
    tenantPath = normalizeTenantPathSegment(rawPath.replace(/^\/+|\/+$/g, '').split('/')[0]);
  }
  return { tenantHost, ...(tenantPath ? { tenantPath } : {}) };
}

function tenantCoordinate(candidate) {
  const rawTenantHost = String(candidate?.tenantHost || '').trim();
  const rawCareersUrl = String(candidate?.careersUrl || '').trim();
  const raw = rawTenantHost || rawCareersUrl;
  if (!raw) return null;
  let url;
  try {
    url = new URL(raw.startsWith('//') ? `https:${raw}` : raw.includes('://') ? raw : `https://${raw}`);
  } catch {
    return null;
  }
  if (!/^https?:$/.test(url.protocol)) return null;
  const host = normalizeHost(url.hostname);
  if (!host || !host.includes('.')) return null;

  const platform = platformEntryForDomain(registrableCandidateDomain(host));
  const owners = platform?.hostEmployers?.[host];
  const distinctOwners = Array.isArray(owners)
    ? new Set(owners.map(registrableCandidateDomain).filter((owner) => owner && owner.includes('.')))
    : new Set();
  const pathCarriesTenant = platform?.tenantShape === 'shared'
    || (platform?.tenantShape === 'mixed' && distinctOwners.size > 1);
  let tenantPath = '';
  if (pathCarriesTenant) {
    const pathSources = [rawTenantHost, rawCareersUrl];
    for (const pathSource of pathSources) {
      if (!pathSource) continue;
      let pathUrl;
      try {
        pathUrl = new URL(pathSource.startsWith('//') ? `https:${pathSource}`
          : pathSource.includes('://') ? pathSource : `https://${pathSource}`);
      } catch {
        continue;
      }
      if (normalizeHost(pathUrl.hostname) !== host) continue;
      const segment = pathUrl.pathname.split('/').filter(Boolean)[0];
      if (!segment) continue;
      tenantPath = normalizeTenantPathSegment(segment);
      break;
    }
  }
  return normalizeTenantCoordinate({ tenantHost: host, tenantPath });
}

function sameTenantCoordinate(left, right) {
  const a = normalizeTenantCoordinate(left);
  const b = normalizeTenantCoordinate(right);
  return Boolean(a && b && a.tenantHost === b.tenantHost && a.tenantPath === b.tenantPath);
}

function legacyComposedTenantKeyMatchesHost(key, candidate) {
  const separator = String(key || '').lastIndexOf('@');
  if (separator <= 0 || separator === String(key).length - 1) return false;
  const keyLabel = String(key).slice(0, separator);
  const normalizedKeyLabel = normalizeCompanyName(keyLabel);
  if (!normalizedKeyLabel || GENERIC_TENANT_NAMES.has(normalizedKeyLabel)) return false;

  const keyPlatform = registrableCandidateDomain(String(key).slice(separator + 1));
  const candidatePlatform = registrableCandidateDomain(candidate?.platform || candidate?.tenantHost || '');
  if (!keyPlatform || candidatePlatform !== keyPlatform) return false;
  const host = normalizeTenantCoordinate(tenantCoordinate(candidate))?.tenantHost;
  if (!host || registrableCandidateDomain(host) !== keyPlatform) return false;
  const hostPrefix = host.slice(0, -(keyPlatform.length + 1));
  return normalizeCompanyName(hostPrefix.replace(/\./g, ' ')) === normalizedKeyLabel;
}

function rejectedTenantIdentityMatches(store, key, incoming) {
  const incomingCoordinate = tenantCoordinate(incoming);
  if (!incomingCoordinate) return false;

  const candidateAtKey = store.candidates?.[key];
  const rejectedCandidate = candidateAtKey?.status === 'rejected' ? candidateAtKey : null;
  const tombstone = tombstonesFor(store)[key];
  if (!rejectedCandidate && !tombstone) return false;

  const storedCoordinates = [];
  if (rejectedCandidate) {
    const coordinate = tenantCoordinate(rejectedCandidate);
    if (coordinate) storedCoordinates.push(coordinate);
    if (sameTenantCoordinate(coordinate, incomingCoordinate)) return true;
  }

  const coordinates = Array.isArray(tombstone?.tenantCoordinates) ? tombstone.tenantCoordinates : [];
  storedCoordinates.push(...coordinates);
  if (coordinates.some((coordinate) => sameTenantCoordinate(coordinate, incomingCoordinate))) return true;
  // Legacy tombstones predate coordinates. Preserve only an unambiguous
  // non-generic composed label that appears in the tenant's own host prefix.
  // Labels such as `career` and `jobs` are intentionally never enough.
  return storedCoordinates.length === 0 && legacyComposedTenantKeyMatchesHost(key, incoming);
}

/** @param {ReturnType<typeof loadCandidates>} store */
function boundTombstones(store) {
  const tombstones = tombstonesFor(store);
  if (tombstoneCount(tombstones) <= MAX_REJECTED_TOMBSTONES) return;
  const keep = Object.entries(tombstones)
    .sort(([keyA, a], [keyB, b]) => String(b.rejectedAt).localeCompare(String(a.rejectedAt)) || keyA.localeCompare(keyB))
    .slice(0, MAX_REJECTED_TOMBSTONES)
    .map(([key]) => key);
  const keepSet = new Set(keep);
  for (const key of Object.keys(tombstones)) if (!keepSet.has(key)) delete tombstones[key];
  TOMBSTONE_COUNTS.set(tombstones, keep.length);
}

/**
 * Keep a rejection timestamp and a small set of tenant coordinates. Reasons,
 * histories and source payloads belong to the candidate record/ledger, not
 * this guard.
 *
 * @param {ReturnType<typeof loadCandidates>} store
 * @param {Record<string, any>} candidate
 */
function rememberRejected(store, candidate) {
  const key = String(candidate?.key || '').trim();
  if (!key) return;
  const tombstones = tombstonesFor(store);
  const rejectedAt = rejectionDate(candidate);
  const hasKey = Object.prototype.hasOwnProperty.call(tombstones, key);
  const countBefore = tombstoneCount(tombstones);
  const current = tombstones[key];
  const currentDate = typeof current === 'string' ? current : current?.rejectedAt;
  const next = {
    rejectedAt: !currentDate || String(currentDate).localeCompare(rejectedAt) < 0
      ? rejectedAt : String(currentDate),
  };
  const coordinates = Array.isArray(current?.tenantCoordinates) ? current.tenantCoordinates : [];
  const coordinate = tenantCoordinate(candidate);
  const uniqueCoordinates = [];
  for (const item of [...coordinates, ...(coordinate ? [coordinate] : [])]) {
    const normalized = normalizeTenantCoordinate(item);
    if (!normalized || uniqueCoordinates.some((existing) => sameTenantCoordinate(existing, normalized))) continue;
    uniqueCoordinates.push(normalized);
    if (uniqueCoordinates.length >= 8) break;
  }
  if (uniqueCoordinates.length) next.tenantCoordinates = uniqueCoordinates;
  tombstones[key] = next;
  if (!hasKey) TOMBSTONE_COUNTS.set(tombstones, countBefore + 1);
  boundTombstones(store);
}

function forgetRejected(store, key) {
  const tombstones = tombstonesFor(store);
  if (!Object.prototype.hasOwnProperty.call(tombstones, key)) return;
  delete tombstones[key];
  TOMBSTONE_COUNTS.set(tombstones, Math.max(0, tombstoneCount(tombstones) - 1));
}

/**
 * @param {Record<string, any>} raw
 * @returns {ReturnType<typeof loadCandidates>}
 */
function normalizeStore(raw) {
  const store = {
    ...raw,
    version: Math.max(Number(raw.version) || 1, STORE_VERSION),
    rejectedTombstones: {},
    candidateAliases: {},
  };
  if (isObjectMap(raw.rejectedTombstones)) {
    for (const [key, value] of Object.entries(raw.rejectedTombstones)) {
      const rejectedAt = typeof value === 'string' ? value : value?.rejectedAt;
      if (!key || !rejectedAt) continue;
      const tombstone = { rejectedAt: String(rejectedAt) };
      const coordinates = Array.isArray(value?.tenantCoordinates) ? value.tenantCoordinates : [];
      const normalizedCoordinates = [];
      for (const coordinate of coordinates) {
        const normalized = normalizeTenantCoordinate(coordinate);
        if (!normalized || normalizedCoordinates.some((existing) => sameTenantCoordinate(existing, normalized))) continue;
        normalizedCoordinates.push(normalized);
        if (normalizedCoordinates.length >= 8) break;
      }
      if (normalizedCoordinates.length) tombstone.tenantCoordinates = normalizedCoordinates;
      store.rejectedTombstones[key] = tombstone;
    }
  }
  if (isObjectMap(raw.candidateAliases)) {
    for (const [key, value] of Object.entries(raw.candidateAliases)) {
      const canonicalKey = typeof value === 'string' ? value : value?.canonicalKey;
      if (key && canonicalKey && key !== canonicalKey) store.candidateAliases[key] = String(canonicalKey);
    }
  }
  // Backfill the compact index for stores written before tombstones existed.
  for (const candidate of Object.values(store.candidates)) {
    if (candidate?.status === 'rejected') rememberRejected(store, candidate);
  }
  return store;
}

/**
 * @param {string} [file]
 */
export function loadCandidates(file = CANDIDATES_PATH) {
  let rawText;
  try {
    rawText = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return structuredClone(EMPTY);
    throw new Error(`Cannot read Prospector candidate store at ${file}`, { cause: error });
  }

  let raw;
  try {
    raw = JSON.parse(rawText);
  } catch (error) {
    throw new Error(`Malformed Prospector candidate store at ${file}`, { cause: error });
  }
  if (!isObjectMap(raw) || !isObjectMap(raw.candidates)) {
    throw new Error(`Invalid Prospector candidate store shape at ${file}`);
  }
  return normalizeStore(raw);
}

/**
 * Legacy diagnostic classifier for trace reasons. It is retained for reports
 * and compatibility, but it is deliberately not authorization to reopen a
 * dead candidate: revival requires the persisted `traceRetryable: true`
 * verdict below.
 *
 * @param {string} reason
 * @returns {boolean}
 */
export function isRetryableTraceReason(reason = '') {
  return RETRYABLE_TRACE_REASON_RX.test(String(reason || '').trim());
}

/**
 * A candidate with a future retry timestamp is intentionally absent from the
 * TRACE queue. `--key=…` remains an explicit operator override in the stage
 * script, so a stuck candidate can still be inspected immediately.
 *
 * @param {Record<string, any>} candidate
 * @param {number} [now]
 * @returns {boolean}
 */
export function isTraceRetryDue(candidate, now = Date.now()) {
  if (hasExhaustedDomainResolution(candidate)) {
    const lastEvidence = candidate?.traceLastEvidenceSnapshot;
    // Old or malformed records have no trustworthy baseline. Fail closed until
    // a discovery upsert saves their pre-merge evidence, then compare incoming
    // evidence structurally so JSON property order cannot wake an identical
    // retry.
    return isTraceEvidenceSnapshot(lastEvidence)
      && !matchesTraceEvidenceSnapshot(candidate, lastEvidence);
  }
  const at = Date.parse(String(candidate?.traceRetryAt || ''));
  return !Number.isFinite(at) || at <= now;
}

/**
 * Build bounded exponential backoff metadata for one retryable trace attempt.
 *
 * @param {Record<string, any>} candidate
 * @param {string} reason
 * @param {number} [now]
 * @returns {Record<string, any>}
 */
export function scheduleTraceRetry(candidate, reason, now = Date.now()) {
  const attempts = Math.max(0, Number(candidate?.traceAttempts) || 0);
  const delayDays = STAGE_RETRY_DELAYS_DAYS[Math.min(attempts, STAGE_RETRY_DELAYS_DAYS.length - 1)];
  const attemptedAt = new Date(now).toISOString();
  return {
    reason,
    traceRetryable: true,
    traceAttempts: attempts + 1,
    traceLastAttemptAt: attemptedAt,
    traceRetryAt: new Date(now + delayDays * 86_400_000).toISOString(),
    traceLastEvidenceSnapshot: traceEvidenceSnapshot(candidate),
  };
}

/**
 * A candidate whose last synthesis fetch failed transiently stays in the
 * traced queue, but is skipped until its bounded retry time.
 *
 * @param {Record<string, any>} candidate
 * @param {number} [now]
 * @returns {boolean}
 */
export function isSynthesisRetryDue(candidate, now = Date.now()) {
  const at = Date.parse(String(candidate?.synthesisRetryAt || ''));
  return !Number.isFinite(at) || at <= now;
}

/**
 * Build bounded retry metadata for a transient SYNTHESIZE fetch failure.
 *
 * @param {Record<string, any>} candidate
 * @param {string} reason
 * @param {number} [now]
 * @returns {Record<string, any>}
 */
export function scheduleSynthesisRetry(candidate, reason, now = Date.now()) {
  const attempts = Math.max(0, Number(candidate?.synthesisAttempts) || 0);
  const nextAttempts = attempts + 1;
  const retryable = nextAttempts <= MAX_SYNTHESIS_RETRIES;
  const delayDays = STAGE_RETRY_DELAYS_DAYS[Math.min(attempts, STAGE_RETRY_DELAYS_DAYS.length - 1)];
  const attemptedAt = new Date(now).toISOString();
  return {
    reason,
    synthesisRetryable: retryable,
    synthesisRetryExhausted: !retryable,
    synthesisAttempts: nextAttempts,
    synthesisLastAttemptAt: attemptedAt,
    synthesisRetryAt: retryable ? new Date(now + delayDays * 86_400_000).toISOString() : null,
  };
}

/**
 * Reopen a retryable dead candidate when a new discovery source sees it again.
 * The explicit `traceRetryable` verdict is required: the human-readable
 * reason is deliberately not authoritative, because old generic reasons such
 * as "sito irraggiungibile" also described permanent 404 responses. A new
 * careers URL remains an independent, stronger discovery signal.
 *
 * @param {ReturnType<typeof loadCandidates>} store
 * @param {string} key
 * @param {Record<string, any>} [incoming]
 * @param {string|null} [ledgerFile]
 * @param {string} [source]
 * @returns {Record<string, any>|null}
 */
export function reviveRetryableDeadCandidate(store, key, incoming = {}, ledgerFile, source = '') {
  const requestedKey = key;
  key = resolveCandidateKey(store, key);
  let candidate = store.candidates[key];
  if (!candidate) {
    const identityMatch = findIncomingIdentityCandidate(store, incoming, source);
    if (identityMatch) {
      key = resolveCandidateKey(store, identityMatch);
      candidate = store.candidates[key];
      if (candidate && requestedKey !== key) aliasesFor(store)[requestedKey] = key;
    }
  }
  if (!candidate || candidate.status !== 'dead') return candidate || null;
  const sourceEvidenceFields = TRACE_RETRY_EVIDENCE_FIELDS_BY_SOURCE.get(source);
  const hasNewCareerUrl = (sourceEvidenceFields?.has('careersUrl') || String(source).startsWith('tenant:'))
    && Boolean(incoming?.careersUrl)
    && String(incoming.careersUrl) !== String(candidate.careersUrl || '');
  if (candidate.traceRetryable !== true && !hasNewCareerUrl) return candidate;
  const revived = setStatus(store, key, 'new', {
    ...(hasNewCareerUrl ? { careersUrl: incoming.careersUrl } : {}),
    reason: 'riscontro dopo una nuova scoperta',
    traceRetryAt: null,
  }, ledgerFile);
  return revived;
}

/**
 * @param {ReturnType<typeof loadCandidates>} store
 * @param {string} [file]
 */
export function saveCandidates(store, file = CANDIDATES_PATH) {
  for (const candidate of Object.values(store.candidates || {})) {
    if (candidate?.status === 'rejected') rememberRejected(store, candidate);
  }
  boundTombstones(store);
  store.version = Math.max(Number(store.version) || 1, STORE_VERSION);
  store.updatedAt = new Date().toISOString();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(store, null, 2)}\n`);
  fs.renameSync(tmp, file);
}

function findIncomingIdentityCandidate(store, incoming, source) {
  const group = identityGroupKey(incoming);
  if (!group) return null;
  const keys = identityIndexFor(store).get(group);
  if (!keys?.size) return null;
  const candidates = [...keys]
    .map((key) => store.candidates[resolveCandidateKey(store, key)])
    .filter((candidate) => candidate && identityGroupKey(candidate) === group);
  const unique = [...new Map(candidates.map((candidate) => [candidate.key, candidate])).values()];
  if (!unique.length || candidateDomains([...unique, incoming]).size !== 1
    || distinctSources([...unique, { ...incoming, sources: [...(incoming.sources || []), source] }]) < 2) return null;
  const crawlerKeys = new Set(unique.map((candidate) => candidate.crawlerKey).filter(Boolean));
  if (incoming.crawlerKey) crawlerKeys.add(incoming.crawlerKey);
  if (crawlerKeys.size > 1) return null;
  return selectCanonicalCandidate(unique)?.key || null;
}

function mergeCareerUrls(target, ...values) {
  const urls = new Set([
    ...(Array.isArray(target.careersUrls) ? target.careersUrls : []),
    target.careersUrl,
    ...values.flatMap((value) => Array.isArray(value) ? value : [value]),
  ].filter((value) => typeof value === 'string' && value.trim()));
  if (urls.size) target.careersUrls = [...urls].slice(0, 12);
}

function mergeCandidateRecord(target, incoming, { preserveTerminalSeed = false } = {}) {
  const previousSeed = target.careersUrl;
  const previousWebObservation = String(target.sourceSeenAt?.web || '');
  const incomingWebObservation = String(incoming.sourceSeenAt?.web || '');
  for (const [field, value] of Object.entries(incoming)) {
    if (value === undefined || value === null || value === '') continue;
    if (['key', 'status', 'sources', 'sourceSeenAt', 'updatedAt', 'rejectedAt', 'reason', 'careersUrl', 'careersUrls', 'commoncrawlCollection'].includes(field)) continue;
    if (field === 'validationHistory' && Array.isArray(value)) {
      target.validationHistory = [...(target.validationHistory || []), ...value]
        .filter((entry, index, all) => all.findIndex((other) => other?.at === entry?.at && other?.qualityContractVersion === entry?.qualityContractVersion) === index)
        .sort((a, b) => String(a?.at || '').localeCompare(String(b?.at || '')))
        .slice(-8);
      continue;
    }
    if (Array.isArray(value) && Array.isArray(target[field])) {
      target[field] = [...new Set([...target[field], ...value])].slice(-100);
      continue;
    }
    if (target[field] === undefined || target[field] === null || target[field] === '') target[field] = value;
  }
  target.sources = [...new Set([...(target.sources || []), ...(incoming.sources || [])])];
  target.sourceSeenAt = { ...(target.sourceSeenAt || {}) };
  for (const [source, at] of Object.entries(incoming.sourceSeenAt || {})) {
    if (!target.sourceSeenAt[source] || String(at) > String(target.sourceSeenAt[source])) target.sourceSeenAt[source] = at;
  }
  if (incoming.commoncrawlCollection
    && (!target.commoncrawlCollection || incomingWebObservation >= previousWebObservation)) {
    target.commoncrawlCollection = incoming.commoncrawlCollection;
  }
  mergeCareerUrls(target, incoming.careersUrl, incoming.careersUrls);
  if (!preserveTerminalSeed && (!target.careersUrl || target.status !== 'rejected' && target.status !== 'dead')) {
    target.careersUrl ||= incoming.careersUrl;
  }
  if (target.careersUrl && previousSeed && target.careersUrl !== previousSeed) mergeCareerUrls(target, previousSeed);
  if (incoming.domain && !target.domain) target.domain = incoming.domain;
  if (!target.crawlerKey && incoming.crawlerKey) target.crawlerKey = incoming.crawlerKey;
  target.firstSeenAt = [target.firstSeenAt, incoming.firstSeenAt].filter(Boolean).sort()[0] || target.firstSeenAt;
  target.updatedAt = [target.updatedAt, incoming.updatedAt].filter(Boolean).sort().at(-1) || target.updatedAt;
}

/**
 * Consolidate only exact normalized name+city groups with at least two source
 * families and one employer domain. Historical keys stay resolvable through
 * `candidateAliases`, so crawler specs and old operator references continue to
 * find the canonical record.
 */
export function reconcileCandidateDuplicates(store, ledgerFile) {
  const groups = identityIndexFor(store);
  const result = { groupsChecked: 0, merged: 0, skippedDomainConflict: 0, skippedEvidence: 0, skippedCrawlerConflict: 0 };
  for (const [identity, rawKeys] of groups) {
    const members = [...rawKeys]
      .map((key) => store.candidates[key])
      .filter((candidate) => candidate && identityGroupKey(candidate) === identity);
    if (members.length < 2) continue;
    result.groupsChecked++;
    const domains = candidateDomains(members);
    if (domains.size !== 1) { result.skippedDomainConflict++; continue; }
    if (distinctSources(members) < 2) { result.skippedEvidence++; continue; }
    if (new Set(members.map((candidate) => candidate.crawlerKey).filter(Boolean)).size > 1) {
      result.skippedCrawlerConflict++;
      continue;
    }
    const canonical = selectCanonicalCandidate(members);
    const preserveTerminalSeed = canonical.status === 'rejected' || canonical.status === 'dead';
    for (const member of members) {
      if (member === canonical) continue;
      mergeCandidateRecord(canonical, member, { preserveTerminalSeed });
      aliasesFor(store)[member.key] = canonical.key;
      for (const [alias, target] of Object.entries(aliasesFor(store))) {
        if (target === member.key) aliasesFor(store)[alias] = canonical.key;
      }
      delete store.candidates[member.key];
      forgetRejected(store, member.key);
      appendLedger({
        eventType: 'candidate_merged',
        key: member.key,
        canonicalKey: canonical.key,
        reasonCode: 'same_name_city_single_domain_cross_source',
        at: new Date().toISOString(),
      }, ledgerFile);
      result.merged++;
    }
    if (!registrableCandidateDomain(canonical.domain)) canonical.domain = [...domains][0];
    canonical.updatedAt = new Date().toISOString();
    if (canonical.status === 'rejected') rememberRejected(store, canonical);
    if (canonical.status === 'dead') {
      // Keep all known paths for a later explicit fresh-evidence revival, but
      // retain the terminal seed until such evidence actually arrives.
      mergeCareerUrls(canonical, canonical.careersUrls);
    }
  }
  IDENTITY_INDEXES.delete(store);
  return result;
}

function reopenEmptySynthesisRejection(store, key, candidate, incoming, source, ledgerFile) {
  if (candidate?.status !== 'rejected'
    || candidate.reason !== 'sintesi fallita: nessun annuncio estratto dal seed') return false;
  const sourceEvidenceFields = TRACE_RETRY_EVIDENCE_FIELDS_BY_SOURCE.get(source);
  const newCareerUrl = Boolean(incoming?.careersUrl)
    && (sourceEvidenceFields?.has('careersUrl') || String(source).startsWith('tenant:'))
    && String(incoming.careersUrl) !== String(candidate.careersUrl || '');
  const freshSecoEvidence = source === 'seco' && hasFreshSecoEvidence(candidate, incoming);
  const priorWebCollection = candidate.synthesisCommoncrawlCollection || candidate.commoncrawlCollection || '';
  const newCommoncrawlCollection = source === 'web'
    && Boolean(incoming?.commoncrawlCollection)
    && String(incoming.commoncrawlCollection) !== String(priorWebCollection);
  if (!newCareerUrl && !freshSecoEvidence && !newCommoncrawlCollection) return false;
  const at = new Date().toISOString();
  const priorReason = candidate.reason;
  candidate.status = 'traced';
  candidate.reason = newCareerUrl
    ? 'nuovo seed carriere: sintesi riaperta'
    : (freshSecoEvidence ? 'nuova evidenza SECO: sintesi riaperta' : 'nuova collection Common Crawl: sintesi riaperta');
  if (newCareerUrl) {
    mergeCareerUrls(candidate, candidate.careersUrl, incoming.careersUrl);
    candidate.careersUrl = String(incoming.careersUrl);
  }
  candidate.synthesisRetryable = false;
  candidate.synthesisAttempts = 0;
  candidate.synthesisLastAttemptAt = null;
  candidate.synthesisRetryAt = null;
  candidate.synthesisRetryExhausted = false;
  candidate.synthesisOutcome = null;
  candidate.synthesisDiagnostics = null;
  candidate.reopenedAt = at;
  delete candidate.rejectedAt;
  candidate.updatedAt = at;
  forgetRejected(store, key);
  appendLedger({
    eventType: 'candidate_reopened', key, from: 'rejected', to: 'traced', at,
    reasonCode: newCareerUrl ? 'new_careers_url' : (freshSecoEvidence ? 'fresh_seco_ads' : 'new_commoncrawl_collection'),
    reason: priorReason,
  }, ledgerFile);
  return true;
}

/**
 * Requeue a bounded batch of the legacy no-vacancy rejections that already
 * carry retry-state fields but predate synthesis attempt accounting. These
 * rows were rejected before synthesis could follow alternate careers links;
 * older terminal records without the retry-state marker remain untouched.
 *
 * @param {ReturnType<typeof loadCandidates>} store
 * @param {number} limit
 * @param {string|null} [ledgerFile]
 * @returns {Record<string, any>[]}
 */
export function requeueLegacyNoVacancyCandidates(store, limit, ledgerFile) {
  const max = Math.max(0, Math.floor(Number(limit) || 0));
  if (!max || LEGACY_RECOVERY_BATCHES.has(store)) return [];

  const candidates = Object.values(store.candidates)
    .filter((candidate) => candidate?.status === 'rejected'
      && candidate.reason === 'sintesi fallita: nessun annuncio estratto dal seed'
      && candidate.synthesisRetryable === false
      && !Object.hasOwn(candidate, 'synthesisAttempts')
      && candidate.synthesisRetryExhausted !== true
      && !candidate.synthesisRecoveryQueuedAt)
    .sort((a, b) => String(b.rejectedAt || b.updatedAt || '').localeCompare(String(a.rejectedAt || a.updatedAt || ''))
      || String(a.key || '').localeCompare(String(b.key || '')))
    .slice(0, max);
  if (candidates.length) LEGACY_RECOVERY_BATCHES.add(store);

  const at = new Date().toISOString();
  for (const candidate of candidates) {
    const priorReason = candidate.reason;
    candidate.status = 'traced';
    candidate.reason = 'sintesi senza annunci: recupero multi-seed in coda';
    candidate.synthesisRetryable = false;
    candidate.synthesisRetryExhausted = false;
    candidate.synthesisAttempts = 0;
    candidate.synthesisLastAttemptAt = null;
    candidate.synthesisRetryAt = null;
    // The outcome is overwritten by each attempt; this timestamp is the durable
    // provenance the conflict resolver uses to recognize the legacy requeue.
    candidate.synthesisOutcome = 'legacy_no_vacancy_recovery';
    candidate.synthesisDiagnostics = null;
    candidate.synthesisRecoveryQueuedAt = at;
    candidate.reopenedAt = at;
    candidate.updatedAt = at;
    delete candidate.rejectedAt;
    forgetRejected(store, candidate.key);
    appendLedger({
      eventType: 'candidate_reopened',
      key: candidate.key,
      from: 'rejected',
      to: 'traced',
      at,
      reasonCode: 'legacy_no_vacancy_recovery',
      reason: priorReason,
    }, ledgerFile);
  }
  return candidates;
}

/**
 * Insert or merge a candidate. Merging never downgrades a status and never
 * loses a source attribution — the same employer legitimately arrives from the
 * SECO feed, a map extract and a tenant sweep, and knowing it came from three
 * independent channels is itself a quality signal.
 *
 * @param {ReturnType<typeof loadCandidates>} store
 * @param {Object} incoming
 * @param {string} source
 * @returns {{ key: string|null, created: boolean, rejected?: boolean, reason?: string }}
 */
export function upsertCandidate(store, incoming, source) {
  const originalDomain = typeof incoming?.domain === 'string' ? incoming.domain.trim() : '';
  const invalidDomain = Boolean(originalDomain && !candidateEmployerDomain(originalDomain));
  if (invalidDomain) {
    incoming = { ...incoming };
    delete incoming.domain;
  }
  const tenantPathKey = pathTenantFallbackKey(incoming, source);
  if (tenantPathKey) {
    if (!hasEmployerSpecificTenantName(incoming)) {
      incoming = { ...incoming };
      delete incoming.name;
    }
  }
  const suppliedKey = typeof incoming.key === 'string' ? incoming.key.trim() : '';
  const keyLooksLikeHost = suppliedKey.includes('.') && !suppliedKey.includes('@');
  const suppliedKeyIsTombstoned = Boolean(suppliedKey && tombstonesFor(store)[suppliedKey]);
  const safeTenantKey = hasVerifiedSubdomainTenantKey(suppliedKey, incoming, source);
  const rejectedComposedTenantKey = String(source || '').startsWith('tenant:')
    && suppliedKey.includes('@') && !safeTenantKey;
  // A rejected legacy composed key may have been persisted under the old
  // tenant identity policy. Do not let the new host-scoped fallback create a
  // fresh record that bypasses that key's durable rejection.
  if (rejectedComposedTenantKey && rejectedTenantIdentityMatches(store, suppliedKey, incoming)) {
    return { key: suppliedKey, created: false };
  }
  const safeSuppliedKey = !safeTenantKey ? ''
    : keyLooksLikeHost && !candidateEmployerDomain(suppliedKey)
      && !suppliedKeyIsTombstoned ? '' : suppliedKey;
  const invalidHostKey = keyLooksLikeHost && !safeSuppliedKey;
  const verifiedIdentityDomain = candidateIdentityDomain(incoming);
  const invalidIdentityHint = [
    invalidDomain ? originalDomain : '',
    invalidHostKey ? suppliedKey : '',
    rejectedComposedTenantKey ? `tenant-key:${suppliedKey}|host:${normalizeHost(incoming.tenantHost || '')}` : '',
  ].filter(Boolean).join('|');
  // An invalid suffix is not an identity and must not fall through to a
  // same-name key already in the store. If a company homepage independently
  // proves the identity, use it; otherwise isolate this unverified record.
  const employerSpecificName = hasEmployerSpecificTenantName(incoming);
  const hasNameAndCity = employerSpecificName && Boolean(normalizeIdentityCity(incoming.city));
  const invalidDomainIsKnownSharedPlatform = invalidDomain
    && isKnownSharedPlatformDomain(registrableCandidateDomain(originalDomain));
  const rejectedTenantKeyIdentity = rejectedComposedTenantKey && !tenantPathKey
    && (!invalidDomain || invalidDomainIsKnownSharedPlatform) && !invalidHostKey
    ? verifiedIdentityDomain
      || (hasNameAndCity ? candidateKey(incoming) : '')
      || subdomainTenantFallbackKey(incoming, source)
    : '';
  if (rejectedComposedTenantKey && !tenantPathKey && !rejectedTenantKeyIdentity) {
    return { key: null, created: false, rejected: true, reason: 'unverified_tenant_identity' };
  }
  const unverifiedKey = `${candidateKey(incoming)}#unverified-${createHash('sha256')
    .update(invalidIdentityHint).digest('hex').slice(0, 12)}`;
  const requestedKey = tenantPathKey || rejectedTenantKeyIdentity || (invalidIdentityHint
    ? verifiedIdentityDomain || unverifiedKey
    : safeSuppliedKey || candidateKey(incoming));
  if (incoming.key !== requestedKey) incoming = { ...incoming, key: requestedKey };
  let key = resolveCandidateKey(store, requestedKey);
  const now = new Date().toISOString();
  let existing = store.candidates[key];
  if (!existing) {
    const identityMatch = findIncomingIdentityCandidate(store, incoming, source);
    if (identityMatch) {
      key = resolveCandidateKey(store, identityMatch);
      existing = store.candidates[key];
      if (key !== requestedKey) aliasesFor(store)[requestedKey] = key;
    }
  }
  if (!existing && tombstonesFor(store)[key]) return { key, created: false };
  const reopenedNoVacancy = existing
    ? reopenEmptySynthesisRejection(store, key, existing, incoming, source, activeLedgerContext?.file)
    : false;
  // A repeated sighting must not refresh a rejected record's retention clock
  // or merge new diagnostic payload into a verdict that is already terminal.
  if (existing?.status === 'rejected' && !reopenedNoVacancy) {
    rememberRejected(store, existing);
    return { key, created: false };
  }
  const previousSynthesisSeed = existing ? synthesisSeedFor(existing) : '';
  if (existing && !Array.isArray(existing.sources)) existing.sources = [];
  const sourcePreviouslySeen = Boolean(existing && (
    existing.sources.includes(source)
    || (isObjectMap(existing.sourceSeenAt) && Object.prototype.hasOwnProperty.call(existing.sourceSeenAt, source))
  ));
  // Legacy exhausted domain guesses have no evidence baseline. Save the
  // pre-upsert snapshot before merging, so an unchanged rediscovery cannot
  // wake the same failed guess merely by refreshing sourceSeenAt.
  if (existing && hasExhaustedDomainResolution(existing)
    && !isTraceEvidenceSnapshot(existing.traceLastEvidenceSnapshot)) {
    existing.traceLastEvidenceSnapshot = traceEvidenceSnapshot(existing);
  }
  if (existing) recordSourceObservation(existing, source, now);
  if (!existing) {
    const candidate = {
      key,
      status: 'new',
      sources: [source],
      firstSeenAt: now,
      updatedAt: now,
      ...incoming,
    };
    mergeCareerUrls(candidate, candidate.careersUrl, candidate.careersUrls);
    recordSourceObservation(candidate, source, now);
    if (source !== 'seco') {
      for (const field of [...SECO_SIGNAL_FIELDS, ...SECO_IDENTITY_FIELDS]) delete candidate[field];
    }
    store.candidates[key] = candidate;
    addToIdentityIndex(store, key, candidate);
    return { key, created: true };
  }
  for (const [k, v] of Object.entries(incoming)) {
    if (v === undefined || v === null || v === '') continue;
    if (k === 'status' || k === 'sources' || k === 'sourceSeenAt') continue;
    if (k === 'careersUrls' && Array.isArray(v)) {
      mergeCareerUrls(existing, v);
      continue;
    }
    if (k === 'careersUrl') {
      mergeCareerUrls(existing, v);
      if (reopenedNoVacancy || !existing[k]
        || (sourcePreviouslySeen && TRACE_RETRY_EVIDENCE_FIELDS_BY_SOURCE.get(source)?.has(k))) existing[k] = v;
      continue;
    }
    if (k === 'commoncrawlCollection') {
      if (source === 'web') existing.commoncrawlCollection = v;
      continue;
    }
    if (SECO_SIGNAL_FIELDS.has(k)) {
      if (source === 'seco') existing[k] = v;
      continue;
    }
    if (SECO_IDENTITY_FIELDS.has(k)) {
      if (source === 'seco') existing[k] = v;
      continue;
    }
    const sourceEvidenceFields = TRACE_RETRY_EVIDENCE_FIELDS_BY_SOURCE.get(source);
    if (TRACE_RETRY_EVIDENCE_FIELDS.includes(k)) {
      const empty = existing[k] === undefined || existing[k] === '' || existing[k] === null;
      if (empty || (sourcePreviouslySeen && sourceEvidenceFields?.has(k))) existing[k] = v;
      continue;
    }
    if (existing[k] === undefined || existing[k] === '' || existing[k] === null) existing[k] = v;
  }
  const nextSynthesisSeed = synthesisSeedFor(existing);
  if (existing.status === 'traced' && nextSynthesisSeed && nextSynthesisSeed !== previousSynthesisSeed) {
    existing.synthesisRetryable = false;
    existing.synthesisAttempts = 0;
    existing.synthesisLastAttemptAt = null;
    existing.synthesisRetryAt = null;
    existing.synthesisRetryExhausted = false;
    existing.synthesisOutcome = null;
    existing.synthesisDiagnostics = null;
    if (String(existing.reason || '').startsWith('sintesi fallita:')) existing.reason = null;
  }
  if (!existing.sources.includes(source)) existing.sources.push(source);
  existing.updatedAt = now;
  addToIdentityIndex(store, key, existing);
  return { key, created: false };
}

const ORDER = ['rejected', 'dead', 'new', 'resolved', 'traced', 'synthesized', 'validated', 'promoted', 'promoting', 'awaiting_first_crawl', 'production'];

function selectCanonicalCandidate(candidates) {
  const active = candidates.filter((candidate) => candidate.status !== 'rejected' && candidate.status !== 'dead');
  const pool = active.length ? active : candidates;
  return pool.slice().sort((a, b) => {
    if (active.length) {
      const rank = ORDER.indexOf(b.status) - ORDER.indexOf(a.status);
      if (rank) return rank;
    } else if (a.status !== b.status) {
      // If every record is terminal, preserve an explicit rejection over a
      // transient dead verdict; otherwise use recency and a stable key tie-break.
      if (a.status === 'rejected') return -1;
      if (b.status === 'rejected') return 1;
    }
    return String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')) || a.key.localeCompare(b.key);
  })[0] || null;
}

/**
 * @param {ReturnType<typeof loadCandidates>} store
 * @param {string} key
 * @param {CandidateStatus} status
 * @param {Record<string, any>} [patch]
 * @param {string} [ledgerFile] dove scrivere la voce di registro; un test che
 *   esercita una transizione non deve appendere al registro committato.
 */
export function setStatus(store, key, status, patch = {}, ledgerFile) {
  key = resolveCandidateKey(store, key);
  const c = store.candidates[key];
  if (!c) return null;
  const prev = c.status;
  // A rejected verdict is terminal. Reopening it would make the compact
  // tombstone ineffective; a future policy can add an explicit reopen API
  // that removes the tombstone instead of treating an ordinary transition as
  // permission to retry.
  if (prev === 'rejected' && status !== 'rejected') {
    rememberRejected(store, c);
    return c;
  }
  // `dead` and `rejected` are terminal verdicts a later stage may legitimately
  // set; everything else only moves forward, so a re-run cannot rewind a
  // candidate that already reached production.
  const forward = status === 'dead' || status === 'rejected'
    || ORDER.indexOf(status) >= ORDER.indexOf(prev);
  if (forward) c.status = status;
  Object.assign(c, patch, { updatedAt: new Date().toISOString() });
  if (c.status === 'rejected' && !c.rejectedAt) c.rejectedAt = c.updatedAt;
  if (prev === 'rejected' || c.status === 'rejected') rememberRejected(store, c);
  if (prev !== c.status) appendLedger({ eventType: 'candidate_transition', key, from: prev, to: c.status, at: c.updatedAt, reason: patch.reason }, ledgerFile);
  else if (Object.keys(patch).length) appendLedger({
    eventType: 'candidate_attempt',
    key,
    status: c.status,
    outcome: patch.synthesisRetryable === true || patch.traceRetryable === true
      ? 'retryable_failure'
      : (patch.qualityVerdict || 'updated'),
    at: c.updatedAt,
    reason: patch.reason,
  }, ledgerFile);
  return c;
}

/**
 * Return a promoted candidate to the retryable validation queue after a fresh
 * run proves a non-terminal gate failure. This is intentionally narrower than
 * `setStatus`: the normal state machine is forward-only, and no other state
 * may be rewound by a validation result. `promoted` is the one state that
 * represents a quality pass while still being outside production.
 *
 * @param {ReturnType<typeof loadCandidates>} store
 * @param {string} key
 * @param {Record<string, any>} [patch]
 * @param {string|null} [ledgerFile]
 * @returns {Record<string, any>|null}
 */
export function requeuePromotedCandidate(store, key, patch = {}, ledgerFile) {
  key = resolveCandidateKey(store, key);
  const c = store.candidates[key];
  if (!c || c.status !== 'promoted') return null;
  const at = new Date().toISOString();
  const safePatch = Object.fromEntries(
    Object.entries(patch).filter(([name]) => name !== 'status'),
  );
  c.status = 'validated';
  Object.assign(c, safePatch, { updatedAt: at });
  appendLedger({ eventType: 'candidate_transition', key, from: 'promoted', to: 'validated', at, reason: safePatch.reason }, ledgerFile);
  return c;
}

/**
 * Send a not-yet-live candidate back to SYNTHESIZE because its crawler key was
 * a vendor host label it cannot own (see `findMiskeyedCandidates()`).
 *
 * The validation history goes with the key: while several employers shared
 * one spec file, a "good" grading may have measured another employer's spec,
 * so none of it can count towards the new spec's two-day stability.
 * `rekeyedAt` lets the promotion gate ignore any entry a concurrent-run merge
 * brings back.
 *
 * @param {ReturnType<typeof loadCandidates>} store
 * @param {string} key
 * @param {{ from: string, to: string }} rekey
 * @param {string|null} [ledgerFile]
 * @returns {Record<string, any>|null}
 */
export function requeueMiskeyedCandidate(store, key, { from, to }, ledgerFile) {
  key = resolveCandidateKey(store, key);
  const c = store.candidates[key];
  if (!c || !['synthesized', 'validated', 'promoted'].includes(c.status) || c.crawlerKey !== from) return null;
  const at = new Date().toISOString();
  const prev = c.status;
  c.status = 'traced';
  c.rekeyedFrom = from;
  c.rekeyedAt = at;
  c.reason = `chiave crawler "${from}" e' un'etichetta del vendor: risintesi come "${to}"`;
  c.validationHistory = [];
  for (const field of ['crawlerKey', 'qualityScore', 'qualityVerdict', 'qualityProblems', 'validationAnomalyIds']) {
    delete c[field];
  }
  c.synthesisRetryable = false;
  c.synthesisAttempts = 0;
  c.synthesisLastAttemptAt = null;
  c.synthesisRetryAt = null;
  c.updatedAt = at;
  appendLedger({
    eventType: 'candidate_transition',
    key,
    from: prev,
    to: 'traced',
    at,
    reasonCode: 'crawler_key_rekey',
    reason: c.reason,
  }, ledgerFile);
  return c;
}

/**
 * Reopen a candidate only after the exact promotion PR is verified CLOSED and
 * unmerged. This is the sole allowed rewind from `promoting`; ordinary
 * `setStatus` stays forward-only. The closed PR remains in bounded audit
 * history while the in-flight pointer is cleared.
 *
 * @param {ReturnType<typeof loadCandidates>} store
 * @param {string} key
 * @param {{ number?: string|number, state?: string, mergedAt?: string|null, closedAt?: string|null, url?: string }} pullRequest
 * @param {string|null} [ledgerFile]
 * @returns {Record<string, any>|null}
 */
export function requeueClosedPromotionCandidate(store, key, pullRequest = {}, ledgerFile) {
  key = resolveCandidateKey(store, key);
  const candidate = store.candidates[key];
  const associatedNumber = Number(candidate?.promotionPr);
  const verifiedNumber = Number(pullRequest.number);
  if (!candidate || candidate.status !== 'promoting'
    || !Number.isSafeInteger(associatedNumber) || associatedNumber <= 0
    || verifiedNumber !== associatedNumber
    || pullRequest.state !== 'CLOSED'
    || !Object.prototype.hasOwnProperty.call(pullRequest, 'mergedAt')
    || pullRequest.mergedAt !== null) return null;

  const at = new Date().toISOString();
  const history = Array.isArray(candidate.promotionHistory) ? candidate.promotionHistory : [];
  history.push({
    number: String(associatedNumber),
    state: 'CLOSED',
    mergedAt: null,
    closedAt: pullRequest.closedAt || null,
    url: pullRequest.url || null,
    observedAt: at,
  });
  candidate.promotionHistory = history.slice(-20);
  candidate.status = 'promoted';
  delete candidate.promotionPr;
  delete candidate.promotionBranch;
  candidate.reason = `PR ${associatedNumber} chiusa senza merge, ricandidato`;
  candidate.updatedAt = at;
  appendLedger({
    eventType: 'candidate_transition',
    key,
    from: 'promoting',
    to: 'promoted',
    at,
    reason: candidate.reason,
  }, ledgerFile);
  return candidate;
}

/**
 * Reopen a rejected candidate only after an explicitly opted-in source adapter
 * has produced a new validation entry. The adapter version is a bounded retry
 * key: a second bad result under the same version remains terminal.
 *
 * @param {ReturnType<typeof loadCandidates>} store
 * @param {string} key
 * @param {string} sourceAdapterVersion
 * @param {string|null} [ledgerFile]
 * @returns {Record<string, any>|null}
 */
export function reopenRejectedCandidate(store, key, sourceAdapterVersion, ledgerFile) {
  key = resolveCandidateKey(store, key);
  const candidate = store.candidates[key];
  const version = String(sourceAdapterVersion || '').trim();
  if (!candidate || candidate.status !== 'rejected' || !version) return null;

  const history = Array.isArray(candidate.validationHistory) ? candidate.validationHistory : [];
  const latest = history.at(-1);
  const previous = history.at(-2);
  if (latest?.sourceAdapterVersion !== version
    || previous?.sourceAdapterVersion === version
    || candidate.reopenedSourceAdapterVersion === version) return null;

  const tombstones = tombstonesFor(store);
  if (Object.prototype.hasOwnProperty.call(tombstones, key)) {
    delete tombstones[key];
    TOMBSTONE_COUNTS.set(tombstones, Math.max(0, tombstoneCount(tombstones) - 1));
  }

  const at = new Date().toISOString();
  candidate.status = 'validated';
  candidate.updatedAt = at;
  candidate.reason = `rivalutata con source adapter ${version}`;
  candidate.reopenedSourceAdapterVersion = version;
  delete candidate.rejectedAt;
  appendLedger({ eventType: 'candidate_reopened', key, from: 'rejected', to: 'validated', at, reason: candidate.reason }, ledgerFile);
  return candidate;
}

/**
 * @param {Record<string, any>} entry
 * @param {string} [file]
 */
export function appendLedger(entry, file) {
  // `null` esplicito = non registrare: serve a una dry-run, che applica la
  // transizione in memoria per stamparla e poi butta via lo store.
  if (activeLedgerContext?.disabled) return;
  const target = file === undefined
    ? (activeLedgerContext?.file === undefined ? LEDGER_PATH : activeLedgerContext.file)
    : file;
  if (!target) return;
  const context = activeLedgerContext || currentLedgerContext();
  const event = {
    ...entry,
    runId: entry.runId || context.runId,
    runAttempt: Number(entry.runAttempt || context.runAttempt),
    phase: entry.phase || context.phase,
  };
  if (!event.eventId) {
    event.eventId = createHash('sha256').update(JSON.stringify(event)).digest('hex').slice(0, 24);
  }
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.appendFileSync(target, `${JSON.stringify(event)}\n`);
  } catch { /* the ledger is diagnostic; never fail a run over it */ }
}

/**
 * Drop terminal candidates older than `maxAgeDays`.
 *
 * The queue is committed on every remote run, so it must not grow without
 * bound: `dead` entries are transient scar tissue and may be rediscovered after
 * the window. A `rejected` record is compacted to a bounded tombstone instead:
 * the explicit verdict survives the diagnostic retention window without
 * keeping its full history and source payload.
 *
 * @param {ReturnType<typeof loadCandidates>} store
 * @param {number} [maxAgeDays]
 * @returns {number} how many were dropped
 */
export function pruneTerminal(store, maxAgeDays = 90) {
  const cutoff = Date.now() - maxAgeDays * 86400000;
  let dropped = 0;
  for (const [key, c] of Object.entries(store.candidates)) {
    if (c.status === 'rejected') rememberRejected(store, c);
    else if (c.status !== 'dead') continue;
    const seen = Date.parse(c.status === 'rejected'
      ? (c.rejectedAt || c.updatedAt || c.firstSeenAt || '')
      : (c.updatedAt || c.firstSeenAt || ''));
    if (Number.isFinite(seen) && seen < cutoff) { delete store.candidates[key]; dropped++; }
  }
  boundTombstones(store);
  return dropped;
}

/**
 * @param {ReturnType<typeof loadCandidates>} store
 * @param {CandidateStatus|CandidateStatus[]} status
 * @returns {any[]}
 */
export function byStatus(store, status) {
  const want = new Set(Array.isArray(status) ? status : [status]);
  return Object.values(store.candidates).filter((c) => want.has(c.status));
}

/**
 * @param {ReturnType<typeof loadCandidates>} store
 * @returns {Record<string, number>}
 */
export function statusCounts(store) {
  /** @type {Record<string, number>} */
  const out = {};
  for (const c of Object.values(store.candidates)) out[c.status] = (out[c.status] || 0) + 1;
  return out;
}
