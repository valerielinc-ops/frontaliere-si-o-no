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

function fetchHttpsText(url, { timeoutMs, userAgent, ca, redirectsRemaining = 4 } = {}) {
  return new Promise((resolve, reject) => {
    const request = https.request(url, {
      method: 'GET',
      headers: {
        Accept: 'text/html,application/xhtml+xml',
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

export async function fetchHtml(url, { timeoutMs = 20000, userAgent, retries = 2, retryDelayMs = 750, ca } = {}) {
  const maxRetries = Number.isInteger(retries) && retries >= 0 ? retries : 2;
  let lastError;

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      if (ca) return await fetchHttpsText(url, { timeoutMs, userAgent, ca });
      const response = await fetch(url, {
        redirect: 'follow',
        headers: {
          Accept: 'text/html,application/xhtml+xml',
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
