#!/usr/bin/env node
/** Read-only, aggregate-only readout. No purchase is inferred from browser events. */
import { parseArgs } from 'node:util';
import { isInvokedDirectly } from '../lib/is-invoked-directly.mjs';
import { getServiceAccountToken, runGa4Report } from '../lib/ga4-service-account.mjs';
import { settledWindow } from '../lib/analytics-settled-window.mjs';
import { sanitizeHouseAdAttribution } from '../../functions/src/houseAdAttribution.js';

export function summarizeHouseTraffic(response) {
  if (Number(response?.rowCount || 0) > (response?.rows || []).length) throw new Error('GA4 report truncated; no partial totals');
  const groups = new Map();
  for (const row of response?.rows || []) {
    const [event, component, surface, device] = row.dimensionValues.map(v => v.value);
    const match = /^(control|time_saved|profile_match|in_control|swiss_work|next_chapter)_v1\.(test|fixed)\.(it|en|de|fr)$/.exec(component);
    if (!match || !['house_ad_impression', 'house_ad_click', 'house_ad_landing'].includes(event)) continue;
    const [format, ...placement] = surface.split('.');
    const key = JSON.stringify([match[1], match[2], match[3], format, placement.join('.'), device]);
    const group = groups.get(key) || { variant: match[1], enrolled: match[2] === 'test', locale: match[3], format, placement: placement.join('.'), device, impressions: 0, clicks: 0, landings: 0 };
    group[event === 'house_ad_click' ? 'clicks' : event === 'house_ad_landing' ? 'landings' : 'impressions'] += Number(row.metricValues[0]?.value || 0);
    groups.set(key, group);
  }
  return [...groups.values()].map(g => ({ ...g, ctr: g.impressions > 0 ? g.clicks / g.impressions : null }));
}

export function summarizeHouseOrders(services, startMs, endMs) {
  const groups = new Map();
  for (const service of services) {
    const created = service.createdAt?.toMillis?.() ?? 0;
    const a = sanitizeHouseAdAttribution(service.houseAdAttribution, created);
    if (!a || created < startMs || created >= endMs) continue;
    const key = JSON.stringify([a.variant, a.enrolled, a.locale, a.format, a.placement, a.device]);
    const group = groups.get(key) || { variant: a.variant, enrolled: a.enrolled, locale: a.locale, format: a.format, placement: a.placement, device: a.device, initiatedOrders: 0, confirmedPurchases: 0, refundedOrders: 0, confirmedRevenueEurCents: 0 };
    group.initiatedOrders++;
    if (service.paymentStatus === 'paid' && service.paidAt?.toMillis?.() > 0) {
      group.confirmedPurchases++;
      if (String(service.currency).toLowerCase() === 'eur') group.confirmedRevenueEurCents += Number(service.amountTotal) || 0;
    }
    if (service.paymentStatus === 'refunded') group.refundedOrders++;
    groups.set(key, group);
  }
  return [...groups.values()];
}

export async function runHouseAdReadout(argv = process.argv.slice(2)) {
  const { values } = parseArgs({ args: argv, options: { days: { type: 'string', default: '28' }, help: { type: 'boolean', default: false } }, strict: true });
  if (values.help) { console.log('Read-only: --days=28. Requires GOOGLE_APPLICATION_CREDENTIALS and GA4_PROPERTY_ID. Outputs aggregates only; no automatic winner or CVR across different measurement populations.'); return; }
  const days = Number(values.days);
  if (!Number.isInteger(days) || days < 1 || days > 90) throw new Error('--days must be 1..90');
  if (!process.env.GA4_PROPERTY_ID) throw new Error('GA4_PROPERTY_ID is required');
  const window = settledWindow({ days });
  const startMs = Date.parse(`${window.start}T00:00:00Z`);
  const endMs = Date.parse(`${window.end}T00:00:00Z`) + 86400000;
  const token = await getServiceAccountToken(['https://www.googleapis.com/auth/analytics.readonly']);
  const traffic = await runGa4Report({ token, body: {
    dateRanges: [{ startDate: window.start, endDate: window.end }],
    dimensions: [{ name: 'eventName' }, { name: 'customEvent:component' }, { name: 'customEvent:cta_surface' }, { name: 'deviceCategory' }],
    metrics: [{ name: 'eventCount' }],
    dimensionFilter: { filter: { fieldName: 'eventName', inListFilter: { values: ['house_ad_impression', 'house_ad_click', 'house_ad_landing'] } } },
    limit: 10000,
  } });
  const { initializeApp, applicationDefault, deleteApp } = await import('firebase-admin/app');
  const { getFirestore, Timestamp } = await import('firebase-admin/firestore');
  const app = initializeApp({ credential: applicationDefault(), projectId: 'frontaliere-ticino' }, 'house-ad-readout');
  try {
    const db = getFirestore(app); const services = []; let cursor;
    for (let page = 0; page < 11; page++) {
      let query = db.collection('application_concierge_services').where('createdAt', '>=', Timestamp.fromMillis(startMs)).where('createdAt', '<', Timestamp.fromMillis(endMs)).orderBy('createdAt').limit(1000);
      if (cursor) query = query.startAfter(cursor);
      const snapshot = await query.get();
      if (services.length + snapshot.size > 10000) throw new Error('Order report exceeds cap; shorten --days');
      services.push(...snapshot.docs.map(doc => doc.data()));
      if (snapshot.size < 1000) break;
      cursor = snapshot.docs.at(-1);
    }
    console.log(JSON.stringify({ experimentId: 'house_creatives_v1', window, observedAt: new Date().toISOString(),
      traffic: summarizeHouseTraffic(traffic), orderCohorts: summarizeHouseOrders(services, startMs, endMs),
      caveats: ['CTR uses observed Firebase/GA4 events and can be incomplete when telemetry is blocked.', 'Purchase totals use verified paymentStatus=paid and paidAt in the service ledger; refunds remain separate.', 'Orders are grouped by creation cohort and current payment state. Do not divide ledger purchases by partially observed clicks or infer statistical winners from CTR.'],
    }, null, 2));
  } finally { await deleteApp(app); }
}
if (isInvokedDirectly(import.meta.url)) runHouseAdReadout().catch(error => { console.error(error.message); process.exitCode = 1; });
