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

// Query-only job detail pages need one stable identifier to remain distinct,
// but names such as `id`, `q`, `role` and `position` are not identities on
// arbitrary hosts. They are also common tracking, search and session keys.
// This host-scoped matrix is grounded in the checked-in corpus plus active
// crawler parsers whose current slice can legitimately be empty.
const JOB_IDENTITY_QUERY_PARAMS_BY_HOST = new Map([
  ['apply5.lumessetalentlink.com', ['jobid']],
  ['bellinz.pi-asp.de', ['id']],
  ['boards.greenhouse.io', ['gh_jid']],
  ['career012.successfactors.eu', ['career_job_req_id']],
  ['career5.successfactors.eu', ['career_job_req_id', 'job', 'jobid']],
  ['career55.sapsf.eu', ['career_job_req_id']],
  ['career74.sapsf.eu', ['career_job_req_id']],
  ['careers.marriott.com', ['id']],
  ['careers.nagra.com', ['id']],
  ['careers.pkb.ch', ['id']],
  ['careers.theheinekencompany.com', ['jobid']],
  ['careers.zegnagroup.com', ['jobid']],
  ['cittamen.pi-asp.de', ['id']],
  ['corporate.lastminute.com', ['id']],
  ['dxt.com', ['panel']],
  ['emea3.recruitmentplatform.com', ['jobid']],
  ['emploi.lasource.ch', ['id']],
  ['emploi.ophtalmique.ch', ['id']],
  ['etavis.softgarden.io', ['jobdbpvid']],
  ['foodiverse.com', ['id']],
  ['fs-2662.my.salesforce-sites.com', ['vacancyno']],
  ['joblink.allibo.com', ['id']],
  ['jobs.hornbach.ch', ['offerapiid']],
  ['jobs.ubs.com', ['jobid']],
  ['karriere.hochgebirgsklinik.ch', ['offerapiid']],
  ['lavoraconnoi.lugano-lis.ch', ['id']],
  ['lombardi.group', ['id']],
  ['mendrisio.ch', ['uuid']],
  ['otb.apps.vs.ch', ['job']],
  ['sygnumpeopleportal.my.salesforce-sites.com', ['vacancyno']],
  ['vaudoise.softgarden.io', ['jobdbpvid']],
  ['weissearena.com', ['jobid']],
  ['concorsi.ti.ch', ['yid']],
  ['coopers.ch', ['refcode']],
  ['ksml.apps.be.ch', ['q']],
  ['lafonte.ch', ['role']],
  ['linnea.ch', ['position']],
  ['lugano.ch', ['unid']],
  ['rhne.ch', ['jobid']],
  ['scandit.com', ['gh_jid']],
  ['wagerenhof.ch', ['reference']],
  ['e-lavoro.ch', ['id']],
  ['zambon.com', ['id']],
  ['www4.ti.ch', ['id']],
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
 * Normalise a job URL the way the overlap comparisons do: lowercase scheme,
 * host and path, no fragment/trailing slash, and only stable host-scoped
 * job-identity query parameters. Identity values preserve their original case.
 * Session/tracking parameters are removed, but query-only detail pages such as
 * `concorsi.ti.ch/...?yid=4264&sid=...` retain `yid`; otherwise every cantonal
 * vacancy collapses onto the same listing URL and becomes a false duplicate.
 *
 * @param {string} raw
 * @returns {string}
 */
export function normalizeJobUrl(raw = '') {
  const s = String(raw).trim();
  const [withoutFragment] = s.split('#');
  const queryAt = withoutFragment.indexOf('?');
  const base = (queryAt >= 0 ? withoutFragment.slice(0, queryAt) : withoutFragment)
    .toLowerCase()
    .replace(/\/+$/, '');
  if (queryAt < 0) return base;

  let sourceHost = '';
  try {
    sourceHost = normalizeSourceHost(new URL(withoutFragment).hostname);
  } catch {
    // A malformed/non-absolute URL has no trustworthy host identity. Keep its
    // safely normalised base, but never retain a globally ambiguous query key.
  }
  const identityParams = JOB_IDENTITY_QUERY_PARAMS_BY_HOST.get(sourceHost) || [];
  const kept = [];
  for (const [key, value] of new URLSearchParams(withoutFragment.slice(queryAt + 1))) {
    const normalizedKey = key.toLowerCase();
    if (identityParams.includes(normalizedKey) && value) {
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
 * Vacancies in a slice about to be written that ANOTHER crawler already owns.
 *
 * ── Why this exists (issue #6759) ────────────────────────────────────────
 *
 * `findOverlappingCrawlers` below has reported this defect since the audit was
 * written, and the repair has twice been a data migration: retire the losing
 * `companyKey`, move its slugs into `previousSlugs`, close the issue on a clean
 * count. Both times the count went back to zero and the issue reopened days
 * later — on 2026-09-01 with the very pairs that had just been retired
 * (`solothurner-spitaeler`, `spz`), on 2026-09-03 with a new one
 * (`swiss-medical-network` + `villa-im-park`). Migrating the data never touched
 * the reason two crawlers can claim one vacancy: nothing asks the question at
 * the moment a slice is persisted. The audit is a morning report, and a report
 * cannot refuse a write.
 *
 * So this is the same question `matchExistingCrawler` asks of a prospector
 * CANDIDATE — "does someone else already publish these vacancies?" — asked of
 * an established crawler at write time, which is the only moment at which the
 * answer can still change the outcome.
 *
 * ── Why the incumbent wins ───────────────────────────────────────────────
 *
 * The guard does NOT adjudicate which employer is the real one: that needs
 * human judgement (a retired alias, two brands on one board, a group crawler
 * reading too widely) and getting it wrong silently is worse than the
 * duplicate. It enforces the weaker invariant that is nonetheless the whole
 * defect — a vacancy URL is served by at most ONE crawler key — and resolves it
 * toward the key that already holds the URL on disk. That choice is the safe
 * one and the stable one:
 *
 *   - safe, because the incumbent's slug is the published, indexed route;
 *     handing the URL to a new claimant moves an indexed page to a different
 *     company card, which is the SEO loss `slug-preservation-guard.mjs` exists
 *     to prevent;
 *   - stable, because it cannot flap. The newcomer drops the URL and the
 *     incumbent keeps it whatever order the two crawlers run in. When the
 *     incumbent genuinely stops listing the vacancy its slice loses the URL,
 *     and the next writer is free to claim it — ownership hands over instead of
 *     oscillating.
 *
 * Pure and I/O-free on purpose, like the two functions above it: the ownership
 * snapshot is passed in, so a caller pays for one scan and a test needs two
 * Maps rather than a slice fixture.
 *
 * ponytail: incumbency is a tie-break, not a verdict. A deliberate takeover
 * (a dedicated brand crawler that SHOULD claim vacancies from the group crawler
 * that currently holds them) is refused by this guard; that hand-over is the
 * reconciler's job, which writes slices directly and never passes through here.
 *
 * @param {string} crawlerKey  key of the slice being written
 * @param {{url?: string}[]} jobs  the payload about to be persisted
 * @param {SourceHostOwnership} ownership  from `loadSourceHostOwnership(root, { urls: true })`
 * @returns {{ jobs: {url?: string}[], dropped: { url: string, owner: string }[] }}
 *   `jobs` filtered to what this crawler may publish, plus what was removed and
 *   to whom it belongs. An empty/unloaded ownership map drops nothing: not
 *   knowing who owns a URL must never be read as "someone else owns it".
 */
export function dropForeignOwnedVacancies(crawlerKey, jobs, ownership) {
  const mine = String(crawlerKey || '').toLowerCase();
  const urlsByKey = ownership?.urlsByKey;
  if (!mine || !Array.isArray(jobs) || !(urlsByKey instanceof Map)) {
    return { jobs: Array.isArray(jobs) ? jobs : [], dropped: [] };
  }
  // Ownership follows SLICE MEMBERSHIP (`urlsByKey`), deliberately not
  // `activeUrlsByKey`. The two are not "history vs now": `activeUrlsByKey`
  // holds only `crawlerJobActivity(job) === 'active'`, and that helper returns
  // `'grace'` as soon as `crawlerMissStreak > 0` — i.e. after ONE missed run.
  // Indexing owners by it would hand a vacancy away on the first flaky crawl
  // (pagination hiccup, markup change, timeout), which is the very flakiness
  // the grace window exists to absorb: A publishes X, misses one run, B sees X
  // and finds it unowned, and the duplicate this guard exists to stop is
  // created by the guard itself.
  //
  // Slice membership is the honest reading of "still published", and it is
  // also what makes the hand-over promised above real: when an incumbent
  // genuinely stops listing a vacancy it is archived out of the slice, so
  // `urlsByKey` loses it and the next writer may claim it. Grace-period
  // carry-over is still published, so it still owns.
  const ownerIndexSource = urlsByKey;

  // Vacancies THIS crawler has already published, from its own slice on disk.
  // History, not the latest crawl: a URL this key ever served has a live,
  // indexed slug, and that is what must not be dropped.
  const alreadyMine = urlsByKey.get(mine) instanceof Set ? urlsByKey.get(mine) : new Set();

  // url -> owning key, every key but this one. Built once per call: the
  // alternative, probing each of ~590 key sets per job, is a full scan per job.
  /** @type {Map<string, string>} */
  const owners = new Map();
  for (const [key, urls] of ownerIndexSource) {
    if (key === mine || !(urls instanceof Set)) continue;
    for (const url of urls) {
      // Lexicographic tie-break so two claimants give a stable answer whatever
      // order readdir returned their slices in.
      const held = owners.get(url);
      if (held === undefined || key < held) owners.set(url, key);
    }
  }

  /** @type {{ url: string, owner: string }[]} */
  const dropped = [];
  const kept = [];
  for (const job of jobs) {
    const url = normalizeJobUrl(job?.url || '');
    const owner = url ? owners.get(url) : undefined;
    // Only a NEW claim is refused. If this key already publishes the vacancy,
    // the duplicate is already live and its slug is already indexed: dropping
    // it here would delete that page instead of redirecting it, turning an
    // indexed URL into a dead route — the loss `slug-preservation-guard.mjs`
    // exists to prevent, inflicted by the guard meant to protect identity.
    // Collapsing an EXISTING duplicate means moving the loser's slugs into the
    // winner's `previousSlugs`, which is a migration with a human deciding who
    // wins (`reconcile-crawler-company-ownership.mjs`), not a write-time drop.
    // So this guard does exactly what the issue asks — stops new duplicates
    // from being created — and leaves the published ones to the reconciler.
    if (owner && !alreadyMine.has(url)) dropped.push({ url, owner });
    else kept.push(job);
  }
  return { jobs: kept, dropped };
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
 * @property {number|null} olderSnapshotAtMs
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
      olderSnapshotAtMs: Number.isFinite(assembledAtA) && Number.isFinite(assembledAtB)
        ? Math.min(assembledAtA, assembledAtB)
        : null,
    });
  }
  // Loudest first: the more vacancies two keys share, the more certain the duplicate.
  out.sort((x, y) => y.shared.length - x.shared.length || x.keys[0].localeCompare(y.keys[0]));
  return out;
}
