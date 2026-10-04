#!/usr/bin/env node

/**
 * report-job-email-ranking-experiment.mjs — fotografia aggregata di un
 * esperimento di ordinamento degli annunci nelle email (job alert e
 * newsletter), per variante, superficie, giorno e posizione.
 *
 * ── Perché esiste ──────────────────────────────────────────────────────────
 *
 * Dal 2026-09-08 (PR 7933) una quota degli invii riceve gli annunci in un
 * ordine diverso (variante `treatment`, riordino per CTR). I dati vivono solo
 * in Firestore, in tre collection con TTL di 100 giorni
 * (`functions/src/lib/jobEmailRankingStore.js`), e nessun codice li leggeva
 * oltre allo store che li scrive. Quando l'esperimento viene sostituito, i
 * dati grezzi spariscono da soli: questo script li riduce a una fotografia di
 * soli aggregati, da committare sotto `scripts/measurements/`, e la stessa
 * esecuzione produce la fotografia comparabile del prossimo esperimento.
 *
 * Le etichette di variante NON sono cablate: lo script riporta quelle che
 * trova (`control`, `treatment`, `affinity`, …). Se un evento o una consegna
 * porta un booleano `affinity_profile`, le stesse metriche escono anche
 * separate per `affinity_profile` vero/falso.
 *
 * ── Due fonti, due compiti ──────────────────────────────────────────────────
 *
 *   job_email_ranking_stats   somme ESATTE per variante (`impressions_by_variant`
 *                             e `clicks_by_variant`), per giorno e superficie.
 *                             Non conoscono la posizione.
 *   job_email_ranking_events  un documento per impression (consegna × annuncio)
 *                             e uno per clic, con posizione e variante.
 *
 * TRAPPOLA DELL'INDICE: dal 2026-10-03 (PR 11164) `job_email_ranking_events`
 * è esentata dall'indice automatico su tutti i campi tranne `occurred_at` ed
 * `expires_at` (`firestore.indexes.json`). Un filtro su `event_type`,
 * `ranking_variant`, `surface` o `position` fallisce. Lo script interroga SOLO
 * per range di `occurred_at`, paginato con `orderBy('occurred_at')` +
 * `startAfter`, e classifica tutto il resto nel codice. Non crea indici.
 *
 * ── Filtro dei clic non umani ───────────────────────────────────────────────
 *
 * I documento-clic di `job_email_ranking_events` non portano IP né user-agent
 * (lo store non li salva), quindi delle regole di `syntheticClicks.js` si può
 * applicare solo quella delle raffiche, con le sue soglie calibrate:
 *   1. deduplica per consegna + annuncio (lo store lo fa già con l'id del
 *      documento; qui è ripetuto per i link legacy senza `delivery_id`);
 *   2. raffica = la stessa consegna con SCAN_BURST_MIN_TARGETS (5) o più clic
 *      entro SCAN_BURST_WINDOW_MS (3 s): tutti i clic della finestra sono
 *      scartati.
 * Il filtro è identico per ogni variante e viene dichiarato nel JSON. Le somme
 * di `job_email_ranking_stats` NON sono filtrate (lo store incrementa il
 * contatore a ogni clic nuovo): il JSON riporta entrambe, e lo scarto.
 *
 * ── Costo ───────────────────────────────────────────────────────────────────
 *
 * Una lettura per documento: tutti gli eventi del periodo (~470k per le prime
 * quattro settimane) più i documenti stats (~110k). Lo script conta le letture
 * e le scrive nel JSON. Non va lanciato in un cron.
 *
 * Uso:
 *   GOOGLE_APPLICATION_CREDENTIALS=<sa.json> \
 *   node scripts/report-job-email-ranking-experiment.mjs \
 *     --from 2026-09-08T00:00:00Z --to 2026-10-04T00:00:00Z \
 *     --out scripts/measurements/<nome>.json \
 *     [--experiment "<nome>"] [--note "<testo>"]... \
 *     [--with-deliveries] [--check-remote-config] [--page-size 5000]
 *
 * Credenziali: FIREBASE_SERVICE_ACCOUNT_JSON (come gli altri script), oppure
 * GOOGLE_APPLICATION_CREDENTIALS, oppure ADC. Sola lettura.
 */

import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { JOB_EMAIL_RANKING_DEFAULTS } from '../functions/src/lib/jobEmailRanking.js';
import {
  JOB_EMAIL_RANKING_DELIVERIES_COLLECTION,
  JOB_EMAIL_RANKING_EVENTS_COLLECTION,
  JOB_EMAIL_RANKING_RETENTION_DAYS,
  JOB_EMAIL_RANKING_STATS_COLLECTION,
} from '../functions/src/lib/jobEmailRankingStore.js';
import {
  SCAN_BURST_MIN_TARGETS,
  SCAN_BURST_WINDOW_MS,
} from '../functions/src/lib/syntheticClicks.js';

export const REPORT_SCHEMA_VERSION = 1;
export const MAX_REPORTED_POSITION = 10;
export const KNOWN_SURFACES = Object.freeze(['job_alert', 'newsletter']);
const Z95 = 1.959964;

