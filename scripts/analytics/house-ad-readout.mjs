#!/usr/bin/env node
/** Read-only, aggregate-only readout. No purchase is inferred from browser events. */
import { parseArgs } from 'node:util';
import { isInvokedDirectly } from '../lib/is-invoked-directly.mjs';
import { getServiceAccountToken, runGa4Report } from '../lib/ga4-service-account.mjs';
import { settledWindow } from '../lib/analytics-settled-window.mjs';
import { sanitizeHouseAdAttribution, sanitizeReaderSubscriptionAdAttribution } from '../../functions/src/houseAdAttribution.js';

export function summarizeHouseTraffic(response) {
  if (Number(response?.rowCount || 0) > (response?.rows || []).length) throw new Error('GA4 report truncated; no partial totals');
  const groups = new Map();
  for (const row of response?.rows || []) {
    const [event, component, surface, device] = row.dimensionValues.map(v => v.value);
    const match = /^(?:(house_creatives_v[12])\.)?(control|time_saved|profile_match|in_control|swiss_work|next_chapter)_v1\.(test|fixed)\.(it|en|de|fr)$/.exec(component);
    if (!match || !['house_ad_impression', 'house_ad_click', 'house_ad_landing'].includes(event)) continue;
    const experimentId = match[1] || 'house_creatives_v1';
    const [format, ...placement] = surface.split('.');
    const key = JSON.stringify([experimentId, match[2], match[3], match[4], format, placement.join('.'), device]);
    const group = groups.get(key) || { experimentId, variant: match[2], enrolled: match[3] === 'test', locale: match[4], format, placement: placement.join('.'), device, impressions: 0, clicks: 0, landings: 0 };
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
    const key = JSON.stringify([a.experimentId, a.variant, a.enrolled, a.locale, a.format, a.placement, a.device]);
    const group = groups.get(key) || { experimentId: a.experimentId, variant: a.variant, enrolled: a.enrolled, locale: a.locale, format: a.format, placement: a.placement, device: a.device, initiatedOrders: 0, confirmedPurchases: 0, refundedOrders: 0, confirmedRevenueEurCents: 0 };
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

export function summarizeReaderSubscriptionTraffic(response) {
  if (Number(response?.rowCount || 0) > (response?.rows || []).length) throw new Error('GA4 report truncated; no partial totals');
  const groups = new Map();
  for (const row of response?.rows || []) {
    const [event, component, surface, device] = row.dimensionValues.map(v => v.value);
    const match = /^reader_subscription_house_v1\.(control|subscription)\.test\.(it|en|de|fr)$/.exec(component);
    if (!match || ![
      'reader_subscription_experiment_exposure', 'reader_subscription_experiment_impression',
      'reader_subscription_experiment_click', 'reader_subscription_ad_impression',
      'reader_subscription_ad_click', 'reader_subscription_ad_landing',
    ].includes(event)) continue;
    const [format, ...placement] = surface.split('.');
    const key = JSON.stringify([match[1], match[2], format, placement.join('.'), device]);
    const group = groups.get(key) || {
      experimentId: 'reader_subscription_house_v1', variant: match[1], locale: match[2],
      format, placement: placement.join('.'), device,
      exposures: 0, impressions: 0, clicks: 0, subscriptionCardImpressions: 0,
      subscriptionCardClicks: 0, landings: 0,
    };
    const metric = Number(row.metricValues[0]?.value || 0);
    if (event === 'reader_subscription_experiment_exposure') group.exposures += metric;
    else if (event === 'reader_subscription_experiment_impression') group.impressions += metric;
    else if (event === 'reader_subscription_experiment_click') group.clicks += metric;
    else if (event === 'reader_subscription_ad_impression') group.subscriptionCardImpressions += metric;
    else if (event === 'reader_subscription_ad_click') group.subscriptionCardClicks += metric;
    else group.landings += metric;
    groups.set(key, group);
  }
  return [...groups.values()].map(group => ({
    ...group,
    ctr: group.impressions > 0 ? group.clicks / group.impressions : null,
    subscriptionCardCtr: group.subscriptionCardImpressions > 0
      ? group.subscriptionCardClicks / group.subscriptionCardImpressions
      : null,
  }));
}

export function summarizeReaderSubscriptionPurchases(subscriptions, startMs, endMs) {
  const groups = new Map();
  for (const subscription of subscriptions) {
    const firstPaidAt = subscription.firstPaidAt?.toMillis?.() ?? 0;
    if (firstPaidAt < startMs || firstPaidAt >= endMs) continue;
    const a = sanitizeReaderSubscriptionAdAttribution(subscription.houseAdAttribution, firstPaidAt);
    if (!a || !a.enrolled) continue;
    const key = JSON.stringify([a.variant, a.locale, a.format, a.placement, a.device]);
    const group = groups.get(key) || {
      experimentId: a.experimentId, variant: a.variant, locale: a.locale,
      format: a.format, placement: a.placement, device: a.device, confirmedPaidSubscriptions: 0,
    };
    group.confirmedPaidSubscriptions++;
    groups.set(key, group);
  }
  return [...groups.values()];
}

export function summarizeReaderSubscriptionResults(traffic, purchases) {
  const groups = new Map();
  const keyFor = value => JSON.stringify([value.variant, value.locale, value.format, value.placement, value.device]);
  for (const row of traffic) groups.set(keyFor(row), { ...row, confirmedPaidSubscriptions: 0 });
  for (const row of purchases) {
    const key = keyFor(row);
    const group = groups.get(key) || {
      ...row, exposures: 0, impressions: 0, clicks: 0,
      subscriptionCardImpressions: 0, subscriptionCardClicks: 0,
      landings: 0, ctr: null, subscriptionCardCtr: null,
    };
    group.confirmedPaidSubscriptions += row.confirmedPaidSubscriptions;
    groups.set(key, group);
  }
  return [...groups.values()].map(group => ({
    ...group,
    confirmedSubscriptionsPerExposedSession: group.exposures > 0
      ? group.confirmedPaidSubscriptions / group.exposures
      : null,
  }));
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
    dimensionFilter: { filter: { fieldName: 'eventName', inListFilter: { values: [
      'house_ad_impression', 'house_ad_click', 'house_ad_landing',
      'reader_subscription_experiment_exposure', 'reader_subscription_experiment_impression',
      'reader_subscription_experiment_click', 'reader_subscription_ad_impression',
      'reader_subscription_ad_click', 'reader_subscription_ad_landing',
    ] } } },
    limit: 10000,
  } });
  const { initializeApp, applicationDefault, deleteApp } = await import('firebase-admin/app');
  const { getFirestore, Timestamp } = await import('firebase-admin/firestore');
  const app = initializeApp({ credential: applicationDefault(), projectId: 'frontaliere-ticino' }, 'house-ad-readout');
  try {
    const db = getFirestore(app); const services = []; const readerSubscriptions = [];
    let serviceCursor; let readerSubscriptionCursor;
    for (let page = 0; page < 11; page++) {
      let query = db.collection('application_concierge_services').where('createdAt', '>=', Timestamp.fromMillis(startMs)).where('createdAt', '<', Timestamp.fromMillis(endMs)).orderBy('createdAt').limit(1000);
      if (serviceCursor) query = query.startAfter(serviceCursor);
      const snapshot = await query.get();
      if (services.length + snapshot.size > 10000) throw new Error('Order report exceeds cap; shorten --days');
      services.push(...snapshot.docs.map(doc => doc.data()));
      if (snapshot.size < 1000) break;
      serviceCursor = snapshot.docs.at(-1);
    }
    for (let page = 0; page < 11; page++) {
      let query = db.collection('reader_subscriptions').where('firstPaidAt', '>=', Timestamp.fromMillis(startMs)).where('firstPaidAt', '<', Timestamp.fromMillis(endMs)).orderBy('firstPaidAt').limit(1000);
      if (readerSubscriptionCursor) query = query.startAfter(readerSubscriptionCursor);
      const snapshot = await query.get();
      if (readerSubscriptions.length + snapshot.size > 10000) throw new Error('Reader subscription report exceeds cap; shorten --days');
      readerSubscriptions.push(...snapshot.docs.map(doc => doc.data()));
      if (snapshot.size < 1000) break;
      readerSubscriptionCursor = snapshot.docs.at(-1);
    }
    const readerSubscriptionTraffic = summarizeReaderSubscriptionTraffic(traffic);
    const readerSubscriptionPurchases = summarizeReaderSubscriptionPurchases(readerSubscriptions, startMs, endMs);
    console.log(JSON.stringify({ currentExperimentId: 'house_creatives_v2', readerSubscriptionExperimentId: 'reader_subscription_house_v1', window, observedAt: new Date().toISOString(),
      traffic: summarizeHouseTraffic(traffic), orderCohorts: summarizeHouseOrders(services, startMs, endMs),
      readerSubscriptionResults: summarizeReaderSubscriptionResults(readerSubscriptionTraffic, readerSubscriptionPurchases),
      caveats: ['house_creatives_v1 is the legacy browser-hash split; compare job-search creatives within currentExperimentId only.', 'CTR uses observed GA4 events and can be incomplete when telemetry is blocked.', 'Job-search purchases use verified paymentStatus=paid and paidAt in the service ledger; refunds remain separate.', 'Reader subscription conversion uses Stripe firstPaidAt and only Firebase Remote Config enrolled attribution; exposures are observed GA4 sessions, not unique people, so compare cohorts directionally and do not declare statistical winners from short samples.'],
    }, null, 2));
  } finally { await deleteApp(app); }
}
if (isInvokedDirectly(import.meta.url)) runHouseAdReadout().catch(error => { console.error(error.message); process.exitCode = 1; });
