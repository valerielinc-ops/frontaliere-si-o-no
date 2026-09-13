import {
  extractEcariTabSection,
  fetchHtml,
  parseEcariAuctionRows,
  parseZhAuctionCards,
} from './plateAuctionsCore.js';
import { getAdminDb } from './newsletterResendWebhookCore.js';
import { PUBLIC_PLATE_AUCTION_SOURCE_REGISTRY } from './plateAuctionSourceRegistry.js';
import { chunkPlateAuctionWrites } from './plateAuctionBatch.js';
import {
  checkPlateAuctionQuality,
  derivePlateAuctionDataConfidence,
} from './plateAuctionQualityCore.js';

export const PLATE_AUCTION_COLLECTION = 'plate_auctions_current';
export const PLATE_AUCTION_HISTORY_COLLECTION = 'plate_auctions_history';
export const PLATE_AUCTION_SOURCE_COLLECTION = 'plate_auction_sources';
export const PLATE_AUCTION_API_SCHEMA = 1;

const CONNECTORS = {
  gr: {
    canton: 'Grigioni',
    plateCode: 'GR',
    url: 'https://eauktion.gr.ch/',
    parserVersion: '2.0.0',
    parse(html, fetchedAt) {
      return [
        ['tabContent1', 'active', 'auction', 'gr'],
        ['tabContent2', 'upcoming', 'future-registration', 'gr-future'],
        ['tabContent3', 'active', 'fixed-price', 'gr-fixed'],
        ['tabContent4', 'upcoming', 'wanted', 'gr-wanted'],
      ].flatMap(([tab, auctionStatus, listingType, idPrefix]) => parseEcariAuctionRows(extractEcariTabSection(html, tab), {
        canton: 'Grigioni',
        plateCode: 'GR',
        officialAuctionUrl: 'https://eauktion.gr.ch/',
        fetchedAt,
        auctionStatus,
        listingType,
        idPrefix,
        detailUrlBuilder: () => 'https://eauktion.gr.ch/',
      }));
    },
  },
  vs: {
    canton: 'Vallese',
    plateCode: 'VS',
    url: 'https://ecari.vs.ch/ecari-auction/',
    parserVersion: '2.0.0',
    parse(html, fetchedAt) {
      return [
        ['tabContent1', 'active', 'auction', 'vs'],
        ['tabContent2', 'upcoming', 'future-registration', 'vs-future'],
        ['tabContent4', 'upcoming', 'wanted', 'vs-wanted'],
      ].flatMap(([tab, status, listingType, idPrefix]) => parseEcariAuctionRows(extractEcariTabSection(html, tab), {
        canton: 'Vallese',
        plateCode: 'VS',
        officialAuctionUrl: 'https://ecari.vs.ch/ecari-auction/',
        fetchedAt,
        auctionStatus: status,
        listingType,
        idPrefix,
        detailUrlBuilder: () => 'https://ecari.vs.ch/ecari-auction/',
      }));
    },
  },
  zh: {
    canton: 'Zurigo',
    plateCode: 'ZH',
    url: 'https://www.auktion.stva.zh.ch/de/?plate_sub_type=&plate_type=car',
    parserVersion: '1.0.0',
    parse(html, fetchedAt) {
      return parseZhAuctionCards(html, {
        fetchedAt,
        officialAuctionUrl: 'https://www.auktion.stva.zh.ch/de/?plate_sub_type=&plate_type=car',
        detailBaseUrl: 'https://www.auktion.stva.zh.ch',
      });
    },
  },
};

function timestampValue(value) {
  if (!value) return undefined;
  if (typeof value === 'string') return value;
  if (typeof value.toDate === 'function') return value.toDate().toISOString();
  if (value instanceof Date) return value.toISOString();
  return undefined;
}

function publicAuction(value) {
  if (!value || typeof value !== 'object') return null;
  const sourceFetchedAt = timestampValue(value.sourceFetchedAt);
  const lastVerifiedAt = timestampValue(value.lastVerifiedAt);
  if (!sourceFetchedAt || !lastVerifiedAt || typeof value.id !== 'string') return null;
  const allowed = [
    'id', 'sourceKey', 'sourceRecordId', 'canton', 'platePrefix', 'plateNumber', 'normalizedPlate',
    'listingType', 'vehicleType', 'auctionStatus', 'currentBidChf', 'startingPriceChf', 'finalPriceChf',
    'bidCount', 'minimumIncrementChf', 'startsAt', 'endsAt', 'closedAt', 'officialAuctionUrl',
    'officialDetailUrl', 'firstSeenAt', 'lastSeenAt', 'finalPriceVerifiedAt', 'sourceCategory',
    'platePattern', 'dataConfidence', 'rawSnapshotHash',
  ];
  const output = {};
  for (const key of allowed) {
    if (value[key] !== undefined && value[key] !== null && (typeof value[key] !== 'object' || typeof value[key].toDate !== 'function')) output[key] = value[key];
  }
  output.sourceFetchedAt = sourceFetchedAt;
  output.lastVerifiedAt = lastVerifiedAt;
  for (const key of ['startsAt', 'endsAt', 'closedAt', 'firstSeenAt', 'lastSeenAt', 'finalPriceVerifiedAt']) {
    const normalized = timestampValue(value[key]);
    if (normalized) output[key] = normalized;
  }
  // Explicitly delete fields that a source may have written by mistake.
  delete output.lastBidder;
  delete output.bidder;
  delete output.winner;
  delete output.winnerName;
  return output;
}

