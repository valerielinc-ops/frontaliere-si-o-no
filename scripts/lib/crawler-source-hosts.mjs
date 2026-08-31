/**
 * Who owns which source host, read straight off the crawled slices.
 *
 * `data/jobs/by-crawler/<key>.json` is the only place in the repo that records
 * where a job was actually read from, so it is the only honest answer to "do we
 * already crawl this host?". Three callers need that answer and they must not
 * disagree, hence one scan here instead of three:
 *
 *   - `scripts/lib/prospector/coverage.mjs`  — don't rediscover an employer we have
 *   - `scripts/generate-crawler-companies.mjs` — don't record a VENDOR host as the
 *     employer's own domain
 *   - `scripts/audit-duplicate-crawler-companies.mjs` — report the ones already split
 *
 * ## Dedicated vs shared, and why the distinction is the whole point
 *
 * A host used by exactly one crawler key is that employer's front door and
 * identifies them. A host used by two or more is a hosted-ATS lobby —
 * `jobs.smartrecruiters.com` serves 24 of our employers — and identifies nobody.
 * Treating the second kind as an identity is how `umantis.com` ends up claiming
 * every Umantis tenant on earth; treating the first kind as anonymous is how the
 * same employer gets crawled twice under two names. Measured on this repo:
 * 471 hosts, 425 dedicated, 46 shared.
 *
 * Slices are scanned as TEXT, not parsed. They total ~422 MB and the two fields
 * needed are flat strings, so `JSON.parse` on each would buy nothing but latency.
 */
import fs from 'node:fs';
import path from 'node:path';
import { isSliceFile } from './crawler-slice-files.mjs';
import { crawlerJobActivity } from './crawler-job-activity.mjs';

export { isSliceFile };

/** `"companyKey": "eoc-ente-ospedaliero-cantonale"` */
const COMPANY_KEY_RE = /"companyKey"\s*:\s*"([^"]+)"/g;
/** `"url": "https://host/path"` — host only, stopping at the first delimiter. */
const URL_HOST_RE = /"url"\s*:\s*"https?:\/\/([^/"?#\\]+)/g;
/** `"url": "https://host/path"` — origin + path, query and fragment dropped. */
const URL_FULL_RE = /"url"\s*:\s*"(https?:\/\/[^"\\?#]+)/g;

// Query-only job detail pages need one stable identifier to remain distinct.
// Everything else (language, source, session, UTM, presentation switches) is
// deliberately discarded so two links to the same posting still compare equal.
// The allow-list is grounded in the current corpus; keys are matched lowercase.
const JOB_IDENTITY_QUERY_PARAMS = new Set([
  'career_job_req_id', 'gh_jid', 'id', 'job', 'jobdbpvid', 'jobid', 'offerapiid',
  'panel', 'position', 'q', 'refcode', 'reference', 'role', 'unid', 'vacancyno',
  'uuid', 'yid',
]);

/**
 * Lowercase a host and drop the `www.` and any port, so two spellings of the
 * same front door compare equal.
 *
 * @param {string} raw
 * @returns {string}
 */
export function normalizeSourceHost(raw = '') {
  return String(raw)
    .trim()
    .toLowerCase()
    .replace(/^www\./, '')
    .replace(/:\d+$/, '');
}

/**
 * @typedef {Object} SliceScan
 * @property {string} file            slice filename (`eoc-candidati-posizioni.json`)
 * @property {string} key             crawler key taken from the filename
 * @property {Set<string>} companyKeys `companyKey` values found inside
 * @property {Set<string>} hosts      normalised source hosts found inside
 * @property {number} jobCount        `"url":` occurrences, i.e. jobs with a link
 * @property {number|null} assembledAtMs top-level slice timestamp, when valid
 */

/**
 * @typedef {Object} SourceHostOwnership
 * @property {SliceScan[]} slices
 * @property {Map<string, Set<string>>} byHost      host -> crawler keys using it
 * @property {Set<string>} dedicatedHosts           hosts owned by exactly one key
 * @property {Set<string>} sharedHosts              hosts used by two or more keys
 * @property {Map<string, Set<string>>} sharedUrls  job URL -> keys, only where >=2
 * @property {Map<string, Set<string>>} urlsByKey   crawler key -> its job URLs
 * @property {Map<string, Set<string>>} activeUrlsByKey crawler key -> URLs seen in
 *   the latest crawl (`crawlerMissStreak` absent/zero), excluding grace-period carry-over
 * @property {Map<string, number>} assembledAtByKey crawler key -> slice timestamp
 */

