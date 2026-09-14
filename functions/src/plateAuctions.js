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
  ti: {
    canton: 'Ticino',
    plateCode: 'TI',
    url: 'https://www.carieauktion.ti.ch/ecari-auktion/',
    parserVersion: '2.0.0',
    parse(html, fetchedAt) {
      return [
        ['tabContent1', 'active', 'auction', 'ti'],
        ['tabContent2', 'upcoming', 'future-registration', 'ti-future'],
        ['tabContent3', 'active', 'fixed-price', 'ti-fixed'],
        ['tabContent4', 'upcoming', 'wanted', 'ti-wanted'],
      ].flatMap(([tab, auctionStatus, listingType, idPrefix]) => parseEcariAuctionRows(extractEcariTabSection(html, tab), {
        canton: 'Ticino',
        plateCode: 'TI',
        officialAuctionUrl: 'https://www.carieauktion.ti.ch/ecari-auktion/',
        fetchedAt,
        auctionStatus,
        listingType,
        idPrefix,
        detailUrlBuilder: () => 'https://www.carieauktion.ti.ch/ecari-auktion/',
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
  sg: {
    canton: 'San Gallo',
    plateCode: 'SG',
    url: 'https://egov.stva.sg.ch/ecari-auction/ui/app/init',
    parserVersion: '2.0.0',
    parse(html, fetchedAt) {
      return parseEcariSource(html, {
        canton: 'San Gallo',
        plateCode: 'SG',
        officialAuctionUrl: 'https://egov.stva.sg.ch/ecari-auction/ui/app/init',
        fetchedAt,
      });
    },
  },
  sz: {
    canton: 'Svitto',
    plateCode: 'SZ',
    url: 'https://cariegov.sz.ch/ecari-auction/ui/app/init',
    parserVersion: '2.0.0',
    parse(html, fetchedAt) {
      return parseEcariSource(html, {
        canton: 'Svitto',
        plateCode: 'SZ',
        officialAuctionUrl: 'https://cariegov.sz.ch/ecari-auction/ui/app/init',
        fetchedAt,
      });
    },
  },
  sh: {
    canton: 'Sciaffusa',
    plateCode: 'SH',
    url: 'https://www.auktion-stva.sh.ch/',
    parserVersion: '1.1.0',
    parse(html, fetchedAt) {
      return parseCardSource(html, {
        canton: 'Sciaffusa',
        plateCode: 'SH',
        officialAuctionUrl: 'https://www.auktion-stva.sh.ch/',
        detailBaseUrl: 'https://www.auktion-stva.sh.ch',
        fetchedAt,
      });
    },
  },
  tg: {
    canton: 'Turgovia',
    plateCode: 'TG',
    url: 'https://www.auktion.tg.ch/de/',
    parserVersion: '1.1.0',
    parse(html, fetchedAt) {
      return parseCardSource(html, {
        canton: 'Turgovia',
        plateCode: 'TG',
        officialAuctionUrl: 'https://www.auktion.tg.ch/de/',
        detailBaseUrl: 'https://www.auktion.tg.ch',
        fetchedAt,
      });
    },
  },
};

const ECARI_TABS = [
  ['tabContent1', 'active', 'auction', 'auction'],
  ['tabContent2', 'upcoming', 'future-registration', 'future'],
  ['tabContent3', 'active', 'fixed-price', 'fixed'],
  ['tabContent4', 'upcoming', 'wanted', 'wanted'],
];

function parseEcariSource(html, { canton, plateCode, officialAuctionUrl, fetchedAt, tabs = ECARI_TABS }) {
  return tabs.flatMap(([tabContentId, auctionStatus, listingType, idSuffix]) => parseEcariAuctionRows(
    extractEcariTabSection(html, tabContentId),
    {
      canton,
      plateCode,
      officialAuctionUrl,
      fetchedAt,
      auctionStatus,
      listingType,
      idPrefix: idSuffix === 'auction' ? plateCode.toLowerCase() : `${plateCode.toLowerCase()}-${idSuffix}`,
      detailUrlBuilder: () => officialAuctionUrl,
    },
  ));
}

function parseCardSource(html, { canton, plateCode, officialAuctionUrl, detailBaseUrl, fetchedAt }) {
  return parseZhAuctionCards(html, {
    fetchedAt,
    officialAuctionUrl,
    detailBaseUrl,
    sourceKey: plateCode,
    canton,
    platePrefix: plateCode,
  });
}

function timestampValue(value) {
  if (!value) return undefined;
  if (typeof value === 'string') return value;
  if (typeof value.toDate === 'function') return value.toDate().toISOString();
  if (value instanceof Date) return value.toISOString();
  return undefined;
}

function timestampMs(value) {
  const normalized = timestampValue(value);
  if (!normalized) return undefined;
  const parsed = Date.parse(normalized);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function closeExpiredObservation(row, now) {
  if (!row || !['active', 'upcoming'].includes(row.auctionStatus)) return null;
  const endsAt = timestampMs(row.endsAt);
  if (endsAt === undefined || endsAt > now.getTime()) return null;
  return {
    ...row,
    auctionStatus: 'closed',
    closedAt: row.closedAt || row.endsAt,
    // A deadline is not a sale result. Keep the record in history without
    // manufacturing a final price or ranking it as a verified sale.
    dataConfidence: row.dataConfidence === 'verified' ? 'partial' : row.dataConfidence,
  };
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
  for (const key of ['lastFetchedAt', 'lastSuccessAt', 'lastCheckedAt']) {
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
  const activeSourceCodes = new Set(Object.values(PUBLIC_PLATE_AUCTION_SOURCE_REGISTRY)
    .filter((source) => source.status === 'active')
    .map((source) => source.plateCode));
  const auctions = auctionRows.map(publicAuction).filter(Boolean)
    .filter((auction) => activeSourceCodes.has(auction.sourceKey || auction.platePrefix))
    .map((auction) => {
    const closed = closeExpiredObservation(auction, new Date());
    return closed ? publicAuction(closed) : auction;
  }).filter(Boolean);
  const history = historyRows.map(publicAuction).filter(Boolean)
    .filter((auction) => activeSourceCodes.has(auction.sourceKey || auction.platePrefix));
  const sources = Object.fromEntries(Object.entries(PUBLIC_PLATE_AUCTION_SOURCE_REGISTRY).map(([key, source]) => [key, { ...source, rowCount: 0 }]));
  for (const source of sourceRows) {
    const publicValue = publicSource(source);
    if (!publicValue) continue;
    const registrySource = PUBLIC_PLATE_AUCTION_SOURCE_REGISTRY[source.id];
    if (registrySource && registrySource.status !== 'active') {
      // A stale Firestore document must not resurrect a source that the
      // registry has explicitly blocked or marked as having no public
      // catalogue. Keep the last check timestamp, but publish the registry
      // state and zero current rows immediately after deployment.
      sources[source.id] = {
        ...registrySource,
        rowCount: 0,
        ...(publicValue.lastCheckedAt ? { lastCheckedAt: publicValue.lastCheckedAt } : {}),
      };
    } else {
      sources[source.id] = publicValue;
    }
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
    lastCheckedAt: fetchedAt,
    ...patch,
  };
}

export async function refreshPlateAuctions({ db = getAdminDb(), fetcher = fetchHtml, now = new Date() } = {}) {
  const fetchedAt = now.toISOString();
  const summaries = {};
  for (const [key, config] of Object.entries(CONNECTORS)) {
    if (PUBLIC_PLATE_AUCTION_SOURCE_REGISTRY[key]?.status !== 'active') continue;
    try {
      const html = await fetcher(config.url, { timeoutMs: 20000 });
      const parsedRows = config.parse(html, fetchedAt);
      const sourceRef = db.collection(PLATE_AUCTION_SOURCE_COLLECTION).doc(key);
      const previous = await db.collection(PLATE_AUCTION_COLLECTION).where('sourceKey', '==', config.plateCode).limit(2500).get();
      const previousById = new Map(previous.docs.map((doc) => [doc.id, { id: doc.id, ...doc.data() }]));
      if (parsedRows.length === 0) {
        // An empty upstream response is degraded, but it must not leave a
        // record visibly active after its official deadline. Close expired
        // observations in both current and history collections while keeping
        // unexpired rows untouched for the next successful fetch.
        const writes = [];
        for (const [id, old] of previousById) {
          const record = closeExpiredObservation(old, now);
          if (!record) continue;
          writes.push({ ref: db.collection(PLATE_AUCTION_COLLECTION).doc(id), record, merge: true });
          writes.push({ ref: db.collection(PLATE_AUCTION_HISTORY_COLLECTION).doc(`${id}-${fetchedAt.replace(/[^0-9]/g, '').slice(0, 14)}-closed`), record });
        }
        for (const chunk of chunkPlateAuctionWrites(writes)) {
          const batch = db.batch();
          for (const write of chunk) {
            if (write.merge) batch.set(write.ref, write.record, { merge: true });
            else batch.set(write.ref, write.record);
          }
          await batch.commit();
        }
        await sourceRef.set(sourceDocument(config, fetchedAt, { status: 'degraded', rowCount: 0, errorCode: 'zero_rows' }), { merge: true });
        summaries[key] = { status: 'degraded', rowCount: 0, closedExpired: writes.length / 2 };
        continue;
      }

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
      const sourceDisappeared = qualityIssues.some((item) => item.code === 'source-disappeared');
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
        if (currentIds.has(id)) continue;
        const record = closeExpiredObservation(old, now);
        if (!record) continue;
        writes.push({ ref: db.collection(PLATE_AUCTION_COLLECTION).doc(id), record, merge: true });
        writes.push({ ref: db.collection(PLATE_AUCTION_HISTORY_COLLECTION).doc(`${id}-${fetchedAt.replace(/[^0-9]/g, '').slice(0, 14)}-closed`), record });
      }
      if (!sourceDisappeared) {
        for (const [id, old] of previousById) {
          // A non-empty successful feed is authoritative for its current
          // catalogue only when quality checks find no source disappearance.
          // A partial catalogue must not erase an unexpired live observation.
          if (currentIds.has(id) || !['active', 'upcoming'].includes(old.auctionStatus)
            || (timestampMs(old.endsAt) !== undefined && timestampMs(old.endsAt) <= now.getTime())) continue;
          writes.push({ ref: db.collection(PLATE_AUCTION_COLLECTION).doc(id), delete: true });
        }
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
      const sourcePatch = sourceDisappeared
        ? { status: 'degraded', rowCount: rows.length, errorCode: 'source_disappeared' }
        : { status: 'active', rowCount: rows.length, lastSuccessAt: fetchedAt, errorCode: null };
      await sourceRef.set(sourceDocument(config, fetchedAt, sourcePatch), { merge: true });
      summaries[key] = { status: sourcePatch.status, rowCount: rows.length, ...(sourceDisappeared ? { errorCode: 'source_disappeared' } : {}) };
    } catch (error) {
      await db.collection(PLATE_AUCTION_SOURCE_COLLECTION).doc(key).set(sourceDocument(config, fetchedAt, { status: 'degraded', errorCode: 'fetch_failed', errorMessage: error instanceof Error ? error.message.slice(0, 180) : 'unknown_error' }), { merge: true });
      summaries[key] = { status: 'degraded', errorCode: 'fetch_failed' };
      console.error(`[refreshPlateAuctions:${key}]`, error instanceof Error ? error.message : String(error));
    }
  }
  // Keep the complete 26-canton matrix visible in the API, including sources
  // that are known to be blocked or that do not publish a public auction
  // catalogue. This is deliberately explicit: a missing connector is an
  // implementation error, while a blocked/no-public source is a known state.
  for (const [key, source] of Object.entries(PUBLIC_PLATE_AUCTION_SOURCE_REGISTRY)) {
    if (CONNECTORS[key] && source.status === 'active') continue;
    const patch = source.status === 'active'
      ? { status: 'degraded', errorCode: 'missing_connector' }
      : { status: source.status, errorCode: null };
    await db.collection(PLATE_AUCTION_SOURCE_COLLECTION).doc(key).set({
      ...source,
      rowCount: 0,
      lastCheckedAt: fetchedAt,
      ...patch,
    }, { merge: true });
    summaries[key] = { status: patch.status, rowCount: 0, ...(patch.errorCode ? { errorCode: patch.errorCode } : {}) };
  }
  return { fetchedAt, summaries };
}

export function isPlateAuctionPublicRecord(value) {
  return Boolean(publicAuction(value));
}
