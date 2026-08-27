#!/usr/bin/env node
/**
 * Vallese (VS) plate-auction connector — `ecari.vs.ch/ecari-auction/`.
 *
 * Verified in issue #6358 (follow-up of #4854 Fase 0): the Canton Valais
 * runs its "Enchères en cours" (current auctions) list on the same
 * white-label eCari platform used by Ticino (`carieauktion.ti.ch`, see
 * `docs/data-sources/aste-targhe-ticino.md`), but unlike TI the VS instance
 * server-renders the current-auctions table on the public entry page — no
 * login, no JSON/API endpoint. Root `/robots.txt` returns 503 because the
 * app is mounted only under `/ecari-auction/` (no separate crawl-block or
 * terms-of-use page gates this listing).
 *
 * Only the "Enchères en cours" tab (categorieID=1, car plates) is scraped:
 * "Inscription pour les futures enchères" and "Plaques souhaitées" require
 * an authenticated account and are out of scope.
 */
import { createHash } from 'node:crypto';

export const VS_CANTON = 'Vallese';
export const VS_PLATE_CODE = 'VS';
export const VS_AUCTION_URL = 'https://ecari.vs.ch/ecari-auction/';

const ROW_RE = /<tr class="L"\s+style="[^"]*">([\s\S]*?)<\/tr>/g;
const NUMBER_RE = /<div class="number">(\d+)<\/div>/;
const AMOUNT_RE = /<td class="amount">(\d+)<\/td>/g;
const CLOSING_TIME_RE = /<td class="closingTime"[^>]*>([^<]+)<\/td>/;
const BID_COUNT_RE = /<td class="closingTime"[^>]*>[^<]+<\/td>\s*<td>(\d+)<\/td>/;
const OPEN_DETAILS_RE = /openDetails\((\d+)\)/;
const ECARI_DATE_RE = /^(\d{4})\/(\d{2})\/(\d{2})\s+(\d{2}):(\d{2}):(\d{2})$/;

/**
 * Converts a "YYYY/MM/DD HH:mm:ss" eCari timestamp (site + registry
 * timezone is Europe/Zurich, DST-aware) into a UTC ISO string, without
 * pulling in a date-tz dependency.
 */
function zurichLocalToUtcIso(y, mo, d, h, mi, s) {
  const asUtcGuess = Date.UTC(y, mo - 1, d, h, mi, s);
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Europe/Zurich',
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const parts = Object.fromEntries(fmt.formatToParts(asUtcGuess).map((p) => [p.type, p.value]));
  const zurichAsUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second),
  );
  const offsetMs = zurichAsUtc - asUtcGuess;
  return new Date(asUtcGuess - offsetMs).toISOString();
}

function parseEcariDate(raw) {
  const m = raw.trim().match(ECARI_DATE_RE);
  if (!m) return undefined;
  const [, y, mo, d, h, mi, s] = m.map(Number);
  return zurichLocalToUtcIso(y, mo, d, h, mi, s);
}

/**
 * Parses the "Enchères en cours" table out of the VS eCari HTML into
 * `PlateAuction`-shaped objects (see `services/plateAuctions/types.ts`).
 * Pure function — no network — so it is unit-testable against a saved
 * fixture (`tests/fixtures/vs-ecari-auction-sample.html`).
 */
export function parseVsAuctionRows(html, { fetchedAt = new Date().toISOString() } = {}) {
  const auctions = [];
  ROW_RE.lastIndex = 0;
  let match;
  while ((match = ROW_RE.exec(html)) !== null) {
    const row = match[1];
    const numberMatch = row.match(NUMBER_RE);
    const idMatch = row.match(OPEN_DETAILS_RE);
    const closingMatch = row.match(CLOSING_TIME_RE);
    const amounts = [...row.matchAll(AMOUNT_RE)].map((m) => Number(m[1]));
    if (!numberMatch || !idMatch || !closingMatch || amounts.length < 3) continue;

    const plateNumber = numberMatch[1];
    const [, minimumIncrementChf, currentBidChf] = amounts;
    const bidCountMatch = row.match(BID_COUNT_RE);
    const endsAt = parseEcariDate(closingMatch[1]);

    auctions.push({
      id: `vs-${idMatch[1]}`,
      canton: VS_CANTON,
      platePrefix: VS_PLATE_CODE,
      plateNumber,
      normalizedPlate: `${VS_PLATE_CODE}${plateNumber}`,
      vehicleType: 'car',
      auctionStatus: 'active',
      currentBidChf,
      minimumIncrementChf,
      bidCount: bidCountMatch ? Number(bidCountMatch[1]) : undefined,
      endsAt,
      officialAuctionUrl: VS_AUCTION_URL,
      sourceFetchedAt: fetchedAt,
      lastVerifiedAt: fetchedAt,
      dataConfidence: 'partial',
      rawSnapshotHash: createHash('sha1').update(row.trim()).digest('hex').slice(0, 12),
    });
  }
  return auctions;
}

async function fetchPage(url) {
  const timeoutMs = Number(process.env.PLATE_AUCTION_FETCH_TIMEOUT_MS) || 20000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      headers: {
        Accept: 'text/html,application/xhtml+xml',
        'User-Agent':
          process.env.JOBS_CRAWLER_USER_AGENT ||
          'Mozilla/5.0 (compatible; FrontaliereTicinoBot/1.0; +https://frontaliereticino.ch/)',
      },
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fetches the live VS eCari page and returns the current auctions as
 * `PlateAuction[]`. The entry URL redirects through a session-bootstrap
 * chain (`fetch` with `redirect: 'follow'` handles it in one call, no
 * manual cookie jar needed — verified against the live site in #6358).
 */
export async function fetchVsPlateAuctions() {
  const html = await fetchPage(VS_AUCTION_URL);
  const fetchedAt = new Date().toISOString();
  return parseVsAuctionRows(html, { fetchedAt });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  fetchVsPlateAuctions()
    .then((auctions) => {
      console.log(JSON.stringify(auctions, null, 2));
      console.log(`\n${auctions.length} active VS plate auction(s) found.`);
    })
    .catch((err) => {
      console.error('VS plate-auction fetch failed:', err);
      process.exitCode = 1;
    });
}
