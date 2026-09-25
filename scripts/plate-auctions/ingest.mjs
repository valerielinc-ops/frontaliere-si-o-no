#!/usr/bin/env node
/**
 * Local/CI snapshot builder for the public plate-auction API.
 *
 * It deliberately writes only sanitized public records. A failed or empty
 * source never overwrites a non-empty previous snapshot; the caller can then
 * inspect the source status and retry without publishing a false zero.
 */
import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import registry from '../../data/plate-auction-sources-registry.json' with { type: 'json' };
import { fetchGrPlateAuctions } from './connectors/gr.mjs';
import { fetchSgPlateAuctions } from './connectors/sg.mjs';
import { fetchShPlateAuctions } from './connectors/sh.mjs';
import { fetchSzPlateAuctions } from './connectors/sz.mjs';
import { fetchTgPlateAuctions } from './connectors/tg.mjs';
import { fetchVsPlateAuctions } from './connectors/vs.mjs';
import { fetchZhPlateAuctions } from './connectors/zh.mjs';
import { fetchExpandedCard, fetchExpandedEcari } from './connectors/expanded.mjs';
import {
  fetchAiFixedPrice,
  fetchBsFixedPrice,
  fetchGlFixedPrice,
  fetchLuFixedPrice,
  fetchUrFixedPrice,
} from './connectors/fixed-price.mjs';
import {
  checkPlateAuctionQuality,
  derivePlateAuctionDataConfidence,
  PLATE_AUCTION_MISSING_GRACE_MS,
  PLATE_AUCTION_SALE_RECOGNITION,
  observeCatalogueDisappearance,
  recognizeCatalogueSales,
} from '../../functions/src/plateAuctionQualityCore.js';
import { isExplicitlyEmptyCatalogue } from '../../functions/src/plateAuctionsCore.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_OUTPUT = resolve(__dirname, '../../public/data/plate-auctions.json');
export const FETCHERS = {
  ag: () => fetchExpandedCard('ag'),
  ai: fetchAiFixedPrice,
  ar: () => fetchExpandedEcari('ar'),
  be: () => fetchExpandedCard('be'),
  bl: () => fetchExpandedEcari('bl'),
  bs: fetchBsFixedPrice,
  // fr and ti have no fetcher on purpose: their registry status is `blocked`
  // because the canton endpoints are unreachable, and check-health.mjs treats a
  // fetcher without an active source as an error. The parser configs stay in
  // connectors/ so re-activating them is a registry change plus one line here.
  gl: fetchGlFixedPrice,
  gr: fetchGrPlateAuctions,
  lu: fetchLuFixedPrice,
  nw: () => fetchExpandedEcari('nw'),
  ow: () => fetchExpandedEcari('ow'),
  sg: fetchSgPlateAuctions,
  sh: fetchShPlateAuctions,
  so: () => fetchExpandedEcari('so'),
  sz: fetchSzPlateAuctions,
  tg: fetchTgPlateAuctions,
  ur: fetchUrFixedPrice,
  vd: () => fetchExpandedCard('vd'),
  vs: fetchVsPlateAuctions,
  zh: fetchZhPlateAuctions,
};

function readPrevious(path) {
  if (!existsSync(path)) return null;
  try {
    const value = JSON.parse(readFileSync(path, 'utf8'));
    return value && typeof value === 'object' ? value : null;
  } catch {
    return null;
  }
}

