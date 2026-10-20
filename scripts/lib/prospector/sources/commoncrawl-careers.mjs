/**
 * Discovery source — Swiss career pages, straight out of the web index.
 *
 * The other three sources each see a slice of the economy. The SECO feed sees
 * employers hiring in notifiable occupations right now; OpenStreetMap sees
 * businesses somebody bothered to map, which in Switzerland means hospitality
 * and retail and almost no hauliers, workshops or trades (measured: 1'411
 * mapped Ticino businesses with a website, of which ZERO in transport or
 * logistics); our own crawls see what we already crawl. None of them is a
 * census of employers who publish vacancies.
 *
 * Common Crawl is. It indexes the Swiss web, and an employer with a careers
 * page has a URL whose PATH says so in one of four languages. So: sweep the
 * `.ch` range of the index and keep the hosts whose paths read as careers
 * pages. No API key, no quota, no ranking bias, and it reaches the employer
 * whether or not they are hiring today.
 *
 * Measured on one index page: 15'000 URLs in 12 seconds yielding 11 distinct
 * Swiss employers with a careers page — `a-zreinigungsdienst.ch`,
 * `a1-industrieboeden.ch`, `a3-haustech.ch`. The whole `.ch` range is 1'223
 * such pages, so a full sweep is roughly four hours and about 13'000
 * employers, exactly the tier the national boards never list.
 *
 * The index is ordered by reversed host, so pages map to alphabetical slabs of
 * the Swiss web. A sweep is therefore resumable by page number and a partial
 * sweep is a partial ALPHABET, not a partial sample — which is why
 * `stride` exists: it walks the range in even steps so a short run still sees
 * the whole alphabet rather than 40 pages of employers starting with "a".
 */
import fs from 'node:fs';
import path from 'node:path';
import { politeFetch } from './../polite-fetch.mjs';
import { normalizeHost, registrableDomain, safeDecodePath } from './../registrable.mjs';
import { PROSPECTOR_DIR, WEB_CHANNEL_HEALTH_PATH } from './../config.mjs';

const INDEX_HOST = 'https://index.commoncrawl.org';
const CURSOR_PATH = path.join(PROSPECTOR_DIR, 'commoncrawl-cursor.json');

/** How many runs of history to keep — a couple of months at one run/night. */
const HEALTH_HISTORY_LIMIT = 60;

/**
 * Career-page paths in the four site locales.
 *
 * Anchored on path SEGMENTS rather than substrings: a bare /jobs/ test also
 * matches `/blog/jobs-report-2026`, and at index scale that noise would
 * dominate the yield.
 */
const CAREER_PATH_RX = new RegExp(
  '(^|/)('
  + 'lavora-con-noi|lavorare-con-noi|posizioni-aperte|posti-liberi|posti-vacanti|offerte-di-lavoro|opportunita-di-lavoro|carriere|carriera'
  + '|jobs?|careers?|join-us|work-with-us|vacancies'
  + '|karriere|offene-stellen|stellenangebote|stellen|jobangebote|arbeiten-bei'
  + '|emplois?|carrieres?|nous-rejoindre|postes-vacants|offres-d-emploi'
  + ')(/|$|\\?)',
  'i',
);

/**
 * The newest collection the index offers.
 * @returns {Promise<string|null>}
 */
export async function latestCollection(options = {}) {
  let res;
  try {
    res = await politeFetch(`${INDEX_HOST}/collinfo.json`, {
      accept: 'application/json', ignoreRobots: true, retries: 3,
      fetchImpl: options.fetchImpl, sleepImpl: options.sleepImpl, lookupImpl: options.lookupImpl,
    });
  } catch {
    return { collection: null, outcome: 'unavailable', errorCode: 'network_error' };
  }
  if (!res.ok) return { collection: null, outcome: 'unavailable', errorCode: `http_${res.status}` };
  let rows;
  try { rows = JSON.parse(res.body); } catch {
    return { collection: null, outcome: 'malformed', errorCode: 'malformed_json' };
  }
  const collection = Array.isArray(rows) ? String(rows[0]?.id || '') : '';
  return collection
    ? { collection, outcome: 'complete', errorCode: null }
    : { collection: null, outcome: 'malformed', errorCode: 'missing_collection_id' };
}

