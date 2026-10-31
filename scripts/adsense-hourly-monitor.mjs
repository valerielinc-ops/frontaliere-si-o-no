#!/usr/bin/env node
import { appendFileSync, realpathSync, writeFileSync } from 'node:fs';
/**
 * adsense-hourly-monitor.mjs
 *
 * Salva ogni ora il totale AdSense del giorno in Firestore (l'API non espone il
 * dettaglio orario) e confronta le revenue con lo stesso giorno della settimana
 * precedente. Logica e soglie: scripts/lib/adsense-hourly.mjs.
 *
 * Exit code come monitor-revenue-signals.mjs: 0 quando il run ha misurato, con o
 * senza allarme; 1 quando non ha potuto misurare. L'allarme viaggia in output.
 *
 * Usage:
 *   node scripts/adsense-hourly-monitor.mjs --out=result.json --body-out=issue.md
 *   node scripts/adsense-hourly-monitor.mjs --dry-run      # non scrive su Firestore
 *   node scripts/adsense-hourly-monitor.mjs --ack=key1,key2  # segna gli allarmi notificati
 *
 * Env: ADSENSE_REFRESH_TOKEN, ADSENSE_CLIENT_ID|GSC_CLIENT_ID,
 *      ADSENSE_CLIENT_SECRET|GSC_CLIENT_SECRET, GOOGLE_APPLICATION_CREDENTIALS,
 *      RUN_URL, GITHUB_OUTPUT.
 */

import { pathToFileURL } from 'node:url';

import { GA4_READONLY_SCOPE, fetchRetry, getServiceAccountToken, runGa4Report } from './lib/ga4-service-account.mjs';
import {
  ALERT_COLLECTION,
  DEFAULT_CONFIG,
  SNAPSHOT_COLLECTION,
  buildIssueBody,
  buildSnapshot,
  detectStale,
  evaluateClosedDay,
  evaluateIntraday,
  hourlyDeltas,
  localClock,
  monitorDecision,
  shiftDate,
  snapshotId,
} from './lib/adsense-hourly.mjs';

const FIREBASE_PROJECT_ID = 'frontaliere-ticino';
const ADSENSE_API = 'https://adsense.googleapis.com/v2';
const REPORT_METRICS = ['ESTIMATED_EARNINGS', 'PAGE_VIEWS', 'AD_REQUESTS', 'IMPRESSIONS', 'CLICKS', 'AD_REQUESTS_COVERAGE'];
const HISTORY_DAYS = 9; // il giorno di sette giorni prima, con margine
const DAILY_DAYS = 10;

function parseArgs(argv) {
  const value = (name) => argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
  return { out: value('out'), bodyOut: value('body-out'), ack: value('ack'), dryRun: argv.includes('--dry-run') };
}

async function adsenseAccessToken(fetchImpl) {
  const refreshToken = process.env.ADSENSE_REFRESH_TOKEN;
  const clientId = process.env.ADSENSE_CLIENT_ID || process.env.GSC_CLIENT_ID;
  const clientSecret = process.env.ADSENSE_CLIENT_SECRET || process.env.GSC_CLIENT_SECRET;
  if (!refreshToken || !clientId || !clientSecret) throw new Error('missing AdSense OAuth credentials');
  const res = await fetchImpl('https://oauth2.googleapis.com/token', {
    method: 'POST',
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken, client_id: clientId, client_secret: clientSecret }),
  });
  if (!res.ok) throw new Error(`adsense token ${res.status}`);
  return (await res.json()).access_token;
}

