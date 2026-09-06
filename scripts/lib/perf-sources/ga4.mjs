// GA4 fetcher — runReport on `pagePath` dimension, filtered to exclude
// newsletter-sourced sessions (sessionMedium != 'newsletter').
//
// Auth: Firebase SA via GOOGLE_APPLICATION_CREDENTIALS (same as GSC).
// Property: GA4_PROPERTY_ID env (e.g. "properties/123456789" — accepts bare
// digits too, we prefix on the fly).

import { windowDates } from './safe.mjs';
import { engagementConsistency, fetchDailyEngagementVerdict } from '../ga4-engagement-reliability.mjs';

const SCOPES = ['https://www.googleapis.com/auth/analytics.readonly'];

async function getToken({ fetchImpl = fetch } = {}) {
  if (!process.env.GOOGLE_APPLICATION_CREDENTIALS && !process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    return null;
  }
  if (!process.env.GOOGLE_APPLICATION_CREDENTIALS && process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const os = await import('node:os');
    const tmp = path.join(os.tmpdir(), `firebase-sa-${process.pid}.json`);
    fs.writeFileSync(tmp, process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
    process.env.GOOGLE_APPLICATION_CREDENTIALS = tmp;
  }
  const { GoogleAuth } = await import('google-auth-library');
  const auth = new GoogleAuth({ scopes: SCOPES });
  const client = await auth.getClient();
  const { token } = await client.getAccessToken();
  return token;
}

function normalizePropertyId(raw) {
  if (!raw) return null;
  return raw.startsWith('properties/') ? raw : `properties/${raw}`;
}

/**
 * Fetch per-pagePath views/engagement, newsletter-excluded.
 * Returns { rows, perPath: Map<pathname, {pageviews, engagementRate, avgScrollProxy}>,
 *   engagement: {reliable, reason, unreliableDates} }
 *
 * `engagementRate` è annotato con `engagementReliable`/`engagementUnreliableReason`
 * (issue #6703): sui giorni non ancora elaborati GA4 riporta un engagement rate
 * che contraddice `averageSessionDuration`, e senza il flag il valore viaggia a
 * valle come se fosse buono.
 *
 * La contraddizione è però una proprietà del SINGOLO giorno: valutata sulla
 * finestra aggregata annega (28 giornate sane diluiscono la giornata in lag) e
 * il verdetto per-path tornava `reliable` proprio nel caso che #6703 vuole
 * intercettare. Si emette quindi una SECONDA richiesta aggregata per sola
 * `date` — ~`windowDays` righe, non `pagePath × date`, quindi nessuna
 * pressione sul `limit: 10000` — e il suo verdetto prevale su quello per-path
 * quando marca la finestra, come già fa `scripts/analytics-report.mjs` (#7511).
 */
export async function fetchGa4ByPage({ windowDays = 30, fetchImpl = fetch, getTokenImpl = getToken } = {}) {
  const propertyId = normalizePropertyId(process.env.GA4_PROPERTY_ID);
  if (!propertyId) throw new Error('no GA4_PROPERTY_ID');
  const token = await getTokenImpl({ fetchImpl });
  if (!token) throw new Error('no service-account token');

  const { start, end } = windowDates(windowDays);
  const url = `https://analyticsdata.googleapis.com/v1beta/${propertyId}:runReport`;

  // Filter: NOT (sessionMedium == "newsletter")
  // GA4 uses dimensionFilter with notExpression.
  const newsletterExcluded = {
    notExpression: {
      filter: {
        fieldName: 'sessionMedium',
        stringFilter: { value: 'newsletter', matchType: 'EXACT' },
      },
    },
  };

  const runReport = (body) =>
    fetchImpl(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

  const requestBody = {
    dateRanges: [{ startDate: start, endDate: end }],
    dimensions: [{ name: 'pagePath' }],
    metrics: [
      { name: 'screenPageViews' },
      { name: 'engagementRate' },
      { name: 'averageSessionDuration' },
    ],
    dimensionFilter: newsletterExcluded,
    limit: 10000,
  };

  const res = await runReport(requestBody);
  if (!res.ok) throw new Error(`ga4 ${res.status}: ${await res.text()}`);
  const data = await res.json();
  const rows = data.rows || [];

  const dailyEngagement = await fetchDailyEngagementVerdict({
    runReport,
    dateRanges: requestBody.dateRanges,
    dimensionFilter: newsletterExcluded,
  });

  const perPath = new Map();
  for (const r of rows) {
    const path = r.dimensionValues?.[0]?.value || '';
    if (!path.includes('/articoli-frontaliere/')) continue;
    const pageviews = Number(r.metricValues?.[0]?.value || 0);
    const engagement = Number(r.metricValues?.[1]?.value || 0);
    const avgDuration = Number(r.metricValues?.[2]?.value || 0);
    const engagementRate = Number.isFinite(engagement) ? engagement : null;
    const avgSessionDuration = Number.isFinite(avgDuration) ? avgDuration : null;
    const verdict = engagementConsistency({
      engagementRate,
      averageSessionDuration: avgSessionDuration,
      sampleSize: pageviews,
    });
    // Il verdetto per-giorno prevale: è l'aggregato di finestra a nascondere la
    // contraddizione, non a rivelarla. Quello per-path resta come secondo
    // canale, per quando la finestra è pulita.
    const effective = dailyEngagement.reliable ? verdict : dailyEngagement;
    perPath.set(path, {
      pageviews,
      engagementRate,
      avgSessionDuration,
      engagementReliable: effective.reliable,
      engagementUnreliableReason: effective.reason,
    });
  }
  return { rows: rows.length, perPath, engagement: dailyEngagement };
}