/**
 * How many index pages the `.ch` range spans in a collection.
 * @param {string} collection
 * @returns {Promise<number>}
 */
export async function chPageCount(collection, options = {}) {
  let res;
  try {
    res = await politeFetch(
      `${INDEX_HOST}/${collection}-index?url=*.ch&showNumPages=true&output=json`,
      {
        accept: 'application/json', ignoreRobots: true, timeoutMs: 180000, retries: 3,
        fetchImpl: options.fetchImpl, sleepImpl: options.sleepImpl, lookupImpl: options.lookupImpl,
      },
    );
  } catch {
    return { totalPages: 0, outcome: 'unavailable', errorCode: 'network_error' };
  }
  if (!res.ok) return { totalPages: 0, outcome: 'unavailable', errorCode: `http_${res.status}` };
  let payload;
  try { payload = JSON.parse(res.body); } catch {
    return { totalPages: 0, outcome: 'malformed', errorCode: 'malformed_json' };
  }
  const totalPages = Number(payload?.pages);
  if (!Number.isSafeInteger(totalPages) || totalPages <= 0) {
    return { totalPages: 0, outcome: 'malformed', errorCode: 'invalid_page_count' };
  }
  return { totalPages, outcome: 'complete', errorCode: null };
}

/**
 * @param {string} collection
 * @param {number} page
 * @returns {Promise<{ employers: { host: string, url: string }[], outcome: 'complete'|'partial'|'unavailable'|'malformed', errorCode: string|null }>}
 */
export async function careerPagesOnIndexPage(collection, page, options = {}) {
  let res;
  try {
    res = await politeFetch(
      `${INDEX_HOST}/${collection}-index?url=*.ch&output=json&fl=url&page=${page}`,
      {
        accept: 'application/json', ignoreRobots: true, timeoutMs: 240000, retries: 3,
        fetchImpl: options.fetchImpl, sleepImpl: options.sleepImpl, lookupImpl: options.lookupImpl,
      },
    );
  } catch {
    return { employers: [], outcome: 'unavailable', errorCode: 'network_error' };
  }
  if (!res.ok) return { employers: [], outcome: 'unavailable', errorCode: `http_${res.status}` };
  if (!String(res.body || '').trim()) {
    return { employers: [], outcome: 'malformed', errorCode: 'empty_index_page' };
  }
  /** @type {Map<string, string>} */
  const byHost = new Map();
  let malformedRows = 0;
  for (const line of res.body.split('\n')) {
    if (!line.trim()) continue;
    let url;
    try { url = JSON.parse(line).url; } catch { malformedRows++; continue; }
    let u;
    try { u = new URL(url); } catch { malformedRows++; continue; }
    const p = safeDecodePath(u);
    if (!CAREER_PATH_RX.test(p)) continue;
    const host = normalizeHost(u.hostname);
    const domain = registrableDomain(host);
    // One careers URL per employer is all a trace needs, and the shortest path
    // is the likeliest to be the careers INDEX rather than one vacancy on it.
    const prev = byHost.get(domain);
    if (!prev || url.length < prev.length) byHost.set(domain, url);
  }
  return {
    employers: [...byHost].map(([host, url]) => ({ host, url })),
    outcome: malformedRows ? (byHost.size ? 'partial' : 'malformed') : 'complete',
    errorCode: malformedRows ? 'malformed_rows' : null,
  };
}

/**
 * Per-run yield history for this channel, oldest first. The index behind this
 * source is a shared volunteer service that goes dark for stretches (measured:
 * a full hour of `status 0`) with no signal beyond that night's run coming back
 * empty — indistinguishable, from a single run, from a night the `.ch` range
 * legitimately had nothing new. Keeping a short history turns "was that run a
 * fluke or a trend" into something a report can answer instead of guess.
 *
 * @param {string} [file]
 * @returns {{ at: string, collection: string|null, totalPages: number, pagesRead: number, employers: number, outcome?: string, errorCode?: string|null, failedPages?: any[], coverageRate?: number|null, outage: boolean }[]}
 */