/** Totali giornalieri nel fuso dell'account, compreso il giorno in corso. */
export async function fetchDailyTotals({ token, from, to, fetchImpl = fetchRetry }) {
  const headers = { Authorization: `Bearer ${token}` };
  const accounts = await fetchImpl(`${ADSENSE_API}/accounts`, { headers });
  if (!accounts.ok) throw new Error(`adsense accounts ${accounts.status}`);
  const account = (await accounts.json()).accounts?.[0]?.name;
  if (!account) throw new Error('no AdSense account on this token');

  const params = new URLSearchParams({ dateRange: 'CUSTOM' });
  for (const [prefix, date] of [['startDate', from], ['endDate', to]]) {
    const [year, month, day] = date.split('-').map(Number);
    params.set(`${prefix}.year`, year);
    params.set(`${prefix}.month`, month);
    params.set(`${prefix}.day`, day);
  }
  params.append('dimensions', 'DATE');
  for (const metric of REPORT_METRICS) params.append('metrics', metric);
  const res = await fetchImpl(`${ADSENSE_API}/${account}/reports:generate?${params}`, { headers });
  if (!res.ok) throw new Error(`adsense report ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  const rows = (data.rows || []).map((row) => {
    const [date, earnings, pageViews, adRequests, impressions, clicks, coverage] = row.cells.map((c) => c.value);
    return {
      date,
      earnings: Number(earnings),
      pageViews: Number(pageViews),
      adRequests: Number(adRequests),
      impressions: Number(impressions),
      clicks: Number(clicks),
      coverage: Number(coverage),
    };
  });
  return { rows, currency: data.headers?.find((h) => h.name === 'ESTIMATED_EARNINGS')?.currencyCode ?? null };
}

/** Riscontro indipendente: un guasto di GA4 non deve far perdere lo snapshot AdSense. */
async function fetchGa4Today(date) {
  try {
    const token = await getServiceAccountToken([GA4_READONLY_SCOPE]);
    const data = await runGa4Report({
      token,
      body: {
        dateRanges: [{ startDate: date, endDate: date }],
        dimensions: [{ name: 'hour' }],
        metrics: [{ name: 'totalAdRevenue' }, { name: 'screenPageViews' }],
        limit: 24,
      },
    });
    const rows = data.rows || [];
    return {
      revenue: Number(rows.reduce((sum, r) => sum + Number(r.metricValues[0].value), 0).toFixed(4)),
      pageViews: rows.reduce((sum, r) => sum + Number(r.metricValues[1].value), 0),
      lastHour: rows.reduce((max, r) => Math.max(max, Number(r.dimensionValues[0].value)), -1),
    };
  } catch (error) {
    console.error(`[adsense-hourly] GA4 non disponibile: ${error.message}`);
    return null;
  }
}

async function firestore() {
  const { applicationDefault, getApps, initializeApp } = await import('firebase-admin/app');
  const { getFirestore } = await import('firebase-admin/firestore');
  if (getApps().length === 0) initializeApp({ credential: applicationDefault(), projectId: FIREBASE_PROJECT_ID });
  return getFirestore();
}

async function loadSnapshots(db, fromDate) {
  const snap = await db.collection(SNAPSHOT_COLLECTION)
    .where('date', '>=', fromDate)
    .get();
  return snap.docs.map((doc) => doc.data());
}

async function notifiedKeys(db, keys) {
  if (keys.length === 0) return new Set();
  const docs = await db.getAll(...keys.map((key) => db.collection(ALERT_COLLECTION).doc(key)));
  return new Set(docs.filter((doc) => doc.exists).map((doc) => doc.id));
}

async function ack(db, keys) {
  const batch = db.batch();
  for (const key of keys) batch.set(db.collection(ALERT_COLLECTION).doc(key), { notifiedAt: new Date().toISOString() });
  await batch.commit();
  console.error(`[adsense-hourly] allarmi notificati: ${keys.join(', ')}`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.ack) {
    await ack(await firestore(), args.ack.split(',').filter(Boolean));
    return;
  }

  const capturedAt = new Date();
  const clock = localClock(capturedAt);
  const token = await adsenseAccessToken(fetchRetry);
  const { rows, currency } = await fetchDailyTotals({ token, from: shiftDate(clock.date, -DAILY_DAYS), to: clock.date });
  const byDate = new Map(rows.map((r) => [r.date, r]));
  const yesterday = byDate.get(shiftDate(clock.date, -1));
  const snapshot = buildSnapshot({
    capturedAt,
    today: byDate.get(clock.date),
    previousDay: yesterday ? { date: yesterday.date, earnings: yesterday.earnings, pageViews: yesterday.pageViews } : null,
    ga4: await fetchGa4Today(clock.date),
    currency,
  });

  const db = await firestore();
  if (!args.dryRun) await db.collection(SNAPSHOT_COLLECTION).doc(snapshotId(capturedAt)).set(snapshot);
  const stored = await loadSnapshots(db, shiftDate(clock.date, -HISTORY_DAYS));
  const snapshots = args.dryRun ? [...stored, snapshot] : stored;

  const closed = evaluateClosedDay(rows, clock.date, clock.hour);
  const intraday = evaluateIntraday(snapshots, clock.date);
  const stale = detectStale(snapshots, clock.date) ? clock.date : null;
  const candidateKeys = [closed.key, intraday.key, stale && `stale-${stale}`].filter(Boolean);
  const notified = await notifiedKeys(db, candidateKeys);
  const decision = monitorDecision({ closed, intraday, stale, alreadyNotified: (key) => notified.has(key) });

  const result = { snapshot, closed, intraday, stale, decision, config: DEFAULT_CONFIG, hourly: hourlyDeltas(snapshots, clock.date) };
  const json = JSON.stringify(result, null, 2);
  if (args.out) writeFileSync(args.out, `${json}\n`);
  else console.log(json);
  if (args.bodyOut && decision.status === 'alarm') {
    writeFileSync(args.bodyOut, `${buildIssueBody({ decision, runUrl: process.env.RUN_URL })}\n`);
  }
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, [
      `status=${decision.status}`,
      `priority=${decision.priority ?? ''}`,
      `alarm_keys=${decision.alarms.map((a) => a.key).join(',')}`,
      '',
    ].join('\n'));
  }
  console.error(`[adsense-hourly] ${clock.date} earnings=${snapshot.earnings} pv=${snapshot.pageViews} status=${decision.status}`);
}

if (process.argv[1] && pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url) {
  main().catch((error) => {
    console.error(`[adsense-hourly] misura fallita: ${error.message}`);
    process.exit(1);
  });
}
