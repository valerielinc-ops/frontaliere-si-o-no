import {
  buildEcariDetailUrl,
  extractEcariTabSection,
  extractPdfUrl,
  fetchJson,
  fetchHtml,
  fetchPdfText,
  FIXED_PRICE_SOURCE_CONFIGS,
  parseAiFixedPricePdfText,
  parseBsFixedPricePdfText,
  parseGlFixedPriceJson,
  parseLuFixedPricePdfText,
  parseEcariAuctionRows,
  parseUrFixedPricePdfText,
  parseZhAuctionCards,
  SWISSSIGN_RSA_TLS_OV_ICA_2022_1,
} from './plateAuctionsCore.js';
import { getAdminDb } from './newsletterResendWebhookCore.js';
import { PUBLIC_PLATE_AUCTION_SOURCE_REGISTRY } from './plateAuctionSourceRegistry.js';
import { chunkPlateAuctionWrites } from './plateAuctionBatch.js';
import {
  checkPlateAuctionQuality,
  derivePlateAuctionDataConfidence,
  observeCatalogueDisappearance,
  recognizeCatalogueSales,
} from './plateAuctionQualityCore.js';

export const PLATE_AUCTION_COLLECTION = 'plate_auctions_current';
export const PLATE_AUCTION_HISTORY_COLLECTION = 'plate_auctions_history';
export const PLATE_AUCTION_SOURCE_COLLECTION = 'plate_auction_sources';
export const PLATE_AUCTION_API_SCHEMA = 1;
const PLATE_AUCTION_PAGE_SIZE = 1000;
const PLATE_AUCTION_MAX_ROWS = 100000;

function canonicalPlateCode(value) {
  return String(value || '').trim().toUpperCase();
}

function makeEcariConnector({ canton, plateCode, url, parserVersion = '2.0.0' }) {
  return {
    canton,
    plateCode,
    url,
    parserVersion,
    parse(html, fetchedAt) {
      return parseEcariSource(html, {
        canton,
        plateCode,
        officialAuctionUrl: url,
        fetchedAt,
      });
    },
  };
}

function makeCardConnector({ canton, plateCode, url, detailBaseUrl, parserVersion = '1.1.0' }) {
  return {
    canton,
    plateCode,
    url,
    parserVersion,
    parse(html, fetchedAt) {
      return parseCardSource(html, {
        canton,
        plateCode,
        officialAuctionUrl: url,
        detailBaseUrl,
        fetchedAt,
      });
    },
  };
}

function makeFixedPriceConnector({ sourceKey, parse }) {
  const source = FIXED_PRICE_SOURCE_CONFIGS[sourceKey];
  if (!source) throw new Error(`Missing fixed-price source config: ${sourceKey}`);
  return {
    canton: source.canton,
    plateCode: source.plateCode,
    url: source.url || source.pageUrl,
    parserVersion: source.parserVersion,
    async fetchSource({ fetchedAt, injectedFetcher } = {}) {
      if (source.kind === 'json') {
        const payload = injectedFetcher
          ? await injectedFetcher(source.url, { responseType: 'json', timeoutMs: 20000 })
          : await fetchJson(source.url);
        return parse(payload, {
          canton: source.canton,
          plateCode: source.plateCode,
          officialUrl: source.officialUrl,
          officialDetailUrl: source.url,
          fetchedAt,
        });
      }
      const pageHtml = injectedFetcher
        ? await injectedFetcher(source.pageUrl, { responseType: 'html', timeoutMs: 20000 })
        : await fetchHtml(source.pageUrl);
      const variants = source.pdfVariants || [{
        fallbackPdfUrl: source.fallbackPdfUrl,
        pdfUrlPattern: source.pdfUrlPattern,
      }];
      const rows = [];
      for (const variant of variants) {
        const pdfUrl = variant.pdfUrlPattern
          ? extractPdfUrl(pageHtml, {
            baseUrl: source.pageUrl,
            pattern: variant.pdfUrlPattern,
          }) || variant.fallbackPdfUrl
          : variant.fallbackPdfUrl;
        const pdf = injectedFetcher
          ? await injectedFetcher(pdfUrl, { responseType: 'pdf-text', timeoutMs: 30000 })
          : await fetchPdfText(pdfUrl);
        rows.push(...parse(pdf, {
          canton: source.canton,
          plateCode: source.plateCode,
          officialUrl: source.officialUrl,
          officialDetailUrl: pdfUrl,
          fetchedAt,
          ...(variant.vehicleType ? { vehicleType: variant.vehicleType } : {}),
        }));
      }
      return rows;
    },
  };
}

