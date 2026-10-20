import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import path from 'node:path';

const PUBLIC_ARCHIVE_FIELDS = [
  'id', 'sourceKey', 'sourceRecordId', 'canton', 'platePrefix', 'plateNumber',
  'normalizedPlate', 'listingType', 'vehicleType', 'auctionStatus',
  'currentBidChf', 'startingPriceChf', 'finalPriceChf', 'bidCount',
  'minimumIncrementChf', 'startsAt', 'endsAt', 'closedAt', 'officialAuctionUrl',
  'officialDetailUrl', 'sourceFetchedAt', 'lastVerifiedAt', 'firstSeenAt',
  'lastSeenAt', 'finalPriceVerifiedAt', 'sourceCategory', 'platePattern',
  'dataConfidence', 'rawSnapshotHash',
];

export function publicArchivedPlateAuction(row) {
  return Object.fromEntries(PUBLIC_ARCHIVE_FIELDS.filter((key) => row[key] !== undefined).map((key) => [key, row[key]]));
}

function readRows(file) {
  if (!existsSync(file)) return [];
  const data = JSON.parse(readFileSync(file, 'utf8'));
  if (data.schema !== 1 || !Array.isArray(data.rows)) throw new Error(`Invalid plate-auction archive: ${file}`);
  return data.rows.map(publicArchivedPlateAuction);
}

/** Durable per-plate records, separate from the API's bounded observation list. */
export function readPlateAuctionArchive(directory) {
  if (!existsSync(directory)) return [];
  const rows = [];
  for (const code of readdirSync(directory).filter((name) => /^[a-z]{2}$/.test(name))) {
    const cantonDir = path.join(directory, code);
    for (const file of readdirSync(cantonDir).filter((name) => new RegExp(`^${code}\\d+\\.json$`).test(name))) {
      rows.push(...readRows(path.join(cantonDir, file)));
    }
  }
  return rows.sort((a, b) => Date.parse(b.sourceFetchedAt || '') - Date.parse(a.sourceFetchedAt || ''));
}

export function writePlateAuctionArchive(snapshot, directory) {
  mkdirSync(directory, { recursive: true });
  const active = new Set(Object.values(snapshot.sources || {}).filter((source) => source.status === 'active').map((source) => source.plateCode?.toUpperCase()));
  const files = new Map();
  for (const candidate of [...(snapshot.auctions || []), ...(snapshot.history || [])]) {
    const row = publicArchivedPlateAuction(candidate);
    const code = String(row.sourceKey || row.platePrefix || '').toUpperCase();
    const plate = String(row.normalizedPlate || '').toUpperCase();
    if (!/^[A-Z]{2}$/.test(code) || !new RegExp(`^${code}\\d+$`).test(plate) || !active.has(code)) continue;
    if (!row.id || row.dataConfidence === 'conflicting' || !['closed', 'sold', 'unsold'].includes(row.auctionStatus)) continue;
    if (!['car', 'motorcycle', 'trailer', 'other'].includes(row.vehicleType) || !Number.isFinite(Date.parse(row.sourceFetchedAt || ''))) continue;
    const file = path.join(directory, code.toLowerCase(), `${plate.toLowerCase()}.json`);
    if (!files.has(file)) files.set(file, new Map(readRows(file).map((old) => [old.vehicleType, old])));
    const records = files.get(file);
    const previous = records.get(row.vehicleType);
    if (!previous || Date.parse(row.sourceFetchedAt) >= Date.parse(previous.sourceFetchedAt || '')) records.set(row.vehicleType, row);
  }
  let written = 0;
  for (const [file, records] of files) {
    const rows = [...records.values()].sort((a, b) => a.vehicleType.localeCompare(b.vehicleType));
    const json = `${JSON.stringify({ schema: 1, rows }, null, 2)}\n`;
    if (existsSync(file) && readFileSync(file, 'utf8') === json) continue;
    mkdirSync(path.dirname(file), { recursive: true });
    const temporary = `${file}.${process.pid}.tmp`;
    writeFileSync(temporary, json, 'utf8');
    renameSync(temporary, file);
    written++;
  }
  return written;
}
