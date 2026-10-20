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
import { normalizeHost } from './../registrable.mjs';

const API = 'https://www.job-room.ch/jobadservice/api/jobAdvertisements/_search';

/**
 * @typedef {Object} SecoEmployer
 * @property {string} name
 * @property {string} city
 * @property {string} zip
 * @property {string} canton
 * @property {string} [website]
 * @property {string[]} applyHosts  hosts seen on this employer's apply URLs
 * @property {number} adCount
 * @property {string[]} titles
 */

function advertisementId(row) {
  const raw = row?.jobAdvertisement?.id ?? row?.id;
  if (typeof raw === 'string' && raw.trim()) return raw.trim();
  if (Number.isSafeInteger(raw)) return String(raw);
  return null;
}

/**
 * @param {{ cantons?: string[], onlineSince?: number, headId?: string|null, startAfterId?: string|null, startPageHint?: number, maxPages?: number, headSearchPages?: number, cursorSearchPages?: number, pageSize?: number, fetchImpl?: typeof fetch, sleepImpl?: (ms:number) => Promise<unknown>, lookupImpl?: any }} [opts]
 * @returns {Promise<{ employers: SecoEmployer[], adCount: number, hostHistogram: Record<string, number>, outcome: 'complete'|'partial'|'unavailable'|'malformed', errorCode: string|null, pagesRead: number, headId: string|null, nextAfterId: string|null, nextAfterPageHint: number }>}
 */
export async function fetchSecoEmployers(opts = {}) {
  const cantons = opts.cantons || ['TI'];
  const onlineSince = opts.onlineSince ?? 30;
  const maxPages = Number.isSafeInteger(opts.maxPages) && opts.maxPages > 0 ? opts.maxPages : 20;
  const pageSize = Number.isSafeInteger(opts.pageSize) && opts.pageSize > 0 ? opts.pageSize : 100;
  const headSearchPages = Number.isSafeInteger(opts.headSearchPages) && opts.headSearchPages > 0
    ? opts.headSearchPages
    : Math.max(20, maxPages);
  const cursorSearchPages = Number.isSafeInteger(opts.cursorSearchPages) && opts.cursorSearchPages > 0
    ? opts.cursorSearchPages
    : Math.max(20, maxPages);
  const startPageHint = Number.isSafeInteger(opts.startPageHint) && opts.startPageHint >= 0 ? opts.startPageHint : 0;
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
    let result;
    try {
      const res = await politeFetch(`${API}?page=${page}&size=${pageSize}&sort=date_desc`, {
        method: 'POST',
        accept: 'application/json',
        ignoreRobots: true,
        body: JSON.stringify({
          permanent: null,
          workloadPercentageMin: 0,
          workloadPercentageMax: 100,
          onlineSince,
          displayRestricted: false,
          keywords: [],
          professionCodes: [],
          cantonCodes: cantons,
          communalCodes: [],
          companyName: null,
        }),
        fetchImpl: opts.fetchImpl,
        sleepImpl: opts.sleepImpl,
        lookupImpl: opts.lookupImpl,
      });
      if (!res.ok) result = { ok: false, outcome: 'unavailable', errorCode: `http_${res.status}` };
      else {
        let batch;
        try { batch = JSON.parse(res.body); } catch { batch = null; }
        if (!Array.isArray(batch)) result = { ok: false, outcome: 'malformed', errorCode: batch === null ? 'malformed_json' : 'unexpected_payload' };
        else result = { ok: true, batch };
      }
    } catch {
      result = { ok: false, outcome: 'unavailable', errorCode: 'network_error' };
    }
    pageCache.set(page, result);
    if (result.ok) pagesRead++;
    return result;
  }

  function processRow(row, page, { advanceCursor = false } = {}) {
    const id = advertisementId(row);
    if (!id) {
      malformedRows++;
      return { ok: false, errorCode: 'missing_advertisement_id' };
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
        adCount: 0,
        titles: [],
      });
    }
    const e = employers.get(key);
    e.adCount++;
    const title = (jc.jobDescriptions || [])[0]?.title;
    if (title && e.titles.length < 5) e.titles.push(String(title).slice(0, 120));
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
        firstId = advertisementId(batch[0]);
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
      lastHeadScanId = advertisementId(batch[batch.length - 1]);
      lastHeadScanPage = page;
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
      headId = advertisementId(batch[0]);
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