function sourceStatus(source, result) {
  const base = {
    ...source,
    rowCount: result.fetchedRowCount,
    lastFetchedAt: result.fetchedAt,
    lastCheckedAt: result.fetchedAt,
  };
  if (result.error) return { ...base, status: 'degraded', rowCount: result.previousRows.length, errorCode: 'fetch_failed', lastSuccessAt: result.previousSuccessAt };
  // Recognised sales are a healthy catalogue doing what a catalogue does; only
  // an unrecognised loss is evidence of a broken or truncated upstream.
  if (result.sourceDisappeared && !result.allLossesAreSales) return {
    ...base,
    status: 'degraded',
    rowCount: result.rows.length,
    errorCode: 'source_disappeared',
    lastSuccessAt: result.previousSuccessAt,
  };
  if (result.zeroRows && source.status === 'active') return {
    ...base,
    status: 'degraded',
    // An empty fetch carries the previous rows forward. The health gate
    // compares rowCount with the rows actually present in the snapshot, and
    // lastSuccessAt must identify the previous successful fetch rather than
    // pretending this empty response was a successful catalogue.
    rowCount: result.rows.length,
    errorCode: 'zero_rows',
    lastSuccessAt: result.previousSuccessAt,
  };
  // `rowCount` must describe the rows this snapshot actually carries for the
  // source, because check-health.mjs compares it against them and fails the
  // run on a mismatch. `fetchedRowCount` is the count the FETCH returned,
  // which differs whenever a row is carried (an expired auction archived, or
  // a deadline-protected row preserved) — the degraded branches above already
  // report the output count for exactly this reason.
  return { ...base, rowCount: result.rows.length, status: source.status, lastSuccessAt: result.fetchedAt };
}

function mergeWithPrevious(rows, previousRows, sourceKey) {
  const previousById = new Map(previousRows.filter((row) => row.sourceKey === sourceKey).map((row) => [row.id, row]));
  return rows.map((row) => {
    const previous = previousById.get(row.id);
    return {
      ...row,
      ...(previous?.firstSeenAt ? { firstSeenAt: previous.firstSeenAt } : {}),
    };
  });
}

function applyQualityPolicy(rows, previousRows, now) {
  const previousById = new Map(previousRows.map((row) => [row.id, row]));
  const issues = checkPlateAuctionQuality(rows, previousById, now);
  const issuesById = new Map();
  for (const item of issues) {
    if (item.id === 'batch') continue;
    const group = issuesById.get(item.id) || [];
    group.push(item);
    issuesById.set(item.id, group);
  }
  return {
    rows: rows.map((row) => ({
      ...row,
      dataConfidence: derivePlateAuctionDataConfidence(row.dataConfidence, issuesById.get(row.id) || []),
    })),
    issues,
  };
}

export const PLATE_AUCTION_HISTORY_CAP = 5000;
export {
  PLATE_AUCTION_MISSING_GRACE_MS,
  PLATE_AUCTION_SALE_RECOGNITION,
  observeCatalogueDisappearance,
  recognizeCatalogueSales,
};




/** Latest observation per id wins; input must be oldest-first. */
function dedupeHistoryById(rows) {
  const byId = new Map();
  for (const row of rows) byId.set(row.id, row);
  return [...byId.values()];
}

function closeExpiredObservation(row, now) {
  const endsAt = row?.endsAt ? Date.parse(row.endsAt) : NaN;
  if (!Number.isFinite(endsAt) || !['active', 'upcoming'].includes(row.auctionStatus) || endsAt > now.getTime()) return row;
  return {
    ...row,
    auctionStatus: 'closed',
    closedAt: row.closedAt || row.endsAt,
    // A deadline is not a sale result. Keep the record usable for history but
    // never let it enter a final-price ranking without an official final.
    dataConfidence: row.dataConfidence === 'verified' ? 'partial' : row.dataConfidence,
  };
}

function isUnexpiredActiveObservation(row, now) {
  if (!['active', 'upcoming'].includes(row.auctionStatus)) return false;
  const endsAt = row?.endsAt ? Date.parse(row.endsAt) : NaN;
  return !Number.isFinite(endsAt) || endsAt > now.getTime();
}

/** Epoch ms of the run that first preserved this row as missing, or NaN. */
function missingSinceMs(row) {
  return Date.parse(row?.missingSince || '');
}

/**
 * @param {{
 *   fetchers?: Record<string, () => Promise<any[]>>,
 *   selectedCantons?: string[],
 *   previous?: any,
 *   now?: Date,
 * }} options
 */