export const CLICK_FILTER = Object.freeze({
  dedupe: 'una sola volta per consegna + annuncio (delivery_id + job_id); i link legacy senza delivery_id ricadono su utente pseudonimo + superficie + annuncio',
  burst: {
    rule: `stessa consegna con ${SCAN_BURST_MIN_TARGETS} o più clic (annunci distinti) entro ${SCAN_BURST_WINDOW_MS / 1000} s: tutti i clic della finestra sono scartati; i link legacy senza delivery_id si raggruppano per utente pseudonimo + superficie + surface_id, mai per solo utente`,
    window_ms: SCAN_BURST_WINDOW_MS,
    min_clicks: SCAN_BURST_MIN_TARGETS,
    source: 'functions/src/lib/syntheticClicks.js (SCAN_BURST_WINDOW_MS, SCAN_BURST_MIN_TARGETS)',
  },
  not_applicable: 'IP scanner, user-agent di automazione e link di opt-out: i documenti clic di job_email_ranking_events non portano IP né user-agent e contengono solo link di annunci',
  same_for_every_variant: true,
});

// ── helpers puri ─────────────────────────────────────────────────────────────

/** Firestore Timestamp | Date | ISO | millis → millis, o null. */
export function toMillis(value) {
  if (value == null || value === '') return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'object') {
    if (typeof value.toMillis === 'function') return value.toMillis();
    if (typeof value.toDate === 'function') return value.toDate().getTime();
    if (typeof value._seconds === 'number') return value._seconds * 1000;
    if (value instanceof Date) return value.getTime();
  }
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : null;
}

/** Stessa normalizzazione di `variantKey` dello store: le chiavi dei due lati coincidono. */
export function normalizeVariant(value) {
  return String(value || 'unknown').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 40) || 'unknown';
}

function normalizeSurface(surface, eventType) {
  const s = String(surface || '');
  if (KNOWN_SURFACES.includes(s)) return s;
  const t = String(eventType || '');
  if (t.startsWith('job_alert_')) return 'job_alert';
  if (t.startsWith('newsletter_')) return 'newsletter';
  return 'other';
}

/** '1'…'10', '>10' oppure 'unknown'. */
export function positionBucket(position) {
  const p = Math.trunc(Number(position));
  if (!Number.isFinite(p) || p < 1) return 'unknown';
  return p > MAX_REPORTED_POSITION ? `>${MAX_REPORTED_POSITION}` : String(p);
}

export const POSITION_BUCKETS = Object.freeze([
  ...Array.from({ length: MAX_REPORTED_POSITION }, (_, i) => String(i + 1)),
  `>${MAX_REPORTED_POSITION}`,
  'unknown',
]);

