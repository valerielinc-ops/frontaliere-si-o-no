// scripts/lib/newsletter-weekly-facts.mjs
//
// The facts the weekly newsletter's AI prompt is built from: the stored CHF/EUR rate,
// the weekly comparison and market insight derived from the rate history, the weekly
// fact and the featured tool. They live HERE, and not inside scripts/send-newsletter.mjs,
// so the workflow's frozen-content probe (scripts/newsletter-content-probe.mjs)
// computes the very same fingerprint inputs with the very same functions as the sender
// (perf-plan email senders, C4, review round 1): a probe that re-derived them any other
// way could say "no LLM needed" while the sender then regenerates without the provider
// setups.

import { getFeaturedTools } from '../../services/newsletter-template.mjs';
import { utcDaysBefore } from './analytics-settled-window.mjs';
import { fetchStoredExchangeRate } from './newsletter-campaign-content.mjs';

export async function fetchExchangeHistory(db, days = 120, { allowHttp = true } = {}) {
  // 1. Read from Firestore exchangeHistory (updated daily by cron job)
  if (db) {
    try {
      // Pick the best period based on requested days
      const period = days <= 35 ? '1m' : days <= 100 ? '3m' : days <= 200 ? '6m' : days <= 400 ? '1y' : '5y';
      const snap = await db.collection('exchangeHistory').doc(`chf-eur-${period}`).get();
      if (snap.exists) {
        const points = snap.data()?.points || [];
        if (points.length >= 5) {
          console.log(`📊 History from Firestore (${period}): ${points.length} points, last: ${points[points.length-1]?.date}`);
          return points;
        }
      }
    } catch (e) {
      console.warn('⚠️ Firestore history read failed:', e.message);
    }
  }

  // 2. Fallback: Frankfurter API (only if Firestore is empty/unavailable)
  if (!allowHttp) return [];
  console.log('⚠️ Falling back to Frankfurter API for history');
  const end = new Date();
  const start = utcDaysBefore(end, days);
  const startStr = start.toISOString().slice(0, 10);
  const endStr = end.toISOString().slice(0, 10);
  const endpoints = [
    `https://api.frankfurter.dev/v2/rates?base=CHF&quotes=EUR&from=${startStr}&to=${endStr}`,
    `https://api.frankfurter.app/v2/rates?base=CHF&quotes=EUR&from=${startStr}&to=${endStr}`,
  ];
  for (const url of endpoints) {
    try {
      const res = await fetch(url, { headers: { accept: 'application/json' } });
      if (!res.ok) continue;
      const data = await res.json();
      const series = (Array.isArray(data) ? data : [])
        .map((entry) => ({ date: entry.date, rate: Number(entry.rate || 0) }))
        .filter((r) => Number.isFinite(r.rate) && r.rate > 0)
        .sort((a, b) => a.date.localeCompare(b.date));
      if (series.length >= 20) return series;
    } catch { /* try next */ }
  }
  return [];
}

function mean(values) {
  if (!values.length) return 0;
  return values.reduce((a, v) => a + v, 0) / values.length;
}

function toWeekdayName(index) {
  return ['Domenica', 'Luned\u00ec', 'Marted\u00ec', 'Mercoled\u00ec', 'Gioved\u00ec', 'Venerd\u00ec', 'Sabato'][index] || 'N/D';
}

