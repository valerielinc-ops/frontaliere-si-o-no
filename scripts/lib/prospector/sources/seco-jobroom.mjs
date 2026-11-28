/**
 * Discovery source — job-room.ch, the Swiss public employment service feed.
 *
 * Why this feed and not a job board. Under the Stellenmeldepflicht, employers
 * hiring in occupations above the unemployment threshold MUST notify the RAV
 * before advertising anywhere else, and that notification lands here. So this
 * is not a marketing surface an employer opted into — it is a legal obligation
 * that pulls in exactly the small, local employers who never appear on the
 * national boards.
 *
 * Measured on Ticino, 30-day window: 305 ads, 186 distinct employers, of which
 * 163 (87%) were absent from our entire jobs dataset and 41 had no dedicated
 * crawler. That is the coverage gap, quantified.
 *
 * What each record hands us: the legal company name, its street address and
 * town, and — on ~45% of ads — the URL the employer wants applications sent to.
 * That URL is doing double duty: it is a careers page AND, when it points at a
 * third party, a platform sighting. The host histogram alone surfaced
 * ohws.prospective.ch, umantis.com, careers-page.com and solique.ch without
 * anyone naming a vendor.
 */
import { politeFetch } from './../polite-fetch.mjs';
import { normalizeHost, registrableDomain } from './../registrable.mjs';
import { NON_PLATFORM_HOSTS } from './../config.mjs';

const API = 'https://www.job-room.ch/jobadservice/api/jobAdvertisements/_search';

/**
 * Mailbox providers: the domain after `@` says nothing about the employer.
 * Swiss ISPs are listed because a micro-employer's address is often theirs.
 */
const SHARED_MAIL_DOMAINS = new Set([
  'bluewin.ch', 'gmail.com', 'gmx.ch', 'gmx.net', 'hispeed.ch', 'hotmail.com',
  'hotmail.it', 'icloud.com', 'libero.it', 'me.com', 'mac.com', 'outlook.com',
  'protonmail.com', 'proton.me', 'sunrise.ch', 'swissonline.ch', 'ticino.com',
  'tiscali.it', 'vtxmail.ch', 'yahoo.com', 'yahoo.it', 'zoho.com',
]);

/**
 * The employer domain an application address points at, or null when the
 * address cannot identify the employer. Only the domain ever leaves this
 * function: the mailbox can name a person and must not reach the store.
 *
 * @param {unknown} email
 * @returns {string|null}
 */
export function employerEmailDomain(email) {
  const match = /^[^@\s]+@([a-z0-9.-]+\.[a-z]{2,})$/i.exec(String(email || '').trim());
  if (!match) return null;
  const domain = registrableDomain(match[1].toLowerCase());
  if (!domain || SHARED_MAIL_DOMAINS.has(domain) || NON_PLATFORM_HOSTS.has(domain)) return null;
  return domain;
}

/**
 * Domain hints per employer name. A domain seen on two different employers is
 * an agency or a recruiting service rather than either employer's own site, the
 * same "two unrelated employers" reading the platform registry applies.
 *
 * @param {SecoEmployer[]} employers
 * @returns {Map<string, string[]>}
 */
export function emailDomainHintsByEmployer(employers = []) {
  const owners = new Map();
  for (const employer of employers) {
    for (const domain of employer.emailDomains || []) {
      owners.set(domain, (owners.get(domain) || 0) + 1);
    }
  }
  return new Map(employers.map((employer) => [
    employer.name,
    (employer.emailDomains || []).filter((domain) => owners.get(domain) === 1).slice(0, 3),
  ]));
}

/**
 * @typedef {Object} SecoEmployer
 * @property {string} name
 * @property {string} city
 * @property {string} zip
 * @property {string} canton
 * @property {string} [website]
 * @property {string[]} applyHosts  hosts seen on this employer's apply URLs
 * @property {string[]} emailDomains  employer domains seen on application addresses
 * @property {number} adCount
 * @property {string[]} titles
 */