function dayOf(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * Un documento di `job_email_ranking_events` → record compatto in memoria.
 * Gli identificativi (delivery_id, user_id, job_id) restano chiavi di join in
 * memoria e non escono mai nell'output.
 * @returns {null | {kind:'impression'|'click', variant:string, surface:string,
 *   position:string, deliveryKey:string|null, userKey:string|null, burstKey:string,
 *   dedupeKey:string, ms:number, day:string, affinity:boolean|null}}
 */
export function classifyRankingEvent(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const type = String(raw.event_type || '');
  const kind = type.endsWith('_impression') ? 'impression' : type.endsWith('_click') ? 'click' : null;
  if (!kind) return null;
  const ms = toMillis(raw.occurred_at);
  if (ms == null) return null;
  const surface = normalizeSurface(raw.surface, type);
  const deliveryKey = raw.delivery_id ? String(raw.delivery_id) : null;
  const userKey = raw.user_id ? String(raw.user_id) : null;
  const jobKey = String(raw.job_id || '');
  // Una consegna, oppure, per i link legacy senza delivery_id, l'utente su UNA
  // superficie/campagna: due invii diversi dello stesso utente non sono una raffica.
  const burstKey = deliveryKey
    ? `d|${deliveryKey}`
    : `u|${userKey || ''}|${surface}|${String(raw.surface_id || '')}`;
  const dedupeKey = `${burstKey}|${jobKey}`;
  return {
    kind,
    variant: normalizeVariant(raw.ranking_variant),
    surface,
    position: positionBucket(raw.position),
    deliveryKey,
    userKey,
    burstKey,
    dedupeKey,
    ms,
    day: dayOf(ms),
    affinity: typeof raw.affinity_profile === 'boolean' ? raw.affinity_profile : null,
  };
}

/**
 * Filtro dei clic non umani (vedi CLICK_FILTER). Puro.
 * @param {Array<ReturnType<typeof classifyRankingEvent>>} clicks
 */
export function filterClicks(clicks, {
  windowMs = SCAN_BURST_WINDOW_MS,
  minClicks = SCAN_BURST_MIN_TARGETS,
} = {}) {
  const sorted = [...clicks].sort((a, b) => a.ms - b.ms);
  const seen = new Set();
  const unique = [];
  let duplicates = 0;
  for (const c of sorted) {
    if (seen.has(c.dedupeKey)) { duplicates += 1; continue; }
    seen.add(c.dedupeKey);
    unique.push(c);
  }
  // Gruppo della raffica: `burstKey` di classifyRankingEvent.
  const groups = new Map();
  for (const c of unique) {
    const g = c.burstKey;
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(c);
  }
  const burst = new Set();
  for (const list of groups.values()) {
    if (list.length < minClicks) continue;
    let j = 0;
    for (let k = 0; k < list.length; k += 1) {
      while (list[k].ms - list[j].ms > windowMs) j += 1;
      if (k - j + 1 >= minClicks) for (let i = j; i <= k; i += 1) burst.add(list[i]);
    }
  }
  const kept = unique.filter((c) => !burst.has(c));
  return {
    kept,
    dropped: { duplicate: duplicates, burst: burst.size },
  };
}

function ratePct(clicks, impressions) {
  return impressions > 0 ? Number(((clicks / impressions) * 100).toFixed(4)) : null;
}

function round(value, digits = 6) {
  return Number.isFinite(value) ? Number(value.toFixed(digits)) : null;
}

function cell(impressions, clicks) {
  return { impressions, clicks, ctr_pct: ratePct(clicks, impressions) };
}

function bump(map, key, field, amount = 1) {
  let row = map.get(key);
  if (!row) { row = { impressions: 0, clicks: 0 }; map.set(key, row); }
  row[field] += amount;
}

/** media, deviazione standard campionaria e IC 95% (normale) di una lista di somme. */
function meanStats(n, sum, sumSq) {
  if (n === 0) return { n, mean: null, sd: null, ci95: null };
  const mean = sum / n;
  const variance = n > 1 ? Math.max(0, (sumSq - n * mean * mean) / (n - 1)) : 0;
  const se = Math.sqrt(variance / n);
  return { n, mean: round(mean), sd: round(Math.sqrt(variance)), ci95: [round(mean - Z95 * se), round(mean + Z95 * se)], se: round(se, 8) };
}

/**
 * Clic per invio con errore standard robusto al cluster utente (metodo delta
 * su rapporto Σclic/Σinvii, un termine per utente): tiene conto che i clic
 * dello stesso utente su più invii non sono indipendenti.
 */
function clusteredRatio(units) {
  const n = units.length;
  let c = 0; let d = 0;
  for (const u of units) { c += u.clicks; d += u.deliveries; }
  if (n === 0 || d === 0) return { users: n, deliveries: d, clicks: c, clicks_per_delivery: null, se: null, ci95: null };
  const r = c / d;
  const dbar = d / n;
  let ss = 0;
  for (const u of units) ss += (u.clicks - r * u.deliveries) ** 2;
  const se = n > 1 ? Math.sqrt(ss / (n - 1) / n) / dbar : 0;
  return { users: n, deliveries: d, clicks: c, clicks_per_delivery: round(r), se: round(se, 8), ci95: [round(r - Z95 * se), round(r + Z95 * se)] };
}

function diffCi(a, b, field, seField) {
  if (a?.[field] == null || b?.[field] == null || a?.[seField] == null || b?.[seField] == null) return null;
  const diff = a[field] - b[field];
  const se = Math.sqrt(a[seField] ** 2 + b[seField] ** 2);
  const ci95 = [round(diff - Z95 * se), round(diff + Z95 * se)];
  return { diff: round(diff), se: round(se, 8), ci95, excludes_zero: ci95[0] > 0 || ci95[1] < 0 };
}

const sortKeys = (obj) => Object.fromEntries(Object.entries(obj).sort(([a], [b]) => a.localeCompare(b)));

/**
 * Aggregazione degli eventi già classificati. Pura: nessun I/O.
 * @param {{impressions: any[], clicks: any[], rawClicks?: any[]}} input
 *   `clicks` = clic dopo il filtro; `rawClicks` = prima del filtro (per lo scarto).
 */
export function aggregateEvents({ impressions, clicks, rawClicks = clicks }) {
  const vs = new Map(); // variant|surface
  const vsd = new Map(); // variant|surface|day
  const vsp = new Map(); // variant|surface|position
  const rawVs = new Map();
  for (const e of impressions) {
    for (const s of [e.surface, 'all']) {
      bump(vs, `${e.variant}|${s}`, 'impressions');
      bump(vsp, `${e.variant}|${s}|${e.position}`, 'impressions');
    }
    bump(vsd, `${e.variant}|${e.surface}|${e.day}`, 'impressions');
  }
  for (const c of clicks) {
    for (const s of [c.surface, 'all']) {
      bump(vs, `${c.variant}|${s}`, 'clicks');
      bump(vsp, `${c.variant}|${s}|${c.position}`, 'clicks');
    }
    bump(vsd, `${c.variant}|${c.surface}|${c.day}`, 'clicks');
  }
  for (const c of rawClicks) for (const s of [c.surface, 'all']) bump(rawVs, `${c.variant}|${s}`, 'clicks');

  const variants = [...new Set([...vs.keys()].map((k) => k.split('|')[0]))].sort();

  const byVariantSurface = {};
  for (const [key, row] of vs) {
    const [v, s] = key.split('|');
    byVariantSurface[v] ||= {};
    const raw = rawVs.get(key)?.clicks || 0;
    byVariantSurface[v][s] = { ...cell(row.impressions, row.clicks), clicks_before_filter: raw, ctr_pct_before_filter: ratePct(raw, row.impressions) };
  }
  for (const v of Object.keys(byVariantSurface)) byVariantSurface[v] = sortKeys(byVariantSurface[v]);

  const byDay = [...vsd.entries()].map(([key, row]) => {
    const [variant, surface, day] = key.split('|');
    return { variant, surface, day, ...cell(row.impressions, row.clicks) };
  }).sort((a, b) => a.day.localeCompare(b.day) || a.variant.localeCompare(b.variant) || a.surface.localeCompare(b.surface));

  const byPosition = [];
  for (const v of variants) {
    for (const s of [...KNOWN_SURFACES, 'other', 'all']) {
      if (!vs.has(`${v}|${s}`)) continue;
      for (const p of POSITION_BUCKETS) {
        const row = vsp.get(`${v}|${s}|${p}`);
        if (!row) continue;
        byPosition.push({ variant: v, surface: s, position: p, ...cell(row.impressions, row.clicks) });
      }
    }
  }

  // Unità statistiche: la consegna e l'utente. I clic contano solo se la loro
  // consegna ha impression nel periodo (altrimenti il denominatore manca).
  const deliveries = new Map(); // deliveryKey → {variant, surface, user, clicks}
  for (const e of impressions) {
    if (!e.deliveryKey) continue;
    if (!deliveries.has(e.deliveryKey)) deliveries.set(e.deliveryKey, { variant: e.variant, surface: e.surface, user: e.userKey, clicks: 0 });
  }
  let unmatched = 0;
  for (const c of clicks) {
    const d = c.deliveryKey ? deliveries.get(c.deliveryKey) : null;
    if (d) d.clicks += 1; else unmatched += 1;
  }
  const perDeliveryAcc = new Map();
  const perUserAcc = new Map(); // variant|surface → Map(user → {deliveries, clicks})
  for (const d of deliveries.values()) {
    for (const s of [d.surface, 'all']) {
      const key = `${d.variant}|${s}`;
      const acc = perDeliveryAcc.get(key) || { n: 0, sum: 0, sumSq: 0 };
      acc.n += 1; acc.sum += d.clicks; acc.sumSq += d.clicks * d.clicks;
      perDeliveryAcc.set(key, acc);
      if (!perUserAcc.has(key)) perUserAcc.set(key, new Map());
      const users = perUserAcc.get(key);
      const uk = d.user || `anon|${users.size}`;
      const u = users.get(uk) || { deliveries: 0, clicks: 0 };
      u.deliveries += 1; u.clicks += d.clicks;
      users.set(uk, u);
    }
  }
  const perDelivery = {};
  for (const [key, acc] of perDeliveryAcc) {
    const [v, s] = key.split('|');
    perDelivery[v] ||= {};
    perDelivery[v][s] = { deliveries: acc.n, clicks: acc.sum, clicks_per_delivery: meanStats(acc.n, acc.sum, acc.sumSq) };
  }
  const perUser = {};
  for (const [key, users] of perUserAcc) {
    const [v, s] = key.split('|');
    const units = [...users.values()];
    let sum = 0; let sumSq = 0;
    for (const u of units) { sum += u.clicks; sumSq += u.clicks * u.clicks; }
    perUser[v] ||= {};
    perUser[v][s] = {
      clicks_per_user: meanStats(units.length, sum, sumSq),
      clicks_per_delivery_user_clustered: clusteredRatio(units),
    };
  }

  const comparisons = {};
  if (perUser.control) {
    for (const v of variants) {
      if (v === 'control') continue;
      for (const s of [...KNOWN_SURFACES, 'other', 'all']) {
        const a = perUser[v]?.[s]; const b = perUser.control?.[s];
        if (!a || !b) continue;
        comparisons[`${v}_vs_control`] ||= {};
        comparisons[`${v}_vs_control`][s] = {
          clicks_per_delivery_user_clustered: diffCi(a.clicks_per_delivery_user_clustered, b.clicks_per_delivery_user_clustered, 'clicks_per_delivery', 'se'),
          clicks_per_delivery_independent: diffCi(perDelivery[v]?.[s]?.clicks_per_delivery, perDelivery.control?.[s]?.clicks_per_delivery, 'mean', 'se'),
        };
      }
    }
  }

  const totals = { impressions: impressions.length, clicks: clicks.length, clicks_before_filter: rawClicks.length };
  return {
    variants,
    totals: { ...totals, ctr_pct: ratePct(totals.clicks, totals.impressions), ctr_pct_before_filter: ratePct(totals.clicks_before_filter, totals.impressions) },
    by_variant_surface: sortKeys(byVariantSurface),
    by_variant_surface_day: byDay,
    by_variant_surface_position: byPosition,
    per_delivery: sortKeys(perDelivery),
    per_user: sortKeys(perUser),
    comparisons_vs_control: comparisons,
    clicks_without_delivery_in_period: unmatched,
  };
}

/** Somme esatte di `job_email_ranking_stats` (campi `*_by_variant`). Pura. */
export function aggregateStats(docs) {
  const vs = new Map();
  const vsd = new Map();
  let plainImpr = 0; let plainClicks = 0; let byVariantImpr = 0; let byVariantClicks = 0;
  for (const d of docs) {
    if (!d) continue;
    const surface = normalizeSurface(d.surface, '');
    const day = String(d.date || '');
    plainImpr += Number(d.impressions) || 0;
    plainClicks += Number(d.clicks) || 0;
    for (const [field, map] of [['impressions', d.impressions_by_variant], ['clicks', d.clicks_by_variant]]) {
      for (const [variantRaw, n] of Object.entries(map || {})) {
        const amount = Number(n) || 0;
        if (!amount) continue;
        const v = normalizeVariant(variantRaw);
        if (field === 'impressions') byVariantImpr += amount; else byVariantClicks += amount;
        bump(vs, `${v}|${surface}`, field, amount);
        bump(vs, `${v}|all`, field, amount);
        bump(vsd, `${v}|${surface}|${day}`, field, amount);
      }
    }
  }
  const byVariantSurface = {};
  for (const [key, row] of vs) {
    const [v, s] = key.split('|');
    byVariantSurface[v] ||= {};
    byVariantSurface[v][s] = cell(row.impressions, row.clicks);
  }
  for (const v of Object.keys(byVariantSurface)) byVariantSurface[v] = sortKeys(byVariantSurface[v]);
  const byDay = [...vsd.entries()].map(([key, row]) => {
    const [variant, surface, day] = key.split('|');
    return { variant, surface, day, ...cell(row.impressions, row.clicks) };
  }).sort((a, b) => a.day.localeCompare(b.day) || a.variant.localeCompare(b.variant) || a.surface.localeCompare(b.surface));
  return {
    documents: docs.length,
    totals: {
      impressions: plainImpr,
      clicks: plainClicks,
      ctr_pct: ratePct(plainClicks, plainImpr),
      impressions_by_variant_sum: byVariantImpr,
      clicks_by_variant_sum: byVariantClicks,
    },
    by_variant_surface: sortKeys(byVariantSurface),
    by_variant_surface_day: byDay,
  };
}

/**
 * Report completo dagli input grezzi. Pura.
 * @param {{events: object[], stats?: object[], deliveryAffinity?: Map<string, boolean>}} input
 */
export function buildExperimentReport({ events, stats = [], deliveryAffinity = new Map(), filter = {} }) {
  const impressions = [];
  const rawClicks = [];
  let unclassified = 0;
  for (const raw of events) {
    const e = classifyRankingEvent(raw);
    if (!e) { unclassified += 1; continue; }
    (e.kind === 'impression' ? impressions : rawClicks).push(e);
  }
  // affinity_profile: valore dell'evento, poi della consegna (documento
  // delivery o una qualunque impression della stessa consegna).
  const affinityByDelivery = new Map(deliveryAffinity);
  for (const e of impressions) {
    if (e.affinity != null && e.deliveryKey && !affinityByDelivery.has(e.deliveryKey)) affinityByDelivery.set(e.deliveryKey, e.affinity);
  }
  for (const e of [...impressions, ...rawClicks]) {
    if (e.affinity == null && e.deliveryKey && affinityByDelivery.has(e.deliveryKey)) e.affinity = affinityByDelivery.get(e.deliveryKey);
  }
  const { kept, dropped } = filterClicks(rawClicks, filter);
  const report = {
    unclassified_events: unclassified,
    click_filter_effect: { clicks_before_filter: rawClicks.length, dropped_duplicate: dropped.duplicate, dropped_burst: dropped.burst, clicks_after_filter: kept.length },
    events: aggregateEvents({ impressions, clicks: kept, rawClicks }),
    stats_exact: aggregateStats(stats),
    by_affinity_profile: null,
  };
  const hasAffinity = impressions.some((e) => e.affinity != null) || kept.some((c) => c.affinity != null);
  if (hasAffinity) {
    const split = {};
    for (const [label, value] of [['true', true], ['false', false], ['unset', null]]) {
      const imp = impressions.filter((e) => e.affinity === value);
      const clk = kept.filter((c) => c.affinity === value);
      if (!imp.length && !clk.length) continue;
      split[label] = aggregateEvents({ impressions: imp, clicks: clk, rawClicks: rawClicks.filter((c) => c.affinity === value) });
    }
    report.by_affinity_profile = split;
  }
  report.consistency = consistencyChecks(report);
  return report;
}

/** Riconciliazione eventi ↔ stats e posizioni ↔ totale. Pura. */
export function consistencyChecks(report) {
  const ev = report.events;
  const st = report.stats_exact;
  const variants = [...new Set([...Object.keys(ev.by_variant_surface), ...Object.keys(st.by_variant_surface)])].sort();
  const byVariant = {};
  for (const v of variants) {
    const e = ev.by_variant_surface[v]?.all || { impressions: 0, clicks: 0, clicks_before_filter: 0 };
    const s = st.by_variant_surface[v]?.all || { impressions: 0, clicks: 0 };
    const posRows = ev.by_variant_surface_position.filter((r) => r.variant === v && r.surface === 'all');
    byVariant[v] = {
      stats_ctr_pct: ratePct(s.clicks, s.impressions),
      events_ctr_pct_before_filter: ratePct(e.clicks_before_filter, e.impressions),
      events_ctr_pct_after_filter: ratePct(e.clicks, e.impressions),
      impressions_events_minus_stats: e.impressions - s.impressions,
      clicks_before_filter_events_minus_stats: e.clicks_before_filter - s.clicks,
      clicks_dropped_by_filter: e.clicks_before_filter - e.clicks,
      position_sum_impressions: posRows.reduce((a, r) => a + r.impressions, 0),
      position_sum_clicks: posRows.reduce((a, r) => a + r.clicks, 0),
      position_sum_matches_total: posRows.reduce((a, r) => a + r.impressions, 0) === e.impressions
        && posRows.reduce((a, r) => a + r.clicks, 0) === e.clicks,
    };
  }
  return { by_variant: byVariant };
}

// ── guardia identificativi ───────────────────────────────────────────────────

const FORBIDDEN_KEYS = new Set(['email', 'user_id', 'uid', 'message_id', 'delivery_id', 'doc_id', 'document_id', 'alert_id', 'newsletter_id', 'job_id', 'subscriber_id']);

/**
 * Cerca identificativi nell'output: chiavi vietate, indirizzi email, hash
 * lunghi (id documento, user_id pseudonimi). Gli unici hex ammessi sono i
 * commit git, sotto una chiave `commit` o `*_commit`. Pura.
 * @returns {string[]} percorsi dei valori sospetti (vuoto = pulito)
 */
export function findIdentifierLeaks(value, path = '$', key = '') {
  const leaks = [];
  const commitKey = key === 'commit' || key.endsWith('_commit');
  const checkString = (text, where) => {
    if (/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i.test(text)) leaks.push(`${where} (email)`);
    else if (!commitKey && /\b[0-9a-f]{20,}\b/i.test(text)) leaks.push(`${where} (hash/id)`);
    else if (!commitKey && !/\s/.test(text) && /^[A-Za-z0-9_-]{28,}$/.test(text) && /\d/.test(text) && /[A-Za-z]/.test(text)) leaks.push(`${where} (id opaco)`);
  };
  if (FORBIDDEN_KEYS.has(key)) leaks.push(`${path} (chiave vietata)`);
  if (typeof value === 'string') {
    checkString(value, path);
  } else if (Array.isArray(value)) {
    value.forEach((v, i) => leaks.push(...findIdentifierLeaks(v, `${path}[${i}]`, key)));
  } else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      checkStringKey(k, `${path}.${k}`, leaks);
      leaks.push(...findIdentifierLeaks(v, `${path}.${k}`, k));
    }
  }
  return leaks;
}