export function computeExchangeInsight(series, fallbackRate, fallbackPrev) {
  if (!series.length) {
    return {
      headline: 'Dati storici limitati',
      summary: 'Confronto settimanale diretto disponibile.',
      currentMonthAvg: fallbackRate,
      previousMonthAvg: fallbackPrev,
      bestWeekday: 'N/D',
    };
  }
  const latest = series[series.length - 1].rate;
  const previous = series[Math.max(0, series.length - 8)]?.rate || latest;
  const weekPct = previous > 0 ? ((latest - previous) / previous) * 100 : 0;
  const trend = weekPct > 0.2 ? 'in rafforzamento' : weekPct < -0.2 ? 'in indebolimento' : 'stabile';
  const now = new Date();
  const curMonth = now.getMonth(), curYear = now.getFullYear();
  const prevDate = new Date(curYear, curMonth - 1, 1);
  const curRates = series.filter((d) => { const dt = new Date(d.date + 'T00:00:00'); return dt.getMonth() === curMonth && dt.getFullYear() === curYear; }).map((d) => d.rate);
  const prevRates = series.filter((d) => { const dt = new Date(d.date + 'T00:00:00'); return dt.getMonth() === prevDate.getMonth() && dt.getFullYear() === prevDate.getFullYear(); }).map((d) => d.rate);
  const curAvg = mean(curRates) || latest;
  const prevAvg = mean(prevRates) || previous;
  const weekdayBuckets = new Map();
  for (const p of series) {
    const d = new Date(p.date + 'T00:00:00').getDay();
    const arr = weekdayBuckets.get(d) || [];
    arr.push(p.rate);
    weekdayBuckets.set(d, arr);
  }
  let bestDay = 1, bestAvg = -Infinity;
  for (const [day, vals] of weekdayBuckets) {
    const avg = mean(vals);
    if (avg > bestAvg) { bestAvg = avg; bestDay = day; }
  }
  const mDelta = prevAvg > 0 ? ((curAvg - prevAvg) / prevAvg) * 100 : 0;
  const rec = mDelta >= 0.4 ? 'Scenario favorevole: valuta cambio graduale.'
    : mDelta <= -0.4 ? 'Scenario debole: considera cambio a tranche.'
    : 'Scenario neutro: mantieni strategia a tranche.';
  return {
    headline: `CHF/EUR ${trend} (${weekPct >= 0 ? '+' : ''}${weekPct.toFixed(2)}% settimanale)`,
    summary: rec,
    currentMonthAvg: curAvg,
    previousMonthAvg: prevAvg,
    bestWeekday: toWeekdayName(bestDay),
  };
}


export function getWeeklyFact(locale = 'it', nowMs = Date.now()) {
  const EPOCH = new Date('2025-01-06').getTime();
  const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
  const weekIndex = Math.floor((nowMs - EPOCH) / WEEK_MS) % 52;
  const FACTS = {
    it: [
      { text: 'In Svizzera, il salario mediano \u00e8 di circa 6.665 CHF al mese (2022).', source: 'UST' },
      { text: 'Circa 79.000 frontalieri lavorano nel Canton Ticino.', source: 'USTAT' },
      { text: 'La franchigia per i nuovi frontalieri dal 2024 \u00e8 di \u20ac10.000.', source: 'Nuovo Accordo Fiscale' },
      { text: 'Il tasso di disoccupazione in Ticino \u00e8 circa il 2.3%.', source: 'SECO' },
      { text: "L'AVS (1\u00b0 pilastro) copre circa il 40% del reddito pre-pensionamento.", source: 'BSV' },
      { text: 'Il 3\u00b0 pilastro 3a permette di dedurre fino a 7.258 CHF (2026) dalle tasse.', source: 'Admin.ch' },
    ],
    en: [
      { text: 'In Switzerland, the median salary is around CHF 6,665 per month (2022).', source: 'FSO' },
      { text: 'About 79,000 cross-border workers commute to Canton Ticino.', source: 'USTAT' },
      { text: 'The tax allowance for new cross-border workers from 2024 is \u20ac10,000.', source: 'New Fiscal Agreement' },
      { text: 'The unemployment rate in Ticino is around 2.3%.', source: 'SECO' },
      { text: 'The AVS (1st pillar) covers about 40% of pre-retirement income.', source: 'BSV' },
      { text: 'Pillar 3a allows you to deduct up to CHF 7,258 (2026) from taxes.', source: 'Admin.ch' },
    ],
    de: [
      { text: 'In der Schweiz liegt der Medianlohn bei rund 6.665 CHF pro Monat (2022).', source: 'BFS' },
      { text: 'Rund 79.000 Grenzg\u00e4nger pendeln in den Kanton Tessin.', source: 'USTAT' },
      { text: 'Der Freibetrag f\u00fcr neue Grenzg\u00e4nger ab 2024 betr\u00e4gt \u20ac10.000.', source: 'Neues Steuerabkommen' },
      { text: 'Die Arbeitslosenquote im Tessin liegt bei etwa 2,3%.', source: 'SECO' },
      { text: 'Die AHV (1. S\u00e4ule) deckt rund 40% des Vorruhestandseinkommens.', source: 'BSV' },
      { text: 'S\u00e4ule 3a erm\u00f6glicht einen Steuerabzug von bis zu 7.258 CHF (2026).', source: 'Admin.ch' },
    ],
    fr: [
      { text: 'En Suisse, le salaire m\u00e9dian est d\u2019environ 6 665 CHF par mois (2022).', source: 'OFS' },
      { text: 'Environ 79 000 frontaliers travaillent dans le canton du Tessin.', source: 'USTAT' },
      { text: 'L\u2019abattement fiscal pour les nouveaux frontaliers \u00e0 partir de 2024 est de \u20ac10 000.', source: 'Nouvel Accord Fiscal' },
      { text: 'Le taux de ch\u00f4mage au Tessin est d\u2019environ 2,3%.', source: 'SECO' },
      { text: 'L\u2019AVS (1er pilier) couvre environ 40% du revenu avant la retraite.', source: 'BSV' },
      { text: 'Le pilier 3a permet de d\u00e9duire jusqu\u2019\u00e0 7 258 CHF (2026) des imp\u00f4ts.', source: 'Admin.ch' },
    ],
  };
  const localeFacts = FACTS[locale] || FACTS.it;
  return localeFacts[weekIndex % localeFacts.length];
}