function advertisementId(row) {
  const raw = row?.jobAdvertisement?.id ?? row?.id;
  if (typeof raw === 'string' && raw.trim()) return raw.trim();
  if (Number.isSafeInteger(raw)) return String(raw);
  return null;
}

function transportOptions(opts) {
  return { fetchImpl: opts.fetchImpl, sleepImpl: opts.sleepImpl, lookupImpl: opts.lookupImpl };
}

/**
 * The API refuses any request whose `(page + 1) * size` passes 100 with a 412
 * "Invalid Search Parameters ... narrow your search" (measured 2026-11-28:
 * page=0&size=100 and page=9&size=10 answer 200, page=1&size=100 and
 * page=10&size=10 answer 412). Nothing deeper than the first 100 rows of a query
 * is reachable, so a full read has to narrow the query, never page deeper.
 */
export const SECO_SEARCH_WINDOW = 100;

/**
 * One page of the public search, the single request behind both consumers: the
 * prospector wants the employers, the job crawler publishes the ads. Never
 * throws — each consumer decides what a failed page means.
 *
 * `displayRestricted:false` asks for what anyone can read. `x-total-count` is
 * the source's own total, and the only way to tell a complete read from a
 * short one. A page past the search window is not sent: it can only be refused.
 *
 * @param {number} page
 * @param {{ cantons: string[], onlineSince: number, pageSize: number, sort?: 'date_asc'|'date_desc', permanent?: boolean|null, workloadMin?: number, workloadMax?: number, fetchImpl?: typeof fetch, sleepImpl?: (ms:number) => Promise<unknown>, lookupImpl?: any }} opts
 * @returns {Promise<{ ok: true, batch: any[], declaredTotal: number|null } | { ok: false, outcome: 'unavailable'|'malformed', errorCode: string }>}
 */
export async function readSecoSearchPage(page, {
  cantons, onlineSince, pageSize, sort = 'date_desc', permanent = null, workloadMin = 0, workloadMax = 100,
  fetchImpl, sleepImpl, lookupImpl,
}) {
  if ((page + 1) * pageSize > SECO_SEARCH_WINDOW) {
    return { ok: false, outcome: 'unavailable', errorCode: 'search_window_exceeded' };
  }
  try {
    const res = await politeFetch(`${API}?page=${page}&size=${pageSize}&sort=${sort}`, {
      method: 'POST',
      accept: 'application/json',
      ignoreRobots: true,
      captureHeaders: ['x-total-count'],
      body: JSON.stringify({
        permanent,
        workloadPercentageMin: workloadMin,
        workloadPercentageMax: workloadMax,
        onlineSince,
        displayRestricted: false,
        keywords: [],
        professionCodes: [],
        cantonCodes: cantons,
        communalCodes: [],
        companyName: null,
      }),
      fetchImpl,
      sleepImpl,
      lookupImpl,
    });
    if (!res.ok) return { ok: false, outcome: 'unavailable', errorCode: `http_${res.status}` };
    let batch;
    try { batch = JSON.parse(res.body); } catch { batch = null; }
    if (!Array.isArray(batch)) {
      return { ok: false, outcome: 'malformed', errorCode: batch === null ? 'malformed_json' : 'unexpected_payload' };
    }
    const rawTotal = String(res.headers?.['x-total-count'] ?? '').trim();
    return { ok: true, batch, declaredTotal: /^\d+$/.test(rawTotal) ? Number(rawTotal) : null };
  } catch {
    return { ok: false, outcome: 'unavailable', errorCode: 'network_error' };
  }
}

/**
 * Further filters the API honours, applied in order to a cell that one day of
 * ads still overflows. `permanent` splits exactly (420 + 102 = 522 on TI,
 * 2026-11-28); the workload bands overlap (an ad spanning 40-60% matches both)
 * and the merge by stable id absorbs that. The probe that fixed this list: a
 * `communalCodes` filter is ignored or inconsistent without a canton and
 * `professionCodes` needs `{type, value}` objects from a list we do not have,
 * so neither can partition blindly.
 */
