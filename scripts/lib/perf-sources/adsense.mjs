// AdSense fetcher — daily revenue for the `blog-articles` URL channel.
// AdSense Reporting API doesn't expose UTM dimensions; the `blog-articles`
// channel is the closest per-feature attribution we have. Total revenue is
// distributed per article URL by GSC clicks / GA4 pageviews share at a
// later stage; here we just pull total CHF for the window.

import { windowDates } from './safe.mjs';

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
 * Pull the URL-channel breakdown for the article cluster. Returns
 * { rows, totalRevenue, perChannel: Map<channelName, revenue> }.
 *
 * Per-URL distribution happens in the orchestrator (via pageview share).
 */
export async function fetchAdsenseChannelRevenue({
  windowDays = 30,
  channelHints = ['blog', 'article'],
  fetchImpl = fetch,
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
  const params = new URLSearchParams();
  params.append('dateRange', 'CUSTOM');
  params.append('startDate.year', start.slice(0, 4));
  params.append('startDate.month', String(Number(start.slice(5, 7))));
  params.append('startDate.day', String(Number(start.slice(8, 10))));
  params.append('endDate.year', end.slice(0, 4));
  params.append('endDate.month', String(Number(end.slice(5, 7))));
  params.append('endDate.day', String(Number(end.slice(8, 10))));
  params.append('metrics', 'ESTIMATED_EARNINGS');
  params.append('dimensions', 'URL_CHANNEL_NAME');

  const url = `https://adsense.googleapis.com/v2/${acct}/reports:generate?${params}`;
  const res = await fetchImpl(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`adsense report ${res.status}: ${await res.text()}`);
  const data = await res.json();

  /** @type {Map<string, number>} */
  const perChannel = new Map();
  let totalRevenue = 0;
  for (const r of data.rows || []) {
    const name = (r.cells?.[0]?.value || '').toLowerCase();
    const revenue = Number(r.cells?.[1]?.value || 0);
    perChannel.set(name, revenue);
    if (channelHints.some((h) => name.includes(h))) {
      totalRevenue += revenue;
    }
  }
  return { rows: (data.rows || []).length, totalRevenue: Number(totalRevenue.toFixed(2)), perChannel };
}
