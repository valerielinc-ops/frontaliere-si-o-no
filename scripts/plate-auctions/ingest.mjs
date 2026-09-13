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
import { fetchVsPlateAuctions } from './connectors/vs.mjs';
import { fetchZhPlateAuctions } from './connectors/zh.mjs';
import {
  checkPlateAuctionQuality,
  derivePlateAuctionDataConfidence,
} from '../../functions/src/plateAuctionQualityCore.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_OUTPUT = resolve(__dirname, '../../public/data/plate-auctions.json');
const FETCHERS = {
  gr: fetchGrPlateAuctions,
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
  const base = { ...source, rowCount: result.fetchedRowCount, lastFetchedAt: result.fetchedAt };
  if (result.error) return { ...base, status: 'degraded', rowCount: result.previousRows.length, errorCode: 'fetch_failed', lastSuccessAt: result.previousSuccessAt };
  if (result.zeroRows && source.status === 'active') return { ...base, status: 'degraded', errorCode: 'zero_rows' };
  return { ...base, status: source.status, lastSuccessAt: result.fetchedAt };
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
      const mergedRows = mergeWithPrevious(rows, previousRows, source.plateCode);
      const quality = applyQualityPolicy(mergedRows, previousForSource, now);
      const normalizedRows = quality.rows;
      const fetchedIds = new Set(normalizedRows.map((row) => row.id));
      const expiredCarry = previousForSource
        .filter((row) => !fetchedIds.has(row.id))
        .map((row) => closeExpiredObservation(row, now))
        .filter((row, index, all) => row.auctionStatus === 'closed' && all.findIndex((candidate) => candidate.id === row.id) === index);
      const displayRows = [...normalizedRows, ...expiredCarry];
      // An empty response is degraded and preserves the last good snapshot.
      // A non-empty response is authoritative even when every previous row
      // disappeared; keeping the old rows in that case would publish stale
      // listings after a valid catalogue refresh.
      const outputRows = rows.length === 0
        ? previousForSource.map((row) => closeExpiredObservation(row, now))
        : displayRows;
      results[key] = { rows: outputRows, fetchedAt, fetchedRowCount: rows.length, previousRows: previousForSource, zeroRows: rows.length === 0, qualityIssues: quality.issues, error: null };
    } catch (error) {
      const previousForSource = previousRows.filter((row) => row.sourceKey === source.plateCode);
      results[key] = { rows: [], fetchedAt, fetchedRowCount: 0, previousRows: previousForSource, previousSuccessAt: previous?.generatedAt, error };
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
      outputAuctions.push(...previousForSource);
      sources[key] = { ...source, rowCount: previousForSource.length };
    }
  }

  const previousHistory = Array.isArray(previous?.history) ? previous.history : [];
  const disappearedObservations = Object.values(results).flatMap((result) => {
    if (!result || result.error || result.fetchedRowCount === 0) return [];
    const currentIds = new Set(result.rows.map((row) => row.id));
    return result.previousRows.filter((row) => !currentIds.has(row.id));
  });
  const history = [...previousHistory, ...disappearedObservations, ...outputAuctions].slice(-5000);
  const finalsVerified = outputAuctions.filter((row) => ['closed', 'sold', 'unsold'].includes(row.auctionStatus)
    && row.dataConfidence === 'verified'
    && typeof row.finalPriceChf === 'number'
    && typeof row.finalPriceVerifiedAt === 'string').length;
  return {
    schema: 1,
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