/** Le chiavi vengono dai dati (etichette di variante): stesse regole dei valori. */
function checkStringKey(key, where, leaks) {
  if (/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i.test(key)) leaks.push(`${where} (email nella chiave)`);
  else if (/\b[0-9a-f]{20,}\b/i.test(key)) leaks.push(`${where} (hash/id nella chiave)`);
}

// ── IO ───────────────────────────────────────────────────────────────────────

export function parseArgs(argv) {
  const out = { notes: [], pageSize: 5000, withDeliveries: false, checkRemoteConfig: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = () => { i += 1; if (i >= argv.length) throw new Error(`${a} richiede un valore`); return argv[i]; };
    if (a === '--from') out.from = next();
    else if (a === '--to') out.to = next();
    else if (a === '--out') out.out = next();
    else if (a === '--experiment') out.experiment = next();
    else if (a === '--note') out.notes.push(next());
    else if (a === '--page-size') out.pageSize = Math.max(100, Math.min(10000, Number(next()) || 5000));
    else if (a === '--with-deliveries') out.withDeliveries = true;
    else if (a === '--check-remote-config') out.checkRemoteConfig = true;
    else throw new Error(`opzione sconosciuta: ${a}`);
  }
  if (!out.from) throw new Error('--from <ISO> obbligatorio');
  const fromMs = toMillis(out.from);
  if (fromMs == null) throw new Error(`--from non valido: ${out.from}`);
  const now = Date.now();
  const requestedTo = out.to ? toMillis(out.to) : now;
  if (requestedTo == null) throw new Error(`--to non valido: ${out.to}`);
  // Le stats sono per giorno UTC intero mentre gli eventi si leggono per
  // [from, to): estremi a metà giornata farebbero contare alle stats ore fuori
  // dalla finestra. Unico taglio ammesso a metà giornata: l'ora del run, dove
  // nessuna delle due fonti ha dati oltre.
  const midnightUtc = (ms) => ms % 86_400_000 === 0;
  if (!midnightUtc(fromMs)) throw new Error(`--from deve essere una mezzanotte UTC (es. 2026-09-08T00:00:00Z): ${out.from}`);
  if (out.to && !midnightUtc(requestedTo)) throw new Error(`--to deve essere una mezzanotte UTC (es. 2026-10-04T00:00:00Z): ${out.to}`);
  out.fromMs = fromMs;
  out.requestedToMs = requestedTo;
  out.toMs = Math.min(requestedTo, now);
  if (out.toMs <= fromMs) throw new Error('--to deve essere dopo --from');
  return out;
}