const SECO_REFINEMENTS = [
  () => [{ permanent: true }, { permanent: false }],
  () => [{ workloadMin: 0, workloadMax: 50 }, { workloadMin: 51, workloadMax: 100 }],
  // Measured 2026-11-28: one employer posted 103 full-time ads in a single day
  // in a canton; only the full-time band holds them (89 of 103).
  (filter) => (filter.workloadMin === 51 && filter.workloadMax === 100
    ? [{ workloadMin: 51, workloadMax: 99 }, { workloadMin: 100, workloadMax: 100 }]
    : null),
];

/**
 * The whole feed for a set of cantons, read in one sweep.
 *
 * The API shows only the first 100 rows of any query, so the read is a
 * partition: each canton is swept over `onlineSince` (nested sets, S_k = ads
 * online for at most k days). With the sort ascending, S_k opens with its
 * oldest ads, which are exactly S_k minus S_j; when that difference fits the
 * window (declared totals tell), one request reads it whole, and the sweep moves
 * on from k. A day that still overflows splits the cell on the next refinement.
 * Everything is merged by stable id, since the same ad can fall in several
 * cells and the feed moves under the sweep. Whether the result is whole is not
 * decided here: the caller holds the deduplicated rows to the root query's own
 * `x-total-count`. A cell that cannot be partitioned further, or a run over its
 * request budget, makes the snapshot `partial`, and a partial snapshot never
 * reaches the merge.
 *
 * The prospector's head/after cursors below are deliberately not used here:
 * they exist to spread a discovery sweep over several runs, while a publisher
 * must see every live ad in every run or it would retire the ones it skipped.
 *
 * @param {{ cantons?: string[], onlineSince?: number, maxRequests?: number, pageSize?: number, fetchImpl?: typeof fetch, sleepImpl?: (ms:number) => Promise<unknown>, lookupImpl?: any }} [opts]  `pageSize` is the read window (default and ceiling 100)
 * @returns {Promise<{ rows: any[], outcome: 'complete'|'partial'|'unavailable'|'malformed', errorCode: string|null, pagesRead: number, firstDeclaredTotal: number|null, lastDeclaredTotal: number|null, skippedRows: number }>}
 */
