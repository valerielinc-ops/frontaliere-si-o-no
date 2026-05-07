// AdSense fetcher — daily revenue for the `blog-articles` URL channels.
//
// Architectural note (2026-05-07):
//   AdSense Reporting API v2 does NOT expose a per-page-URL dimension. The
//   closest dimensions for per-content attribution are:
//     - URL_CHANNEL_NAME  — bucket-level (max 500 channels per account)
//     - AD_UNIT_NAME      — per ad slot, not per page
//   We therefore query DATE × URL_CHANNEL_NAME to get a richer time-series
//   row set (one row per day per channel) instead of a single aggregate per
//   channel. This:
//     1. Makes the `rows` count in `data/article-performance.json` a
//        meaningful diagnostic (e.g. 30 days × N channels = ~30..500 rows
//        instead of the previous "= number of active channels" misleader).
//     2. Lets future code surface daily revenue trends without re-querying.
//     3. Triggers the API's pagination path (nextPageToken) which we now
//        exhaust with a defensive cap.
//   The orchestrator still distributes `totalRevenue` per article URL via
//   GA4/PostHog/GSC pageview share — that's the only mechanism AdSense's
//   reporting model permits.

import { windowDates } from './safe.mjs';

// Defensive cap — AdSense in practice returns far fewer rows than this for
// our window/dimensions, but we never want an infinite loop on a malformed
// nextPageToken from the API.
const MAX_ROWS = 100_000;

// Page size hint to the API. AdSense honours up to 50,000 per call but
// we keep this low-ish for predictable memory + clearer logging at scale.
const PAGE_SIZE = 5000;

// Default no-op logger; tests inject a vi.fn() to assert log shape, and the
// production caller picks up the real console.log via the default below.
const defaultLogger = (msg) => console.log(msg);

async function refreshAccessToken({ clientId, clientSecret, refreshToken, fetchImpl = fetch }) {
  const res = await fetchImpl('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }),
  });
  if (!res.ok) throw new Error(`adsense token ${res.status}: ${await res.text()}`);
  return (await res.json()).access_token;
}

/**
 * Fetch one page of the AdSense report. Returns the raw JSON body so the
 * caller can inspect both `rows` and `nextPageToken`.
 */
async function fetchReportPage({ acct, params, token, fetchImpl }) {
  const url = `https://adsense.googleapis.com/v2/${acct}/reports:generate?${params}`;
  const res = await fetchImpl(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`adsense report ${res.status}: ${await res.text()}`);
  return res.json();
}

function buildBaseParams({ start, end }) {
  const params = new URLSearchParams();
  params.append('dateRange', 'CUSTOM');
  params.append('startDate.year', start.slice(0, 4));
  params.append('startDate.month', String(Number(start.slice(5, 7))));
  params.append('startDate.day', String(Number(start.slice(8, 10))));
  params.append('endDate.year', end.slice(0, 4));
  params.append('endDate.month', String(Number(end.slice(5, 7))));
  params.append('endDate.day', String(Number(end.slice(8, 10))));
  params.append('metrics', 'ESTIMATED_EARNINGS');
  // DATE first so rows come back ordered by day; URL_CHANNEL_NAME second
  // so each (day, channel) pair is a distinct row.
  params.append('dimensions', 'DATE');
  params.append('dimensions', 'URL_CHANNEL_NAME');
  params.append('limit', String(PAGE_SIZE));
  return params;
}

/**
 * Pull the URL-channel breakdown for the article cluster, paginated.
 * Returns a stable object shape that the orchestrator and tests rely on:
 *   {
 *     rows: number,                  // actual row count returned (post-pagination)
 *     pages: number,                 // how many API pages we walked
 *     totalRevenue: number,          // hint-matched revenue (or all-channels fallback)
 *     hintMatchedRevenue: number,
 *     totalAcrossAllChannels: number,
 *     matchedHints: boolean,
 *     matchedChannelNames: string[],
 *     perChannel: { [name]: number }
 *   }
 *
 * Per-URL distribution happens in the orchestrator (via pageview share).
 */