function publicSource(value) {
  if (!value || typeof value !== 'object') return null;
  const allowed = [
    'canton', 'plateCode', 'officialUrl', 'accessMethod', 'fetchFrequency', 'timezone',
    'parserVersion', 'availableFields', 'rateLimit', 'termsOfUse', 'owner', 'status',
    'rowCount', 'errorCode', 'notes',
  ];
  const output = {};
  for (const key of allowed) {
    if (value[key] !== undefined && value[key] !== null) output[key] = value[key];
  }
  for (const key of ['lastFetchedAt', 'lastSuccessAt']) {
    const normalized = timestampValue(value[key]);
    if (normalized) output[key] = normalized;
  }
  delete output.lastBidder;
  delete output.bidder;
  delete output.winner;
  delete output.winnerName;
  return output;
}

async function readCollection(db, collection, limit) {
  const snapshot = await db.collection(collection).limit(limit).get();
  return snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
}

export async function getPublicPlateAuctionSnapshot(db = getAdminDb()) {
  const [auctionRows, sourceRows] = await Promise.all([
    readCollection(db, PLATE_AUCTION_COLLECTION, 2500),
    readCollection(db, PLATE_AUCTION_SOURCE_COLLECTION, 50),
  ]);
  let historyRows = [];
  try {
    historyRows = await db.collection(PLATE_AUCTION_HISTORY_COLLECTION)
      .orderBy('sourceFetchedAt', 'desc')
      .limit(5000)
      .get()
      .then((snapshot) => snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() })));
  } catch (error) {
    // History is an enhancement over the current feed. A missing index or a
    // first deployment must not take the live catalogue down with it.
    console.warn('[getPublicPlateAuctionSnapshot:history]', error instanceof Error ? error.message : String(error));
  }
  const auctions = auctionRows.map(publicAuction).filter(Boolean);
  const history = historyRows.map(publicAuction).filter(Boolean);
  const sources = Object.fromEntries(Object.entries(PUBLIC_PLATE_AUCTION_SOURCE_REGISTRY).map(([key, source]) => [key, { ...source, rowCount: 0 }]));
  for (const source of sourceRows) {
    const publicValue = publicSource(source);
    if (publicValue) sources[source.id] = publicValue;
  }
  return {
    schema: PLATE_AUCTION_API_SCHEMA,
    generatedAt: new Date().toISOString(),
    sources,
    auctions,
    history,
    counts: {
      active: auctions.filter((auction) => auction.auctionStatus === 'active').length,
      upcoming: auctions.filter((auction) => auction.auctionStatus === 'upcoming').length,
      closed: auctions.filter((auction) => ['closed', 'sold', 'unsold'].includes(auction.auctionStatus)).length,
      finalsVerified: auctions.filter((auction) => ['closed', 'sold', 'unsold'].includes(auction.auctionStatus)
        && auction.dataConfidence === 'verified'
        && typeof auction.finalPriceChf === 'number'
        && typeof auction.finalPriceVerifiedAt === 'string').length,
      cantonsWithData: new Set(auctions.map((auction) => auction.sourceKey || auction.platePrefix)).size,
    },
  };
}

function sourceDocument(config, fetchedAt, patch = {}) {
  return {
    canton: config.canton,
    plateCode: config.plateCode,
    officialUrl: config.url,
    accessMethod: 'html-scrape',
    fetchFrequency: 'PT6H',
    timezone: 'Europe/Zurich',
    parserVersion: config.parserVersion,
    availableFields: ['sourceRecordId', 'plateNumber', 'listingType', 'vehicleType', 'startingPriceChf', 'minimumIncrementChf', 'currentBidChf', 'bidCount', 'endsAt', 'officialDetailUrl'],
    rateLimit: 'collector capped at four fetches/day',
    termsOfUse: 'review source terms before increasing frequency',
    owner: 'platform',
    lastFetchedAt: fetchedAt,
    ...patch,
  };
}

