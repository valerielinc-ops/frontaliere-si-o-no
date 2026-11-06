import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { writeJsonAtomic } from '../atomic-write-json.mjs';
import {
  isKnownAggregatorDomain,
  KNOWN_AGGREGATOR_DOMAINS,
  OFFICIAL_SECO_CHANNEL_DOMAINS,
} from '../known-aggregator-domains.mjs';
import { CANTONS, DATA_ROOT, PROSPECTOR_DIR, ROOT } from './config.mjs';
import { normalizeCompanyName } from './coverage.mjs';
import {
  classifyStaffingEmployer,
  loadStaffingRegistry,
  STAFFING_CLASSIFIER_VERSION,
  STAFFING_REGISTRY_RELATIVE_PATH,
} from './seco-staffing-classifier.mjs';
import { auditStaffingClassifier, STAFFING_AUDIT_FILENAME } from './staffing-classifier-audit.mjs';

export const COVERAGE_EXCLUSIVITY_VERSION = 2;
export const COVERAGE_HISTORY_VERSION = 2;
export const OFFICIAL_CRAWLER_KEY = 'seco-jobroom';
export const OFFICIAL_SLICE_RELATIVE_PATH = path.join('jobs', 'by-crawler', `${OFFICIAL_CRAWLER_KEY}.json`);
export const COVERAGE_HISTORY_FILENAME = 'coverage-exclusivity-history.json';
export const OWNER_STAFFING_REFERENCE = Object.freeze({
  source: 'owner-provided brief',
  estimatedAgencyShare: 0.31,
  referenceSnapshot: {
    officialOffers: 2432,
    adeccoOffers: 522,
  },
  interpretation: "benchmark dichiarato dal proprietario; non è l'output del classificatore curato e non viene usato per assegnare agency/direct",
});

export const OFFER_VOLUME_BANDS = Object.freeze([
  { key: 'micro', min: 1, max: 4, label: '1–4 offerte SECO vive' },
  { key: 'small', min: 5, max: 19, label: '5–19 offerte SECO vive' },
  { key: 'medium', min: 20, max: 99, label: '20–99 offerte SECO vive' },
  { key: 'large', min: 100, max: Number.POSITIVE_INFINITY, label: '100+ offerte SECO vive' },
]);

// These domains are known job boards, but these three are the official/public
// channels behind the SECO slice rather than independent aggregator evidence.
// Counting them would compare the official feed with itself.
export const NON_COMPARABLE_AGGREGATOR_DOMAINS = Object.freeze([
  ...OFFICIAL_SECO_CHANNEL_DOMAINS,
]);
export const COMPARABLE_AGGREGATOR_DOMAINS = Object.freeze(
  [...KNOWN_AGGREGATOR_DOMAINS]
    .filter((domain) => !NON_COMPARABLE_AGGREGATOR_DOMAINS.includes(domain))
    .sort(),
);

const SOURCE_URL_FIELDS = Object.freeze([
  'url', 'applyUrl', 'sourceUrl', 'sourcePageUrl', 'originalUrl',
]);
const CLOSED_STATUSES = new Set(['archived', 'closed', 'expired', 'filled', 'inactive', 'removed']);
const TITLE_STOPWORDS = new Set([
  'a', 'an', 'and', 'bei', 'con', 'de', 'der', 'die', 'du', 'ein', 'eine', 'en', 'et',
  'für', 'im', 'in', 'la', 'le', 'les', 'mit', 'of', 'per', 'pour', 'the', 'und', 'un',
  'una', 'uno', 'with', 'zur', 'zum', 'job', 'jobs', 'stelle', 'stellen', 'offre', 'offerte',
]);

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function jobsFromDocument(document) {
  if (Array.isArray(document)) return document;
  if (Array.isArray(document?.jobs)) return document.jobs;
  if (Array.isArray(document?.rows)) return document.rows;
  return [];
}

export function loadSliceDocument(filePath) {
  const document = readJson(filePath);
  return {
    document,
    jobs: jobsFromDocument(document),
    assembledAt: document?.assembledAt || document?.generatedAt || null,
    runId: document?.runId || null,
  };
}

function normalizeUrl(value) {
  try {
    const url = new URL(String(value));
    if (!/^https?:$/.test(url.protocol)) return '';
    url.hash = '';
    for (const key of [...url.searchParams.keys()]) {
      if (key.toLowerCase().startsWith('utm_') || ['fbclid', 'gclid'].includes(key.toLowerCase())) {
        url.searchParams.delete(key);
      }
    }
    return url.toString();
  } catch {
    return '';
  }
}

