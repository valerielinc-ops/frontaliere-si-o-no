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
//     3. Checks the response against totalMatchedRows so a truncated report
//        cannot masquerade as a complete population.
//   The orchestrator still distributes `totalRevenue` per article URL via
//   GA4/PostHog/GSC pageview share — that's the only mechanism AdSense's
//   reporting model permits.

import { windowDates } from './safe.mjs';
import { ADSENSE_REPORT_MAX_ROWS, adsenseReportCoverage } from '../adsense-report-coverage.mjs';

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

/** Fetch the single reports.generate response, including totalMatchedRows. */
async function fetchReport({ acct, params, token, fetchImpl }) {
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
  params.append('limit', String(ADSENSE_REPORT_MAX_ROWS));
  return params;
}

/**
 * Pull the URL-channel breakdown for the article cluster in one report.
 * Returns a stable object shape that the orchestrator and tests rely on:
 *   {
 *     rows: number,                  // actual row count returned
 *     pages: number,                 // number of report responses (one)
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

  const data = await fetchReport({ acct, params: buildBaseParams({ start, end }), token, fetchImpl });
  const allRows = Array.isArray(data?.rows) ? data.rows : [];
  const pages = 1; // Retained for existing report consumers.
  const coverage = adsenseReportCoverage(data);
  const { truncated } = coverage;
  const currencyCode = data?.headers?.find((header) => header.name === 'ESTIMATED_EARNINGS')?.currencyCode || null;
  const warnings = Array.isArray(data?.warnings) ? data.warnings.map(String) : [];
  if (!coverage.complete) log(`[adsense] incomplete report: ${coverage.returnedRows}/${coverage.totalMatchedRows ?? 'unknown'} rows`);

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
      `(revenue=${hintMatchedRevenue.toFixed(2)} of ${totalAcrossAllChannels.toFixed(2)} ${currencyCode || 'currency unknown'}); ` +
      `dropped=${droppedMalformed}${truncated ? ' [TRUNCATED]' : ''}`,
  );

  return {
    rows: allRows.length,
    pages,
    currencyCode,
    warnings,
    revenueScope: matchedHints ? 'matched_url_channels' : 'all_url_channels_fallback',
    coverage: { ...coverage, complete: coverage.complete && droppedMalformed === 0 },
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