/**
 * @param {string} root  repo root
 * @param {{ urls?: boolean }} [opts]  `urls: true` also collects per-job-URL
 *   overlap, which is what the audit needs and what nobody else should pay for.
 * @returns {SourceHostOwnership}
 */
export function loadSourceHostOwnership(root, opts = {}) {
  const collectUrls = opts.urls === true;
  const dir = path.join(root, 'data', 'jobs', 'by-crawler');

  /** @type {SliceScan[]} */
  const slices = [];
  /** @type {Map<string, Set<string>>} */
  const byHost = new Map();
  /** @type {Map<string, Set<string>>} */
  const byUrl = new Map();
  /** @type {Map<string, Set<string>>} */
  const urlsByKey = new Map();
  /** @type {Map<string, Set<string>>} */
  const activeUrlsByKey = new Map();
  /** @type {Map<string, number>} */
  const assembledAtByKey = new Map();

  let files;
  try {
    files = fs.readdirSync(dir).filter(isSliceFile).sort();
  } catch {
    // Not materialised in a sparse checkout. An empty ownership map makes every
    // caller fall back to its other signals rather than assert a wrong answer.
    return {
      slices: [], byHost, dedicatedHosts: new Set(), sharedHosts: new Set(),
      sharedUrls: new Map(), urlsByKey, activeUrlsByKey, assembledAtByKey,
    };
  }

  for (const file of files) {
    let text;
    try {
      text = fs.readFileSync(path.join(dir, file), 'utf8');
    } catch {
      continue;
    }
    // The filename is the fallback identity: a slice that names no `companyKey`
    // still belongs to exactly one crawler.
    const key = file.replace(/\.json$/, '').toLowerCase();
    const companyKeys = new Set([key]);
    for (const m of text.matchAll(COMPANY_KEY_RE)) companyKeys.add(m[1].toLowerCase());

    const hosts = new Set();
    for (const m of text.matchAll(URL_HOST_RE)) {
      const h = normalizeSourceHost(m[1]);
      if (h) hosts.add(h);
    }

    let jobCount = 0;
    let assembledAtMs = null;
    if (collectUrls) {
      const mine = new Set();
      const activeMine = new Set();
      try {
        const payload = JSON.parse(text);
        const jobs = Array.isArray(payload) ? payload : (Array.isArray(payload?.jobs) ? payload.jobs : []);
        const assembledAt = Array.isArray(payload) ? '' : (payload?.assembledAt || payload?.generatedAt || '');
        const parsedAt = Date.parse(String(assembledAt));
        if (Number.isFinite(parsedAt)) {
          assembledAtMs = parsedAt;
          assembledAtByKey.set(key, parsedAt);
        }
        for (const job of jobs) {
          const u = normalizeJobUrl(job?.url || '');
          if (!u) continue;
          jobCount += 1;
          mine.add(u);
          if (crawlerJobActivity(job) === 'active') activeMine.add(u);
          let owners = byUrl.get(u);
          if (!owners) byUrl.set(u, (owners = new Set()));
          owners.add(key);
        }
      } catch {
        // Preserve the old text-scan behaviour for a partially written or
        // legacy slice. Without parsed miss metadata every URL is conservatively
        // considered active, so the audit can over-report but never hide a gap.
        for (const m of text.matchAll(URL_FULL_RE)) {
          jobCount += 1;
          const u = normalizeJobUrl(m[1]);
          mine.add(u);
          activeMine.add(u);
          let owners = byUrl.get(u);
          if (!owners) byUrl.set(u, (owners = new Set()));
          owners.add(key);
        }
      }
      urlsByKey.set(key, mine);
      activeUrlsByKey.set(key, activeMine);
    } else {
      for (const _ of text.matchAll(URL_FULL_RE)) jobCount += 1;
    }

    for (const h of hosts) {
      let owners = byHost.get(h);
      if (!owners) byHost.set(h, (owners = new Set()));
      for (const k of companyKeys) owners.add(k);
    }
    slices.push({ file, key, companyKeys, hosts, jobCount, assembledAtMs });
  }

  const dedicatedHosts = new Set();
  const sharedHosts = new Set();
  for (const [h, owners] of byHost) (owners.size === 1 ? dedicatedHosts : sharedHosts).add(h);

  const sharedUrls = new Map();
  for (const [u, owners] of byUrl) if (owners.size > 1) sharedUrls.set(u, owners);

  return {
    slices, byHost, dedicatedHosts, sharedHosts, sharedUrls, urlsByKey,
    activeUrlsByKey, assembledAtByKey,
  };
}