export function sourceUrlsOf(job = {}) {
  const values = [];
  for (const field of SOURCE_URL_FIELDS) {
    const raw = job?.[field];
    if (Array.isArray(raw)) values.push(...raw);
    else if (raw) values.push(raw);
  }
  return [...new Set(values.map(normalizeUrl).filter(Boolean))];
}

export function knownAggregatorUrlsOf(job = {}) {
  return sourceUrlsOf(job).filter((url) => isKnownAggregatorDomain(url));
}

function knownAggregatorDomainForUrl(url) {
  let host;
  try { host = new URL(url).hostname.toLowerCase().replace(/^www\./, ''); } catch { return null; }
  return [...KNOWN_AGGREGATOR_DOMAINS]
    .sort((left, right) => right.length - left.length)
    .find((domain) => host === domain || host.endsWith(`.${domain}`)) || null;
}

export function comparableAggregatorDomainsOf(job = {}) {
  return [...new Set(knownAggregatorUrlsOf(job)
    .map(knownAggregatorDomainForUrl)
    .filter((domain) => domain && !NON_COMPARABLE_AGGREGATOR_DOMAINS.includes(domain)))];
}

function nonComparableAggregatorDomainsOf(job = {}) {
  return [...new Set(knownAggregatorUrlsOf(job)
    .map(knownAggregatorDomainForUrl)
    .filter((domain) => domain && NON_COMPARABLE_AGGREGATOR_DOMAINS.includes(domain)))];
}

export function isLiveOffer(job = {}) {
  if (!job || typeof job !== 'object') return false;
  if (job.expired === true || job.active === false) return false;
  const status = String(job.status || '').trim().toLowerCase();
  return !CLOSED_STATUSES.has(status);
}

function employerNameOf(job = {}) {
  return String(
    job.company
      || job.employerName
      || job.hiringOrganization?.name
      || job.employer?.name
      || '',
  ).trim();
}

function cantonOf(job = {}) {
  const canton = String(
    job.canton
      || job.addressRegion
      || job.location?.addressRegion
      || job.jobLocation?.address?.addressRegion
      || '',
  ).trim().toUpperCase();
  return CANTONS.includes(canton) ? canton : 'UNKNOWN';
}

function titleOf(job = {}) {
  return String(job.title || job.name || job.position || '').trim();
}

function employerFingerprint(name) {
  return normalizeCompanyName(name).replace(/\s+/g, ' ').trim();
}

function employerTokens(fingerprint) {
  return new Set(String(fingerprint || '').split(' ').filter((token) => token.length >= 3));
}