export async function collectPlateAuctions({
  fetchers = FETCHERS,
  selectedCantons = Object.keys(fetchers),
  previous = null,
  now = new Date(),
} = {}) {
  const previousRows = Array.isArray(previous?.auctions) ? previous.auctions : [];
  const results = {};
  for (const key of selectedCantons) {
    const source = registry.sources[key];
    if (!source || source.status !== 'active' || typeof fetchers[key] !== 'function') continue;
    const fetchedAt = now.toISOString();
    try {
      const rows = await fetchers[key]();
      // An empty fetch is a failure UNLESS the source itself said its
      // catalogue is empty (eCari between two rounds). That answer is as
      // authoritative as a non-empty catalogue: its missing rows take the
      // normal path — archived past their deadline, otherwise preserved and
      // judged — instead of the `zero_rows` carry-over of a broken fetch.
      const answered = rows.length > 0 || isExplicitlyEmptyCatalogue(rows);
      const previousForSource = previousRows.filter((row) => row.sourceKey === source.plateCode);
      const previousSuccessAt = previous?.sources?.[key]?.lastSuccessAt || previous?.generatedAt;
      const mergedRows = mergeWithPrevious(rows, previousRows, source.plateCode);
      const quality = applyQualityPolicy(mergedRows, previousForSource, now);
      const normalizedRows = quality.rows;
      const fetchedIds = new Set(normalizedRows.map((row) => row.id));
      const missingPreviousRows = previousForSource.filter((row) => !fetchedIds.has(row.id));
      const expiredCarry = missingPreviousRows
        .map((row) => closeExpiredObservation(row, now))
        .filter((row, index, all) => row.auctionStatus === 'closed' && all.findIndex((candidate) => candidate.id === row.id) === index);
      // Is this loss shaped like sales, or like a truncated catalogue?
      //
      // Only a row with NO deadline is ambiguous. A row that vanishes before
      // its own published deadline is an upstream anomaly whatever the shape
      // of the loss — the auction should still have been listed — so it keeps
      // the existing preserve-as-live behaviour and is never read as a sale.
      // Preservation is bounded either way: a row still absent after
      // PLATE_AUCTION_MISSING_GRACE_MS is recorded as gone (see below).
      // Deadline-less rows are the fixed-price catalogue (16'976 of 17'260),
      // where disappearance is the only sale signal that exists.
      const stillLive = missingPreviousRows.filter((row) => isUnexpiredActiveObservation(row, now));
      // A row an earlier run preserved carries `missingSince`. That run already
      // judged and reported its absence, so it is not evidence about THIS
      // fetch. Judged again, the same rows re-tripped the guard on every run and
      // no source could ever recover: UR logged previous=460 fetched=447
      // vanished=13 on 2026-09-20 and again on 2026-09-24, and LU's preserved
      // rows grew from 146 to 188 while its PDF kept listing ~140 plates.
      const newlyMissing = stillLive.filter((row) => !Number.isFinite(missingSinceMs(row)));
      const knownMissing = stillLive.filter((row) => Number.isFinite(missingSinceMs(row)));
      // A sale candidate must be a fixed-price row AND have no usable deadline.
      // Requiring the type matters: a malformed timed-auction row whose
      // `endsAt` is missing or unparseable would otherwise be stamped `closed`
      // and entered into history as a sale whenever band/cap pass. Every other
      // missing row — future deadline, or malformed but not fixed-price — is
      // protected and preserved.
      const isSaleCandidate = (row) => row.listingType === 'fixed-price'
        && !Number.isFinite(Date.parse(row.endsAt || ''));
      const saleCandidates = newlyMissing.filter(isSaleCandidate);
      const protectedRows = newlyMissing.filter((row) => !isSaleCandidate(row));
      // The denominator is what the LAST fetch listed. Archived rows carried
      // by `expiredCarry` are excluded (they end up in the next run's
      // `previous.auctions` and would inflate it over time until the band
      // starved), and so are rows still preserved from an earlier run: the
      // upstream did not list them last time either, so counting them measured
      // a healthy catalogue against its own ghosts and failed the band forever.
      const previousLiveCount = previousForSource
        .filter((row) => ['active', 'upcoming'].includes(row?.auctionStatus) && !Number.isFinite(missingSinceMs(row))).length;
      const saleDecision = recognizeCatalogueSales({
        sourceKey: key,
        previousCount: previousLiveCount,
        fetchedCount: rows.length,
        vanishedCount: saleCandidates.length,
      });
      // A known-missing row is resolved only by a fetch that is itself healthy
      // (non-empty, band and cap passed on the NEW losses) once the grace
      // window has elapsed: a run that may be truncated is no evidence that an
      // older absence is final. An explicitly empty page does not qualify
      // either: it lists nothing to measure against, and retiring the last
      // rows of a source there would leave it with none, which check-health
      // rejects as fatal for an active source and would freeze every baseline.
      const healthyFetch = rows.length > 0 && saleDecision.recognized;
      const expiredMissing = healthyFetch
        ? knownMissing.filter((row) => now.getTime() - missingSinceMs(row) >= PLATE_AUCTION_MISSING_GRACE_MS)
        : [];
      const expiredMissingIds = new Set(expiredMissing.map((row) => row.id));
      // Logged on EVERY run, including when sales are recognised: without the
      // four numbers the first week of real data is not verifiable and the
      // retuning would be done by eye.
      console.log(
        `[collectPlateAuctions:${key}] sale-recognition previous=${previousLiveCount} `
        + `fetched=${rows.length} vanished=${saleCandidates.length} cap=${saleDecision.cap} `
        + `protected=${protectedRows.length} known-missing=${knownMissing.length} expired-missing=${expiredMissing.length} `
        + (saleDecision.recognized ? `decision=sales sold=${saleCandidates.length}` : `decision=preserve-as-live blocked-by=${saleDecision.blockedBy.join('+')}`),
      );
      // An expired known-missing row goes through the same record as a sale:
      // closed, `disappearedFromCatalogue`, last asking price, never a final.
      // For a timed-auction row that is a withdrawal record, not a result.
      const catalogueSales = [
        ...(saleDecision.recognized ? saleCandidates : []),
        ...expiredMissing,
      ].map((row) => observeCatalogueDisappearance(row, now));
      // Not recognised: keep the rows visible rather than assert a sale, and
      // stamp the run that first missed them so the next run does not judge
      // the same absence again. Rows with a future deadline are preserved
      // either way; a known-missing row keeps its original stamp.
      const preserveMissing = (row) => ({
        ...row,
        dataConfidence: row.dataConfidence === 'verified' ? 'partial' : row.dataConfidence,
        missingSince: Number.isFinite(missingSinceMs(row)) ? row.missingSince : now.toISOString(),
      });
      const preservedMissing = [
        ...protectedRows,
        ...(saleDecision.recognized ? [] : saleCandidates),
        ...knownMissing.filter((row) => !expiredMissingIds.has(row.id)),
      ].map(preserveMissing);
      const displayRows = [...normalizedRows, ...expiredCarry, ...preservedMissing];
      // An empty response is degraded and preserves the last good snapshot,
      // unless it is the source's explicit empty catalogue (see `answered`).
      // A non-empty response is authoritative when quality checks do not flag
      // a source disappearance. A partial catalogue must retain unexpired
      // live rows so a markup regression cannot erase the public view.
      const outputRows = answered
        ? displayRows
        : previousForSource.map((row) => closeExpiredObservation(row, now));
      // Only a row the last fetch still listed can make THIS fetch look broken;
      // a known-missing row was reported by the run that first missed it.
      const sourceDisappeared = answered && newlyMissing.length > 0;
      // The source is only healthy-despite-losses when EVERY newly missing
      // active row was a recognized sale. One protected row means the feed also
      // lost something checkDisappearedSources() calls an upstream anomaly, and
      // a single recognized sale must not launder that into `active`.
      const allLossesAreSales = saleDecision.recognized && protectedRows.length === 0 && saleCandidates.length > 0;
      results[key] = { rows: outputRows, fetchedAt, fetchedRowCount: rows.length, previousRows: previousForSource, previousSuccessAt, zeroRows: !answered, sourceDisappeared, allLossesAreSales, catalogueSales, qualityIssues: quality.issues, error: null };
    } catch (error) {
      const previousForSource = previousRows.filter((row) => row.sourceKey === source.plateCode);
      console.warn(`[collectPlateAuctions:${key}] ${error instanceof Error ? error.message : String(error)}`);
      results[key] = { rows: [], fetchedAt, fetchedRowCount: 0, previousRows: previousForSource, previousSuccessAt: previous?.sources?.[key]?.lastSuccessAt || previous?.generatedAt, error };
    }
  }

  const outputAuctions = [];
  const sources = {};
  for (const [key, source] of Object.entries(registry.sources)) {
    const result = results[key];
    if (result) {
      const rows = result.error ? result.previousRows : result.rows;
      outputAuctions.push(...rows);
      sources[key] = sourceStatus(source, result);
    } else {
      const previousForSource = previousRows.filter((row) => row.sourceKey === source.plateCode);
      if (source.status === 'active') outputAuctions.push(...previousForSource);
      sources[key] = {
        ...source,
        rowCount: source.status === 'active' ? previousForSource.length : 0,
        lastCheckedAt: now.toISOString(),
      };
    }
  }

  const previousHistory = Array.isArray(previous?.history) ? previous.history : [];
  // Taken from the per-source decision rather than re-derived from the row
  // sets: one place decides what counts as a sale, and it is the place that
  // logged why.
  const disappearedObservations = Object.values(results)
    .flatMap((result) => (result && !result.error ? result.catalogueSales || [] : []));
  // History is the record of what is NO LONGER live, so the live catalogue does
  // not belong in it. Concatenating `outputAuctions` (17'260 rows) before a
  // `.slice(-5000)` meant the window was filled entirely by current rows and
  // BOTH `previousHistory` and `disappearedObservations` were discarded on
  // every single run — the sale signal was computed and then thrown away.
  // Measured on the committed snapshot: 5'000 history rows, 100% `auctionStatus:
  // 'active'`, zero finals, 4'139 of them BS, i.e. the tail of the current
  // catalogue. Keeping only non-live rows also makes the cap a disappearance
  // budget instead of a mixed one. Oldest first: `.slice` keeps the tail.
  const closedFromOutput = outputAuctions.filter((row) => !['active', 'upcoming'].includes(row.auctionStatus));
  // The committed history is 5'000 rows that are all still `active` — the
  // artefact of the window bug this PR fixes. Appending it unfiltered would
  // carry those live rows forward, consume the whole cap and leave the new
  // invariant false until enough sales evicted them, so they are dropped here
  // rather than waited out.
  const history = dedupeHistoryById([
    ...previousHistory.filter((row) => !['active', 'upcoming'].includes(row?.auctionStatus)),
    ...closedFromOutput,
    ...disappearedObservations,
  ]).slice(-PLATE_AUCTION_HISTORY_CAP);
  const finalsVerified = outputAuctions.filter((row) => ['closed', 'sold', 'unsold'].includes(row.auctionStatus)
    && row.dataConfidence === 'verified'
    && typeof row.finalPriceChf === 'number'
    && typeof row.finalPriceVerifiedAt === 'string').length;
  return {
    schema: 1,
    complete: true,
    generatedAt: now.toISOString(),
    sources,
    auctions: outputAuctions,
    history,
    counts: {
      active: outputAuctions.filter((row) => row.auctionStatus === 'active').length,
      upcoming: outputAuctions.filter((row) => row.auctionStatus === 'upcoming').length,
      closed: outputAuctions.filter((row) => ['closed', 'sold', 'unsold'].includes(row.auctionStatus)).length,
      finalsVerified,
      cantonsWithData: new Set(outputAuctions.map((row) => row.sourceKey)).size,
    },
  };
}

export async function writePlateAuctionSnapshot(snapshot, outputPath = DEFAULT_OUTPUT) {
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
}

async function main() {
  const outputPath = process.env.PLATE_AUCTION_OUTPUT
    ? resolve(process.env.PLATE_AUCTION_OUTPUT)
    : DEFAULT_OUTPUT;
  const selectedCantons = (process.env.PLATE_AUCTION_CANTONS || Object.keys(FETCHERS).join(','))
    .split(',').map((value) => value.trim().toLowerCase()).filter(Boolean);
  const previous = readPrevious(outputPath);
  const snapshot = await collectPlateAuctions({ selectedCantons, previous });
  if (process.env.PLATE_AUCTION_DRY_RUN !== '1') await writePlateAuctionSnapshot(snapshot, outputPath);
  console.log(JSON.stringify({ outputPath, generatedAt: snapshot.generatedAt, counts: snapshot.counts, sources: Object.fromEntries(Object.entries(snapshot.sources).filter(([key]) => selectedCantons.includes(key)).map(([key, value]) => [key, { status: value.status, rowCount: value.rowCount, errorCode: value.errorCode }])) }, null, 2));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error('Plate-auction ingest failed:', error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