/**
 * Normalise a job URL the way the overlap comparisons do: lowercase, no
 * fragment/trailing slash, and only stable job-identity query parameters.
 * Session/tracking parameters are removed, but query-only detail pages such as
 * `concorsi.ti.ch/...?yid=4264&sid=...` retain `yid`; otherwise every cantonal
 * vacancy collapses onto the same listing URL and becomes a false duplicate.
 *
 * @param {string} raw
 * @returns {string}
 */
export function normalizeJobUrl(raw = '') {
  const s = String(raw).trim().toLowerCase();
  const [withoutFragment] = s.split('#');
  const queryAt = withoutFragment.indexOf('?');
  const base = (queryAt >= 0 ? withoutFragment.slice(0, queryAt) : withoutFragment)
    .replace(/\/+$/, '');
  if (queryAt < 0) return base;

  const kept = [];
  for (const [key, value] of new URLSearchParams(withoutFragment.slice(queryAt + 1))) {
    const normalizedKey = key.toLowerCase();
    if (JOB_IDENTITY_QUERY_PARAMS.has(normalizedKey) && value) {
      kept.push([normalizedKey, value]);
    }
  }
  kept.sort(([keyA, valueA], [keyB, valueB]) =>
    keyA.localeCompare(keyB) || valueA.localeCompare(valueB));
  const identityQuery = new URLSearchParams(kept).toString();
  return identityQuery ? `${base}?${identityQuery}` : base;
}

/**
 * Does a freshly scraped candidate re-publish vacancies we already crawl?
 *
 * The host check in `coverage.mjs` catches a candidate standing on a tenant we
 * already read. This catches the rest: a candidate reached through an
 * aggregator, a vanity domain, or a second path on the same site, whose HOST
 * never matches but whose individual postings do. The vacancies themselves are
 * the identity — if most of what a "new employer" offers is already on the site
 * under someone else's name, it is not a new employer.
 *
 * Compared on URL, never on title: the duplicate this was written for carried
 * titles built from two concatenated job cards, so text similarity would have
 * scored it as unrelated.
 *
 * @param {string[]} urls        vacancy URLs the candidate's spec just produced
 * @param {SourceHostOwnership} ownership  loaded with `{ urls: true }`
 * @param {{ threshold?: number, exclude?: string }} [opts]
 *   `threshold`: share of the candidate's vacancies that must already be covered
 *   before we call it a duplicate. Default 0.5 — a simple majority, which the
 *   EOC duplicate cleared at 7 of 10.
 *   `exclude`: the candidate's OWN crawler key. Required whenever the candidate
 *   may already be in production, because the validate stage re-grades promoted
 *   candidates too and a live crawler matches its own slice at 100% — it would
 *   otherwise reject every established crawler as a duplicate of itself.
 * @returns {{ key: string, shared: number, total: number, rate: number } | null}
 *   the existing crawler that already covers them, or null
 */
export function matchExistingCrawler(urls, ownership, opts = {}) {
  const threshold = opts.threshold ?? 0.5;
  const exclude = opts.exclude ? String(opts.exclude).toLowerCase() : '';
  const mine = new Set(urls.map(normalizeJobUrl).filter(Boolean));
  if (!mine.size) return null;

  let best = null;
  for (const [key, theirs] of ownership.urlsByKey) {
    if (key === exclude) continue;
    let shared = 0;
    // Iterate OUR side: a candidate offers a handful of vacancies while an
    // established slice can hold thousands.
    for (const url of mine) if (theirs.has(url)) shared += 1;
    if (!shared) continue;
    const rate = shared / mine.size;
    if (rate >= threshold && (!best || shared > best.shared)) {
      best = { key, shared, total: mine.size, rate };
    }
  }
  return best;
}

