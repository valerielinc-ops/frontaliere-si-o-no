import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import https from 'node:https';
import tls from 'node:tls';

export const SWISSSIGN_RSA_TLS_OV_ICA_2022_1 = readFileSync(
  new URL('./certs/swisssign-rsa-tls-ov-ica-2022-1.pem', import.meta.url),
  'utf8',
);

/**
 * Pure parsers shared by the scheduled collector and the local connector
 * smoke-tests. Keep this file free of Firebase imports: it is also imported
 * by scripts/plate-auctions so the deployed and local paths cannot drift.
 */

const ECARI_DATE_RE = /^(\d{4})\/(\d{2})\/(\d{2})\s+(\d{2}):(\d{2}):(\d{2})$/;

function zurichLocalToUtcIso(year, month, day, hour, minute, second) {
  const utcGuess = Date.UTC(year, month - 1, day, hour, minute, second);
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: 'Europe/Zurich',
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    }).formatToParts(utcGuess).map((part) => [part.type, part.value]),
  );
  const localAsUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second),
  );
  return new Date(utcGuess - (localAsUtc - utcGuess)).toISOString();
}

export function parseEcariDate(value) {
  const match = String(value || '').trim().match(ECARI_DATE_RE);
  if (!match) return undefined;
  return zurichLocalToUtcIso(...match.slice(1).map(Number));
}

export function buildEcariDetailUrl(officialAuctionUrl, sourceRecordId) {
  if (!officialAuctionUrl || !sourceRecordId) return undefined;
  try {
    const url = new URL(officialAuctionUrl);
    const pathname = url.pathname.replace(/\/+$/, '');
    const uiIndex = pathname.toLowerCase().indexOf('/ui/app');
    const auctionRoot = uiIndex >= 0
      ? pathname.slice(0, uiIndex)
      : pathname.match(/^(.*\/ecari(?:-auction|-auktion))$/i)?.[1];
    if (!auctionRoot) return officialAuctionUrl;
    const locale = url.searchParams.get('locale');
    url.pathname = `${auctionRoot}/ui/app/details/app`;
    url.search = '';
    url.searchParams.set('id', String(sourceRecordId));
    if (locale) url.searchParams.set('locale', locale);
    return url.toString();
  } catch {
    return officialAuctionUrl;
  }
}

export function extractEcariTabSection(html, tabContentId) {
  const pattern = new RegExp(`<div id="${String(tabContentId).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"[\\s\\S]*?(?=<div id="tabContent\\d+"|$)`);
  return String(html || '').match(pattern)?.[0] || '';
}

