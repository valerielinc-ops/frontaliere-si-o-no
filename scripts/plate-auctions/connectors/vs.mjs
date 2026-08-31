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
 * All three tabs — "Enchères en cours" (tabContent1), "Inscription pour les
 * futures enchères" (tabContent2) and "Plaques souhaitées" (tabContent4) —
 * are public: re-verified in issue #6801 (follow-up of #6775), which had
 * originally (wrongly) declared tab2/tab4 as requiring an authenticated
 * account. The site is a classic server-rendered tab widget: a single fetch
 * of `VS_AUCTION_URL` returns ALL tab panels in one HTML document, with only
 * the active one visible (`display:none` on the rest) — `curl`-ing
 * `ui/app/changeTab/app?tabNumber=2` with a session cookie confirms tab2/4
 * respond with their own `tabNumber` state and no redirect to a login page.
 * tab2/tab4 currently render "Plaques indisponibles" (no entries) rather
 * than being blocked, so `parseVsAuctionRows` legitimately returns zero rows
 * for them until eCari actually lists something there.
 */
import { createHash } from 'node:crypto';

export const VS_CANTON = 'Vallese';
export const VS_PLATE_CODE = 'VS';
export const VS_AUCTION_URL = 'https://ecari.vs.ch/ecari-auction/';

/**
 * The three tabs with a visible nav entry on the VS eCari page (tab3 exists
 * in the markup but has no nav link and is not user-reachable). Each panel
 * is scraped with the same row parser — the site reuses one table component
 * across tabs, so a not-yet-observed real row in tab2/4 is expected to use
 * the same `<tr class="L" style=...>` markup as tab1's "Enchères en cours".
 */
const VS_TAB_SECTIONS = [
  { tabContentId: 'tabContent1', auctionStatus: 'active', idPrefix: 'vs' },
  { tabContentId: 'tabContent2', auctionStatus: 'upcoming', idPrefix: 'vs-future' },
  { tabContentId: 'tabContent4', auctionStatus: 'upcoming', idPrefix: 'vs-wanted' },
];

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
 * Extracts a single tab panel's HTML out of the full VS eCari page. Panels
 * are rendered as sibling `<div id="tabContentN">` blocks with no nesting
 * between them, so a lazy scan up to the next `tabContent` div (or EOF) is
 * enough to isolate one tab's rows from the others without an HTML parser.
 * Returns `''` when the id is not found (e.g. a trimmed test fixture).
 */
export function extractTabSection(html, tabContentId) {
  const re = new RegExp(`<div id="${tabContentId}"[\\s\\S]*?(?=<div id="tabContent\\d+"|$)`);
  const match = html.match(re);
  return match ? match[0] : '';
}

/**
 * Parses an auction-rows table out of a VS eCari HTML fragment into
 * `PlateAuction`-shaped objects (see `services/plateAuctions/types.ts`).
 * Pure function — no network — so it is unit-testable against a saved
 * fixture (`tests/fixtures/vs-ecari-auction-sample.html`). `auctionStatus`
 * and `idPrefix` let the same parser cover tabs beyond "Enchères en cours"
 * (see `VS_TAB_SECTIONS`) — a tab with no matching rows (e.g. today's empty
 * "Plaques indisponibles" tab2/tab4) legitimately yields `[]`, not an error.
 */
export function parseVsAuctionRows(
  html,
  { fetchedAt = new Date().toISOString(), auctionStatus = 'active', idPrefix = 'vs' } = {},
) {
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
      id: `${idPrefix}-${idMatch[1]}`,
      canton: VS_CANTON,
      platePrefix: VS_PLATE_CODE,
      plateNumber,
      normalizedPlate: `${VS_PLATE_CODE}${plateNumber}`,
      vehicleType: 'car',
      auctionStatus,
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
 * Fetches the live VS eCari page and returns auctions from all public tabs
 * (`VS_TAB_SECTIONS`) as `PlateAuction[]`. The entry URL redirects through a
 * session-bootstrap chain (`fetch` with `redirect: 'follow'` handles it in
 * one call, no manual cookie jar needed — verified against the live site in
 * #6358) and the single response already embeds every tab panel, so one
 * fetch is enough to cover tab1/tab2/tab4 (#6801).
 */
export async function fetchVsPlateAuctions() {
  const html = await fetchPage(VS_AUCTION_URL);
  const fetchedAt = new Date().toISOString();
  return VS_TAB_SECTIONS.flatMap(({ tabContentId, auctionStatus, idPrefix }) =>
    parseVsAuctionRows(extractTabSection(html, tabContentId), { fetchedAt, auctionStatus, idPrefix }),
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  fetchVsPlateAuctions()
    .then((auctions) => {
      console.log(JSON.stringify(auctions, null, 2));
      console.log(`\n${auctions.length} VS plate auction(s)/listing(s) found across tab1/tab2/tab4.`);
    })
    .catch((err) => {
      console.error('VS plate-auction fetch failed:', err);
      process.exitCode = 1;
    });
}
