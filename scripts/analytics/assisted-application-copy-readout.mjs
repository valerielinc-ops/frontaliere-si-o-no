#!/usr/bin/env node
/** Read-only GA4 report for exposure-to-checkout by assisted-application copy. */
import fs from 'node:fs';
import { parseArgs } from 'node:util';
import { isInvokedDirectly } from '../lib/is-invoked-directly.mjs';
import { getServiceAccountToken, runGa4Report } from '../lib/ga4-service-account.mjs';
import { ANALYTICS_PROCESSING_LAG_DAYS, settledWindow } from '../lib/analytics-settled-window.mjs';
import {
  GA4_EXCLUDED_TRAFFIC,
  ga4And,
  ga4Exact,
  ga4ExcludeTraffic,
} from '../lib/experiment-stats.mjs';
import {
  ASSISTED_APPLICATION_COPY_EXPERIMENT_ID,
  ASSISTED_APPLICATION_COPY_GA4_DIMENSIONS,
  ASSISTED_APPLICATION_COPY_PRIMARY_EVENTS,
  ASSISTED_APPLICATION_COPY_USER_PROPERTIES,
  ASSISTED_APPLICATION_COPY_SECONDARY_EVENTS,
} from '../../services/assistedApplicationCopyAnalyticsContract.mjs';

function parseCli(argv) {
  return parseArgs({
    args: argv,
    options: {
      since: { type: 'string' },
      until: { type: 'string' },
      days: { type: 'string', default: '28' },
      json: { type: 'string' },
      help: { type: 'boolean', short: 'h', default: false },
    },
    strict: true,
  }).values;
}

function validDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const ms = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 10) === value;
}

function resolveWindow(args, now = new Date()) {
  if (args.since || args.until) {
    const { start, end } = settledWindow({ days: Number(args.days), lagDays: ANALYTICS_PROCESSING_LAG_DAYS, now });
    const since = args.since || start;
    const until = args.until || end;
    if (!validDate(since) || !validDate(until) || until < since) throw new Error('Use valid --since/--until dates with until >= since.');
    return { since, until };
  }
  const days = Number(args.days);
  if (!Number.isInteger(days) || days < 1 || days > 365) throw new Error('--days must be an integer from 1 to 365.');
  const { start, end } = settledWindow({ days, lagDays: ANALYTICS_PROCESSING_LAG_DAYS, now });
  return { since: start, until: end };
}

export function summarizeCopyReport(response) {
  const byVariant = {};
  for (const row of response?.rows || []) {
    const [eventName, experiment, variant] = (row.dimensionValues || []).map((value) => value?.value ?? '');
    const [eventCount, totalUsers] = (row.metricValues || []).map((value) => Number(value?.value) || 0);
    if (experiment !== ASSISTED_APPLICATION_COPY_EXPERIMENT_ID || !variant || !eventName) continue;
    byVariant[variant] ||= {};
    byVariant[variant][eventName] = { eventCount, users: totalUsers };
  }
  const arms = Object.fromEntries(Object.entries(byVariant).map(([variant, events]) => {
    const exposures = events[ASSISTED_APPLICATION_COPY_PRIMARY_EVENTS.exposure]?.users || 0;
    const completions = events[ASSISTED_APPLICATION_COPY_PRIMARY_EVENTS.conversion]?.users || 0;
    return [variant, {
      exposures,
      completedUsers: completions,
      sameWindowCheckoutExposureRatio: exposures ? completions / exposures : null,
      events,
    }];
  }));
  return { experimentId: ASSISTED_APPLICATION_COPY_EXPERIMENT_ID, arms };
}

export async function runCopyReadout(argv = process.argv.slice(2), {
  propertyId = process.env.GA4_PROPERTY_ID,
  getToken = getServiceAccountToken,
  runReport = runGa4Report,
  now = new Date(),
} = {}) {
  const args = parseCli(argv);
  if (args.help) {
    console.log('Read-only. Requires GA4_PROPERTY_ID, credentials, and registered USER dimensions aa_copy_experiment + aa_copy_variant.');
    return { exitCode: 0 };
  }
  const rawProperty = String(propertyId || '').trim();
  if (!rawProperty) throw new Error('GA4_PROPERTY_ID is required; refusing to use an implicit property.');
  const property = rawProperty.startsWith('properties/') ? rawProperty : `properties/${rawProperty}`;
  const window = resolveWindow(args, now);
  const token = await getToken(['https://www.googleapis.com/auth/analytics.readonly']);
  if (!token) throw new Error('GA4 read-only authentication failed.');
  const dimensionNames = [
    'eventName',
    `customUser:${ASSISTED_APPLICATION_COPY_USER_PROPERTIES.experiment}`,
    `customUser:${ASSISTED_APPLICATION_COPY_USER_PROPERTIES.variant}`,
  ];
  const report = await runReport({
    token,
    propertyId: property,
    body: {
      dateRanges: [{ startDate: window.since, endDate: window.until }],
      dimensions: dimensionNames.map((name) => ({ name })),
      metrics: [{ name: 'eventCount' }, { name: 'totalUsers' }],
      dimensionFilter: ga4ExcludeTraffic(
        ga4And(ga4Exact(`customUser:${ASSISTED_APPLICATION_COPY_USER_PROPERTIES.experiment}`, ASSISTED_APPLICATION_COPY_EXPERIMENT_ID)),
        GA4_EXCLUDED_TRAFFIC,
      ),
      limit: 10_000,
    },
  });
  const summary = summarizeCopyReport(report);
  const result = { window, dimensions: ASSISTED_APPLICATION_COPY_GA4_DIMENSIONS.map((d) => d.parameterName), ...summary };
  console.log(`Candidatura assistita · ${window.since} → ${window.until} · ${result.experimentId}`);
  console.log('Escluso il traffico automatico secondo la regola condivisa con gli altri readout.');
  for (const [variant, arm] of Object.entries(result.arms)) {
    const rate = arm.sameWindowCheckoutExposureRatio == null ? 'n/d' : `${(arm.sameWindowCheckoutExposureRatio * 100).toFixed(2)}%`;
    console.log(`- ${variant}: ${arm.exposures} utenti con offerta vista, ${arm.completedUsers} con checkout completato (${rate} rapporto nella stessa finestra)`);
    for (const eventName of ASSISTED_APPLICATION_COPY_SECONDARY_EVENTS) {
      const event = arm.events[eventName];
      if (event) console.log(`  ${eventName}: ${event.users} utenti / ${event.eventCount} eventi`);
    }
  }
  if (args.json) fs.writeFileSync(args.json, `${JSON.stringify(result, null, 2)}\n`);
  return { exitCode: 0, result };
}

if (isInvokedDirectly(import.meta.url)) {
  runCopyReadout().then(({ exitCode }) => process.exit(exitCode)).catch((error) => {
    console.error(`assisted-application-copy-readout: ${error?.message || error}`);
    process.exit(1);
  });
}