const CONNECTORS = {
  ag: makeCardConnector({
    canton: 'Argovia',
    plateCode: 'AG',
    url: 'https://www.auktion-ag.ch',
    detailBaseUrl: 'https://www.auktion-ag.ch',
  }),
  ai: makeFixedPriceConnector({ sourceKey: 'ai', parse: parseAiFixedPricePdfText }),
  ar: makeEcariConnector({ canton: 'Appenzello Esterno', plateCode: 'AR', url: 'https://eauktion.ar.ch/ecari-auction/ui/app/init' }),
  be: makeCardConnector({
    canton: 'Berna',
    plateCode: 'BE',
    url: 'https://www.auktion-be.ch/de/',
    detailBaseUrl: 'https://www.auktion-be.ch',
  }),
  bl: makeEcariConnector({ canton: 'Basilea Campagna', plateCode: 'BL', url: 'https://eauktion.bl.ch/ecari-auction/ui/app/init' }),
  bs: makeFixedPriceConnector({ sourceKey: 'bs', parse: parseBsFixedPricePdfText }),
  fr: makeEcariConnector({ canton: 'Friburgo', plateCode: 'FR', url: 'https://appls.ocn.ch/ecari-auction/ui/app/init?locale=fr_ch' }),
  gl: makeFixedPriceConnector({ sourceKey: 'gl', parse: parseGlFixedPriceJson }),
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
        detailUrlBuilder: (sourceRecordId) => buildEcariDetailUrl('https://eauktion.gr.ch/', sourceRecordId),
      }));
    },
  },
  nw: makeEcariConnector({ canton: 'Nidvaldo', plateCode: 'NW', url: 'https://ecarinwprod.ilz.info/ecari-auction/' }),
  ow: makeEcariConnector({ canton: 'Obvaldo', plateCode: 'OW', url: 'https://ecariowprod.ilz.info/ecari-auction/' }),
  so: makeEcariConnector({ canton: 'Soletta', plateCode: 'SO', url: 'https://eauktion.so.ch/ecari-auction' }),
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
        detailUrlBuilder: (sourceRecordId) => buildEcariDetailUrl('https://ecari.vs.ch/ecari-auction/', sourceRecordId),
      }));
    },
  },
  vd: makeCardConnector({
    canton: 'Vaud',
    plateCode: 'VD',
    url: 'https://www.encheres-vd.ch/de/',
    detailBaseUrl: 'https://www.encheres-vd.ch',
  }),
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
        detailUrlBuilder: (sourceRecordId) => buildEcariDetailUrl('https://www.carieauktion.ti.ch/ecari-auktion/', sourceRecordId),
      }));
    },
  },
  lu: makeFixedPriceConnector({ sourceKey: 'lu', parse: parseLuFixedPricePdfText }),
  ur: makeFixedPriceConnector({ sourceKey: 'ur', parse: parseUrFixedPricePdfText }),
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
      detailUrlBuilder: (sourceRecordId) => buildEcariDetailUrl(officialAuctionUrl, sourceRecordId),
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

async function readPaginatedDocuments({ firstQuery, nextQuery, pageSize, maxRows = PLATE_AUCTION_MAX_ROWS, label }) {
  const documents = [];
  let query = firstQuery;
  while (true) {
    const snapshot = await query.get();
    const pageDocuments = Array.isArray(snapshot?.docs) ? snapshot.docs : [];
    if (documents.length + pageDocuments.length > maxRows) {
      throw new Error(`${label} pagination limit`);
    }
    documents.push(...pageDocuments);
    if (pageDocuments.length < pageSize) return documents;
    const lastDocument = pageDocuments[pageDocuments.length - 1];
    if (!lastDocument || typeof nextQuery !== 'function') {
      throw new Error(`${label} pagination unavailable`);
    }
    query = nextQuery(lastDocument);
  }
}

async function readCollection(db, collection, options = {}) {
  // Keep callers using the historical numeric second argument safe while the
  // paginated reader accepts named limits. A number means maxRows, as it did
  // before pagination was introduced.
  const { pageSize = PLATE_AUCTION_PAGE_SIZE, maxRows = PLATE_AUCTION_MAX_ROWS } = typeof options === 'number'
    ? { maxRows: options }
    : (options || {});
  const collectionRef = db.collection(collection);
  if (typeof collectionRef.orderBy !== 'function') {
    const snapshot = await collectionRef.limit(maxRows).get();
    if (Array.isArray(snapshot?.docs) && snapshot.docs.length >= maxRows) {
      throw new Error(`${collection} pagination unavailable`);
    }
    return (snapshot.docs || []).map((doc) => ({ id: doc.id, ...doc.data() }));
  }
  const ordered = collectionRef.orderBy('__name__');
  const documents = await readPaginatedDocuments({
    firstQuery: ordered.limit(pageSize),
    nextQuery: (lastDocument) => ordered.startAfter(lastDocument).limit(pageSize),
    pageSize,
    maxRows,
    label: collection,
  });
  return documents.map((doc) => ({ id: doc.id, ...doc.data() }));
}

