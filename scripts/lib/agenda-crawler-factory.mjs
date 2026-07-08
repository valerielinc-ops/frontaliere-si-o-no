#!/usr/bin/env node
/**
 * scripts/lib/agenda-crawler-factory.mjs
 *
 * Reusable quota-free "agenda" crawler factory (issue #3644, F2 of #3125).
 *
 * Generalizes the fetch-loop → parse → merge-by-id → DOM-drift-guard →
 * mirror-images → write-slice orchestration that scripts/crawl-tio-agenda.mjs's
 * own `main()` pioneered, so a new source-canton pilot doesn't hand-roll it
 * again — same relationship as `createWorkdaySwissParser` has to the job
 * crawlers (scripts/lib/workday-swiss-job-parser-common.mjs): validates
 * required config, returns a small object of functions; every source-specific
 * detail (URL shape, card selectors, comune resolution, date-text parsing)
 * lives in the caller-supplied `baseUrl`/`parseDayHtml`, not here.
 *
 * `crawl-tio-agenda.mjs` itself is NOT refactored onto this factory — it has
 * extra per-event enrichment (price, geocoding, title translation) this pilot
 * doesn't need, and re-plumbing a crawler that commits straight to `main`
 * daily is a bigger, separate risk than this issue's stated scope (one pilot
 * canton). New agenda sources should use this factory; nothing here
 * duplicates it (there was no factory before this file).
 *
 * Contract per iteration `i` (0-based, opaque — interpreted by the caller):
 *   - tio.ch is DAY-indexed: `i` is a day offset from today.
 *   - Ville de Genève's `/agenda` listing is PAGE-indexed (`?page=N`,
 *     chronologically ascending, no date in the URL) — `i` is a page number.
 *   Either way, `baseUrl(i)` returns the URL to fetch for that iteration and
 *   `parseDayHtml(html, i)` returns the events found on it.
 *
 * Required per-event fields from `parseDayHtml` (assembler's own gate — see
 * assemble-events-dataset.mjs `assemble()`): `id` (MUST come from
 * `eventStableId(sourceKey, rawId)` so identity is stable run-to-run),
 * `title`, `startDate`.
 *
 * Recurrence across iterations: an id seen again on a later iteration has its
 * `endDate` extended forward (mirrors tio-agenda's own within-run merge) —
 * only matters for sources whose `parseDayHtml` can re-emit the same id with
 * a later `startDate` (day-indexed sources); a no-op for page-indexed sources
 * where each event appears on exactly one page.
 *
 * DOM-drift guard (issue #3644): if at least one page fetched OK (HTTP 200)
 * but the WHOLE run parsed 0 events, `process.exitCode = 1` so
 * crawl-events.yml opens a failure issue instead of letting the dataset go
 * silently stale — mirrors crawl-tio-agenda.mjs's own guard exactly. If every
 * fetch failed instead (network/WAF), that's treated as transient: soft-exit
 * 0, no slice write, existing slice on disk is left untouched.
 *
 * Termination for page-indexed sources (no fixed day horizon): two optional,
 * off-by-default knobs so day-indexed sources (there are none on this
 * factory yet, but the default must stay safe) are unaffected —
 *   - `horizonDays`: stop paging once an iteration's furthest-seen
 *     `startDate` reaches `today + horizonDays` (assumes ascending
 *     chronological order, true for Genève's listing — verified live).
 *   - `stopOnEmptyPage`: once at least one event has been collected, stop
 *     after 2 consecutive iterations that parsed 0 events (real end of a
 *     paginated listing returns HTTP 200 with 0 cards, verified live at
 *     `?page=999`) — NOT applied before any event has been seen, so a
 *     source with genuine event-free gaps early in its horizon doesn't
 *     terminate early.
 *   `iterations` remains a hard safety ceiling in all cases.
 *
 * No-hotlink policy: every event's `imageUrl` is mirrored via the shared
 * `mirrorEventImage` (events-utils.mjs) before the slice is written — the
 * same convention every existing events crawler already follows.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { EVENT_SOURCES, EVENTS_SLICE_DIR, mirrorEventImage } from './events-utils.mjs';

const DEFAULT_USER_AGENT = 'Mozilla/5.0 (compatible; FrontaliereTicinoBot/1.0; +https://frontaliereticino.ch)';
const DEFAULT_FETCH_TIMEOUT_MS = 20000;
const DEFAULT_POLITE_DELAY_MS = 600;
const DEFAULT_IMAGE_MIRROR_DELAY_MS = 150;
const DEFAULT_ITERATIONS = 21;
const CONSECUTIVE_EMPTY_LIMIT = 2;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * @typedef {object} AgendaCrawlerConfig
 * @property {string} sourceKey - must have a matching `EVENT_SOURCES` entry.
 * @property {(i: number) => string} baseUrl
 * @property {(html: string, i: number) => Array<object> | Promise<Array<object>>} parseDayHtml
 * @property {number} [iterations] - default loop count / hard safety ceiling.
 * @property {number} [horizonDays] - stop once furthest-seen startDate reaches today+N.
 * @property {boolean} [stopOnEmptyPage] - stop after 2 consecutive empty-but-ok pages (once >=1 event seen).
 * @property {string} [userAgent]
 * @property {number} [fetchTimeoutMs]
 * @property {number} [politeDelayMs]
 * @property {number} [imageMirrorDelayMs]
 * @property {boolean} [mirrorImages] - default true (no-hotlink policy).
 * @property {typeof fetch} [fetchImpl] - injectable for tests.
 */