export async function refreshPlateAuctions({ db = getAdminDb(), fetcher = fetchHtml, now = new Date() } = {}) {
  const fetchedAt = now.toISOString();
  const summaries = {};
  for (const [key, config] of Object.entries(CONNECTORS)) {
    try {
      const html = await fetcher(config.url, { timeoutMs: 20000 });
      const parsedRows = config.parse(html, fetchedAt);
      const sourceRef = db.collection(PLATE_AUCTION_SOURCE_COLLECTION).doc(key);
      if (parsedRows.length === 0) {
        await sourceRef.set(sourceDocument(config, fetchedAt, { status: 'degraded', rowCount: 0, errorCode: 'zero_rows' }), { merge: true });
        summaries[key] = { status: 'degraded', rowCount: 0 };
        continue;
      }

      const previous = await db.collection(PLATE_AUCTION_COLLECTION).where('sourceKey', '==', config.plateCode).limit(2500).get();
      const previousById = new Map(previous.docs.map((doc) => [doc.id, { id: doc.id, ...doc.data() }]));
      const qualityIssues = checkPlateAuctionQuality(parsedRows, previousById, now);
      const issuesById = new Map();
      for (const item of qualityIssues) {
        if (item.id === 'batch') continue;
        const group = issuesById.get(item.id) || [];
        group.push(item);
        issuesById.set(item.id, group);
      }
      const rows = parsedRows.map((row) => ({
        ...row,
        dataConfidence: derivePlateAuctionDataConfidence(row.dataConfidence, issuesById.get(row.id) || []),
      }));
      if (qualityIssues.length > 0) {
        console.warn(`[refreshPlateAuctions:${key}] quality issues`, qualityIssues.map((item) => item.code).join(','));
      }
      const writes = [];
      for (const row of rows) {
        const old = previousById.get(row.id) || {};
        const ref = db.collection(PLATE_AUCTION_COLLECTION).doc(row.id);
        const record = { ...row, firstSeenAt: old.firstSeenAt || row.firstSeenAt || fetchedAt, lastSeenAt: fetchedAt };
        writes.push({ ref, record, merge: true });
        writes.push({ ref: db.collection(PLATE_AUCTION_HISTORY_COLLECTION).doc(`${row.id}-${fetchedAt.replace(/[^0-9]/g, '').slice(0, 14)}`), record });
      }
      const currentIds = new Set(rows.map((row) => row.id));
      for (const [id, old] of previousById) {
        if (currentIds.has(id) || !['active', 'upcoming'].includes(old.auctionStatus) || !old.endsAt || Date.parse(old.endsAt) > now.getTime()) continue;
        const record = {
          ...old,
          auctionStatus: 'closed',
          closedAt: old.closedAt || old.endsAt,
          dataConfidence: old.dataConfidence === 'verified' ? 'partial' : old.dataConfidence,
        };
        writes.push({ ref: db.collection(PLATE_AUCTION_COLLECTION).doc(id), record, merge: true });
        writes.push({ ref: db.collection(PLATE_AUCTION_HISTORY_COLLECTION).doc(`${id}-${fetchedAt.replace(/[^0-9]/g, '').slice(0, 14)}-closed`), record });
      }
      for (const [id, old] of previousById) {
        // A non-empty successful feed is authoritative for its current
        // catalogue. If an active row disappears before its deadline, remove
        // it from the current view but keep the last observation in history;
        // absence is not evidence of a sale or a final price.
        if (currentIds.has(id) || !['active', 'upcoming'].includes(old.auctionStatus)
          || (old.endsAt && Date.parse(old.endsAt) <= now.getTime())) continue;
        writes.push({ ref: db.collection(PLATE_AUCTION_COLLECTION).doc(id), delete: true });
      }
      // Firestore batches are capped at 500 writes. Keep the collector safe
      // when a canton publishes a larger catalogue than today's fixture.
      for (const chunk of chunkPlateAuctionWrites(writes)) {
        const batch = db.batch();
        for (const write of chunk) {
          if (write.delete) batch.delete(write.ref);
          else if (write.merge) batch.set(write.ref, write.record, { merge: true });
          else batch.set(write.ref, write.record);
        }
        await batch.commit();
      }
      await sourceRef.set(sourceDocument(config, fetchedAt, { status: 'active', rowCount: rows.length, lastSuccessAt: fetchedAt, errorCode: null }), { merge: true });
      summaries[key] = { status: 'active', rowCount: rows.length };
    } catch (error) {
      await db.collection(PLATE_AUCTION_SOURCE_COLLECTION).doc(key).set(sourceDocument(config, fetchedAt, { status: 'degraded', errorCode: 'fetch_failed', errorMessage: error instanceof Error ? error.message.slice(0, 180) : 'unknown_error' }), { merge: true });
      summaries[key] = { status: 'degraded', errorCode: 'fetch_failed' };
      console.error(`[refreshPlateAuctions:${key}]`, error instanceof Error ? error.message : String(error));
    }
  }
  return { fetchedAt, summaries };
}

export function isPlateAuctionPublicRecord(value) {
  return Boolean(publicAuction(value));
}
