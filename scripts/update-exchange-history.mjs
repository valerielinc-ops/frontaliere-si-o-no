#!/usr/bin/env node
/**
 * Daily exchange rate history updater.
 *
 * Runs as a GitHub Actions cron job once per day.
 * - Fetches CHF→EUR history from Frankfurter API for all periods (1m, 3m, 6m, 1y, 5y)
 * - Saves each period to Firestore `exchangeHistory/chf-eur-{period}`
 * - Writes `previousRate` (7-day-ago) + `previousRateDate` to `config/exchange_rate`
 * - Cleans up legacy `exchange_rates/chf_eur` doc if present
 *
 * Client-side code reads from Firestore only — never writes history.
 */

import admin from 'firebase-admin';

admin.initializeApp({
  credential: admin.credential.applicationDefault(),
  projectId: process.env.GCLOUD_PROJECT || 'frontaliere-ticino',
});
const db = admin.firestore();

const PERIODS = [
  { id: '1m', months: 1 },
  { id: '3m', months: 3 },
  { id: '6m', months: 6 },
  { id: '1y', months: 12 },
  { id: '5y', months: 60 },
];

const FRANKFURTER_ENDPOINTS = [
  'https://api.frankfurter.dev',
  'https://api.frankfurter.app',
];

function getDateRange(months) {
  const end = new Date();
  const start = new Date();
  start.setMonth(end.getMonth() - months);
  return {
    startStr: start.toISOString().slice(0, 10),
    endStr: end.toISOString().slice(0, 10),
  };
}

async function fetchFromFrankfurter(startStr, endStr) {
  for (const base of FRANKFURTER_ENDPOINTS) {
    try {
      // Split into yearly chunks to avoid huge JSON responses
      const startDate = new Date(startStr);
      const endDate = new Date(endStr);
      const allPoints = [];

      let chunkStart = new Date(startDate);
      while (chunkStart < endDate) {
        const chunkEnd = new Date(chunkStart);
        chunkEnd.setFullYear(chunkEnd.getFullYear() + 1);
        if (chunkEnd > endDate) chunkEnd.setTime(endDate.getTime());

        const cs = chunkStart.toISOString().slice(0, 10);
        const ce = chunkEnd.toISOString().slice(0, 10);
        const url = `${base}/v2/rates?base=CHF&quotes=EUR&from=${cs}&to=${ce}`;
        const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        if (Array.isArray(data)) {
          for (const entry of data) {
            const rate = Number(entry.rate);
            if (entry.date && Number.isFinite(rate) && rate > 0) {
              allPoints.push({ date: entry.date, rate });
            }
          }
        }
        chunkStart = new Date(chunkEnd);
        chunkStart.setDate(chunkStart.getDate() + 1);
      }

      allPoints.sort((a, b) => a.date.localeCompare(b.date));
      if (allPoints.length >= 5) return allPoints;
    } catch (e) {
      console.warn(`⚠️ ${base} failed:`, e.message);
    }
  }
  throw new Error('All Frankfurter endpoints failed');
}

async function updatePeriod(period) {
  const { startStr, endStr } = getDateRange(period.months);
  console.log(`📊 Fetching ${period.id} (${startStr} → ${endStr})...`);
  const points = await fetchFromFrankfurter(startStr, endStr);
  const lastDate = points[points.length - 1]?.date || '';
  
  await db.collection('exchangeHistory').doc(`chf-eur-${period.id}`).set({
    points,
    lastDate,
    period: period.id,
    updatedAt: new Date().toISOString(),
    source: 'frankfurter',
  });
  
  console.log(`  ✅ ${period.id}: ${points.length} points, last: ${lastDate}`);
  return points;
}

async function updatePreviousRate(allPoints) {
  // Use the freshest period's data to find 7-day-ago rate
  const today = new Date().toISOString().slice(0, 10);
  const weekAgoTarget = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
  
  // Find exact match or nearest earlier date
  const weekAgoEntry = allPoints.find(p => p.date === weekAgoTarget)
    || allPoints.filter(p => p.date <= weekAgoTarget).pop();
  
  if (!weekAgoEntry) {
    console.warn('⚠️ No 7-day-ago entry found, skipping previousRate update');
    return;
  }
  
  const rateRef = db.collection('config').doc('exchange_rate');
  const rateDoc = await rateRef.get();
  const currentRate = rateDoc.data()?.rate;
  
  await rateRef.update({
    previousRate: weekAgoEntry.rate,
    previousRateDate: weekAgoEntry.date,
  });
  
  const delta = currentRate
    ? ((currentRate - weekAgoEntry.rate) / weekAgoEntry.rate * 100).toFixed(3)
    : '?';
  console.log(`\n📈 previousRate: ${weekAgoEntry.rate} (${weekAgoEntry.date})`);
  console.log(`   currentRate:  ${currentRate || '?'}`);
  console.log(`   weekly Δ:     ${delta}%`);
}

async function cleanupLegacy() {
  try {
    const legacyRef = db.collection('exchange_rates').doc('chf_eur');
    const legacyDoc = await legacyRef.get();
    if (legacyDoc.exists) {
      await legacyRef.delete();
      console.log('🗑️ Deleted legacy exchange_rates/chf_eur doc');
    }
  } catch (e) {
    console.warn('⚠️ Legacy cleanup failed:', e.message);
  }
}

async function main() {
  console.log('🔄 Exchange Rate History Updater\n');
  
  let freshestPoints = [];
  
  for (const period of PERIODS) {
    try {
      const points = await updatePeriod(period);
      // Keep the period with most recent data (should all be same, but prefer longer periods)
      if (points.length > freshestPoints.length) {
        freshestPoints = points;
      }
    } catch (e) {
      console.error(`❌ ${period.id} failed:`, e.message);
    }
  }
  
  if (freshestPoints.length > 0) {
    await updatePreviousRate(freshestPoints);
  }
  
  await cleanupLegacy();
  
  console.log('\n✅ Done');
}

main().then(() => process.exit(0)).catch(e => {
  console.error('❌ Fatal:', e.message);
  process.exit(1);
});