async function initFirebase() {
  const { initializeApp, cert, getApps, applicationDefault } = await import('firebase-admin/app');
  const { getFirestore } = await import('firebase-admin/firestore');
  if (getApps().length === 0) {
    const projectId = 'frontaliere-ticino';
    if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
      initializeApp({ credential: cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON)), projectId });
    } else if (process.env.GOOGLE_APPLICATION_CREDENTIALS && fs.existsSync(process.env.GOOGLE_APPLICATION_CREDENTIALS)) {
      const cred = JSON.parse(fs.readFileSync(process.env.GOOGLE_APPLICATION_CREDENTIALS, 'utf8'));
      initializeApp(cred.private_key ? { credential: cert(cred), projectId } : { credential: applicationDefault(), projectId });
    } else {
      initializeApp({ credential: applicationDefault(), projectId });
    }
  }
  return getFirestore();
}

const EVENT_FIELDS = ['event_type', 'surface', 'surface_id', 'delivery_id', 'job_id', 'position', 'ranking_variant', 'user_id', 'occurred_at', 'affinity_profile'];
const STATS_FIELDS = ['surface', 'date', 'impressions', 'clicks', 'impressions_by_variant', 'clicks_by_variant'];

async function readPaged(query, pageSize, onPage) {
  let reads = 0;
  let last = null;
  for (;;) {
    const page = await (last ? query.startAfter(last) : query).limit(pageSize).get();
    reads += Math.max(1, page.size); // una query vuota costa comunque una lettura
    if (page.empty) break;
    onPage(page.docs);
    last = page.docs[page.docs.length - 1];
    if (page.size < pageSize) break;
  }
  return reads;
}

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