function titleTokens(title) {
  return new Set(String(title || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .split(/\s+/)
    .filter((token) => token && token.length > 1 && !TITLE_STOPWORDS.has(token) && !/^\d+$/.test(token)));
}

export function titleSimilarity(left, right) {
  const a = titleTokens(left);
  const b = titleTokens(right);
  if (!a.size || !b.size) return 0;
  if (left === right) return 1;
  const intersection = [...a].filter((token) => b.has(token)).length;
  const union = new Set([...a, ...b]).size;
  const smaller = Math.min(a.size, b.size);
  return Math.min(intersection / smaller, intersection / union + 0.35 * (intersection / smaller));
}

function employerSimilarity(left, right) {
  if (!left || !right) return 0;
  if (left === right) return 1;
  const a = new Set(left.split(' ').filter(Boolean));
  const b = new Set(right.split(' ').filter(Boolean));
  if (!a.size || !b.size) return 0;
  const intersection = [...a].filter((token) => b.has(token)).length;
  return Math.min(
    intersection / Math.min(a.size, b.size),
    intersection / Math.max(a.size, b.size) + 0.25 * (intersection / Math.min(a.size, b.size)),
  );
}

function stableOfferKey(job) {
  const id = String(job?.id || job?.jobId || '').trim();
  if (id) return `id:${id}`;
  const url = normalizeUrl(job?.url || job?.applyUrl || job?.sourceUrl || '');
  if (url) return `url:${url}`;
  return [employerFingerprint(employerNameOf(job)), titleOf(job).toLowerCase(), cantonOf(job), String(job?.location || '')]
    .join('|');
}

function deduplicateLiveJobs(jobs) {
  const byKey = new Map();
  for (const job of jobs) {
    if (!isLiveOffer(job)) continue;
    const key = stableOfferKey(job);
    if (!byKey.has(key)) byKey.set(key, job);
  }
  return [...byKey.values()];
}

function groupKey(company, canton) {
  return `${employerFingerprint(company)}|${canton}`;
}

export function matchOfficialOffer(official, aggregator) {
  const officialUrl = new Set(sourceUrlsOf(official));
  const aggregatorUrl = new Set(sourceUrlsOf(aggregator));
  if ([...officialUrl].some((url) => aggregatorUrl.has(url))) {
    return { matched: true, reason: 'same-normalized-url', titleSimilarity: 1, employerSimilarity: 1 };
  }
  const officialEmployer = employerFingerprint(employerNameOf(official));
  const aggregatorEmployer = employerFingerprint(employerNameOf(aggregator));
  const employerScore = employerSimilarity(officialEmployer, aggregatorEmployer);
  if (!officialEmployer || !aggregatorEmployer || employerScore < 0.75) return { matched: false };
  const officialCanton = cantonOf(official);
  const aggregatorCanton = cantonOf(aggregator);
  if (officialCanton !== 'UNKNOWN' && aggregatorCanton !== 'UNKNOWN' && officialCanton !== aggregatorCanton) {
    return { matched: false };
  }
  const similarity = titleSimilarity(titleOf(official), titleOf(aggregator));
  if (similarity < 0.80) return { matched: false, employerSimilarity: employerScore, titleSimilarity: similarity };
  return {
    matched: true,
    reason: 'employer-canton-title',
    employerSimilarity: employerScore,
    titleSimilarity: similarity,
  };
}

function rate(numerator, denominator) {
  return denominator ? Number((numerator / denominator).toFixed(6)) : null;
}

function emptyTypedMeasure() {
  return {
    officialOffers: 0,
    aggregatorMatchedOffers: 0,
    unmatchedOfficialOffers: 0,
    // Absence from a partial aggregator population is not exclusivity.
    exclusiveOffers: null,
    exclusivityRate: null,
    employers: 0,
  };
}

function emptyMeasure() {
  return {
    officialOffers: 0,
    aggregatorMatchedOffers: 0,
    unmatchedOfficialOffers: 0,
    exclusiveOffers: null,
    exclusivityRate: null,
    employers: 0,
    byEmployerType: {
      agency: emptyTypedMeasure(),
      direct: emptyTypedMeasure(),
      unknown: emptyTypedMeasure(),
    },
  };
}

function addMeasure(target, offer, matched, classification) {
  target.officialOffers += 1;
  if (matched) target.aggregatorMatchedOffers += 1;
  else target.unmatchedOfficialOffers += 1;
  const type = target.byEmployerType[classification] ? classification : 'unknown';
  const typed = target.byEmployerType[type];
  typed.officialOffers += 1;
  if (matched) typed.aggregatorMatchedOffers += 1;
  else typed.unmatchedOfficialOffers += 1;
  target._employers.add(employerFingerprint(employerNameOf(offer)));
  target._employersByType[type].add(employerFingerprint(employerNameOf(offer)));
}

function finalizeMeasure(target) {
  target.exclusiveOffers = null;
  target.exclusivityRate = null;
  target.employers = target._employers.size;
  for (const type of Object.keys(target.byEmployerType)) {
    target.byEmployerType[type].exclusiveOffers = null;
    target.byEmployerType[type].exclusivityRate = null;
    target.byEmployerType[type].employers = target._employersByType[type].size;
  }
  delete target._employers;
  delete target._employersByType;
  return target;
}

function withMeasureInternals(measure = emptyMeasure()) {
  measure._employers = new Set();
  measure._employersByType = { agency: new Set(), direct: new Set(), unknown: new Set() };
  return measure;
}

function baseMethod() {
  return {
    officialSource: {
      crawlerKey: OFFICIAL_CRAWLER_KEY,
      slice: `data/${OFFICIAL_SLICE_RELATIVE_PATH}`,
      liveDefinition: 'record presente nella snapshot corrente e non marcato expired, inactive, archived, closed, filled o removed',
    },
    aggregatorSource: {
      inclusion: 'record live delle altre slice by-crawler con URL su un dominio noto e comparabile',
      domains: [...COMPARABLE_AGGREGATOR_DOMAINS],
      excludedDomains: Object.fromEntries(NON_COMPARABLE_AGGREGATOR_DOMAINS.map((domain) => [domain, 'canale ufficiale/pubblico SECO, non evidenza indipendente'])),
      registry: 'scripts/lib/known-aggregator-domains.mjs:isKnownAggregatorDomain',
    },
    comparison: {
      deduplication: 'per slice: id/jobId, altrimenti URL normalizzato (hash e tracking rimossi), altrimenti datore+titolo+cantone+località; le slice non condividono ID implicitamente',
      employer: 'normalizzazione Unicode, rimozione forme legali, indice esatto + token condivisi, overlap token >= 0.75',
      canton: 'se entrambe le offerte hanno il cantone, deve coincidere; cantone mancante non forza il rifiuto',
      title: 'token overlap >= 0.80 dopo rimozione di stopword, percentuali e token numerici',
      unmatched: 'offerta SECO senza match osservato nelle slice presenti; non significa esclusiva',
      exclusivity: 'nonMisurabile finché non è attestata una popolazione aggregatore completa e confrontabile per portale',
    },
    employerSizeProxy: {
      definition: 'fascia di volume del datore, non numero di dipendenti: conteggio globale delle offerte SECO live per nome normalizzato',
      bands: OFFER_VOLUME_BANDS.map(({ key, min, max, label }) => ({ key, min, max: Number.isFinite(max) ? max : null, label })),
    },
    staffingClassification: {
      classifierVersion: STAFFING_CLASSIFIER_VERSION,
      registry: `data/${STAFFING_REGISTRY_RELATIVE_PATH}`,
      agency: 'registry.agencies oppure segnali di nome, employerDisclosed e frequenza multi-cantonale; l evidence resta nel report',
      direct: 'residuo non riconosciuto dal registry e dai segnali; non equivale a verifica completa del registro SECO',
      unknown: 'nome mancante o registry non disponibile/malformata',
      manualAudit: `data/prospector/${STAFFING_AUDIT_FILENAME}`,
      referenceEstimate: OWNER_STAFFING_REFERENCE,
    },
  };
}

function bandForCount(count) {
  return OFFER_VOLUME_BANDS.find((band) => count >= band.min && count <= band.max)?.key || 'micro';
}

function sourceSliceFiles(dataRoot) {
  const directory = path.join(dataRoot, 'jobs', 'by-crawler');
  try {
    return fs.readdirSync(directory)
      .filter((file) => file.endsWith('.json'))
      .sort()
      .map((file) => path.join(directory, file));
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
}

function newGroups() {
  const groups = {};
  for (const canton of [...CANTONS, 'UNKNOWN']) {
    groups[canton] = Object.fromEntries(OFFER_VOLUME_BANDS.map(({ key }) => [key, withMeasureInternals()]));
  }
  return groups;
}

function registryPathFor(dataRoot, explicitPath) {
  return explicitPath || path.join(dataRoot, STAFFING_REGISTRY_RELATIVE_PATH);
}

function sourceRelativePath(filePath) {
  return path.relative(ROOT, filePath).replaceAll(path.sep, '/');
}

function sourceRecordKey(sourceSlice, offerKey) {
  return `${sourceSlice}|${offerKey}`;
}

function aggregatorEntriesForSlice(filePath, slice) {
  const sourceSlice = sourceRelativePath(filePath);
  const jobsByKey = new Map();
  for (const job of deduplicateLiveJobs(slice.jobs)) {
    const domains = comparableAggregatorDomainsOf(job);
    if (!domains.length) continue;
    const offerKey = stableOfferKey(job);
    if (!jobsByKey.has(offerKey)) jobsByKey.set(offerKey, { job, offerKey, sourceSlice, domains });
  }
  return [...jobsByKey.values()].flatMap(({ job, offerKey, sourceSlice, domains }) => domains.map((portal) => ({
    key: `${sourceRecordKey(sourceSlice, offerKey)}|${portal}`,
    recordKey: sourceRecordKey(sourceSlice, offerKey),
    sourceSlice,
    portal,
    job,
  })));
}

function addIndexValue(index, key, entry) {
  if (!key) return;
  if (!index.has(key)) index.set(key, []);
  index.get(key).push(entry);
}

function buildEmployerCandidateIndex(entries) {
  const byEmployer = new Map();
  const byEmployerAndCanton = new Map();
  const byToken = new Map();
  for (const entry of entries) {
    const employer = employerFingerprint(employerNameOf(entry.job));
    addIndexValue(byEmployer, employer, entry);
    addIndexValue(byEmployerAndCanton, groupKey(employer, cantonOf(entry.job)), entry);
    for (const token of employerTokens(employer)) addIndexValue(byToken, token, entry);
  }
  return { byEmployer, byEmployerAndCanton, byToken };
}

function candidateEntriesFor(offer, index) {
  const employer = employerFingerprint(employerNameOf(offer));
  const exact = [
    ...(index.byEmployerAndCanton.get(groupKey(employer, cantonOf(offer))) || []),
    ...(index.byEmployer.get(employer) || []),
  ];
  const fuzzy = [];
  for (const token of employerTokens(employer)) fuzzy.push(...(index.byToken.get(token) || []));
  const seen = new Set();
  return [...exact, ...fuzzy].filter((entry) => {
    if (seen.has(entry.key)) return false;
    seen.add(entry.key);
    return true;
  });
}

function matchOfficialOffers(officialOffers, entries) {
  const index = buildEmployerCandidateIndex(entries);
  const matchedOfficialKeys = new Set();
  const matchedAggregatorKeys = new Set();
  const reasons = {};
  for (const official of officialOffers) {
    const candidates = candidateEntriesFor(official, index);
    const match = candidates
      .map((entry) => ({ entry, result: matchOfficialOffer(official, entry.job) }))
      .find(({ result }) => result.matched);
    if (!match) continue;
    matchedOfficialKeys.add(stableOfferKey(official));
    matchedAggregatorKeys.add(match.entry.key);
    reasons[match.result.reason] = (reasons[match.result.reason] || 0) + 1;
  }
  return { matchedOfficialKeys, matchedAggregatorKeys, reasons };
}

function aggregatorIdentity(portalEntries) {
  const material = [...portalEntries.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([portal, entries]) => `${portal}:${entries.map((entry) => entry.key).sort().join(',')}`)
    .join(';');
  return crypto.createHash('sha256').update(material).digest('hex').slice(0, 24);
}

function sourceFingerprint(officialDocument, population, aggregatorIdentityValue) {
  return [
    officialDocument.assembledAt || 'unknown',
    officialDocument.runId || 'unknown',
    population.officialOffers,
    population.aggregatorOffers,
    population.aggregatorMatchedOffers,
    aggregatorIdentityValue,
  ].join('|');
}

function controlledPortalMeasurement(entries, sampleOffers, sampleEmployerKeys) {
  const matches = matchOfficialOffers(sampleOffers, entries);
  const matchedEmployerKeys = new Set(sampleOffers
    .filter((offer) => matches.matchedOfficialKeys.has(stableOfferKey(offer)))
    .map((offer) => employerFingerprint(employerNameOf(offer))));
  return {
    sampleEmployers: sampleEmployerKeys.size,
    matchedEmployers: matchedEmployerKeys.size,
    matchedEmployerRate: null,
  };
}

function portalMeasurement(portal, entries, officialOffers, controlledSample) {
  const matches = matchOfficialOffers(officialOffers, entries);
  const sourceSlices = [...new Set(entries.map((entry) => entry.sourceSlice))].sort();
  return {
    portal,
    status: 'nonMisurabile',
    observed: entries.length > 0,
    reason: entries.length
      ? 'slice presente, ma completezza e stessa finestra temporale del SECO non sono attestate; gli unmatched non sono esclusive'
      : 'nessuna offerta live comparabile osservata nelle slice by-crawler disponibili',
    sourceSlices,
    officialOffers: officialOffers.length,
    aggregatorOffers: entries.length,
    matchedOfficialOffers: matches.matchedOfficialKeys.size,
    unmatchedOfficialOffers: officialOffers.length - matches.matchedOfficialKeys.size,
    unmatchedAggregatorOffers: entries.length - matches.matchedAggregatorKeys.size,
    observedMatchReasons: matches.reasons,
    controlledSample: controlledPortalMeasurement(
      entries,
      controlledSample.offers,
      controlledSample.employerKeys,
    ),
    exclusiveOffers: null,
    exclusivityRate: null,
  };
}

function invalidEmptyExclusivitySnapshot(item) {
  const population = item?.population;
  return item?.status === 'ok'
    && Number(population?.aggregatorOffers) === 0
    && Number(population?.aggregatorSlices) === 0
    && Number(population?.aggregatorMatchedOffers) === 0
    && Number(population?.exclusiveOffers) === Number(population?.officialOffers)
    && Number(population?.exclusivityRate) === 1;
}

/**
 * Measure observed overlap without turning an incomplete aggregator corpus
 * into a proof of exclusivity. CI passes its normal data root; tests pass a
 * tiny fixture root.
 */
export function measureCoverageExclusivity({
  dataRoot = DATA_ROOT,
  registryPath,
  now = new Date().toISOString(),
} = {}) {
  const method = baseMethod();
  const officialPath = path.join(dataRoot, OFFICIAL_SLICE_RELATIVE_PATH);
  if (!fs.existsSync(officialPath)) {
    return {
      schemaVersion: COVERAGE_EXCLUSIVITY_VERSION,
      metric: 'official-seco-offer-exclusivity-vs-known-aggregator-slices',
      status: 'unavailable',
      generatedAt: now,
      method,
      source: { officialSlice: `data/${OFFICIAL_SLICE_RELATIVE_PATH}`, reason: 'official-slice-missing' },
    };
  }

  let officialDocument;
  try {
    officialDocument = loadSliceDocument(officialPath);
  } catch (error) {
    return {
      schemaVersion: COVERAGE_EXCLUSIVITY_VERSION,
      metric: 'official-seco-offer-exclusivity-vs-known-aggregator-slices',
      status: 'unavailable',
      generatedAt: now,
      method,
      source: { officialSlice: `data/${OFFICIAL_SLICE_RELATIVE_PATH}`, reason: 'official-slice-malformed', detail: String(error?.message || error).slice(0, 160) },
    };
  }

  const officialOffers = deduplicateLiveJobs(officialDocument.jobs);
  const allFiles = sourceSliceFiles(dataRoot);
  const aggregatorSlices = new Set();
  const aggregatorRecords = new Map();
  const portalEntries = new Map(COMPARABLE_AGGREGATOR_DOMAINS.map((domain) => [domain, []]));
  const observedAggregatorDomains = new Set();
  const observedNonComparableDomains = new Set();
  for (const filePath of allFiles) {
    if (path.resolve(filePath) === path.resolve(officialPath)) continue;
    let slice;
    try { slice = loadSliceDocument(filePath); } catch { continue; }
    for (const job of deduplicateLiveJobs(slice.jobs)) {
      for (const domain of nonComparableAggregatorDomainsOf(job)) observedNonComparableDomains.add(domain);
    }
    const entries = aggregatorEntriesForSlice(filePath, slice);
    if (!entries.length) continue;
    const sourceSlice = sourceRelativePath(filePath);
    aggregatorSlices.add(sourceSlice);
    for (const entry of entries) {
      observedAggregatorDomains.add(entry.portal);
      if (!portalEntries.has(entry.portal)) portalEntries.set(entry.portal, []);
      portalEntries.get(entry.portal).push(entry);
      if (!aggregatorRecords.has(entry.recordKey)) aggregatorRecords.set(entry.recordKey, entry);
    }
  }

  const allAggregatorEntries = [...portalEntries.values()].flat();
  const globalMatches = matchOfficialOffers(officialOffers, allAggregatorEntries);
  const matchedRecords = new Set(allAggregatorEntries
    .filter((entry) => globalMatches.matchedAggregatorKeys.has(entry.key))
    .map((entry) => entry.recordKey));
  const aggregatorIdentityValue = aggregatorIdentity(portalEntries);

  const officialEmployerProfiles = new Map();
  const officialOffersByEmployer = new Map();
  for (const offer of officialOffers) {
    const employer = employerFingerprint(employerNameOf(offer));
    if (!officialEmployerProfiles.has(employer)) officialEmployerProfiles.set(employer, {
      offerCount: 0,
      cantons: new Set(),
      undisclosedCount: 0,
    });
    const profile = officialEmployerProfiles.get(employer);
    if (!officialOffersByEmployer.has(employer)) officialOffersByEmployer.set(employer, []);
    officialOffersByEmployer.get(employer).push(offer);
    profile.offerCount += 1;
    profile.cantons.add(cantonOf(offer));
    if (offer.employerDisclosed === false) profile.undisclosedCount += 1;
  }
  const registry = loadStaffingRegistry(registryPathFor(dataRoot, registryPath));
  const classificationCache = new Map();
  const classificationFor = (offer) => {
    const employer = employerNameOf(offer);
    if (!classificationCache.has(employer)) {
      const profile = officialEmployerProfiles.get(employerFingerprint(employer));
      classificationCache.set(employer, classifyStaffingEmployer(employer, registry, {
        offerCount: profile?.offerCount,
        cantons: profile ? [...profile.cantons] : [cantonOf(offer)],
        cantonCount: profile?.cantons.size || 0,
        employerDisclosed: offer.employerDisclosed,
        undisclosedCount: profile?.undisclosedCount,
      }));
    }
    return classificationCache.get(employer);
  };
  const controlledSampleEmployers = [...officialEmployerProfiles.entries()]
    .filter(([employer, profile]) => profile.offerCount <= 4
      && profile.cantons.size === 1
      && profile.cantons.has('TI')
      && classificationFor(officialOffersByEmployer.get(employer)[0]).classification === 'direct')
    .sort(([left], [right]) => left.localeCompare(right))
    .slice(0, 30)
    .map(([employer]) => employer);
  const controlledSample = {
    status: controlledSampleEmployers.length === 30 ? 'ok' : 'insufficient',
    selection: '30 datori distinti con 1–4 offerte vive, solo TI, classificati direct; ordinamento per nome normalizzato',
    sampleSize: controlledSampleEmployers.length,
    employerKeys: new Set(controlledSampleEmployers),
    employers: controlledSampleEmployers,
    offers: officialOffers.filter((offer) => controlledSampleEmployers.includes(employerFingerprint(employerNameOf(offer)))),
    note: 'campione di overlap osservato, non denominatore di esclusività; anche 0 match non dimostra che le offerte siano esclusive',
  };

  const groups = newGroups();
  const byType = {
    agency: { officialOffers: 0, aggregatorMatchedOffers: 0, unmatchedOfficialOffers: 0, employers: new Set() },
    direct: { officialOffers: 0, aggregatorMatchedOffers: 0, unmatchedOfficialOffers: 0, employers: new Set() },
    unknown: { officialOffers: 0, aggregatorMatchedOffers: 0, unmatchedOfficialOffers: 0, employers: new Set() },
  };
  for (const offer of officialOffers) {
    const employer = employerFingerprint(employerNameOf(offer));
    const canton = cantonOf(offer);
    const profile = officialEmployerProfiles.get(employer);
    const band = bandForCount(profile?.offerCount || 1);
    const matched = globalMatches.matchedOfficialKeys.has(stableOfferKey(offer));
    const classification = classificationFor(offer).classification;
    addMeasure(groups[canton][band], offer, matched, classification);
    const type = byType[classification] ? classification : 'unknown';
    byType[type].officialOffers += 1;
    byType[type].employers.add(employer);
    if (matched) byType[type].aggregatorMatchedOffers += 1;
    else byType[type].unmatchedOfficialOffers += 1;
  }

  const population = {
    officialOffers: officialOffers.length,
    officialEmployers: new Set(officialOffers.map((offer) => employerFingerprint(employerNameOf(offer)))).size,
    aggregatorOffers: aggregatorRecords.size,
    aggregatorPortalOffers: allAggregatorEntries.length,
    aggregatorSlices: aggregatorSlices.size,
    aggregatorMatchedOffers: globalMatches.matchedOfficialKeys.size,
    unmatchedOfficialOffers: officialOffers.length - globalMatches.matchedOfficialKeys.size,
    unmatchedAggregatorOffers: aggregatorRecords.size - matchedRecords.size,
    // This is deliberately null: the observed slices are not a complete,
    // time-aligned denominator for any portal.
    exclusiveOffers: null,
    exclusivityRate: null,
    measurementStatus: 'nonMisurabile',
    measurementReason: aggregatorRecords.size
      ? 'slice aggregatori presenti ma popolazione non attestata completa e temporalmente allineata'
      : 'nessuna slice aggregatore comparabile con offerte live osservata',
  };

  for (const groupByCanton of Object.values(groups)) {
    for (const band of Object.keys(groupByCanton)) finalizeMeasure(groupByCanton[band]);
  }
  const classificationCounts = Object.fromEntries(Object.entries(byType).map(([type, values]) => [type, {
    officialOffers: values.officialOffers,
    offerShare: rate(values.officialOffers, officialOffers.length),
    aggregatorMatchedOffers: values.aggregatorMatchedOffers,
    unmatchedOfficialOffers: values.unmatchedOfficialOffers,
    exclusiveOffers: null,
    exclusivityRate: null,
    employers: values.employers.size,
  }]));
  const classificationAudit = auditStaffingClassifier({
    dataRoot,
    registryPath: registryPathFor(dataRoot, registryPath),
  });
  const portals = Object.fromEntries(COMPARABLE_AGGREGATOR_DOMAINS.map((portal) => [
    portal,
    portalMeasurement(portal, portalEntries.get(portal) || [], officialOffers, controlledSample),
  ]));
  return {
    schemaVersion: COVERAGE_EXCLUSIVITY_VERSION,
    metric: 'official-seco-offer-exclusivity-vs-known-aggregator-slices',
    status: 'ok',
    generatedAt: now,
    source: {
      officialSlice: `data/${OFFICIAL_SLICE_RELATIVE_PATH}`,
      officialAssembledAt: officialDocument.assembledAt,
      officialRunId: officialDocument.runId,
      aggregatorSlices: [...aggregatorSlices].sort(),
      observedAggregatorDomains: [...observedAggregatorDomains].sort(),
      observedNonComparableDomains: [...observedNonComparableDomains].sort(),
      snapshotKey: sourceFingerprint(officialDocument, population, aggregatorIdentityValue),
      aggregatorIdentity: aggregatorIdentityValue,
    },
    population,
    portals,
    controlledOverlapSample: {
      status: controlledSample.status,
      selection: controlledSample.selection,
      sampleSize: controlledSample.sampleSize,
      employers: controlledSample.employers,
      note: controlledSample.note,
      portals: Object.fromEntries(Object.entries(portals).map(([portal, measurement]) => [portal, measurement.controlledSample])),
    },
    classification: {
      registryAvailable: registry.available,
      registryCurated: registry.curated,
      registryFetchedAt: registry.fetchedAt,
      registryEntryCount: registry.agencies.length,
      referenceEstimate: OWNER_STAFFING_REFERENCE,
      ...classificationCounts,
    },
    classificationAudit,
    byCantonAndSize: groups,
    method,
  };
}

export function coverageHistoryPath(outputPath = process.env.PROSPECTOR_COVERAGE_HISTORY_OUT) {
  return outputPath || path.join(PROSPECTOR_DIR, COVERAGE_HISTORY_FILENAME);
}

export function loadCoverageHistory(outputPath = coverageHistoryPath()) {
  try {
    const history = readJson(outputPath);
    if (!Array.isArray(history?.runs)) throw new Error('coverage history has no runs array');
    return history;
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return {
        schemaVersion: COVERAGE_HISTORY_VERSION,
        metric: 'official-seco-offer-exclusivity-vs-known-aggregator-slices',
        metricVersion: COVERAGE_EXCLUSIVITY_VERSION,
        runs: [],
      };
    }
    throw error;
  }
}

export function appendCoverageHistory(metric, outputPath = coverageHistoryPath()) {
  if (metric?.status !== 'ok') return loadCoverageHistory(outputPath);
  const history = loadCoverageHistory(outputPath);
  const runId = metric.source?.snapshotKey || `${metric.generatedAt}:${metric.population?.officialOffers || 0}`;
  const run = { ...metric, runId };
  const invalidatedAt = metric.generatedAt;
  history.runs = history.runs.map((item) => {
    if (item.runId === runId || !invalidEmptyExclusivitySnapshot(item) || item.status === 'invalidated') return item;
    return {
      ...item,
      status: 'invalidated',
      invalidatedAt,
      invalidatedReason: 'popolazione aggregatori vuota contata erroneamente come prova di esclusività',
      supersededBy: runId,
    };
  });
  const existingIndex = history.runs.findIndex((item) => item.runId === runId);
  if (existingIndex >= 0) history.runs[existingIndex] = run;
  else history.runs.push(run);
  history.runs = history.runs.slice(-400);
  history.schemaVersion = COVERAGE_HISTORY_VERSION;
  history.metricVersion = COVERAGE_EXCLUSIVITY_VERSION;
  history.metric = metric.metric;
  history.method = metric.method;
  history.latestRunId = runId;
  history.updatedAt = metric.generatedAt;
  writeJsonAtomic(outputPath, history);
  return history;
}