const ECARI_TAB_IDS = ['tabContent1', 'tabContent2', 'tabContent3', 'tabContent4'];
// Le etichette dello stato vuoto seguono la lingua della pagina, non il
// cantone: VS e FR servono fr_ch, TI it_CH (catena root → bootstrap →
// props?locale=it_CH misurata da Zurigo il 2026-09-25, Globalping
// 2PC0TDQSHF4T7OySI00021CPL e 2IcfQS3Fl9FHl7rNB00021CPM). Con il solo tedesco
// un catalogo vuoto di queste tre fonti restava `zero_rows`. Testi misurati il
// 2026-09-25 sulle schede vuote di NW (432.10.83, locale fr_ch e it_ch), VS (fr)
// e GR (it): fr «Aucune enchère en cours» / «Plaques indisponibles»; in
// italiano anche la scheda d'asta dice «Nessuna targa disponibile».
const ECARI_NO_RUNNING_AUCTION_RE = /Keine\s+laufende\s+Versteigerung|Aucune\s+ench(?:è|&egrave;|&#232;)re\s+en\s+cours|Nessuna\s+targa\s+disponibile/i;
const ECARI_EMPTY_TAB_RE = /Keine\s+laufende\s+Versteigerung|Kontrollschilder\s+nicht\s+verf(?:ü|&uuml;)gbar|Aucune\s+ench(?:è|&egrave;|&#232;)re\s+en\s+cours|Plaques\s+indisponibles|Nessuna\s+targa\s+disponibile/i;

/**
 * True when an eCari page is the portal's OWN empty catalogue, not a page we
 * failed to read. Between two auction rounds eCari prints "Keine laufende
 * Versteigerung" in the auction tab and "Kontrollschilder nicht verfügbar" in
 * the others: NW and OW served exactly that on 2026-09-24, after all 21 rows
 * of each had ended on 2026-09-21, and were reported `zero_rows` on every run.
 *
 * Fail-closed on purpose: every tab the connector reads (`expectedTabIds`)
 * must be on the page, every tab on the page must carry its empty label and
 * no table row may hold anything else. A page whose real rows the parser no
 * longer understands, a shell without the labels, or a truncated response
 * that kept only an empty first tab is never mistaken for an empty catalogue.
 */
export function isEcariCatalogueExplicitlyEmpty(html, expectedTabIds = ECARI_TAB_IDS) {
  if (!Array.isArray(expectedTabIds) || expectedTabIds.length === 0) return false;
  if (expectedTabIds.some((tabId) => !extractEcariTabSection(html, tabId))) return false;
  const tabs = [...new Set([...expectedTabIds, ...ECARI_TAB_IDS])]
    .map((tabId) => extractEcariTabSection(html, tabId))
    .filter(Boolean);
  if (!ECARI_NO_RUNNING_AUCTION_RE.test(htmlText(extractEcariTabSection(html, 'tabContent1')))) return false;
  return tabs.every((section) => ECARI_EMPTY_TAB_RE.test(htmlText(section))
    && [...section.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)]
      .map((match) => match[1])
      .filter((row) => !/<th\b/i.test(row))
      .every((row) => ECARI_EMPTY_TAB_RE.test(htmlText(row))));
}

/**
 * A parse result carries no room for "the source said it is empty", and the
 * collectors must tell that apart from a parse that found nothing. The flag
 * rides on the empty array itself (non-enumerable, so equality and JSON are
 * unchanged) and is read only through isExplicitlyEmptyCatalogue().
 */
export function isExplicitlyEmptyCatalogue(rows) {
  return Array.isArray(rows) && rows.length === 0 && rows.explicitlyEmpty === true;
}

/**
 * The parsed rows, or the explicitly-empty catalogue when eCari itself says
 * nothing is listed. `expectedTabIds` are the tabs the caller parsed: each one
 * must be on the page for the empty state to count.
 */
export function withEcariEmptyState(rows, html, expectedTabIds = ECARI_TAB_IDS) {
  if (rows.length > 0 || !isEcariCatalogueExplicitlyEmpty(html, expectedTabIds)) return rows;
  return explicitlyEmptyCatalogue();
}

/**
 * L'array vuoto con il flag letto da isExplicitlyEmptyCatalogue(): «la fonte
 * ha risposto che oggi non c'è catalogo». Condiviso da eCari e dalla lista PDF
 * di Ginevra, così i due collector trattano allo stesso modo ogni fonte che
 * dichiara esplicitamente di non avere un'asta in corso.
 */
export function explicitlyEmptyCatalogue() {
  return Object.defineProperty([], 'explicitlyEmpty', { value: true });
}

function htmlText(value) {
  return String(value || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&#160;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

function numericText(value) {
  const text = htmlText(value).replace(/[^0-9-]/g, '');
  if (!text) return undefined;
  const number = Number(text);
  return Number.isFinite(number) ? number : undefined;
}

function moneyText(value) {
  const text = String(value || '').replace(/\u00a0/g, ' ').trim();
  const match = text.match(/[0-9][0-9'’]*(?:,[0-9]{3})?(?:\.[0-9]{1,2})?/);
  if (!match) return undefined;
  const raw = match[0].replace(/[ '’]/g, '');
  const normalized = /,\d{3}(?:\.|$)/.test(raw)
    ? raw.replace(/,/g, '')
    : raw.replace(',', '.');
  const number = Number(normalized);
  return Number.isFinite(number) ? number : undefined;
}

function fixedPriceRow({
  sourceKey,
  canton,
  plateCode,
  plateNumber,
  sourceRecordId,
  price,
  officialUrl,
  officialDetailUrl,
  fetchedAt,
  vehicleType = 'car',
  sourceCategory = 'fixed-price',
  rawSnapshot,
}) {
  const normalizedCode = String(plateCode || sourceKey || '').toUpperCase();
  const normalizedNumber = String(plateNumber || '').replace(/\s+/g, '');
  const recordId = String(sourceRecordId || normalizedNumber);
  if (!normalizedCode || !normalizedNumber || price === undefined) return null;
  return {
    id: `${normalizedCode.toLowerCase()}-${recordId}`,
    sourceKey: normalizedCode,
    sourceRecordId: recordId,
    canton,
    platePrefix: normalizedCode,
    plateNumber: normalizedNumber,
    normalizedPlate: `${normalizedCode}${normalizedNumber}`,
    listingType: 'fixed-price',
    vehicleType,
    auctionStatus: 'active',
    startingPriceChf: price,
    officialAuctionUrl: officialUrl,
    ...(officialDetailUrl ? { officialDetailUrl } : {}),
    sourceFetchedAt: fetchedAt,
    lastVerifiedAt: fetchedAt,
    firstSeenAt: fetchedAt,
    lastSeenAt: fetchedAt,
    sourceCategory,
    dataConfidence: 'partial',
    rawSnapshotHash: createHash('sha1').update(String(rawSnapshot || recordId)).digest('hex').slice(0, 12),
  };
}

function sourceText(value) {
  if (Array.isArray(value)) return value.join('\n');
  if (value && typeof value === 'object' && typeof value.text === 'string') return value.text;
  return String(value || '');
}

function sourcePages(value) {
  if (value && typeof value === 'object' && Array.isArray(value.pages)) return value.pages;
  return [sourceText(value)];
}

/**
 * Parses Appenzell Innerrhoden's official price-group PDF. The PDF lists a
 * price heading followed by all numbers in that group; a number is not
 * treated as a bid or a sale result.
 */
export function parseAiFixedPricePdfText(value, {
  canton = 'Appenzello Interno',
  plateCode = 'AI',
  officialUrl,
  officialDetailUrl,
  fetchedAt = new Date().toISOString(),
  vehicleType = 'car',
} = {}) {
  const text = sourceText(value);
  const prices = [...text.matchAll(/Fr\.?\s*([0-9][0-9'’]*(?:,[0-9]{3})?(?:\.[0-9]{1,2})?)/gi)];
  const rows = [];
  for (let index = 0; index < prices.length; index += 1) {
    const match = prices[index];
    const price = moneyText(match[1]);
    if (price === undefined) continue;
    const end = prices[index + 1]?.index ?? text.length;
    const segment = text.slice(match.index + match[0].length, end);
    for (const numberMatch of segment.matchAll(/\b\d{3,6}\b/g)) {
      const plateNumber = numberMatch[0];
      const row = fixedPriceRow({
        sourceKey: plateCode,
        canton,
        plateCode,
        plateNumber,
        sourceRecordId: vehicleType === 'car' ? plateNumber : `${vehicleType}-${plateNumber}`,
        price,
        officialUrl,
        officialDetailUrl,
        fetchedAt,
        vehicleType,
        sourceCategory: 'fixed-price-price-group',
        rawSnapshot: `${match[0]}:${plateNumber}`,
      });
      if (row) rows.push(row);
    }
  }
  return rows;
}

/** Parses Basel-Stadt's official motor-vehicle Wunschkontrollschilder PDF. */
export function parseBsFixedPricePdfText(value, {
  canton = 'Basilea Città',
  plateCode = 'BS',
  officialUrl,
  officialDetailUrl,
  fetchedAt = new Date().toISOString(),
  vehicleType = 'car',
} = {}) {
  const text = sourceText(value);
  const rows = [];
  const rowRe = /\bBS\s+(\d{1,5})\s+([0-9][0-9'’]*(?:,[0-9]{3})?(?:\.[0-9]{1,2})?)\s+(Ja|Nein)\b/gi;
  let match;
  while ((match = rowRe.exec(text)) !== null) {
    const price = moneyText(match[2]);
    const row = fixedPriceRow({
      sourceKey: plateCode,
      canton,
      plateCode,
      plateNumber: match[1],
      sourceRecordId: vehicleType === 'car' ? match[1] : `${vehicleType}-${match[1]}`,
      price,
      officialUrl,
      officialDetailUrl,
      fetchedAt,
      vehicleType,
      sourceCategory: match[3].toLowerCase() === 'ja' ? 'fixed-price-in-stock' : 'fixed-price-order',
      rawSnapshot: match[0],
    });
    if (row) rows.push(row);
  }
  return rows;
}

function luPriceColumns(line) {
  return [...String(line || '').matchAll(/Fr\s*([0-9][0-9'’]*(?:,[0-9]{3})?(?:\.[0-9]{1,2})?)\s*[-–]?/gi)]
    .map((match) => moneyText(match[1]))
    .filter((value) => value !== undefined);
}

function luPlateColumns(line) {
  return [...String(line || '').matchAll(/\b(\d{1,2})\s+(\d{3})\b/g)]
    .map((match) => `${match[1]}${match[2]}`);
}

/**
 * Parses Luzern's multi-page PDF using its table columns. Page-level text is
 * important here: each row's Nth plate belongs to the Nth price column.
 */
export function parseLuFixedPricePdfText(value, {
  canton = 'Lucerna',
  plateCode = 'LU',
  officialUrl,
  officialDetailUrl,
  fetchedAt = new Date().toISOString(),
} = {}) {
  const rows = [];
  const seen = new Set();
  for (const page of sourcePages(value)) {
    const lines = String(page || '').split(/\r?\n/);
    let vehicleType = 'car';
    let format = 'catalogue';
    let prices = [];
    for (const line of lines) {
      if (/Wunschkontrollschilder\s+Motorrad/i.test(line)) vehicleType = 'motorcycle';
      else if (/Wunschkontrollschilder\s+Motorwagen/i.test(line)) vehicleType = 'car';
      if (/Hochformat/i.test(line)) format = 'high-format';
      if (/Langformat/i.test(line)) format = 'long-format';
      const linePrices = luPriceColumns(line);
      if (linePrices.length > 0) {
        prices = linePrices;
        continue;
      }
      const plates = luPlateColumns(line);
      if (plates.length === 0 || prices.length === 0) continue;
      plates.forEach((plateNumber, index) => {
        const price = prices[index];
        if (price === undefined) return;
        const sourceRecordId = `${vehicleType}-${format}-${plateNumber}`;
        if (seen.has(sourceRecordId)) return;
        seen.add(sourceRecordId);
        const row = fixedPriceRow({
          sourceKey: plateCode,
          canton,
          plateCode,
          plateNumber,
          sourceRecordId,
          price,
          officialUrl,
          officialDetailUrl,
          fetchedAt,
          vehicleType,
          sourceCategory: `fixed-price-${format}`,
          rawSnapshot: `${line}:${sourceRecordId}`,
        });
        if (row) rows.push(row);
      });
    }
  }
  return rows;
}

/** Parses Uri's official fixed-price motor-vehicle catalogue PDF. */
export function parseUrFixedPricePdfText(value, {
  canton = 'Uri',
  plateCode = 'UR',
  officialUrl,
  officialDetailUrl,
  fetchedAt = new Date().toISOString(),
  vehicleType = 'car',
} = {}) {
  const text = sourceText(value);
  const rows = [];
  const rowRe = /\bUR\s+(\d{3,5})\s+\d+\s*x\s+\d+\s*cm\s+([0-9][0-9'’]*(?:,[0-9]{3})?(?:\.[0-9]{1,2})?)\s*[-–.]{1,3}\s*SFr\.?/gi;
  let match;
  while ((match = rowRe.exec(text)) !== null) {
    const row = fixedPriceRow({
      sourceKey: plateCode,
      canton,
      plateCode,
      plateNumber: match[1],
      sourceRecordId: vehicleType === 'car' ? match[1] : `${vehicleType}-${match[1]}`,
      price: moneyText(match[2]),
      officialUrl,
      officialDetailUrl,
      fetchedAt,
      vehicleType,
      sourceCategory: 'fixed-price-list',
      rawSnapshot: match[0],
    });
    if (row) rows.push(row);
  }
  return rows;
}

/** Parses Glarus' official JSON plate inventory. */
export function parseGlFixedPriceJson(value, {
  canton = 'Glarona',
  plateCode = 'GL',
  officialUrl,
  officialDetailUrl,
  fetchedAt = new Date().toISOString(),
} = {}) {
  const items = Array.isArray(value) ? value : Array.isArray(value?.data) ? value.data : [];
  return items.flatMap((item) => {
    if (!item || typeof item !== 'object' || item.deleted || item.registered || item.available === 0) return [];
    const plateNumber = String(item.number ?? '').replace(/\D/g, '');
    const price = moneyText(item.price);
    if (!plateNumber || price === undefined) return [];
    const type = String(item.platetype || '').toLowerCase();
    const vehicleType = type.includes('motor') ? 'motorcycle' : type.includes('trailer') ? 'trailer' : 'car';
    const row = fixedPriceRow({
      sourceKey: plateCode,
      canton,
      plateCode,
      plateNumber,
      sourceRecordId: item.id ?? plateNumber,
      price,
      officialUrl,
      officialDetailUrl,
      fetchedAt,
      vehicleType,
      sourceCategory: 'fixed-price-api',
      rawSnapshot: JSON.stringify(item),
    });
    return row ? [row] : [];
  });
}

/** Official indexes and machine-readable endpoints for the five structured
 * catalogues that were previously classified as "no public auction". */
export const FIXED_PRICE_SOURCE_CONFIGS = Object.freeze({
  ai: {
    kind: 'pdf',
    canton: 'Appenzello Interno',
    plateCode: 'AI',
    officialUrl: 'https://ai.ch/themen/mobilitaet-und-verkehr/strassenverkehr/kontrollschilder/liste-freie-kontrollschilder',
    pageUrl: 'https://ai.ch/themen/mobilitaet-und-verkehr/strassenverkehr/kontrollschilder/liste-freie-kontrollschilder',
    fallbackPdfUrl: 'https://ai.ch/themen/mobilitaet-und-verkehr/strassenverkehr/kontrollschilder/liste-freie-kontrollschilder/liste-freie-auto-kontrollschilder/download',
    pdfUrlPattern: /liste-freie-auto-kontrollschilder\/download/i,
    pdfVariants: [
      {
        vehicleType: 'car',
        fallbackPdfUrl: 'https://ai.ch/themen/mobilitaet-und-verkehr/strassenverkehr/kontrollschilder/liste-freie-kontrollschilder/liste-freie-auto-kontrollschilder/download',
        pdfUrlPattern: /liste-freie-auto-kontrollschilder\/download/i,
      },
      {
        vehicleType: 'motorcycle',
        fallbackPdfUrl: 'https://ai.ch/themen/mobilitaet-und-verkehr/strassenverkehr/kontrollschilder/liste-freie-kontrollschilder/liste-freier-motorrad-kontrollschilder.pdf',
        pdfUrlPattern: /liste-freier-motorrad-kontrollschilder(?:\.pdf)?(?:\/download)?$/i,
      },
    ],
    parserVersion: 'fixed-price-1.0.0',
  },
  bs: {
    kind: 'pdf',
    canton: 'Basilea Città',
    plateCode: 'BS',
    officialUrl: 'https://www.bs.ch/themen/mobilitaet/kontrollschilder/wunschkontrollschilder',
    pageUrl: 'https://www.bs.ch/themen/mobilitaet/kontrollschilder/wunschkontrollschilder',
    // Deliberately NO fallbackPdfUrl. BS publishes one content-addressed PDF
    // per ISO week (`/original_file/<sha>/wuko-pw-<week>.pdf`), so any URL
    // hardcoded here is pinned to the week it was captured and is wrong by
    // construction from the next publication on. The two that used to live
    // here had drifted to weeks 35 and 33 while the live page served 36 and
    // 35. Without a fallback, a pattern that stops matching now names itself
    // instead of 404-ing on a stale week.
    pdfUrlPattern: /\/wuko-pw-[^/]+\.pdf$/i,
    pdfVariants: [
      {
        vehicleType: 'car',
        pdfUrlPattern: /\/wuko-pw-[^/]+\.pdf$/i,
      },
      {
        vehicleType: 'motorcycle',
        pdfUrlPattern: /\/wuko-mr-[^/]+\.pdf$/i,
      },
    ],
    parserVersion: 'fixed-price-1.0.0',
  },
  gl: {
    kind: 'json',
    canton: 'Glarona',
    plateCode: 'GL',
    officialUrl: 'https://www.gl.ch/verwaltung/sicherheit-und-justiz/justiz/strassenverkehrsamt/strassenverkehr/kontrollschilder/wunschkontrollschilder.html/450',
    url: 'https://eschild.gl.ch/api/v1/plate',
    parserVersion: 'fixed-price-1.0.0',
  },
  lu: {
    kind: 'pdf',
    canton: 'Lucerna',
    plateCode: 'LU',
    officialUrl: 'https://strassenverkehrsamt.lu.ch/strassenverkehr/fahrzeug/kontrollschilderboerse_wunschkontrollschild',
    pageUrl: 'https://strassenverkehrsamt.lu.ch/strassenverkehr/fahrzeug/kontrollschilderboerse_wunschkontrollschild',
    fallbackPdfUrl: 'https://strassenverkehrsamt.lu.ch/downloads/strassenverkehrsamt/kontrollschilder/wunschschilder.pdf',
    pdfUrlPattern: /wunschschilder\.pdf$/i,
    parserVersion: 'fixed-price-1.0.0',
  },
  ur: {
    kind: 'pdf',
    canton: 'Uri',
    plateCode: 'UR',
    officialUrl: 'https://www.ur.ch/dienstleistungen/4046',
    pageUrl: 'https://www.ur.ch/dienstleistungen/4046',
    fallbackPdfUrl: 'https://www.ur.ch/_rtr/publikation_4932',
    pdfVariants: [
      { vehicleType: 'car', fallbackPdfUrl: 'https://www.ur.ch/_rtr/publikation_4932' },
      { vehicleType: 'motorcycle', fallbackPdfUrl: 'https://www.ur.ch/_rtr/publikation_4933' },
    ],
    parserVersion: 'fixed-price-1.0.0',
  },
});

export function parseEcariAuctionRows(
  html,
  {
    canton,
    plateCode,
    officialAuctionUrl,
    detailUrlBuilder,
    fetchedAt = new Date().toISOString(),
    auctionStatus = 'active',
    listingType = 'auction',
    idPrefix = String(plateCode || '').toLowerCase(),
    vehicleType = 'car',
  } = {},
) {
  const auctions = [];
  const rowRe = /<tr\s+class="L"(?:\s+[^>]*)?>([\s\S]*?)<\/tr>/gi;
  let rowMatch;
  while ((rowMatch = rowRe.exec(String(html || ''))) !== null) {
    const row = rowMatch[1];
    const sourceId = row.match(/openDetails\((\d+)\)/i)?.[1];
    const plateNumber = row.match(/<div\s+class="number">\s*(\d+)\s*<\/div>/i)?.[1];
    const closingMatch = row.match(/<td\s+class="closingTime"[^>]*>([\s\S]*?)<\/td>/i);
    const amounts = [...row.matchAll(/<td\s+class="amount"[^>]*>([\s\S]*?)<\/td>/gi)]
      .map((match) => numericText(match[1]))
      .filter((value) => value !== undefined);
    // Tabs 1/2 expose a full auction row, while the direct-sale and wanted
    // tabs can omit price/deadline cells. The identity is still public and
    // useful; missing numeric fields must remain missing rather than become
    // zeroes that look like verified prices.
    if (!sourceId || !plateNumber) continue;

    const endsAt = closingMatch ? parseEcariDate(htmlText(closingMatch[1])) : undefined;
    const afterClosing = closingMatch
      ? row.slice((closingMatch.index || 0) + closingMatch[0].length)
      : '';
    const bidCount = numericText(afterClosing.match(/<td(?:\s+[^>]*)?>\s*(\d+)\s*<\/td>/i)?.[1]);
    const sourceRecordId = String(sourceId);
    const detailUrl = typeof detailUrlBuilder === 'function'
      ? detailUrlBuilder(sourceRecordId)
      : buildEcariDetailUrl(officialAuctionUrl, sourceRecordId);

    const record = {
      id: `${idPrefix}-${sourceRecordId}`,
      sourceKey: String(plateCode || '').toUpperCase(),
      sourceRecordId,
      canton,
      platePrefix: String(plateCode || '').toUpperCase(),
      plateNumber,
      normalizedPlate: `${String(plateCode || '').toUpperCase()}${plateNumber}`,
      listingType,
      vehicleType,
      auctionStatus,
      ...(listingType === 'fixed-price' && amounts.length === 1
        ? { currentBidChf: amounts[0] }
        : {
          ...(amounts[0] !== undefined ? { startingPriceChf: amounts[0] } : {}),
          ...(amounts[1] !== undefined ? { minimumIncrementChf: amounts[1] } : {}),
          ...(amounts[2] !== undefined ? { currentBidChf: amounts[2] } : {}),
        }),
      ...(bidCount !== undefined ? { bidCount } : {}),
      ...(endsAt ? { endsAt } : {}),
      officialAuctionUrl,
      ...(detailUrl ? { officialDetailUrl: detailUrl } : {}),
      sourceFetchedAt: fetchedAt,
      lastVerifiedAt: fetchedAt,
      firstSeenAt: fetchedAt,
      lastSeenAt: fetchedAt,
      dataConfidence: 'partial',
      rawSnapshotHash: createHash('sha1').update(row.trim()).digest('hex').slice(0, 12),
    };
    auctions.push(record);
  }
  return auctions;
}

function parseZhDate(value, fallbackDate) {
  const match = String(value || '').match(/(\d{1,2})\.(\d{1,2})\.(\d{4}),?\s+(\d{1,2}):(\d{2})(?::(\d{2}))?/);
  if (match) {
    return zurichLocalToUtcIso(
      Number(match[3]),
      Number(match[2]),
      Number(match[1]),
      Number(match[4]),
      Number(match[5]),
      Number(match[6] || 0),
    );
  }
  const timeOnly = String(value || '').trim().match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  const dateMatch = String(fallbackDate || '').match(/(\d{1,2})\.(\d{1,2})\.(\d{4})/);
  if (!timeOnly || !dateMatch) return undefined;
  return zurichLocalToUtcIso(
    Number(dateMatch[3]),
    Number(dateMatch[2]),
    Number(dateMatch[1]),
    Number(timeOnly[1]),
    Number(timeOnly[2]),
    Number(timeOnly[3] || 0),
  );
}

function parseZhMoney(value) {
  const match = String(value || '').replace(/&nbsp;/gi, ' ').match(/([0-9][0-9' .]*)/);
  if (!match) return undefined;
  const number = Number(match[1].replace(/[ '.]/g, ''));
  return Number.isFinite(number) ? number : undefined;
}

function parseZhVehicleType(block) {
  const text = String(block || '').toLowerCase();
  if (/motor|motorrad|moto|bike/.test(text)) return 'motorcycle';
  if (/anhänger|remorque|trailer/.test(text)) return 'trailer';
  return 'car';
}

export function parseZhAuctionCards(
  html,
  {
    fetchedAt = new Date().toISOString(),
    officialAuctionUrl = 'https://www.auktion.stva.zh.ch/de/?plate_sub_type=&plate_type=car',
    detailBaseUrl = 'https://www.auktion.stva.zh.ch',
    auctionStatus = 'active',
    sourceKey = 'ZH',
    canton = 'Zurigo',
    platePrefix = 'ZH',
  } = {},
) {
  const auctions = [];
  const normalizedSourceKey = String(sourceKey || platePrefix || '').toUpperCase();
  const normalizedPlatePrefix = String(platePrefix || sourceKey || '').toUpperCase();
  const escapedPlatePrefix = normalizedPlatePrefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const cardRe = /<a\s+href="([^"]*\/auction\/[^"?#]+)"\s+class="auction-element-link"[\s\S]*?<\/a>/gi;
  let cardMatch;
  while ((cardMatch = cardRe.exec(String(html || ''))) !== null) {
    const block = cardMatch[0];
    const plate = block.match(new RegExp(`<figure\\s+title="${escapedPlatePrefix}\\s+([^"<]+)"`, 'i'))?.[1]
      || block.match(new RegExp(`<figcaption[^>]*>\\s*${escapedPlatePrefix}\\s+([^<]+)`, 'i'))?.[1];
    const sourceRecordId = cardMatch[1].match(/\/auction\/([^/?#]+)/i)?.[1];
    if (!plate || !sourceRecordId) continue;
    const currentBidChf = parseZhMoney(block.match(/class="auction-current-bid"[^>]*>([\s\S]*?)<\/div>/i)?.[1]);
    const bidCount = numericText(block.match(/class="auction-number-bids"[^>]*>([\s\S]*?)<\/div>/i)?.[1]);
    const fallbackEndDate = [...String(html || '').slice(0, cardMatch.index).matchAll(/Auktionsende\s+am\s+(\d{1,2}\.\d{1,2}\.\d{4})/gi)].at(-1)?.[1];
    const endsAt = parseZhDate(block.match(/class="auction-ends-at-text"[\s\S]*?<\/div>\s*<div>([\s\S]*?)<\/div>/i)?.[1], fallbackEndDate);
    const detailUrl = new URL(cardMatch[1], detailBaseUrl).toString();
    const normalizedNumber = String(plate).replace(/\s+/g, '').toUpperCase();
    auctions.push({
      id: `${normalizedSourceKey.toLowerCase()}-${sourceRecordId}`,
      sourceKey: normalizedSourceKey,
      sourceRecordId,
      canton,
      platePrefix: normalizedPlatePrefix,
      plateNumber: normalizedNumber,
      normalizedPlate: `${normalizedPlatePrefix}${normalizedNumber}`,
      listingType: 'auction',
      vehicleType: parseZhVehicleType(block),
      auctionStatus,
      ...(currentBidChf !== undefined ? { currentBidChf } : {}),
      ...(bidCount !== undefined ? { bidCount } : {}),
      ...(endsAt ? { endsAt } : {}),
      officialAuctionUrl,
      officialDetailUrl: detailUrl,
      sourceFetchedAt: fetchedAt,
      lastVerifiedAt: fetchedAt,
      firstSeenAt: fetchedAt,
      lastSeenAt: fetchedAt,
      dataConfidence: 'partial',
      rawSnapshotHash: createHash('sha1').update(block.trim()).digest('hex').slice(0, 12),
    });
  }
  return auctions;
}

function fetchHttpsText(url, { timeoutMs, userAgent, ca, accept, redirectsRemaining = 4 } = {}) {
  return new Promise((resolve, reject) => {
    const request = https.request(url, {
      method: 'GET',
      headers: {
        Accept: accept || 'text/html,application/xhtml+xml',
        'User-Agent': userAgent || process.env.JOBS_CRAWLER_USER_AGENT || 'FrontaliereTicinoBot/1.0',
      },
      ca: [...tls.rootCertificates, ca].join('\n'),
    }, (response) => {
      const chunks = [];
      response.setEncoding('utf8');
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('error', reject);
      response.on('end', () => {
        const status = response.statusCode || 0;
        if (status >= 300 && status < 400 && response.headers.location && redirectsRemaining > 0) {
          resolve(fetchHttpsText(new URL(response.headers.location, url), {
            timeoutMs,
            userAgent,
            ca,
            accept,
            redirectsRemaining: redirectsRemaining - 1,
          }));
          return;
        }
        if (status < 200 || status >= 300) {
          const error = new Error(`HTTP ${status} from ${url}`);
          error.retryable = status === 408 || status === 425 || status === 429 || status >= 500;
          reject(error);
          return;
        }
        resolve(chunks.join(''));
      });
    });
    request.setTimeout(timeoutMs, () => {
      const error = new Error(`Timeout fetching ${url}`);
      error.retryable = true;
      request.destroy(error);
    });
    request.on('error', reject);
    request.end();
  });
}

export async function fetchHtml(url, { timeoutMs = 20000, userAgent, retries = 2, retryDelayMs = 750, ca, accept } = {}) {
  const maxRetries = Number.isInteger(retries) && retries >= 0 ? retries : 2;
  let lastError;

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      if (ca) return await fetchHttpsText(url, { timeoutMs, userAgent, ca, accept });
      const response = await fetch(url, {
        redirect: 'follow',
        headers: {
          Accept: accept || 'text/html,application/xhtml+xml',
          'User-Agent': userAgent || process.env.JOBS_CRAWLER_USER_AGENT || 'FrontaliereTicinoBot/1.0',
        },
        signal: controller.signal,
      });
      if (!response.ok) {
        const error = new Error(`HTTP ${response.status} from ${url}`);
        error.retryable = response.status === 408 || response.status === 425 || response.status === 429 || response.status >= 500;
        throw error;
      }
      return await response.text();
    } catch (error) {
      lastError = error;
      if (attempt >= maxRetries || error?.retryable === false) throw error;
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs * (2 ** attempt)));
    } finally {
      clearTimeout(timer);
    }
  }

  throw lastError;
}

export async function fetchJson(url, options = {}) {
  const body = await fetchHtml(url, { ...options, accept: 'application/json,text/plain;q=0.9,*/*;q=0.8' });
  try {
    return JSON.parse(body);
  } catch (error) {
    throw new Error(`Invalid JSON from ${url}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function extractPdfUrl(html, { baseUrl, pattern } = {}) {
  const hrefs = [...String(html || '').matchAll(/(?:href|data-href)\s*=\s*["']([^"']+)["']/gi)]
    .map((match) => match[1]
      .replace(/&amp;/gi, '&')
      .replace(/\\u0026/g, '&'))
    .map((href) => {
      try {
        return new URL(href, baseUrl).toString();
      } catch {
        return null;
      }
    })
    .filter((value) => value && (/(?:\.pdf(?:$|[?#])|\/download(?:$|[?#]))/i.test(value)));
  const matching = typeof pattern?.test === 'function'
    ? hrefs.find((href) => {
      pattern.lastIndex = 0;
      return pattern.test(href);
    })
    : undefined;
  // A configured pattern is a contract, not a ranking hint. Falling back to
  // the first PDF can silently feed the car parser with the motorcycle list
  // (or vice versa) after an upstream markup change. Callers that have a
  // deliberately verified fallback URL choose it explicitly.
  return typeof pattern?.test === 'function' ? matching : hrefs[0];
}

/**
 * Resolve the PDF a variant should read, from the live index page.
 *
 * Shared by both collectors on purpose: `scripts/plate-auctions/ingest.mjs`
 * (via connectors/fixed-price.mjs) and the Cloud Function in plateAuctions.js
 * each carried a literal copy of `extractPdfUrl(...) || variant.fallbackPdfUrl`,
 * so a fix to one silently left the other wrong.
 *
 * That `||` was the bug. `extractPdfUrl` returns nothing when a configured
 * pattern matches no href — its contract, not a ranking miss — and the `||`
 * turned that answer into a hardcoded URL. BS publishes one content-addressed
 * PDF per ISO week (`/original_file/<sha>/wuko-pw-<week>.pdf`), so its
 * hardcoded copy was pinned to the week it was captured: on 2026-09-19 it
 * answered HTTP 404 and the run reported `fetch_failed`, which was the LUCKY
 * outcome. A hashed asset that keeps answering 200 publishes a five-week-old
 * catalogue as current, with fresh timestamps and `status: active`, and nothing
 * downstream can tell. Measured the same day the live page served week 36 (car)
 * and week 35 (motorcycle) while the pinned URLs were weeks 35 and 33.
 *
 * A fallback is therefore only honoured when the config still vouches for it —
 * AI's `/download` and LU's `wunschschilder.pdf` are canonical evergreen paths
 * — and using one is logged, because a pattern that stopped matching is the
 * same signal that preceded the BS breakage.
 */
export function resolveVariantPdfUrl(variant, { sourceKey, pageUrl, indexHtml }) {
  const derived = variant.pdfUrlPattern
    ? extractPdfUrl(indexHtml, { baseUrl: pageUrl, pattern: variant.pdfUrlPattern })
    : null;
  const pdfUrl = derived || variant.fallbackPdfUrl;
  if (!pdfUrl) {
    throw new Error(`${sourceKey}: no PDF href matched ${variant.pdfUrlPattern} on ${pageUrl}`);
  }
  if (variant.pdfUrlPattern && !derived) {
    console.warn(`[plate-auctions:${sourceKey}] ${variant.pdfUrlPattern} matched no href on ${pageUrl}; falling back to the configured ${pdfUrl}`);
  }
  return pdfUrl;
}

async function extractPdfText(arrayBuffer) {
  const { extractText, getDocumentProxy } = await import('unpdf');
  const pdf = await getDocumentProxy(new Uint8Array(arrayBuffer));
  try {
    const merged = await extractText(pdf, { mergePages: true });
    let pages = [];
    try {
      const perPage = await extractText(pdf, { mergePages: false });
      pages = Array.isArray(perPage?.text) ? perPage.text.map((page) => String(page || '')) : [];
    } catch {
      pages = [];
    }
    const mergedText = String(merged?.text || '');
    return {
      text: mergedText || pages.join('\n'),
      pages,
      totalPages: Number(merged?.totalPages || pages.length || 0),
    };
  } finally {
    try {
      await pdf.destroy();
    } catch {
      // Some PDF backends do not expose destroy; extraction is still usable.
    }
  }
}

export async function fetchPdfText(url, {
  timeoutMs = 30000,
  userAgent,
  retries = 2,
  retryDelayMs = 750,
} = {}) {
  const maxRetries = Number.isInteger(retries) && retries >= 0 ? retries : 2;
  let lastError;
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, {
        redirect: 'follow',
        headers: {
          Accept: 'application/pdf,*/*;q=0.8',
          'User-Agent': userAgent || process.env.JOBS_CRAWLER_USER_AGENT || 'FrontaliereTicinoBot/1.0',
        },
        signal: controller.signal,
      });
      if (!response.ok) {
        const error = new Error(`HTTP ${response.status} from ${url}`);
        error.retryable = response.status === 408 || response.status === 425 || response.status === 429 || response.status >= 500;
        throw error;
      }
      return await extractPdfText(await response.arrayBuffer());
    } catch (error) {
      lastError = error;
      if (attempt >= maxRetries || error?.retryable === false) throw error;
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs * (2 ** attempt)));
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError;
}

/**
 * Ginevra: l'OCV pubblica su ge.ch, per ogni sessione d'asta, un PDF con i
 * numeri messi all'asta e la finestra della sessione («ce dès le 11 au 20 mai
 * 2026, 11h00»), senza prezzi né offerte. Le offerte stanno solo su Ricardo,
 * che non si legge mai: challenge Cloudflare, robots.txt che esclude
 * /online-shop/, AGB 3.2/3.7 che vietano script e riuso delle offerte. Da
 * ge.ch si estraggono solo fatti (numeri, date) e si linka il PDF, senza
 * ripubblicarlo.
 *
 * Le liste escono ~2,5-4 settimane prima della sessione (primavera e
 * autunno). Righe solo mentre la sessione è futura o in corso; dopo la fine
 * il collector riceve il catalogo esplicitamente vuoto, come eCari fra due
 * aste.
 */
export const GE_PLATE_AUCTION_SOURCE = Object.freeze({
  canton: 'Ginevra',
  plateCode: 'GE',
  pageUrl: 'https://www.ge.ch/plaques/vente-aux-encheres-plaques',
  // I due slug delle liste OCV presenti nella sitemap di ge.ch il 2026-09-25:
  // maggio 2026 (documento 22794) e novembre 2025 (documento 15062). Durante
  // una sessione la pagina d'asta linka anche la lista corrente (/node/<id>).
  listDocumentUrls: Object.freeze([
    'https://www.ge.ch/document/liste-numeros-plaques-mis-aux-encheres',
    'https://www.ge.ch/document/liste-plaques-aux-encheres',
  ]),
  // Solo link, mai richiesto.
  auctionUrl: 'https://www.ricardo.ch/fr/shop/ENCHERES-PLAQUES-GE/offers/',
  parserVersion: 'ge-pdf-1.0.0',
});

const FRENCH_MONTHS = {
  janvier: 1, fevrier: 2, février: 2, mars: 3, avril: 4, mai: 5, juin: 6, juillet: 7,
  aout: 8, août: 8, septembre: 9, octobre: 10, novembre: 11, decembre: 12, décembre: 12,
};

function frenchMonth(value) {
  return FRENCH_MONTHS[String(value || '').toLowerCase()];
}

function decodeHtmlAttribute(value) {
  return String(value || '').replace(/&amp;/gi, '&').replace(/&#0?39;/g, "'");
}

/**
 * Link alle liste dalla pagina d'asta: a sessione annunciata la pagina scrive
 * «Liste des numéros proposés à la vente» verso /node/<id> (misurato nella
 * copia Wayback del 2026-05-17); uno slug /document/…liste…plaques… vale
 * uguale. Il testo o lo slug decidono, non la posizione nella pagina.
 */
export function extractGeListDocumentUrls(html, { baseUrl = GE_PLATE_AUCTION_SOURCE.pageUrl } = {}) {
  const urls = [];
  for (const match of String(html || '').matchAll(/<a\b[^>]*\bhref\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    const href = decodeHtmlAttribute(match[1]);
    const text = htmlText(match[2]);
    const isList = /liste\s+des\s+num[ée]ros/i.test(text)
      || /\/document\/[^/?#]*liste[^/?#]*plaques/i.test(href);
    if (!isList || /telecharger/i.test(href)) continue;
    try {
      const url = new URL(href, baseUrl);
      if (url.hostname !== 'www.ge.ch') continue;
      if (!urls.includes(url.toString())) urls.push(url.toString());
    } catch {
      // href non valido: non è una lista.
    }
  }
  return urls;
}

/**
 * Da una pagina documento di ge.ch: il PDF (/document/<id>/telecharger), la
 * data di aggiornamento (`og:updated_time`, altrimenti `<meta name="date">`)
 * e il titolo. Undefined se la pagina non è una lista di plaques aux enchères.
 */
export function parseGeListDocumentPage(html, { baseUrl } = {}) {
  const source = String(html || '');
  const title = htmlText(source.match(/<title>([\s\S]*?)<\/title>/i)?.[1]);
  if (!/plaques/i.test(title) || !/ench[èe]res/i.test(title)) return undefined;
  const href = source.match(/href\s*=\s*["']([^"']*\/document\/\d+\/telecharger)["']/i)?.[1];
  if (!href) return undefined;
  const updated = source.match(/<meta\s+property="og:updated_time"\s+content="([^"]+)"/i)?.[1]
    || source.match(/<meta\s+name="date"\s+content="([^"]+)"/i)?.[1];
  const updatedMs = Date.parse(String(updated || '').replace(/([+-]\d{2})(\d{2})$/, '$1:$2'));
  return {
    title,
    pdfUrl: new URL(decodeHtmlAttribute(href), baseUrl || GE_PLATE_AUCTION_SOURCE.pageUrl).toString(),
    updatedAt: Number.isFinite(updatedMs) ? new Date(updatedMs).toISOString() : undefined,
  };
}

/**
 * «ce dès le 11 au 20 mai 2026, 11h00» → inizio e fine in UTC (Europe/Zurich).
 * Il PDF dà l'ora solo per la chiusura: l'inizio è la mezzanotte del giorno
 * indicato, così una riga non resta «upcoming» il giorno in cui si può già
 * offrire. Senza ora di chiusura vale la fine della giornata.
 */
export function parseGeAuctionSessionWindow(value) {
  const text = sourceText(value).replace(/\s+/g, ' ');
  const match = text.match(/(?:d[èe]s\s+le|du)\s+(\d{1,2})(?:er)?(?:\s+([a-zà-ÿ]+))?(?:\s+(\d{4}))?\s+au\s+(\d{1,2})(?:er)?\s+([a-zà-ÿ]+)\s+(\d{4})(?:\s*,?\s*(\d{1,2})\s*h\s*(\d{2})?)?/i);
  if (!match) return undefined;
  const endMonth = frenchMonth(match[5]);
  const startMonth = match[2] ? frenchMonth(match[2]) : endMonth;
  if (!endMonth || !startMonth) return undefined;
  const endYear = Number(match[6]);
  const startYear = match[3] ? Number(match[3]) : (startMonth > endMonth ? endYear - 1 : endYear);
  const endHour = match[7] !== undefined ? Number(match[7]) : 23;
  const endMinute = match[7] !== undefined ? Number(match[8] || 0) : 59;
  const startsAt = zurichLocalToUtcIso(startYear, startMonth, Number(match[1]), 0, 0, 0);
  const endsAt = zurichLocalToUtcIso(endYear, endMonth, Number(match[4]), endHour, endMinute, 0);
  if (Date.parse(startsAt) >= Date.parse(endsAt)) return undefined;
  return { startsAt, endsAt, label: match[0] };
}

/**
 * Numeri in vendita dal punto 8 della lista: «GE 6226» (auto), «Moto GE 2570»,
 * «Lot plaques voiture et moto GE 100069» (stesso numero per auto e moto).
 */
export function parseGeAuctionListEntries(value) {
  const text = sourceText(value).replace(/\s+/g, ' ');
  const start = text.search(/seront\s+propos[ée]s\s+aux\s+ench[èe]res/i);
  if (start < 0) return [];
  const rest = text.slice(start);
  const end = rest.search(/\(format\s+de\s+la\s+plaque|\s9\.\s/i);
  const section = end > 0 ? rest.slice(0, end) : rest;
  const entries = [];
  const seen = new Set();
  for (const match of section.matchAll(/(Lot\s+plaques\s+voiture\s+et\s+moto\s+|Moto\s+)?GE\s+(\d{1,6})\b/gi)) {
    const kind = !match[1] ? 'car' : /^lot/i.test(match[1]) ? 'lot' : 'motorcycle';
    const key = `${kind}-${match[2]}`;
    if (seen.has(key)) continue;
    seen.add(key);
    entries.push({ kind, plateNumber: match[2], raw: match[0].trim() });
  }
  return entries;
}

/**
 * Righe della lista GE per la sessione del PDF, oppure il catalogo
 * esplicitamente vuoto se la sessione è già finita. Un PDF senza finestra o
 * senza numeri è un errore: non si confonde con «nessuna asta».
 *
 * @param {unknown} value testo del PDF (stringa o `{ text, pages }` di fetchPdfText)
 * @param {{ pdfUrl?: string, fetchedAt?: string, now?: Date }} [options]
 */
export function parseGePlateAuctionListPdfText(value, {
  pdfUrl,
  fetchedAt = new Date().toISOString(),
  now = new Date(fetchedAt),
} = {}) {
  const session = parseGeAuctionSessionWindow(value);
  if (!session) throw new Error('GE: the auction list has no parsable session window');
  const entries = parseGeAuctionListEntries(value);
  if (entries.length === 0) throw new Error('GE: the auction list has no plate numbers');
  const nowMs = now.getTime();
  if (nowMs >= Date.parse(session.endsAt)) return explicitlyEmptyCatalogue();
  const { canton, plateCode, auctionUrl } = GE_PLATE_AUCTION_SOURCE;
  const sessionKey = session.endsAt.slice(0, 10).replace(/-/g, '');
  const auctionStatus = nowMs < Date.parse(session.startsAt) ? 'upcoming' : 'active';
  return entries.map(({ kind, plateNumber, raw }) => {
    const suffix = kind === 'car' ? plateNumber : `${kind}-${plateNumber}`;
    const sourceRecordId = `${sessionKey}-${suffix}`;
    return {
      id: `${plateCode.toLowerCase()}-${sourceRecordId}`,
      sourceKey: plateCode,
      sourceRecordId,
      canton,
      platePrefix: plateCode,
      plateNumber,
      normalizedPlate: `${plateCode}${plateNumber}`,
      listingType: 'auction',
      vehicleType: kind === 'car' ? 'car' : kind === 'motorcycle' ? 'motorcycle' : 'other',
      auctionStatus,
      startsAt: session.startsAt,
      endsAt: session.endsAt,
      officialAuctionUrl: auctionUrl,
      ...(pdfUrl ? { officialDetailUrl: pdfUrl } : {}),
      sourceFetchedAt: fetchedAt,
      lastVerifiedAt: fetchedAt,
      firstSeenAt: fetchedAt,
      lastSeenAt: fetchedAt,
      sourceCategory: kind === 'lot' ? 'official-auction-list-lot-car-motorcycle' : 'official-auction-list',
      // Numero e date ufficiali, ma nessun prezzo né offerta: mai `verified`.
      dataConfidence: 'partial',
      rawSnapshotHash: createHash('sha1').update(`${session.label}:${raw}`).digest('hex').slice(0, 12),
    };
  });
}

/**
 * Pagina d'asta → liste candidate → la più recente → PDF → righe. Solo ge.ch:
 * `auctionUrl` (Ricardo) non viene mai richiesto. `injectedFetcher` segue la
 * firma dei connettori a prezzo fisso della Cloud Function.
 *
 * @param {{ fetchedAt?: string, now?: Date, injectedFetcher?: (url: string, options?: Record<string, unknown>) => Promise<any> }} [options]
 */
export async function fetchGePlateAuctions({
  fetchedAt = new Date().toISOString(),
  now = new Date(fetchedAt),
  injectedFetcher,
} = {}) {
  const source = GE_PLATE_AUCTION_SOURCE;
  const readHtml = (url) => (injectedFetcher
    ? injectedFetcher(url, { responseType: 'html', timeoutMs: 20000 })
    : fetchHtml(url));
  const auctionPage = await readHtml(source.pageUrl);
  const candidates = [...new Set([
    ...extractGeListDocumentUrls(auctionPage, { baseUrl: source.pageUrl }),
    ...source.listDocumentUrls,
  ])];
  const documents = [];
  const failures = [];
  for (const url of candidates) {
    try {
      const document = parseGeListDocumentPage(await readHtml(url), { baseUrl: url });
      if (document) documents.push(document);
      else failures.push(`${url}: not a plate-auction list`);
    } catch (error) {
      failures.push(`${url}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const newest = documents
    .filter((document, index) => documents.findIndex((other) => other.pdfUrl === document.pdfUrl) === index)
    .sort((a, b) => (Date.parse(b.updatedAt || '') || 0) - (Date.parse(a.updatedAt || '') || 0))[0];
  if (!newest) throw new Error(`GE: no plate-auction list found (${failures.join('; ') || 'no candidate'})`);
  const pdf = injectedFetcher
    ? await injectedFetcher(newest.pdfUrl, { responseType: 'pdf-text', timeoutMs: 30000 })
    : await fetchPdfText(newest.pdfUrl);
  return parseGePlateAuctionListPdfText(pdf, { pdfUrl: newest.pdfUrl, fetchedAt, now });
}
