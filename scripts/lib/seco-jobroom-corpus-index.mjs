/**
 * What the dedicated crawlers already publish, reduced to the keys a job-room
 * ad can be matched on. Rule of the feed: when an employer's own source is
 * already on the site, that source wins and the job-room copy stays out.
 *
 * Read from the slices on disk because they are the only record of what was
 * actually crawled (`crawler-source-hosts.mjs` makes the same argument). An
 * empty index is not "no duplicates": it means the slices are not there, and
 * publishing on that answer would duplicate every employer we already follow,
 * so `buildCorpusIndex` throws instead.
 *
 * Match strengths, strongest first:
 *   - `url`:       the ad's channel is a vacancy URL a crawler already holds;
 *   - `host`:      the channel sits on a host exactly one crawler reads, so that
 *                  crawler is the employer's front door for this vacancy. Hosts
 *                  shared by two or more keys are hosted-ATS lobbies and known
 *                  job boards identify nobody: neither ever matches here;
 *   - `reference`: same employer and the ad's reference appears in that
 *                  employer's vacancy URLs or stored ids;
 *   - `title`:     same employer, same title (up to gender and workload
 *                  markers), same postal code or town.
 *
 * Deliberately no "same employer" rule on its own: a dedicated crawler can
 * cover one site of an employer, and the feed's other sites would disappear.
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  isSliceFile,
  normalizeJobUrl,
  normalizeSourceHost,
} from './crawler-source-hosts.mjs';
import { extractStableJobId } from './job-match-key.mjs';
import { isKnownAggregatorDomain } from './known-aggregator-domains.mjs';
import { normalizeCompanyName } from './prospector/coverage.mjs';

const GENDER_MARKER_RE = /\(\s*(?:[mwfdxhia](?:\s*[/|,]\s*[mwfdxhia]){1,3}|all genders)\s*\)/giu;
const WORKLOAD_RE = /\b\d{1,3}\s*(?:%|prozent)?\s*(?:[-–—]|bis|à|a)\s*\d{1,3}\s*%|\b\d{1,3}\s*%/giu;
const REFERENCE_MIN_LENGTH = 5;

/** @param {string} title */
export function comparableTitle(title = '') {
  return String(title)
    .replace(GENDER_MARKER_RE, ' ')
    .replace(WORKLOAD_RE, ' ')
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function hostOf(url) {
  try {
    return normalizeSourceHost(new URL(url).hostname);
  } catch {
    return '';
  }
}

function comparablePlace(value = '') {
  return String(value).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
}

function referenceTokens(url = '') {
  let pathname = '';
  try { pathname = new URL(url).pathname + new URL(url).search; } catch { return []; }
  return pathname.toLowerCase().split(/[^a-z0-9_-]+/).filter(
    (token) => token.length >= REFERENCE_MIN_LENGTH && /\d/.test(token),
  );
}

function hostScopedStableKey(url) {
  const host = hostOf(url);
  // `extractStableJobId` can return a hostless numeric key: two employers'
  // vacancy 123456 are not the same vacancy.
  return host ? `${host}|${extractStableJobId(url)}` : '';
}

/**
 * @typedef {Object} CorpusIndex
 * @property {Set<string>} urls
 * @property {Set<string>} stableKeys
 * @property {Map<string, Set<string>>} hostOwners
 * @property {Set<string>} references  `company|reference`
 * @property {Set<string>} titlePlaces `company|title|place`
 * @property {number} sliceCount
 */

/**
 * @returns {CorpusIndex}
 */
export function emptyCorpusIndex() {
  return {
    urls: new Set(),
    stableKeys: new Set(),
    hostOwners: new Map(),
    references: new Set(),
    titlePlaces: new Set(),
    sliceCount: 0,
  };
}

/**
 * Add one crawler's jobs. Exported so a test needs two objects, not a slice
 * directory.
 *
 * @param {CorpusIndex} index
 * @param {string} crawlerKey
 * @param {object[]} jobs
 */
export function addJobsToCorpusIndex(index, crawlerKey, jobs) {
  for (const job of jobs) {
    const company = normalizeCompanyName(job?.company || '');
    for (const url of [job?.url, job?.applyUrl]) {
      if (typeof url !== 'string' || !url) continue;
      const normalized = normalizeJobUrl(url);
      if (normalized) index.urls.add(normalized);
      const stable = hostScopedStableKey(url);
      if (stable) index.stableKeys.add(stable);
      if (company) {
        for (const token of referenceTokens(url)) index.references.add(`${company}|${token}`);
      }
    }
    const sourceHost = typeof job?.url === 'string' ? hostOf(job.url) : '';
    if (sourceHost) {
      let owners = index.hostOwners.get(sourceHost);
      if (!owners) index.hostOwners.set(sourceHost, (owners = new Set()));
      owners.add(crawlerKey);
    }
    if (!company) continue;
    for (const reference of [job?.externalId, job?.jobId, job?.referenceNumber, job?.reference]) {
      if (reference != null && String(reference).length >= REFERENCE_MIN_LENGTH) {
        index.references.add(`${company}|${String(reference).toLowerCase()}`);
      }
    }
    const titles = new Set([job?.title, ...Object.values(job?.titleByLocale || {})].map(comparableTitle));
    const places = [job?.postalCode, job?.addressLocality, job?.location]
      .map(comparablePlace).filter(Boolean);
    for (const title of titles) {
      if (!title) continue;
      for (const place of places) index.titlePlaces.add(`${company}|${title}|${place}`);
    }
  }
  return index;
}

/**
 * @param {string} root  repo root
 * @param {{ excludeKey: string }} opts  this crawler's own slice never counts
 * @returns {CorpusIndex}
 */
export function buildCorpusIndex(root, { excludeKey }) {
  const dir = path.join(root, 'data', 'jobs', 'by-crawler');
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter(isSliceFile).sort() : [];
  const index = emptyCorpusIndex();
  for (const file of files) {
    const key = file.replace(/\.json$/, '').toLowerCase();
    if (key === excludeKey) continue;
    let payload;
    try {
      payload = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
    } catch {
      continue;
    }
    const jobs = Array.isArray(payload) ? payload : (Array.isArray(payload?.jobs) ? payload.jobs : []);
    addJobsToCorpusIndex(index, key, jobs);
    index.sliceCount += 1;
  }
  if (index.sliceCount === 0) {
    throw new Error(`corpus index: no crawler slice readable under ${dir} — refusing to deduplicate against nothing`);
  }
  return index;
}

/**
 * @param {{ company: string, title: string, titles?: string[], postalCode?: string, city?: string, channelUrls: string[], externalReference?: string|null }} ad
 * @param {CorpusIndex} index
 * @returns {'url'|'host'|'reference'|'title'|null}
 */
export function matchCorpus(ad, index) {
  for (const url of ad.channelUrls) {
    if (index.urls.has(normalizeJobUrl(url))) return 'url';
    const stable = hostScopedStableKey(url);
    if (stable && index.stableKeys.has(stable)) return 'url';
  }
  for (const url of ad.channelUrls) {
    const host = hostOf(url);
    if (!host || isKnownAggregatorDomain(host)) continue;
    if (index.hostOwners.get(host)?.size === 1) return 'host';
  }
  const company = normalizeCompanyName(ad.company);
  if (!company) return null;
  const reference = String(ad.externalReference || '').trim().toLowerCase();
  if (reference.length >= REFERENCE_MIN_LENGTH && index.references.has(`${company}|${reference}`)) {
    return 'reference';
  }
  const title = comparableTitle(ad.title);
  for (const place of [ad.postalCode, ad.city].map(comparablePlace).filter(Boolean)) {
    if (title && index.titlePlaces.has(`${company}|${title}|${place}`)) return 'title';
  }
  return null;
}