export function loadChannelHealth(file = WEB_CHANNEL_HEALTH_PATH) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw new Error(`Cannot read Common Crawl health at ${file}`, { cause: error });
  }
  let parsed;
  try { parsed = JSON.parse(text); } catch (error) {
    throw new Error(`Malformed Common Crawl health at ${file}`, { cause: error });
  }
  if (!Array.isArray(parsed)) throw new Error(`Invalid Common Crawl health shape at ${file}`);
  return parsed;
}

/**
 * Appends one run's yield to the channel health history, capped to the most
 * recent {@link HEALTH_HISTORY_LIMIT} entries. `outage` is true only for an
 * `unavailable` source outcome; malformed responses and partial reads remain
 * distinct states.
 *
 * @param {{ collection: string|null, totalPages: number, pagesRead: number, employers: number, outcome?: string, errorCode?: string|null, failedPages?: Array<{page:number,outcome:string,errorCode:string|null}>, coverageRate?: number }} sample
 * @param {string} [file]
 */
export function recordChannelHealth(sample, file = WEB_CHANNEL_HEALTH_PATH) {
  const history = loadChannelHealth(file);
  const outcome = sample.outcome || (sample.totalPages === 0 ? 'unavailable' : 'complete');
  history.push({
    at: new Date().toISOString(),
    collection: sample.collection,
    totalPages: sample.totalPages,
    pagesRead: sample.pagesRead,
    employers: sample.employers,
    outcome,
    errorCode: sample.errorCode || null,
    failedPages: Array.isArray(sample.failedPages) ? sample.failedPages.slice(0, 100) : [],
    coverageRate: Number.isFinite(sample.coverageRate) ? Number(sample.coverageRate.toFixed(4)) : null,
    outage: outcome === 'unavailable',
  });
  const trimmed = history.slice(-HEALTH_HISTORY_LIMIT);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(trimmed, null, 2)}\n`);
    fs.renameSync(temporary, file);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

const EMPTY_CURSOR = { collection: null, nextPage: 0, totalPages: 0, sweptPages: [], collectionHistory: [] };

/**
 * Resume position for the `.ch` sweep. A missing cursor is a first run;
 * malformed or unreadable state is an error so a save cannot erase coverage.
 *
 * @returns {{ collection: string|null, nextPage: number, totalPages: number, stride: number, sweptPages: number[], pendingPages: number[], collectionHistory: any[] }}
 */
export function loadCursor(file = CURSOR_PATH) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return structuredClone(EMPTY_CURSOR);
    throw new Error(`Cannot read Common Crawl cursor at ${file}`, { cause: error });
  }
  let cursor;
  try { cursor = JSON.parse(text); } catch (error) {
    throw new Error(`Malformed Common Crawl cursor at ${file}`, { cause: error });
  }
  if (!cursor || typeof cursor !== 'object' || Array.isArray(cursor)
    || !(cursor.collection === null || typeof cursor.collection === 'string')
    || !Number.isSafeInteger(cursor.nextPage) || cursor.nextPage < 0
    || (cursor.totalPages !== undefined && (!Number.isSafeInteger(cursor.totalPages) || cursor.totalPages < 0))
    || !Array.isArray(cursor.sweptPages)
    || cursor.sweptPages.some((page) => !Number.isSafeInteger(page) || page < 0)
    || (cursor.pendingPages !== undefined && (!Array.isArray(cursor.pendingPages)
      || cursor.pendingPages.some((page) => !Number.isSafeInteger(page) || page < 0)))
    || (cursor.collectionHistory !== undefined && !Array.isArray(cursor.collectionHistory))) {
    throw new Error(`Invalid Common Crawl cursor shape at ${file}`);
  }
  return {
    ...EMPTY_CURSOR,
    ...cursor,
    totalPages: Number(cursor.totalPages || 0),
    stride: Number.isSafeInteger(cursor.stride) && cursor.stride > 0 ? cursor.stride : 0,
    pendingPages: Array.isArray(cursor.pendingPages) ? cursor.pendingPages : [],
    collectionHistory: Array.isArray(cursor.collectionHistory) ? cursor.collectionHistory : [],
  };
}

/**
 * @param {{ collection: string|null, nextPage: number, totalPages?: number, stride?: number, sweptPages: number[], pendingPages?: number[], collectionHistory?: any[] }} cursor
 */
export function saveCursor(cursor, file = CURSOR_PATH) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(cursor, null, 2)}\n`);
    fs.renameSync(temporary, file);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