export async function fetchSecoAdSnapshot(opts = {}) {
  const cantons = opts.cantons || ['TI'];
  const onlineSince = opts.onlineSince ?? 30;
  const maxRequests = Number.isSafeInteger(opts.maxRequests) && opts.maxRequests > 0 ? opts.maxRequests : 400;
  const windowSize = Number.isSafeInteger(opts.pageSize) && opts.pageSize > 0
    ? Math.min(opts.pageSize, SECO_SEARCH_WINDOW)
    : SECO_SEARCH_WINDOW;
  const byId = new Map();
  let pagesRead = 0;
  let firstDeclaredTotal = null;
  let lastDeclaredTotal = null;
  let skippedRows = 0;
  let failure = null;
  let incompleteCode = null;
  const finish = (outcome, errorCode = null) => ({
    rows: [...byId.values()], outcome, errorCode, pagesRead, firstDeclaredTotal, lastDeclaredTotal, skippedRows,
  });

  async function read(filter, since, sort, size = windowSize) {
    if (pagesRead >= maxRequests) {
      failure = failure || { outcome: 'unavailable', errorCode: 'request_budget_exceeded' };
      return null;
    }
    const result = await readSecoSearchPage(0, { onlineSince: since, pageSize: size, sort, ...filter, ...transportOptions(opts) });
    if (!result.ok) {
      failure = failure || result;
      return null;
    }
    pagesRead++;
    if (result.declaredTotal === null) {
      failure = failure || { outcome: 'malformed', errorCode: 'missing_declared_total' };
      return null;
    }
    for (const row of result.batch) {
      const id = advertisementId(row);
      if (id) byId.set(id, row); else skippedRows++;
    }
    return result;
  }

  // Root query: its declared total is what the whole partition is held to.
  const root = await read({ cantons }, onlineSince, 'date_desc');
  if (!root) return finish(pagesRead > 0 ? 'partial' : failure.outcome, failure.errorCode);
  firstDeclaredTotal = root.declaredTotal;
  lastDeclaredTotal = root.declaredTotal;
  if (root.declaredTotal <= windowSize) return finish('complete');

  /**
   * Reads the ads of one cell that went online between day `start` (exclusive)
   * and day `end` (inclusive). `declaredAtStart` is the cell's own declared
   * total at `start`, so what each request adds is known before it is trusted.
   * @returns {Promise<boolean>} false once a request failed or ran out of budget
   */
  async function readCell(filter, refinements, start = 0, end = onlineSince, declaredAtStart = 0) {
    let from = start;
    let declaredAtFrom = declaredAtStart;
    let step = end - start;
    while (from < end) {
      const to = Math.min(end, from + step);
      const result = await read(filter, to, 'date_asc');
      if (!result) return false;
      const fresh = result.declaredTotal - declaredAtFrom;
      if (result.declaredTotal <= windowSize || fresh <= windowSize) {
        from = to;
        declaredAtFrom = result.declaredTotal;
        if (fresh * 2 < windowSize) step = Math.min(end - from, step * 2) || 1;
        continue;
      }
      if (to - from > 1) { step = Math.max(1, Math.floor((to - from) / 2)); continue; }
      // One day of this cell overflows the window: narrow the cell for that
      // day only, then carry on with this cell from the day after.
      let parts = null;
      let rest = refinements;
      while (!parts && rest.length) {
        parts = rest[0](filter);
        rest = rest.slice(1);
      }
      if (!parts) incompleteCode = incompleteCode || 'unpartitionable_leaf';
      else {
        for (const part of parts) {
          const sub = { ...filter, ...part };
          const atFrom = from === 0 ? { declaredTotal: 0 } : await read(sub, from, 'date_asc', 1);
          if (!atFrom || !await readCell(sub, rest, from, to, atFrom.declaredTotal)) return false;
        }
      }
      from = to;
      declaredAtFrom = result.declaredTotal;
    }
    return true;
  }

  for (const canton of cantons.length > 1 ? cantons : [null]) {
    const filter = { cantons: canton ? [canton] : cantons };
    if (!await readCell(filter, SECO_REFINEMENTS)) {
      return finish(pagesRead > 0 ? 'partial' : failure.outcome, failure.errorCode);
    }
  }

  // The root total again: the gap the sweep itself moved is not a short read.
  const closing = await read({ cantons }, onlineSince, 'date_desc', 1);
  // Without the closing total the opening count cannot vouch for the sweep.
  if (!closing) return finish('partial', failure?.errorCode || 'closing_total_unavailable');
  lastDeclaredTotal = closing.declaredTotal;
  if (incompleteCode) return finish('partial', incompleteCode);
  return finish('complete');
}

/**
 * @param {{ cantons?: string[], onlineSince?: number, headId?: string|null, startAfterId?: string|null, startPageHint?: number, maxPages?: number, headSearchPages?: number, cursorSearchPages?: number, pageSize?: number, fetchImpl?: typeof fetch, sleepImpl?: (ms:number) => Promise<unknown>, lookupImpl?: any }} [opts]
 * @returns {Promise<{ employers: SecoEmployer[], adCount: number, hostHistogram: Record<string, number>, outcome: 'complete'|'partial'|'unavailable'|'malformed', errorCode: string|null, pagesRead: number, headId: string|null, nextAfterId: string|null, nextAfterPageHint: number }>}
 */