/**
 * Crawler keys that read the SAME vacancies, and what each one is missing.
 *
 * Two keys sharing a host may still be two genuine employers behind one ATS
 * lobby, so a shared host alone proves nothing. Two keys serving the same
 * vacancy URL is a different claim entirely: that URL is one job posting, and
 * publishing it under two employer identities is a duplicate on the site no
 * matter how the two crawlers came to exist.
 *
 * Matching is on the URL, never on the title. The duplicate that prompted this
 * code carried the title `Collaboratrice-ore dell'economia domestica a ore
 * Collaboratrice-ore dell` — two job cards concatenated by a half-finished
 * extractor — so text similarity would have missed it while the URL matched
 * exactly.
 *
 * @typedef {Object} OverlapPair
 * @property {[string, string]} keys
 * @property {string[]} shared
 * @property {string[]} onlyA
 * @property {string[]} onlyB
 * @property {string[]} activeShared
 * @property {string[]} activeOnlyA
 * @property {string[]} activeOnlyB
 * @property {number|null} activeTotalA
 * @property {number|null} activeTotalB
 * @property {number|null} snapshotSkewMs
 * @property {string|null} olderSnapshotKey
 */

/**
 * @param {SourceHostOwnership} ownership  from `loadSourceHostOwnership(root, { urls: true })`
 * @returns {OverlapPair[]}
 *   one entry per pair of keys sharing at least one vacancy URL, `onlyA`/`onlyB`
 *   being the vacancies each side has that the other does not — a coverage gap.
 */
export function findOverlappingCrawlers(ownership) {
  // Value carries the pair explicitly: the Map key is an identity, never
  // something to parse back. The first version joined the two keys with a NUL and
  // split it again, which planted a control character in a file under
  // `scripts/lib` — exactly what tests/sanitize-control-chars.test.ts forbids.
  /** @type {Map<string, { keys: [string, string], urls: Set<string> }>} */
  const pairs = new Map();
  for (const [url, owners] of ownership.sharedUrls) {
    const keys = [...owners].sort();
    for (let i = 0; i < keys.length; i++) {
      for (let j = i + 1; j < keys.length; j++) {
        const id = `${keys[i]}--${keys[j]}`;
        let entry = pairs.get(id);
        if (!entry) pairs.set(id, (entry = { keys: [keys[i], keys[j]], urls: new Set() }));
        entry.urls.add(url);
      }
    }
  }

  /** @type {OverlapPair[]} */
  const out = [];
  for (const { keys: [a, b], urls: shared } of pairs.values()) {
    const urlsA = ownership.urlsByKey.get(a) || new Set();
    const urlsB = ownership.urlsByKey.get(b) || new Set();
    const hasActiveMetadata = ownership.activeUrlsByKey?.has(a)
      && ownership.activeUrlsByKey?.has(b);
    const activeA = hasActiveMetadata ? ownership.activeUrlsByKey.get(a) : urlsA;
    const activeB = hasActiveMetadata ? ownership.activeUrlsByKey.get(b) : urlsB;
    const assembledAtA = ownership.assembledAtByKey?.get(a);
    const assembledAtB = ownership.assembledAtByKey?.get(b);
    out.push({
      keys: [a, b],
      shared: [...shared].sort(),
      onlyA: [...urlsA].filter((u) => !urlsB.has(u)).sort(),
      onlyB: [...urlsB].filter((u) => !urlsA.has(u)).sort(),
      activeShared: hasActiveMetadata
        ? [...activeA].filter((u) => activeB.has(u)).sort()
        : [...shared].sort(),
      activeOnlyA: [...activeA].filter((u) => !urlsB.has(u)).sort(),
      activeOnlyB: [...activeB].filter((u) => !urlsA.has(u)).sort(),
      activeTotalA: hasActiveMetadata ? activeA.size : null,
      activeTotalB: hasActiveMetadata ? activeB.size : null,
      snapshotSkewMs: Number.isFinite(assembledAtA) && Number.isFinite(assembledAtB)
        ? Math.abs(assembledAtA - assembledAtB)
        : null,
      olderSnapshotKey: Number.isFinite(assembledAtA) && Number.isFinite(assembledAtB)
        ? (assembledAtA < assembledAtB ? a : (assembledAtB < assembledAtA ? b : null))
        : null,
    });
  }
  // Loudest first: the more vacancies two keys share, the more certain the duplicate.
  out.sort((x, y) => y.shared.length - x.shared.length || x.keys[0].localeCompare(y.keys[0]));
  return out;
}