async function readSourceRows(db, sourceKey) {
  const collectionRef = db.collection(PLATE_AUCTION_COLLECTION);
  const filtered = collectionRef.where('sourceKey', '==', sourceKey);
  if (typeof filtered.orderBy !== 'function') {
    const snapshot = await filtered.limit(PLATE_AUCTION_MAX_ROWS).get();
    if (Array.isArray(snapshot?.docs) && snapshot.docs.length >= PLATE_AUCTION_MAX_ROWS) {
      throw new Error(`plate-auctions:${sourceKey} pagination unavailable`);
    }
    return snapshot.docs || [];
  }
  const ordered = filtered.orderBy('__name__');
  return readPaginatedDocuments({
    firstQuery: ordered.limit(PLATE_AUCTION_PAGE_SIZE),
    nextQuery: (lastDocument) => ordered.startAfter(lastDocument).limit(PLATE_AUCTION_PAGE_SIZE),
    pageSize: PLATE_AUCTION_PAGE_SIZE,
    maxRows: PLATE_AUCTION_MAX_ROWS,
    label: `plate-auctions:${sourceKey}`,
  });
}

export async function getPublicPlateAuctionSnapshot(db = getAdminDb()) {
  const [auctionRows, sourceRows] = await Promise.all([
    // Basel-Stadt publishes a large official fixed-price catalogue. Read all
    // pages and fail closed above the defensive cap instead of silently
    // truncating the public snapshot.
    readCollection(db, PLATE_AUCTION_COLLECTION),
    readCollection(db, PLATE_AUCTION_SOURCE_COLLECTION, { pageSize: 50, maxRows: 50 }),
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
    .map((source) => canonicalPlateCode(source.plateCode)));
  const auctions = auctionRows.map(publicAuction).filter(Boolean)
    .filter((auction) => activeSourceCodes.has(canonicalPlateCode(auction.sourceKey || auction.platePrefix)))
    .map((auction) => {
    const closed = closeExpiredObservation(auction, new Date());
    return closed ? publicAuction(closed) : auction;
  }).filter(Boolean);
  const history = historyRows.map(publicAuction).filter(Boolean)
    .filter((auction) => activeSourceCodes.has(canonicalPlateCode(auction.sourceKey || auction.platePrefix)));
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
    complete: true,
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

function sourceDocument(sourceKey, config, fetchedAt, patch = {}) {
  const registrySource = PUBLIC_PLATE_AUCTION_SOURCE_REGISTRY[sourceKey] || {};
  return {
    canton: registrySource.canton || config.canton,
    plateCode: registrySource.plateCode || config.plateCode,
    officialUrl: registrySource.officialUrl || config.url,
    accessMethod: registrySource.accessMethod || 'html-scrape',
    fetchFrequency: registrySource.fetchFrequency || 'PT6H',
    timezone: registrySource.timezone || 'Europe/Zurich',
    parserVersion: registrySource.parserVersion || config.parserVersion,
    availableFields: registrySource.availableFields || [],
    rateLimit: registrySource.rateLimit || 'collector capped at four fetches/day',
    termsOfUse: registrySource.termsOfUse || 'review source terms before increasing frequency',
    owner: registrySource.owner || 'platform',
    ...(registrySource.notes ? { notes: registrySource.notes } : {}),
    lastFetchedAt: fetchedAt,
    lastCheckedAt: fetchedAt,
    ...patch,
  };
}

/**
 * @param {{db?: any, fetcher?: (url: string, options?: Record<string, unknown>) => Promise<any>, now?: Date}} options
 */
export async function refreshPlateAuctions({ db = getAdminDb(), fetcher, now = new Date() } = {}) {
  const fetchedAt = now.toISOString();
  const summaries = {};
  for (const [key, config] of Object.entries(CONNECTORS)) {
    if (PUBLIC_PLATE_AUCTION_SOURCE_REGISTRY[key]?.status !== 'active') continue;
    try {
      const parsedRows = typeof config.fetchSource === 'function'
        ? await config.fetchSource({ fetchedAt, injectedFetcher: fetcher })
        : config.parse(await (fetcher || fetchHtml)(config.url, {
          timeoutMs: 20000,
          ...(key === 'fr' ? { ca: SWISSSIGN_RSA_TLS_OV_ICA_2022_1 } : {}),
        }), fetchedAt);
      const sourceRef = db.collection(PLATE_AUCTION_SOURCE_COLLECTION).doc(key);
      const previous = { docs: await readSourceRows(db, config.plateCode) };
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
        await sourceRef.set(sourceDocument(key, config, fetchedAt, { status: 'degraded', rowCount: 0, errorCode: 'zero_rows' }), { merge: true });
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
      // Same defect class as scripts/plate-auctions/ingest.mjs, in the other
      // pipeline: closeExpiredObservation() returns null without an `endsAt`,
      // which no fixed-price row has, so a sold plate was skipped here and
      // never recorded as closed. The decision and its threshold come from the
      // shared quality core so the two pipelines cannot drift apart.
      const vanished = [...previousById.entries()].filter(([id]) => !currentIds.has(id));
      // Mirrors the ingest predicate: fixed-price AND no usable deadline.
      // Without the type check a malformed timed-auction row would be stamped
      // closed as a sale; every other missing row stays protected.
      const isSaleCandidate = (row) => row.listingType === 'fixed-price'
        && timestampMs(row.endsAt) === undefined
        && ['active', 'upcoming'].includes(row.auctionStatus);
      const saleCandidates = vanished.filter(([, old]) => isSaleCandidate(old));
      const protectedVanished = vanished.filter(([, old]) => !isSaleCandidate(old)
        && ['active', 'upcoming'].includes(old.auctionStatus));
      // Only LIVE observations may enter the denominator. This same path
      // writes closed records back into PLATE_AUCTION_COLLECTION below, so
      // `previousById.size` grows with every accumulated sale while
      // `rows.length` only ever counts the live feed: the 95% band would
      // tighten run after run until a healthy feed was classified
      // preserve-as-live and sales stopped being recorded altogether.
      const previousLiveCount = [...previousById.values()]
        .filter((row) => ['active', 'upcoming'].includes(row?.auctionStatus)).length;
      const saleDecision = recognizeCatalogueSales({
        previousCount: previousLiveCount,
        fetchedCount: rows.length,
        vanishedCount: saleCandidates.length,
      });
      console.log(
        `[refreshPlateAuctions:${key}] sale-recognition previous=${previousLiveCount} `
        + `fetched=${rows.length} vanished=${saleCandidates.length} protected=${protectedVanished.length} cap=${saleDecision.cap} `
        + (saleDecision.recognized ? `decision=sales sold=${saleCandidates.length}` : `decision=preserve-as-live blocked-by=${saleDecision.blockedBy.join('+')}`),
      );
      const recognizedSaleIds = new Set(saleDecision.recognized ? saleCandidates.map(([id]) => id) : []);
      for (const [id, old] of vanished) {
        // A deadline that has passed archives the row; a catalogue removal in
        // a healthy catalogue is a sale. Neither ever carries a final price.
        const record = recognizedSaleIds.has(id)
          ? observeCatalogueDisappearance({ ...old, id }, now)
          : closeExpiredObservation(old, now);
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
      // Same rule as ingest's sourceStatus(): recognized fixed-price sales
      // leave `sourceDisappeared` true, so deriving the patch from that raw
      // flag kept a healthy source `degraded` and could hide its active rows
      // from consumers that require an active source. A single protected row
      // still means an upstream anomaly, so it must NOT be laundered into
      // `active` by one recognized sale.
      const allLossesAreSales = saleDecision.recognized
        && protectedVanished.length === 0
        && recognizedSaleIds.size > 0;
      const sourcePatch = sourceDisappeared && !allLossesAreSales
        ? { status: 'degraded', rowCount: rows.length, errorCode: 'source_disappeared' }
        : { status: 'active', rowCount: rows.length, lastSuccessAt: fetchedAt, errorCode: null };
      await sourceRef.set(sourceDocument(key, config, fetchedAt, sourcePatch), { merge: true });
      summaries[key] = { status: sourcePatch.status, rowCount: rows.length, ...(sourcePatch.errorCode ? { errorCode: sourcePatch.errorCode } : {}) };
    } catch (error) {
      await db.collection(PLATE_AUCTION_SOURCE_COLLECTION).doc(key).set(sourceDocument(key, config, fetchedAt, { status: 'degraded', errorCode: 'fetch_failed', errorMessage: error instanceof Error ? error.message.slice(0, 180) : 'unknown_error' }), { merge: true });
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