function gcd(a, b) {
  let left = Math.abs(a);
  let right = Math.abs(b);
  while (right) [left, right] = [right, left % right];
  return left;
}

/** Choose a near-even step that forms one complete permutation of the page range. */
export function commonCrawlStride(totalPages, wanted) {
  if (!Number.isSafeInteger(totalPages) || totalPages <= 1) return 1;
  const target = Math.max(1, Math.floor(totalPages / Math.max(1, wanted)));
  for (let distance = 0; distance < totalPages; distance++) {
    const lower = target - distance;
    const upper = target + distance;
    if (lower > 0 && gcd(lower, totalPages) === 1) return lower;
    if (upper < totalPages && gcd(upper, totalPages) === 1) return upper;
  }
  return 1;
}

/** Pure page planner: retry failures first, then continue one full-range permutation. */
export function planCommonCrawlPages(cursor, totalPages, wanted, requestedStride) {
  const safeWanted = Math.max(0, Math.floor(Number(wanted) || 0));
  if (!Number.isSafeInteger(totalPages) || totalPages <= 0 || safeWanted === 0) {
    return { pages: [], stride: 1, nextPage: 0, pendingPages: [] };
  }
  const seen = new Set((Array.isArray(cursor.sweptPages) ? cursor.sweptPages : [])
    .filter((page) => Number.isSafeInteger(page) && page >= 0 && page < totalPages));
  const pending = [...new Set((Array.isArray(cursor.pendingPages) ? cursor.pendingPages : [])
    .filter((page) => Number.isSafeInteger(page) && page >= 0 && page < totalPages && !seen.has(page)))];
  const pages = pending.slice(0, safeWanted);
  const pendingSet = new Set(pending);
  const stride = Number.isSafeInteger(requestedStride) && requestedStride > 0 && gcd(requestedStride, totalPages) === 1
    ? requestedStride
    : commonCrawlStride(totalPages, safeWanted);
  let nextPage = Number.isSafeInteger(cursor.nextPage) ? cursor.nextPage % totalPages : 0;
  if (Number(cursor.totalPages) !== totalPages || cursor.stride !== stride) nextPage = 0;
  let lastNewOffset = -1;
  for (let offset = 0; pages.length < safeWanted && offset < totalPages; offset++) {
    const page = (nextPage + offset * stride) % totalPages;
    if (seen.has(page) || pendingSet.has(page) || pages.includes(page)) continue;
    pages.push(page);
    lastNewOffset = offset;
  }
  return {
    pages,
    stride,
    nextPage: lastNewOffset < 0 ? nextPage : (nextPage + (lastNewOffset + 1) * stride) % totalPages,
    pendingPages: pending.slice(safeWanted),
  };
}

/**
 * Sweep part of the `.ch` range, resuming where the last run stopped.
 *
 * @param {{ pages?: number, collection?: string, stride?: number, persist?: boolean, fetchImpl?: typeof fetch, sleepImpl?: (ms:number) => Promise<unknown>, lookupImpl?: any, cursorFile?: string, healthFile?: string }} [opts]
 * @returns {Promise<{ employers: { host: string, url: string }[], pagesRead: number[], failedPages: Array<{page:number,outcome:string,errorCode:string|null}>, totalPages: number, collection: string|null, outcome: string, errorCode: string|null, coverageRate: number }>}
 */
