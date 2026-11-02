import fs from 'node:fs';
import path from 'node:path';
import { writeJsonAtomic } from '../atomic-write-json.mjs';
import { isKnownAggregatorDomain, KNOWN_AGGREGATOR_DOMAINS } from '../known-aggregator-domains.mjs';
import { CANTONS, DATA_ROOT, PROSPECTOR_DIR, ROOT } from './config.mjs';
import { normalizeCompanyName } from './coverage.mjs';
import {
  classifyStaffingEmployer,
  loadStaffingRegistry,
  STAFFING_CLASSIFIER_VERSION,
  STAFFING_REGISTRY_RELATIVE_PATH,
} from './seco-staffing-classifier.mjs';

export const COVERAGE_EXCLUSIVITY_VERSION = 1;
export const COVERAGE_HISTORY_VERSION = 1;
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
  return Math.min(intersection / Math.min(a.size, b.size), intersection / Math.max(a.size, b.size) + 0.25 * (intersection / Math.min(a.size, b.size)));
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

function emptyMeasure() {
  return {
    officialOffers: 0,
    aggregatorMatchedOffers: 0,
    exclusiveOffers: 0,
    exclusivityRate: null,
    employers: 0,
    byEmployerType: {
      agency: { officialOffers: 0, aggregatorMatchedOffers: 0, exclusiveOffers: 0, exclusivityRate: null, employers: 0 },
      direct: { officialOffers: 0, aggregatorMatchedOffers: 0, exclusiveOffers: 0, exclusivityRate: null, employers: 0 },
      unknown: { officialOffers: 0, aggregatorMatchedOffers: 0, exclusiveOffers: 0, exclusivityRate: null, employers: 0 },
    },
  };
}

function addMeasure(target, offer, matched, classification) {
  target.officialOffers += 1;
  if (matched) target.aggregatorMatchedOffers += 1;
  else target.exclusiveOffers += 1;
  const type = target.byEmployerType[classification] ? classification : 'unknown';
  const typed = target.byEmployerType[type];
  typed.officialOffers += 1;
  if (matched) typed.aggregatorMatchedOffers += 1;
  else typed.exclusiveOffers += 1;
  target._employers.add(employerFingerprint(employerNameOf(offer)));
  target._employersByType[type].add(employerFingerprint(employerNameOf(offer)));
}