export async function fetchAdsenseChannelRevenue({
  windowDays = 30,
  // Order matters — first match wins for 'matchedChannelNames' display.
  // 'articoli' is the Italian path segment for /articoli-frontaliere/* (blog).
  // English 'article' is included for any future English-named channels.
  channelHints = ['articoli', 'blog', 'article'],
  fetchImpl = fetch,
  log = defaultLogger,
} = {}) {
  const refreshToken = process.env.ADSENSE_REFRESH_TOKEN;
  if (!refreshToken) throw new Error('no ADSENSE_REFRESH_TOKEN');
  const clientId = process.env.ADSENSE_CLIENT_ID || process.env.GSC_CLIENT_ID;
  const clientSecret = process.env.ADSENSE_CLIENT_SECRET || process.env.GSC_CLIENT_SECRET;
  if (!clientId || !clientSecret) throw new Error('no ADSENSE_CLIENT_ID/SECRET');

  const token = await refreshAccessToken({ clientId, clientSecret, refreshToken, fetchImpl });

  const acctRes = await fetchImpl('https://adsense.googleapis.com/v2/accounts', {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!acctRes.ok) throw new Error(`adsense accounts ${acctRes.status}: ${await acctRes.text()}`);
  const acct = (await acctRes.json()).accounts?.[0]?.name;
  if (!acct) throw new Error('no AdSense account');

  const { start, end } = windowDates(windowDays);
  log(`[adsense] querying ${acct} window=${start}..${end} (${windowDays}d) dims=DATE,URL_CHANNEL_NAME`);

  // Walk every page of results until nextPageToken is empty or we hit MAX_ROWS.
  /** @type {Array<{ cells?: Array<{ value?: string }> }>} */
  const allRows = [];
  let pages = 0;
  let nextPageToken = '';
  let truncated = false;

  // Defensive: bound the loop by an explicit page cap that mirrors MAX_ROWS,
  // so a buggy server that always returns the same token can't spin forever.
  const MAX_PAGES = Math.ceil(MAX_ROWS / PAGE_SIZE) + 5;

  while (pages < MAX_PAGES) {
    const params = buildBaseParams({ start, end });
    if (nextPageToken) params.append('pageToken', nextPageToken);
    const data = await fetchReportPage({ acct, params, token, fetchImpl });
    pages += 1;
    const pageRows = Array.isArray(data?.rows) ? data.rows : [];
    if (allRows.length + pageRows.length > MAX_ROWS) {
      // Take only the slice that fits, then stop.
      const remaining = MAX_ROWS - allRows.length;
      if (remaining > 0) allRows.push(...pageRows.slice(0, remaining));
      truncated = true;
      log(`[adsense] page ${pages}: ${pageRows.length} rows (truncated at MAX_ROWS=${MAX_ROWS})`);
      break;
    }
    allRows.push(...pageRows);
    log(`[adsense] page ${pages}: ${pageRows.length} rows (total so far: ${allRows.length})`);
    nextPageToken = typeof data?.nextPageToken === 'string' ? data.nextPageToken : '';
    if (!nextPageToken) break;
  }

  if (pages === MAX_PAGES && nextPageToken) {
    truncated = true;
    log(`[adsense] WARN — reached MAX_PAGES=${MAX_PAGES} with token still present; truncating`);
  }

  // Aggregate: per-channel revenue (summed across all DATE rows).
  /** @type {Map<string, number>} */
  const perChannel = new Map();
  let droppedMalformed = 0;
  for (const r of allRows) {
    // Row shape: cells[0] = DATE, cells[1] = URL_CHANNEL_NAME, cells[2] = ESTIMATED_EARNINGS.
    const cells = Array.isArray(r?.cells) ? r.cells : null;
    if (!cells || cells.length < 3) {
      droppedMalformed += 1;
      continue;
    }
    const name = String(cells[1]?.value ?? '').toLowerCase();
    const revenueRaw = cells[2]?.value;
    const revenue = Number(revenueRaw);
    if (!Number.isFinite(revenue)) {
      droppedMalformed += 1;
      continue;
    }
    perChannel.set(name, (perChannel.get(name) || 0) + revenue);
  }

  // Hint matching: same logic as before — consumer-facing channel filter.
  let hintMatchedRevenue = 0;
  let totalAcrossAllChannels = 0;
  const matchedChannelNames = [];
  for (const [name, revenue] of perChannel.entries()) {
    totalAcrossAllChannels += revenue;
    if (channelHints.some((h) => name.includes(h))) {
      hintMatchedRevenue += revenue;
      matchedChannelNames.push(name);
    }
  }

  // If user-provided channelHints didn't match anything (or matched 0 revenue
  // while other channels DO have revenue), fall back to summing ALL URL
  // channels. We surface both numbers so the orchestrator can decide and
  // the consumer can see exactly what AdSense returned.
  const matchedHints = matchedChannelNames.length > 0 && hintMatchedRevenue > 0;
  const totalRevenue = matchedHints ? hintMatchedRevenue : totalAcrossAllChannels;

  log(
    `[adsense] aggregated ${allRows.length} rows in ${pages} page(s); ` +
      `${perChannel.size} channels; matched=${matchedChannelNames.length} ` +
      `(revenue=${hintMatchedRevenue.toFixed(2)} of ${totalAcrossAllChannels.toFixed(2)} CHF); ` +
      `dropped=${droppedMalformed}${truncated ? ' [TRUNCATED]' : ''}`,
  );

  return {
    rows: allRows.length,
    pages,
    truncated,
    droppedMalformed,
    totalRevenue: Number(totalRevenue.toFixed(2)),
    hintMatchedRevenue: Number(hintMatchedRevenue.toFixed(2)),
    totalAcrossAllChannels: Number(totalAcrossAllChannels.toFixed(2)),
    matchedHints,
    matchedChannelNames,
    perChannel: Object.fromEntries(
      [...perChannel.entries()].map(([k, v]) => [k, Number(v.toFixed(2))]),
    ),
  };
}