export async function fetchSecoEmployers(opts = {}) {
  const cantons = opts.cantons || ['TI'];
  const onlineSince = opts.onlineSince ?? 30;
  const maxPages = Number.isSafeInteger(opts.maxPages) && opts.maxPages > 0 ? opts.maxPages : 20;
  const pageSize = Number.isSafeInteger(opts.pageSize) && opts.pageSize > 0 ? Math.min(opts.pageSize, SECO_SEARCH_WINDOW) : SECO_SEARCH_WINDOW;
  const headSearchPages = Number.isSafeInteger(opts.headSearchPages) && opts.headSearchPages > 0
    ? opts.headSearchPages
    : Math.max(20, maxPages);
  const cursorSearchPages = Number.isSafeInteger(opts.cursorSearchPages) && opts.cursorSearchPages > 0
    ? opts.cursorSearchPages
    : Math.max(20, maxPages);
  // A page behind the search window is refused by the feed: a persisted hint
  // beyond it is dropped so the cursor search starts from page 0.
  const startPageHint = Number.isSafeInteger(opts.startPageHint) && opts.startPageHint > 0
    && (opts.startPageHint + 1) * pageSize <= SECO_SEARCH_WINDOW ? opts.startPageHint : 0;
  const startAfterId = typeof opts.startAfterId === 'string' && opts.startAfterId.trim()
    ? opts.startAfterId.trim()
    : null;
  const savedHeadId = typeof opts.headId === 'string' && opts.headId.trim() ? opts.headId.trim() : null;

  /** @type {Map<string, SecoEmployer>} */
  const employers = new Map();
  /** @type {Record<string, number>} */
  const hostHistogram = {};
  const seenIds = new Set();
  const pageCache = new Map();
  let adCount = 0;
  let pagesRead = 0;
  let malformedRows = 0;
  let headId = savedHeadId;
  let nextAfterId = startAfterId;
  let nextAfterPageHint = startPageHint;
  let headSearchIncomplete = false;

  const finish = (outcome = 'complete', errorCode = null) => {
    const finalOutcome = outcome === 'complete' && malformedRows ? 'partial' : outcome;
    const finalErrorCode = errorCode || (malformedRows ? 'malformed_records' : null);
    return {
      employers: [...employers.values()], adCount, hostHistogram,
      outcome: finalOutcome, errorCode: finalErrorCode, pagesRead,
      headId, nextAfterId, nextAfterPageHint,
    };
  };
  const failedOutcome = (failure, code) => (pagesRead > 0 || employers.size > 0)
    ? finish('partial', code)
    : finish(failure, code);

  async function readPage(page) {
    if (pageCache.has(page)) return pageCache.get(page);
    const result = await readSecoSearchPage(page, { cantons, onlineSince, pageSize, ...transportOptions(opts) });
    pageCache.set(page, result);
    if (result.ok) pagesRead++;
    return result;
  }

  function processRow(row, page, { advanceCursor = false } = {}) {
    const id = advertisementId(row);
    if (!id) {
      malformedRows++;
      // The row cannot become a cursor, but it must not hide later valid ads
      // in the same page. Keep the run partial and advance on the next stable ID.
      return { ok: true, skipped: true };
    }
    if (advanceCursor) {
      nextAfterId = id;
      nextAfterPageHint = page;
    }
    if (seenIds.has(id)) return { ok: true, id };
    seenIds.add(id);

    const jc = row?.jobAdvertisement?.jobContent;
    if (!jc) { malformedRows++; return { ok: true, id }; }
    adCount++;
    const c = jc.company || {};
    const name = String(c.name || '').trim();
    if (!name) { malformedRows++; return { ok: true, id }; }
    const key = name.toLowerCase();
    if (!employers.has(key)) {
      employers.set(key, {
        name,
        city: String(c.city || '').trim(),
        zip: String(c.postalCode || '').trim(),
        canton: cantons.length === 1 ? cantons[0] : '',
        website: c.website || undefined,
        applyHosts: [],
        emailDomains: [],
        adCount: 0,
        titles: [],
      });
    }
    const e = employers.get(key);
    e.adCount++;
    const title = (jc.jobDescriptions || [])[0]?.title;
    if (title && e.titles.length < 5) e.titles.push(String(title).slice(0, 120));
    const emailDomain = employerEmailDomain(jc.applyChannel?.emailAddress);
    if (emailDomain && !e.emailDomains.includes(emailDomain)) e.emailDomains.push(emailDomain);
    const url = jc.externalUrl || jc.applyChannel?.formUrl || null;
    if (url) {
      try {
        const host = normalizeHost(new URL(url).hostname);
        if (host) {
          if (!e.applyHosts.includes(host)) e.applyHosts.push(host);
          hostHistogram[host] = (hostHistogram[host] || 0) + 1;
        }
      } catch { /* malformed apply URL */ }
    }
    return { ok: true, id };
  }

  function processRows(batch, page, startIndex = 0, endIndex = batch.length, advanceCursor = false) {
    for (let index = startIndex; index < endIndex; index++) {
      const result = processRow(batch[index], page, { advanceCursor });
      if (!result.ok) return result;
    }
    return { ok: true };
  }

  // The head cursor finds new advertisements inserted ahead of an older
  // partial-run cursor. The older cursor then continues the previous sweep.
  // Both are record IDs; page numbers are only lookup hints, never progress.
  if (savedHeadId) {
    let foundHead = false;
    let reachedEnd = false;
    let firstId = null;
    let lastHeadScanId = null;
    let lastHeadScanPage = 0;
    for (let page = 0; page < headSearchPages; page++) {
      const responsePage = await readPage(page);
      if (!responsePage.ok) return failedOutcome(responsePage.outcome, responsePage.errorCode);
      const { batch } = responsePage;
      if (page === 0 && batch.length) {
        firstId = batch.map(advertisementId).find(Boolean) || null;
        if (!firstId) return failedOutcome('malformed', 'missing_advertisement_id');
      }
      if (!batch.length) { reachedEnd = true; break; }
      const markerIndex = batch.findIndex((row) => advertisementId(row) === savedHeadId);
      const countBeforeMarker = markerIndex >= 0 ? markerIndex : batch.length;
      const processed = processRows(batch, page, 0, countBeforeMarker, false);
      if (!processed.ok) return finish('partial', processed.errorCode);
      if (markerIndex >= 0) {
        foundHead = true;
        headId = firstId || savedHeadId;
        break;
      }
      const pageLastId = [...batch].reverse().map(advertisementId).find(Boolean);
      if (pageLastId) {
        lastHeadScanId = pageLastId;
        lastHeadScanPage = page;
      }
      if (batch.length < pageSize) { reachedEnd = true; break; }
    }
    if (!foundHead) {
      if (reachedEnd) headId = firstId;
      else {
        // Persist the bounded head scan's progress. Replace the older
        // backfill boundary: continuing from it would jump over this gap.
        headId = firstId || savedHeadId;
        nextAfterId = lastHeadScanId;
        nextAfterPageHint = lastHeadScanPage;
        headSearchIncomplete = true;
      }
    }
  }

  if (headSearchIncomplete) return finish('partial', 'head_cursor_not_found');

  // A stable cursor can move to a later page when new ads are inserted. Try
  // the saved page hint first, then fall back to a bounded search from page 0
  // if removals or other source changes moved the record earlier.
  if (startAfterId) {
    async function findCursor(fromPage, pagesToSearch) {
      let reachedEnd = false;
      for (let offset = 0; offset < pagesToSearch; offset++) {
        const page = fromPage + offset;
        const responsePage = await readPage(page);
        if (!responsePage.ok) return { failure: responsePage };
        const { batch } = responsePage;
        if (!batch.length) return { reachedEnd: true };
        const index = batch.findIndex((row) => advertisementId(row) === startAfterId);
        if (index >= 0) return { page, batch, index };
        if (batch.length < pageSize) { reachedEnd = true; break; }
      }
      return { reachedEnd };
    }

    let cursor = await findCursor(startPageHint, cursorSearchPages);
    if (!cursor.page && !cursor.failure && !cursor.reachedEnd && startPageHint > 0) {
      const fallbackPages = Math.min(500, Math.max(cursorSearchPages, startPageHint + cursorSearchPages));
      cursor = await findCursor(0, fallbackPages);
    }
    if (cursor.failure) return failedOutcome(cursor.failure.outcome, cursor.failure.errorCode);
    if (!Number.isSafeInteger(cursor.page)) {
      // Do not skip ahead from a boundary that disappeared. A fresh sweep on
      // the next invocation resumes from the current head and safely replays
      // candidates the store has already seen.
      if (cursor.reachedEnd || cursorSearchPages > 0) {
        headId = null;
        nextAfterId = null;
        nextAfterPageHint = 0;
      }
      return finish('partial', cursor.reachedEnd ? 'cursor_expired' : 'cursor_not_found');
    }

    let page = cursor.page;
    let batch = cursor.batch;
    let continuationPages = 0;
    const afterMarker = processRows(batch, page, cursor.index + 1, batch.length, true);
    if (!afterMarker.ok) return finish('partial', afterMarker.errorCode);
    if (cursor.index + 1 < batch.length) continuationPages++;
    if (batch.length < pageSize) {
      nextAfterId = null;
      nextAfterPageHint = 0;
      return finish(headSearchIncomplete ? 'partial' : 'complete', headSearchIncomplete ? 'head_cursor_not_found' : null);
    }

    page++;
    while (continuationPages < maxPages) {
      const responsePage = await readPage(page);
      if (!responsePage.ok) return failedOutcome(responsePage.outcome, responsePage.errorCode);
      batch = responsePage.batch;
      if (!batch.length) {
        nextAfterId = null;
        nextAfterPageHint = 0;
        return finish(headSearchIncomplete ? 'partial' : 'complete', headSearchIncomplete ? 'head_cursor_not_found' : null);
      }
      const processed = processRows(batch, page, 0, batch.length, true);
      if (!processed.ok) return finish('partial', processed.errorCode);
      continuationPages++;
      if (batch.length < pageSize) {
        nextAfterId = null;
        nextAfterPageHint = 0;
        return finish(headSearchIncomplete ? 'partial' : 'complete', headSearchIncomplete ? 'head_cursor_not_found' : null);
      }
      page++;
    }
    return finish('partial', headSearchIncomplete ? 'head_cursor_not_found' : 'page_limit_reached');
  }

  // No backfill is pending once a head cursor has been established. A normal
  // later run only needs the short head scan above to collect newly inserted
  // ads; the store handles duplicates from the overlap window.
  if (savedHeadId) {
    return finish();
  }

  // Initial sweep: no cursor exists yet, so read from the head and persist a
  // stable advertisement ID after each complete page.
  for (let page = 0; page < maxPages; page++) {
    const responsePage = await readPage(page);
    if (!responsePage.ok) return failedOutcome(responsePage.outcome, responsePage.errorCode);
    const { batch } = responsePage;
    if (!batch.length) {
      nextAfterId = null;
      nextAfterPageHint = 0;
      return finish();
    }
    if (page === 0) {
      headId = batch.map(advertisementId).find(Boolean) || null;
      if (!headId) return finish('partial', 'missing_advertisement_id');
    }
    const processed = processRows(batch, page, 0, batch.length, true);
    if (!processed.ok) return finish('partial', processed.errorCode);
    if (batch.length < pageSize) {
      nextAfterId = null;
      nextAfterPageHint = 0;
      return finish();
    }
  }
  return finish('partial', 'page_limit_reached');
}