function finalizeMeasure(target) {
  target.exclusivityRate = rate(target.exclusiveOffers, target.officialOffers);
  target.employers = target._employers.size;
  for (const type of Object.keys(target.byEmployerType)) {
    target.byEmployerType[type].exclusivityRate = rate(
      target.byEmployerType[type].exclusiveOffers,
      target.byEmployerType[type].officialOffers,
    );
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
      inclusion: 'ogni record live delle altre slice by-crawler con almeno un url/applyUrl/sourceUrl/sourcePageUrl/originalUrl su un dominio noto',
      domains: [...KNOWN_AGGREGATOR_DOMAINS].sort(),
      registry: 'scripts/lib/known-aggregator-domains.mjs:isKnownAggregatorDomain',
    },
    comparison: {
      deduplication: 'id/jobId, altrimenti URL normalizzato (hash e tracking rimossi), altrimenti datore+titolo+cantone+località',
      employer: 'normalizzazione Unicode, rimozione forme legali, overlap token >= 0.75',
      canton: 'se entrambe le offerte hanno il cantone, deve coincidere; cantone mancante non forza il rifiuto',
      title: 'token overlap >= 0.80 dopo rimozione di stopword, percentuali e token numerici',
      exclusiveOffer: 'offerta SECO live senza almeno una corrispondenza nella popolazione aggregatori',
    },
    employerSizeProxy: {
      definition: 'fascia di volume del datore, non numero di dipendenti: conteggio globale delle offerte SECO live per nome normalizzato',
      bands: OFFER_VOLUME_BANDS.map(({ key, min, max, label }) => ({ key, min, max: Number.isFinite(max) ? max : null, label })),
    },
    staffingClassification: {
      classifierVersion: STAFFING_CLASSIFIER_VERSION,
      registry: `data/${STAFFING_REGISTRY_RELATIVE_PATH}`,
      agency: 'nome SECO che matcha un alias di registry.agencies',
      direct: 'residuo non matchato nella registry curata; non equivale a verifica completa del registro SECO',
      unknown: 'nome mancante o registry non disponibile/malformata',
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

function sourceFingerprint(officialDocument, population) {
  return [
    officialDocument.assembledAt || 'unknown',
    officialDocument.runId || 'unknown',
    population.officialOffers,
    population.aggregatorOffers,
    population.aggregatorMatchedOffers,
    population.exclusiveOffers,
  ].join('|');
}

/**
 * Measure the official-vs-aggregator gap without materializing the large
 * dataset in the sparse agent worktree. CI passes its normal data root; tests
 * pass a tiny fixture root.
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
  const aggregatorSlices = [];
  const aggregatorOffersByKey = new Map();
  const observedAggregatorDomains = new Set();
  for (const filePath of allFiles) {
    if (path.resolve(filePath) === path.resolve(officialPath)) continue;
    let slice;
    try { slice = loadSliceDocument(filePath); } catch { continue; }
    const liveAggregatorOffers = deduplicateLiveJobs(slice.jobs)
      .filter((job) => knownAggregatorUrlsOf(job).length);
    if (!liveAggregatorOffers.length) continue;
    aggregatorSlices.push(path.relative(ROOT, filePath));
    for (const job of liveAggregatorOffers) {
      for (const url of knownAggregatorUrlsOf(job)) {
        try { observedAggregatorDomains.add(new URL(url).hostname.toLowerCase().replace(/^www\./, '')); } catch { /* normalized above */ }
      }
      const key = stableOfferKey(job);
      if (!aggregatorOffersByKey.has(key)) aggregatorOffersByKey.set(key, job);
    }
  }
  const aggregatorOffers = [...aggregatorOffersByKey.values()];
  const byEmployerAndCanton = new Map();
  const byEmployer = new Map();
  for (const offer of aggregatorOffers) {
    const employer = employerFingerprint(employerNameOf(offer));
    const canton = cantonOf(offer);
    const exactKey = groupKey(employer, canton);
    if (!byEmployerAndCanton.has(exactKey)) byEmployerAndCanton.set(exactKey, []);
    byEmployerAndCanton.get(exactKey).push(offer);
    if (!byEmployer.has(employer)) byEmployer.set(employer, []);
    byEmployer.get(employer).push(offer);
  }

  const officialEmployerCounts = new Map();
  for (const offer of officialOffers) {
    const employer = employerFingerprint(employerNameOf(offer));
    officialEmployerCounts.set(employer, (officialEmployerCounts.get(employer) || 0) + 1);
  }
  const registry = loadStaffingRegistry(registryPathFor(dataRoot, registryPath));
  const classificationCache = new Map();
  const classificationFor = (offer) => {
    const employer = employerNameOf(offer);
    if (!classificationCache.has(employer)) classificationCache.set(employer, classifyStaffingEmployer(employer, registry));
    return classificationCache.get(employer);
  };
  const groups = newGroups();
  let aggregatorMatchedOffers = 0;
  const byType = {
    agency: { officialOffers: 0, aggregatorMatchedOffers: 0, exclusiveOffers: 0, employers: new Set() },
    direct: { officialOffers: 0, aggregatorMatchedOffers: 0, exclusiveOffers: 0, employers: new Set() },
    unknown: { officialOffers: 0, aggregatorMatchedOffers: 0, exclusiveOffers: 0, employers: new Set() },
  };

  for (const offer of officialOffers) {
    const employer = employerFingerprint(employerNameOf(offer));
    const canton = cantonOf(offer);
    const band = bandForCount(officialEmployerCounts.get(employer) || 1);
    const candidates = [
      ...(byEmployerAndCanton.get(groupKey(employer, canton)) || []),
      ...(byEmployer.get(employer) || []),
    ];
    const seen = new Set();
    const match = candidates
      .filter((candidate) => {
        const key = stableOfferKey(candidate);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .map((candidate) => matchOfficialOffer(offer, candidate))
      .find((result) => result.matched);
    const matched = Boolean(match);
    const classification = classificationFor(offer).classification;
    const group = groups[canton][band];
    addMeasure(group, offer, matched, classification);
    const type = byType[classification] ? classification : 'unknown';
    byType[type].officialOffers += 1;
    byType[type].employers.add(employer);
    if (matched) {
      aggregatorMatchedOffers += 1;
      byType[type].aggregatorMatchedOffers += 1;
    } else {
      byType[type].exclusiveOffers += 1;
    }
  }

  const population = {
    officialOffers: officialOffers.length,
    officialEmployers: new Set(officialOffers.map((offer) => employerFingerprint(employerNameOf(offer)))).size,
    aggregatorOffers: aggregatorOffers.length,
    aggregatorSlices: aggregatorSlices.length,
    aggregatorMatchedOffers,
    exclusiveOffers: officialOffers.length - aggregatorMatchedOffers,
    exclusivityRate: rate(officialOffers.length - aggregatorMatchedOffers, officialOffers.length),
  };
  for (const groupByCanton of Object.values(groups)) {
    for (const band of Object.keys(groupByCanton)) finalizeMeasure(groupByCanton[band]);
  }
  const classificationCounts = Object.fromEntries(Object.entries(byType).map(([type, values]) => [type, {
    officialOffers: values.officialOffers,
    offerShare: rate(values.officialOffers, officialOffers.length),
    aggregatorMatchedOffers: values.aggregatorMatchedOffers,
    exclusiveOffers: values.exclusiveOffers,
    exclusivityRate: rate(values.exclusiveOffers, values.officialOffers),
    employers: values.employers.size,
  }]));

  return {
    schemaVersion: COVERAGE_EXCLUSIVITY_VERSION,
    metric: 'official-seco-offer-exclusivity-vs-known-aggregator-slices',
    status: 'ok',
    generatedAt: now,
    source: {
      officialSlice: `data/${OFFICIAL_SLICE_RELATIVE_PATH}`,
      officialAssembledAt: officialDocument.assembledAt,
      officialRunId: officialDocument.runId,
      aggregatorSlices,
      observedAggregatorDomains: [...observedAggregatorDomains].sort(),
      snapshotKey: sourceFingerprint(officialDocument, population),
    },
    population,
    classification: {
      registryAvailable: registry.available,
      registryCurated: registry.curated,
      registryFetchedAt: registry.fetchedAt,
      registryEntryCount: registry.agencies.length,
      referenceEstimate: OWNER_STAFFING_REFERENCE,
      ...classificationCounts,
    },
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