export async function sweepSwissCareerPages(opts = {}) {
  const wanted = opts.pages ?? 40;
  // Recorded on every exit, including the outage ones below: a run that comes
  // back with `totalPages: 0` because the index answered nothing looks
  // identical, from a single console line, to a legitimately quiet night — the
  // history is what tells the two apart (see `recordChannelHealth`).
  const finish = (result) => {
    if (opts.persist !== false) {
      try {
        recordChannelHealth({
        collection: result.collection,
        totalPages: result.totalPages,
        pagesRead: result.pagesRead.length,
        employers: result.employers.length,
        outcome: result.outcome,
        errorCode: result.errorCode,
        failedPages: result.failedPages,
        coverageRate: result.coverageRate,
        }, opts.healthFile || WEB_CHANNEL_HEALTH_PATH);
      } catch {
        console.error('::warning::Common Crawl health history non aggiornata; lo sweep prosegue senza sovrascrivere lo storico.');
      }
    }
    return result;
  };

  const collectionResult = opts.collection
    ? { collection: opts.collection, outcome: 'complete', errorCode: null }
    : await latestCollection(opts);
  const collection = collectionResult.collection;
  if (!collection) return finish({
    employers: [], pagesRead: [], failedPages: [], totalPages: 0, collection: null,
    outcome: collectionResult.outcome, errorCode: collectionResult.errorCode, coverageRate: 0,
  });

  const cursorFile = opts.cursorFile || CURSOR_PATH;
  const cursor = loadCursor(cursorFile);
  cursor.collectionHistory = Array.isArray(cursor.collectionHistory) ? cursor.collectionHistory : [];
  if (cursor.collection !== collection) {
    if (cursor.collection && Number(cursor.totalPages) > 0) {
      const oldTotal = Number(cursor.totalPages);
      const oldSwept = Array.isArray(cursor.sweptPages) ? cursor.sweptPages.length : 0;
      cursor.collectionHistory.push({
        collection: cursor.collection,
        totalPages: oldTotal,
        sweptPages: oldSwept,
        coverageRate: Number((oldSwept / oldTotal).toFixed(4)),
        completed: oldSwept >= oldTotal,
        supersededAt: new Date().toISOString(),
      });
      cursor.collectionHistory = cursor.collectionHistory.slice(-6);
    }
    cursor.collection = collection;
    cursor.nextPage = 0;
    cursor.totalPages = 0;
    cursor.sweptPages = [];
    cursor.pendingPages = [];
    cursor.stride = 0;
  }
  const pageCount = await chPageCount(collection, opts);
  const totalPages = pageCount.totalPages;
  if (!totalPages) return finish({
    employers: [], pagesRead: [], failedPages: [], totalPages: 0, collection,
    outcome: pageCount.outcome, errorCode: pageCount.errorCode, coverageRate: 0,
  });

  const seen = new Set((Array.isArray(cursor.sweptPages) ? cursor.sweptPages : [])
    .filter((page) => Number.isSafeInteger(page) && page >= 0 && page < totalPages));
  const plan = planCommonCrawlPages(cursor, totalPages, wanted, opts.stride);
  const pages = plan.pages;
  const pendingPages = new Set(plan.pendingPages);

  /** @type {Map<string, string>} */
  const employers = new Map();
  const pagesRead = [];
  const failedPages = [];
  for (const p of pages) {
    const result = await careerPagesOnIndexPage(collection, p, opts);
    for (const f of result.employers) if (!employers.has(f.host)) employers.set(f.host, f.url);
    if (result.outcome === 'complete') {
      pagesRead.push(p);
      seen.add(p);
    } else {
      failedPages.push({ page: p, outcome: result.outcome, errorCode: result.errorCode });
      pendingPages.add(p);
    }
  }

  const outcome = failedPages.length === 0
    ? 'complete'
    : pagesRead.length > 0 || failedPages.some((failure) => failure.outcome === 'partial')
      ? 'partial'
      : failedPages.every((failure) => failure.outcome === 'malformed') ? 'malformed' : 'unavailable';
  const errorCode = failedPages[0]?.errorCode || null;
  const coverageRate = seen.size / totalPages;

  if (opts.persist !== false) {
    cursor.totalPages = totalPages;
    cursor.stride = plan.stride;
    cursor.sweptPages = [...seen].sort((a, b) => a - b).slice(-5000);
    cursor.pendingPages = [...pendingPages].sort((a, b) => a - b).slice(-1000);
    cursor.nextPage = plan.nextPage;
    try { saveCursor(cursor, cursorFile); } catch {
      console.error('::warning::Common Crawl cursor non aggiornato; le pagine lette verranno ripetute al prossimo run.');
    }
  }
  return finish({
    employers: [...employers].map(([host, url]) => ({ host, url })),
    pagesRead,
    failedPages,
    totalPages,
    collection,
    outcome,
    errorCode,
    coverageRate,
  });
}