/** @param {AgendaCrawlerConfig} config */
export function createAgendaCrawler(config) {
  const {
    sourceKey,
    baseUrl,
    parseDayHtml,
    iterations: defaultIterations = DEFAULT_ITERATIONS,
    horizonDays,
    stopOnEmptyPage = false,
    userAgent = DEFAULT_USER_AGENT,
    fetchTimeoutMs = DEFAULT_FETCH_TIMEOUT_MS,
    politeDelayMs = DEFAULT_POLITE_DELAY_MS,
    imageMirrorDelayMs = DEFAULT_IMAGE_MIRROR_DELAY_MS,
    mirrorImages = true,
    fetchImpl = fetch,
  } = config || {};

  if (!sourceKey || typeof sourceKey !== 'string') {
    throw new Error('createAgendaCrawler: sourceKey (string) is required');
  }
  if (typeof baseUrl !== 'function') {
    throw new Error('createAgendaCrawler: baseUrl(i) function is required');
  }
  if (typeof parseDayHtml !== 'function') {
    throw new Error('createAgendaCrawler: parseDayHtml(html, i) function is required');
  }
  const source = EVENT_SOURCES[sourceKey];
  if (!source) {
    throw new Error(`createAgendaCrawler: no EVENT_SOURCES['${sourceKey}'] entry — add one in events-utils.mjs first`);
  }

  async function fetchHtml(url) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), fetchTimeoutMs);
    try {
      const res = await fetchImpl(url, { headers: { 'User-Agent': userAgent }, signal: controller.signal });
      if (!res.ok) return null;
      return await res.text();
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Returns a NEW array (does not mutate `events`). */
  async function mirrorImagesForEvents(events) {
    if (!mirrorImages) return events;
    const out = [];
    for (const ev of events) {
      if (!ev.imageUrl) {
        out.push(ev);
        continue;
      }
      const mirrored = await mirrorEventImage(ev.imageUrl, ev.id);
      out.push({ ...ev, imageUrl: mirrored || undefined });
      await sleep(imageMirrorDelayMs);
    }
    return out;
  }

  /**
   * Run the fetch → parse → merge loop, then write the per-source slice
   * (unless `dryRun`). Never overwrites a good slice with an empty one —
   * see the DOM-drift guard in the file header.
   *
   * @param {{ iterations?: number, dryRun?: boolean }} [options]
   */
  async function crawl({ iterations = defaultIterations, dryRun = false } = {}) {
    const crawledAt = new Date().toISOString();
    const today = crawledAt.slice(0, 10);
    const horizonDate = horizonDays ? new Date(Date.now() + horizonDays * 86400000).toISOString().slice(0, 10) : null;

    const byId = new Map();
    let pagesOk = 0;
    let pagesFail = 0;
    let emptyStreak = 0;
    let maxSeenDate = '';

    for (let i = 0; i < iterations; i += 1) {
      const html = await fetchHtml(baseUrl(i));
      if (!html) {
        pagesFail += 1;
        if (i < iterations - 1) await sleep(politeDelayMs);
        continue;
      }
      pagesOk += 1;

      let parsed = [];
      try {
        parsed = (await parseDayHtml(html, i)) || [];
      } catch (err) {
        console.error(`[${sourceKey}] parseDayHtml threw on iteration ${i}: ${err?.message || err}`);
        parsed = [];
      }

      if (parsed.length > 0) {
        emptyStreak = 0;
        for (const ev of parsed) {
          if (!ev || !ev.id) continue;
          if (ev.startDate && ev.startDate > maxSeenDate) maxSeenDate = ev.startDate;
          const existing = byId.get(ev.id);
          if (existing) {
            if (ev.startDate && ev.startDate > (existing.endDate || existing.startDate)) {
              existing.endDate = ev.startDate;
            }
          } else {
            // Per-event stamp, not just slice-level metadata below — eventLd()'s
            // `organizer.name` reads `event.sourceName` directly (GSC "missing
            // name in organizer" for every ge-agenda event before this fix).
            byId.set(ev.id, { ...ev, sourceKey: source.key, sourceName: source.label, crawledAt });
          }
        }
      } else if (stopOnEmptyPage && byId.size > 0) {
        emptyStreak += 1;
        if (emptyStreak >= CONSECUTIVE_EMPTY_LIMIT) break;
      }

      if (horizonDate && maxSeenDate >= horizonDate) break;
      if (i < iterations - 1) await sleep(politeDelayMs);
    }

    const events = [...byId.values()];
    console.log(
      `[${sourceKey}] ${events.length} events over ${pagesOk + pagesFail} iteration(s) ` +
        `(${pagesOk} pages ok, ${pagesFail} failed, today=${today})`,
    );

    if (events.length === 0) {
      console.log(`[${sourceKey}] 0 events parsed — leaving existing slice untouched`);
      if (pagesOk > 0) {
        console.error(
          `[${sourceKey}] DOM drift? ${pagesOk} page(s) returned HTTP 200 but yielded 0 events — check parseDayHtml's selectors`,
        );
        process.exitCode = 1;
      }
      return { events: [], pagesOk, pagesFail, written: false };
    }

    const mirroredEvents = await mirrorImagesForEvents(events);
    const sorted = [...mirroredEvents].sort((a, b) => (a.startDate || '').localeCompare(b.startDate || ''));

    if (dryRun) {
      console.log(`[${sourceKey}] dry-run — slice not written`);
      return { events: sorted, pagesOk, pagesFail, written: false };
    }

    mkdirSync(EVENTS_SLICE_DIR, { recursive: true });
    const slicePath = path.join(EVENTS_SLICE_DIR, `${source.key}.json`);
    const slice = {
      schemaVersion: 1,
      sourceKey: source.key,
      sourceName: source.label,
      canton: source.canton,
      assembledAt: crawledAt,
      events: sorted,
    };
    writeFileSync(slicePath, `${JSON.stringify(slice, null, 2)}\n`, 'utf-8');
    console.log(`[${sourceKey}] wrote ${sorted.length} events → ${path.relative(process.cwd(), slicePath)}`);
    return { events: sorted, pagesOk, pagesFail, written: true };
  }

  return { fetchHtml, crawl };
}