/** The featured tool of the week, localized (same weekly index for every locale). */
export function getFeaturedToolForLocale(locale, nowMs = Date.now()) {
  const toolIndex = Math.floor((nowMs - new Date('2025-01-06').getTime()) / (7 * 24 * 60 * 60 * 1000)) % 4;
  const tools = getFeaturedTools(locale);
  return tools[toolIndex % tools.length];
}

/**
 * The exchange facts exactly as the sender builds them: the stored rate, its weekly
 * comparison taken from the history, and the insight derived from that history.
 * `allowHttp: false` (the probe) never leaves Firestore: with no stored history it
 * returns `null` instead of calling the Frankfurter API.
 *
 * @returns {Promise<{ exchangeRate: object|null, exchangeInsight: object, history: object[] }|null>}
 */
export async function loadExchangeFacts(db, { nowMs = Date.now(), allowHttp = true, log = () => {}, warn = () => {} } = {}) {
  const exchangeRate = await fetchStoredExchangeRate(db, { warn });
  const history = await fetchExchangeHistory(db, 120, { allowHttp });
  if (!allowHttp && history.length < 5) return null;
  // Always use history for the 7-day-ago rate — Firestore previousRate is just
  // the last hourly update, not the weekly comparison we need for the newsletter
  if (exchangeRate && history.length >= 2) {
    const weekAgoDate = new Date(nowMs - 7 * 24 * 3600 * 1000).toISOString().slice(0, 10);
    const weekAgoEntry = history.find((h) => h.date === weekAgoDate)
      || history.filter((h) => h.date <= weekAgoDate).pop()
      || history[0];
    exchangeRate.previousRate = weekAgoEntry?.rate || exchangeRate.rate;
    log(`📊 Rate: ${exchangeRate.rate.toFixed(4)} | 7d ago (${weekAgoEntry?.date || '?'}): ${exchangeRate.previousRate.toFixed(4)} | Δ ${(((exchangeRate.rate - exchangeRate.previousRate) / exchangeRate.previousRate) * 100).toFixed(2)}%`);
  } else if (exchangeRate && !exchangeRate.previousRate) {
    exchangeRate.previousRate = exchangeRate.rate; // no change if no history
  }
  const exchangeInsight = computeExchangeInsight(
    history,
    exchangeRate?.rate || 0.9420,
    exchangeRate?.previousRate || 0.9385,
  );
  return { exchangeRate, exchangeInsight, history };
}
