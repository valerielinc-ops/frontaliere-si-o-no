#!/usr/bin/env node
/**
 * Weekly, read-only conversion-funnel report for the site.
 *
 * Usage:
 *   source bin/rc-env.sh
 *   node scripts/conversion-funnel-report.mjs --days 7
 *   node scripts/conversion-funnel-report.mjs --days 30 --json
 */

import {
  DEFAULT_GA4_PROPERTY_ID,
  GA4_READONLY_SCOPE,
  ga4DateRange,
  getServiceAccountToken,
  runGa4Report,
} from './lib/ga4-service-account.mjs';
import {
  fmtUtcDate,
  utcDaysBefore,
} from './lib/analytics-settled-window.mjs';
import {
  buildChannelRows,
  buildConversionSummary,
  buildDataQuality,
  buildLandingMatrix,
  buildReportBodies,
  CONVERSION_DEFINITIONS,
  diffByKey,
} from './lib/conversion-funnel-report.mjs';

const DEFAULT_DAYS = 7;
const DEFAULT_LIMIT = 10000;
const LAG_DAYS = 2;

function readOption(args, name, fallback) {
  const index = args.indexOf(name);
  if (index < 0) return fallback;
  return args[index + 1] || fallback;
}

function parseArgs(args) {
  const days = Math.max(1, Math.min(90, Number(readOption(args, '--days', DEFAULT_DAYS)) || DEFAULT_DAYS));
  const limit = Math.max(1, Math.min(10000, Number(readOption(args, '--limit', DEFAULT_LIMIT)) || DEFAULT_LIMIT));
  return {
    days: Math.floor(days),
    limit: Math.floor(limit),
    propertyId: readOption(args, '--property', process.env.GA4_PROPERTY_ID || DEFAULT_GA4_PROPERTY_ID),
    json: args.includes('--json'),
    help: args.includes('--help') || args.includes('-h'),
  };
}

function previousRange(current, days) {
  const currentStart = new Date(`${current.startDate}T00:00:00.000Z`);
  const end = utcDaysBefore(currentStart, 1);
  const start = utcDaysBefore(end, days - 1);
  return { startDate: fmtUtcDate(start), endDate: fmtUtcDate(end) };
}

async function runPeriod({ token, propertyId, range, limit }) {
  const bodies = buildReportBodies({ ...range, limit });
  const reports = {};
  reports.landingPages = await runGa4Report({ token, propertyId, body: bodies.landingPages });
  reports.channels = await runGa4Report({ token, propertyId, body: bodies.channels });
  reports.conversions = {};
  for (const definition of CONVERSION_DEFINITIONS) {
    reports.conversions[definition.key] = await runGa4Report({
      token,
      propertyId,
      body: bodies.conversions[definition.key],
    });
  }
  return reports;
}

function buildReport({ currentRaw, previousRaw, currentWindow, previousWindow, propertyId, days, limit }) {
  const currentLanding = buildLandingMatrix(currentRaw.landingPages, currentRaw.conversions);
  const previousLanding = buildLandingMatrix(previousRaw.landingPages, previousRaw.conversions);
  const currentChannels = buildChannelRows(currentRaw.channels);
  const previousChannels = buildChannelRows(previousRaw.channels);
  const landingPages = diffByKey(currentLanding, previousLanding);
  const channels = diffByKey(currentChannels, previousChannels, 'channel');

  return {
    generatedAt: new Date().toISOString(),
    property: propertyId,
    window: {
      current: currentWindow,
      previous: previousWindow,
      days,
      lagDays: LAG_DAYS,
      limit,
    },
    dataQuality: buildDataQuality(currentLanding),
    channels: { current: channels, previous: previousChannels },
    conversions: {
      current: buildConversionSummary(currentRaw.landingPages, currentRaw.conversions),
      previous: buildConversionSummary(previousRaw.landingPages, previousRaw.conversions),
    },
    landingPages,
  };
}

function formatNumber(value) {
  return new Intl.NumberFormat('it-CH', { maximumFractionDigits: 0 }).format(value || 0);
}

function formatPercent(value) {
  return `${((value || 0) * 100).toFixed(1)}%`;
}

function printHumanReport(report) {
  const currentLanding = report.landingPages;
  const totalSessions = currentLanding.reduce((sum, row) => sum + row.sessions, 0);
  const totalEngaged = currentLanding.reduce((sum, row) => sum + row.engagedSessions, 0);
  console.log(`Conversion funnel — ${report.window.current.startDate} → ${report.window.current.endDate}`);
  console.log(`Sessioni: ${formatNumber(totalSessions)} · engagement: ${formatPercent(totalSessions ? totalEngaged / totalSessions : 0)}`);
  console.log(`Confronto: ${report.window.previous.startDate} → ${report.window.previous.endDate}`);
  console.log('\nCanali principali');
  for (const channel of report.channels.current.slice(0, 8)) {
    console.log(`- ${channel.channel}: ${formatNumber(channel.sessions)} sessioni · ${formatPercent(channel.engagementRate)} engagement`);
  }

  console.log('\nConversioni');
  for (const definition of CONVERSION_DEFINITIONS) {
    const conversion = report.conversions.current[definition.key];
    console.log(`- ${conversion.label}: ${formatNumber(conversion.conversionSessions)} sessioni · ${formatPercent(conversion.rate)}`);
  }

  console.log('\nLanding page principali');
  for (const page of currentLanding.slice(0, 12)) {
    console.log(`- ${page.landingPage}: ${formatNumber(page.sessions)} sessioni · ${formatPercent(page.engagementRate)} engagement · Δ ${formatPercent(page.sessionDeltaRate)}`);
  }

  const { notSetSessions, notSetRate, warning } = report.dataQuality;
  console.log(`\nQualità dati: (not set) ${formatNumber(notSetSessions)} sessioni (${formatPercent(notSetRate)})`);
  if (warning) console.log(`⚠️  ${warning}`);
}

function printHelp() {
  console.log('Uso: node scripts/conversion-funnel-report.mjs [--days 7] [--limit 10000] [--property ID] [--json]');
  console.log('Il report usa solo query GA4 Data API in lettura e finestre assestate con lag di 2 giorni.');
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }

  const currentWindow = ga4DateRange(options.days, LAG_DAYS);
  const previousWindow = previousRange(currentWindow, options.days);
  const token = await getServiceAccountToken([GA4_READONLY_SCOPE], {
    logInfo: options.json ? () => {} : console.error,
    logError: options.json ? () => {} : console.error,
  });
  if (!token) {
    throw new Error('Credenziali GA4 mancanti o non valide. Esegui "source bin/rc-env.sh" dalla root del workspace e riprova.');
  }

  const [currentRaw, previousRaw] = await Promise.all([
    runPeriod({ token, propertyId: options.propertyId, range: currentWindow, limit: options.limit }),
    runPeriod({ token, propertyId: options.propertyId, range: previousWindow, limit: options.limit }),
  ]);
  const report = buildReport({
    currentRaw,
    previousRaw,
    currentWindow,
    previousWindow,
    propertyId: options.propertyId,
    days: options.days,
    limit: options.limit,
  });

  if (options.json) console.log(JSON.stringify(report, null, 2));
  else printHumanReport(report);
}

main().catch((error) => {
  console.error(`Conversion funnel report failed: ${error.message}`);
  process.exitCode = 1;
});
