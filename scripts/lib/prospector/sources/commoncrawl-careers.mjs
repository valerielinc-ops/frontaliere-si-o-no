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
import { normalizeHost, registrableDomain } from './../registrable.mjs';
import { PROSPECTOR_DIR } from './../config.mjs';

const INDEX_HOST = 'https://index.commoncrawl.org';
const CURSOR_PATH = path.join(PROSPECTOR_DIR, 'commoncrawl-cursor.json');

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
export async function latestCollection() {
  const res = await politeFetch(`${INDEX_HOST}/collinfo.json`, { accept: 'application/json', ignoreRobots: true, retries: 3 });
  if (!res.ok) return null;
  try { return JSON.parse(res.body)[0]?.id || null; } catch { return null; }
}

/**
 * How many index pages the `.ch` range spans in a collection.
 * @param {string} collection
 * @returns {Promise<number>}
 */
export async function chPageCount(collection) {
  const res = await politeFetch(
    `${INDEX_HOST}/${collection}-index?url=*.ch&showNumPages=true&output=json`,
    { accept: 'application/json', ignoreRobots: true, timeoutMs: 180000, retries: 3 },
  );
  if (!res.ok) return 0;
  try { return Number(JSON.parse(res.body).pages) || 0; } catch { return 0; }
}

/**
 * @param {string} collection
 * @param {number} page
 * @returns {Promise<{ host: string, url: string }[]>}
 */
export async function careerPagesOnIndexPage(collection, page) {
  const res = await politeFetch(
    `${INDEX_HOST}/${collection}-index?url=*.ch&output=json&fl=url&page=${page}`,
    { accept: 'application/json', ignoreRobots: true, timeoutMs: 240000, retries: 3 },
  );
  if (!res.ok) return [];
  /** @type {Map<string, string>} */
  const byHost = new Map();
  for (const line of res.body.split('\n')) {
    if (!line.trim()) continue;
    let url;
    try { url = JSON.parse(line).url; } catch { continue; }
    let u;
    try { u = new URL(url); } catch { continue; }
    let p;
    try { p = decodeURIComponent(u.pathname); } catch { p = u.pathname; }
    if (!CAREER_PATH_RX.test(p)) continue;
    const host = normalizeHost(u.hostname);
    const domain = registrableDomain(host);
    // One careers URL per employer is all a trace needs, and the shortest path
    // is the likeliest to be the careers INDEX rather than one vacancy on it.
    const prev = byHost.get(domain);
    if (!prev || url.length < prev.length) byHost.set(domain, url);
  }
  return [...byHost].map(([host, url]) => ({ host, url }));
}

/**
 * @returns {{ collection: string|null, nextPage: number, sweptPages: number[] }}
 */
export function loadCursor() {
  try { return JSON.parse(fs.readFileSync(CURSOR_PATH, 'utf8')); }
  catch { return { collection: null, nextPage: 0, sweptPages: [] }; }
}

/**
 * @param {{ collection: string|null, nextPage: number, sweptPages: number[] }} cursor
 */
export function saveCursor(cursor) {
  fs.mkdirSync(path.dirname(CURSOR_PATH), { recursive: true });
  fs.writeFileSync(CURSOR_PATH, `${JSON.stringify(cursor, null, 2)}\n`);
}

/**
 * Sweep part of the `.ch` range, resuming where the last run stopped.
 *
 * @param {{ pages?: number, collection?: string, stride?: number, persist?: boolean }} [opts]
 * @returns {Promise<{ employers: { host: string, url: string }[], pagesRead: number[], totalPages: number, collection: string|null }>}
 */
export async function sweepSwissCareerPages(opts = {}) {
  const wanted = opts.pages ?? 20;
  const collection = opts.collection || await latestCollection();
  if (!collection) return { employers: [], pagesRead: [], totalPages: 0, collection: null };

  const cursor = loadCursor();
  if (cursor.collection !== collection) { cursor.collection = collection; cursor.nextPage = 0; cursor.sweptPages = []; }
  const totalPages = await chPageCount(collection);
  if (!totalPages) return { employers: [], pagesRead: [], totalPages: 0, collection };

  // Walk in strides so a short run samples the whole alphabet, not one slab.
  const stride = opts.stride ?? Math.max(1, Math.floor(totalPages / Math.max(wanted, 1)));
  const seen = new Set(cursor.sweptPages);
  const pages = [];
  for (let i = 0; pages.length < wanted && i < totalPages; i++) {
    const p = (cursor.nextPage + i * stride) % totalPages;
    if (seen.has(p)) continue;
    pages.push(p);
    seen.add(p);
  }

  /** @type {Map<string, string>} */
  const employers = new Map();
  const pagesRead = [];
  for (const p of pages) {
    const found = await careerPagesOnIndexPage(collection, p);
    pagesRead.push(p);
    for (const f of found) if (!employers.has(f.host)) employers.set(f.host, f.url);
  }

  if (opts.persist !== false) {
    cursor.sweptPages = [...seen].sort((a, b) => a - b).slice(-2000);
    cursor.nextPage = (cursor.nextPage + 1) % Math.max(stride, 1);
    saveCursor(cursor);
  }
  return {
    employers: [...employers].map(([host, url]) => ({ host, url })),
    pagesRead,
    totalPages,
    collection,
  };
}