function gitLines(args) {
  try {
    return execFileSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim().split('\n').filter(Boolean);
  } catch { return []; }
}

/** Commit del modulo di ranking in vigore durante il periodo (l'ultimo prima di `from` + quelli dentro). */
export function rankingModuleCommits(fromIso, toIso, file = 'functions/src/lib/jobEmailRanking.js') {
  const fmt = '--format=%H%x09%cI%x09%s';
  const before = gitLines(['log', '-1', fmt, `--until=${fromIso}`, 'origin/main', '--', file]);
  const during = gitLines(['log', fmt, `--since=${fromIso}`, `--until=${toIso}`, 'origin/main', '--', file]).reverse();
  const atEnd = gitLines(['log', '-1', fmt, `--until=${toIso}`, 'origin/main', '--', file]);
  const row = (line) => { const [commit, date, subject] = line.split('\t'); return { commit, date, subject }; };
  return {
    file,
    in_force_at_start_commit: before[0] ? row(before[0]).commit : null,
    changes_during_period: during.map(row),
    in_force_at_end_commit: atEnd[0] ? row(atEnd[0]).commit : null,
  };
}

async function readRemoteConfigOverrides() {
  const { getRemoteConfig } = await import('firebase-admin/remote-config');
  const template = await getRemoteConfig().getTemplate();
  const found = {};
  const scan = (params) => {
    for (const [name, p] of Object.entries(params || {})) {
      if (/^JOB_EMAIL_RANKING_/.test(name)) {
        found[name] = { default: p?.defaultValue?.value ?? null, conditional: Object.keys(p?.conditionalValues || {}) };
      }
    }
  };
  scan(template.parameters);
  for (const group of Object.values(template.parameterGroups || {})) scan(group?.parameters);
  return { checked: true, template_version: template.version?.versionNumber ?? null, job_email_ranking_parameters: found };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const fromIso = new Date(opts.fromMs).toISOString();
  const toIso = new Date(opts.toMs).toISOString();
  const generatedAt = new Date().toISOString();
  const db = await initFirebase();
  const reads = { events: 0, stats: 0, deliveries: 0 };

  console.log(`📥 eventi ${fromIso} → ${toIso}`);
  const events = [];
  reads.events = await readPaged(
    db.collection(JOB_EMAIL_RANKING_EVENTS_COLLECTION)
      .where('occurred_at', '>=', new Date(opts.fromMs))
      .where('occurred_at', '<', new Date(opts.toMs))
      .orderBy('occurred_at')
      .select(...EVENT_FIELDS),
    opts.pageSize,
    (docs) => {
      for (const d of docs) events.push(d.data());
      if (events.length % 50000 < docs.length) console.log(`   … ${events.length} eventi`);
    },
  );

  // `date` è il giorno UTC: un `to` a mezzanotte esclude quel giorno.
  const fromDay = dayOf(opts.fromMs);
  const lastDay = dayOf(opts.toMs - 1);
  console.log(`📥 stats ${fromDay} → ${lastDay}`);
  const stats = [];
  reads.stats = await readPaged(
    db.collection(JOB_EMAIL_RANKING_STATS_COLLECTION)
      .where('date', '>=', fromDay)
      .where('date', '<=', lastDay)
      .orderBy('date')
      .select(...STATS_FIELDS),
    opts.pageSize,
    (docs) => { for (const d of docs) stats.push(d.data()); },
  );

  const deliveryAffinity = new Map();
  if (opts.withDeliveries) {
    console.log('📥 consegne (affinity_profile)');
    reads.deliveries = await readPaged(
      db.collection(JOB_EMAIL_RANKING_DELIVERIES_COLLECTION)
        .where('sent_at', '>=', new Date(opts.fromMs))
        .where('sent_at', '<', new Date(opts.toMs))
        .orderBy('sent_at')
        .select('delivery_id', 'affinity_profile'),
      opts.pageSize,
      (docs) => {
        for (const d of docs) {
          const x = d.data();
          if (x.delivery_id && typeof x.affinity_profile === 'boolean') deliveryAffinity.set(String(x.delivery_id), x.affinity_profile);
        }
      },
    );
  }

  let remoteConfig = { checked: false };
  if (opts.checkRemoteConfig) {
    try { remoteConfig = await readRemoteConfigOverrides(); } catch (e) { remoteConfig = { checked: false, error: String(e?.message || e).slice(0, 200) }; }
  }

  const body = buildExperimentReport({ events, stats, deliveryAffinity });
  const report = {
    _what: 'Fotografia aggregata di un esperimento di ordinamento degli annunci nelle email (job alert e newsletter): impression, clic e CTR per variante, superficie, giorno e posizione, più clic per invio e per utente. Solo aggregati: nessun identificativo.',
    _how: 'node scripts/report-job-email-ranking-experiment.mjs (vedi docblock). Eventi letti per range di occurred_at e classificati nel codice; somme esatte da job_email_ranking_stats; CTR in percentuale con 4 decimali.',
    schema_version: REPORT_SCHEMA_VERSION,
    generated_at: generatedAt,
    experiment: opts.experiment || null,
    notes: opts.notes,
    period: {
      from: fromIso,
      to: toIso,
      requested_to: new Date(opts.requestedToMs).toISOString(),
      truncated_to_run_time: opts.toMs < opts.requestedToMs,
      events_window: 'occurred_at in [from, to): impression per data di invio, clic per data del clic',
      stats_window: `date (giorno UTC) in [${fromDay}, ${lastDay}]`,
    },
    ranking_module: rankingModuleCommits(fromIso, toIso),
    parameters: { code_defaults: { ...JOB_EMAIL_RANKING_DEFAULTS }, remote_config: remoteConfig },
    sources: {
      stats: JOB_EMAIL_RANKING_STATS_COLLECTION,
      events: JOB_EMAIL_RANKING_EVENTS_COLLECTION,
      deliveries: opts.withDeliveries ? JOB_EMAIL_RANKING_DELIVERIES_COLLECTION : null,
      retention_days: JOB_EMAIL_RANKING_RETENTION_DAYS,
    },
    click_filter: CLICK_FILTER,
    reads: { ...reads, total: reads.events + reads.stats + reads.deliveries, events_documents: events.length, stats_documents: stats.length },
    ...body,
  };

  const leaks = findIdentifierLeaks(report);
  if (leaks.length) {
    console.error('❌ identificativi nell\'output, niente scrittura:', leaks.slice(0, 10));
    process.exitCode = 2;
    return;
  }

  for (const [v, row] of Object.entries(report.consistency.by_variant)) {
    console.log(`  ${v}: stats CTR ${row.stats_ctr_pct}% | eventi ${row.events_ctr_pct_before_filter}% → filtrati ${row.events_ctr_pct_after_filter}% | Δimpr ${row.impressions_events_minus_stats} Δclic ${row.clicks_before_filter_events_minus_stats} | posizioni ok ${row.position_sum_matches_total}`);
  }
  console.log(`📊 letture: ${report.reads.total} (eventi ${reads.events}, stats ${reads.stats}, consegne ${reads.deliveries})`);
  if (opts.out) {
    fs.writeFileSync(opts.out, `${JSON.stringify(report, null, 2)}\n`);
    console.log(`📄 ${opts.out}`);
  } else {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  }
}

const isDirectRun = (() => {
  try { return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href; } catch { return false; }
})();
if (isDirectRun) {
  main().catch((e) => {
    console.error('❌ report-job-email-ranking-experiment failed:', e?.stack || e);
    process.exit(1);
  });
}
