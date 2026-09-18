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
import { fetchTiPlateAuctions } from './connectors/ti.mjs';
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
  PLATE_AUCTION_SALE_RECOGNITION,
  observeCatalogueDisappearance,
  recognizeCatalogueSales,
} from '../../functions/src/plateAuctionQualityCore.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_OUTPUT = resolve(__dirname, '../../public/data/plate-auctions.json');
export const FETCHERS = {
  ag: () => fetchExpandedCard('ag'),
  ai: fetchAiFixedPrice,
  ar: () => fetchExpandedEcari('ar'),
  be: () => fetchExpandedCard('be'),
  bl: () => fetchExpandedEcari('bl'),
  bs: fetchBsFixedPrice,
  fr: () => fetchExpandedEcari('fr'),
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
  ti: fetchTiPlateAuctions,
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
  if (result.zeroRows && source.status === 'active') return { ...base, status: 'degraded', errorCode: 'zero_rows' };
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
export { PLATE_AUCTION_SALE_RECOGNITION, observeCatalogueDisappearance, recognizeCatalogueSales };




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
      const previousForSource = previousRows.filter((row) => row.sourceKey === source.plateCode);
      const previousSuccessAt = previous?.sources?.[key]?.lastSuccessAt || previous?.generatedAt;
      const mergedRows = mergeWithPrevious(rows, previousRows, source.plateCode);
      const quality = applyQualityPolicy(mergedRows, previousForSource, now);
      const normalizedRows = quality.rows;
      const sourceDisappeared = rows.length > 0 && quality.issues.some((item) => item.code === 'source-disappeared');
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
      // Deadline-less rows are the fixed-price catalogue (16'976 of 17'260),
      // where disappearance is the only sale signal that exists.
      const stillLive = missingPreviousRows.filter((row) => isUnexpiredActiveObservation(row, now));
      // A sale candidate must be a fixed-price row AND have no usable deadline.
      // Requiring the type matters: a malformed timed-auction row whose
      // `endsAt` is missing or unparseable would otherwise be stamped `closed`
      // and entered into history as a sale whenever band/cap pass. Every other
      // missing row — future deadline, or malformed but not fixed-price — is
      // protected and preserved.
      const isSaleCandidate = (row) => row.listingType === 'fixed-price'
        && !Number.isFinite(Date.parse(row.endsAt || ''));
      const saleCandidates = stillLive.filter(isSaleCandidate);
      const protectedRows = stillLive.filter((row) => !isSaleCandidate(row));
      // Same denominator rule as the Firestore pipeline: archived rows carried
      // by `expiredCarry` end up in the next run's `previous.auctions`, so
      // counting them here would inflate the denominator over time and
      // eventually starve the band exactly as it would there.
      const previousLiveCount = previousForSource
        .filter((row) => ['active', 'upcoming'].includes(row?.auctionStatus)).length;
      const saleDecision = recognizeCatalogueSales({
        previousCount: previousLiveCount,
        fetchedCount: rows.length,
        vanishedCount: saleCandidates.length,
      });
      // Logged on EVERY run, including when sales are recognised: without the
      // four numbers the first week of real data is not verifiable and the
      // retuning would be done by eye.
      console.log(
        `[collectPlateAuctions:${key}] sale-recognition previous=${previousLiveCount} `
        + `fetched=${rows.length} vanished=${saleCandidates.length} cap=${saleDecision.cap} `
        + `protected=${protectedRows.length} `
        + (saleDecision.recognized ? `decision=sales sold=${saleCandidates.length}` : `decision=preserve-as-live blocked-by=${saleDecision.blockedBy.join('+')}`),
      );
      const catalogueSales = saleDecision.recognized
        ? saleCandidates.map((row) => observeCatalogueDisappearance(row, now))
        : [];
      // Not recognised: keep the rows visible rather than assert a sale. Rows
      // with a future deadline are preserved either way.
      const demoteConfidence = (row) => ({
        ...row,
        dataConfidence: row.dataConfidence === 'verified' ? 'partial' : row.dataConfidence,
      });
      const preservedMissing = [
        ...protectedRows.map(demoteConfidence),
        ...(saleDecision.recognized ? [] : saleCandidates.map(demoteConfidence)),
      ];
      const displayRows = [...normalizedRows, ...expiredCarry, ...preservedMissing];
      // An empty response is degraded and preserves the last good snapshot.
      // A non-empty response is authoritative when quality checks do not flag
      // a source disappearance. A partial catalogue must retain unexpired
      // live rows so a markup regression cannot erase the public view.
      const outputRows = rows.length === 0
        ? previousForSource.map((row) => closeExpiredObservation(row, now))
        : displayRows;
      // The source is only healthy-despite-losses when EVERY missing active row
      // was a recognized sale. One protected row means the feed also lost
      // something checkDisappearedSources() calls an upstream anomaly, and a
      // single recognized sale must not launder that into `active`.
      const allLossesAreSales = saleDecision.recognized && protectedRows.length === 0 && catalogueSales.length > 0;
      results[key] = { rows: outputRows, fetchedAt, fetchedRowCount: rows.length, previousRows: previousForSource, previousSuccessAt, zeroRows: rows.length === 0, sourceDisappeared, allLossesAreSales, catalogueSales, qualityIssues: quality.issues, error: null };
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
