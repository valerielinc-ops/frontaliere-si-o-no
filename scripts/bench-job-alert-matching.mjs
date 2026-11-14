#!/usr/bin/env node
/**
 * bench-job-alert-matching.mjs — costo del matching dei job alert: percorso
 * legacy (lo scorer su ogni riga della finestra) contro indice dei candidati a
 * bitset (perf-plan PR 2).
 *
 * Misura, per ogni alert sintetico, i millisecondi di `planAlertMatch` nei due
 * percorsi e le righe passate allo scorer, e verifica che i due piani siano
 * IDENTICI (candidateCount, rankedCount, zeroCause, matched: id, ordine, score).
 * Un piano diverso fa uscire il processo con codice 1: il bench è anche un test.
 *
 * Dati. Di default un inventario SINTETICO (descrizioni lunghe come in
 * produzione, ~2,4 KB) e alert sintetici ricavati dal vocabolario
 * dell'inventario stesso, con una distribuzione dei criteri simile a quella
 * dei job alert reali (keyword dure, geo, settore, azienda, annuncio fisso,
 * profilo vuoto). Con `--jobs <file>` si usa invece un data/jobs.json reale
 * (dati pubblici, non di subscriber): le date vengono traslate con
 * `--rebase-now` perché i crawl di un file vecchio non cadono più nella
 * finestra di oggi.
 *
 * MAI email o documenti reali di subscriber: gli indirizzi sono
 * `bench-<n>@example.test` e nessun dato di Firestore viene letto o scritto.
 *
 * Uso:
 *   node scripts/bench-job-alert-matching.mjs [--rows 35000] [--alerts 60]
 *        [--seed 42] [--jobs data/jobs.json --rebase-now] [--json]
 *        [--max-legacy-seconds 600] [--no-search] [--index-only]
 *
 * `--no-search` toglie gli alert con ricerca testuale (`job_search_query`):
 * la ricerca stemmed costa lo stesso nei due percorsi (haystack per riga) e,
 * con pochi alert, nasconde il guadagno degli altri rami.
 */
import fs from 'node:fs';
import { performance } from 'node:perf_hooks';
import {
  createJobFeatureCache,
  createJobFeatureStore,
} from '../services/jobAlertMatching.mjs';
import {
  comparePlanOutcomes,
  createJobAlertCandidateIndex,
} from './lib/job-alert-candidate-index.mjs';
import { createJobAlertCandidateSelector, resolveJobAlertCursor } from './lib/job-alert-newness.mjs';
import { planAlertMatch } from './send-job-alerts.mjs';
import { nlNormLocale } from '../services/newsletter-template.mjs';

const DAY = 24 * 60 * 60 * 1000;

function parseArgs(argv) {
  const args = { rows: 35_000, alerts: 60, seed: 42, jobs: null, rebaseNow: false, json: false, maxLegacySeconds: 600, search: true, indexOnly: false };
  for (let i = 0; i < argv.length; i++) {
    const [key, inline] = argv[i].split('=');
    const next = () => (inline !== undefined ? inline : argv[++i]);
    switch (key) {
      case '--rows': args.rows = Number(next()); break;
      case '--alerts': args.alerts = Number(next()); break;
      case '--seed': args.seed = Number(next()); break;
      case '--jobs': args.jobs = next(); break;
      case '--rebase-now': args.rebaseNow = true; break;
      case '--json': args.json = true; break;
      case '--max-legacy-seconds': args.maxLegacySeconds = Number(next()); break;
      case '--no-search': args.search = false; break;
      case '--index-only': args.indexOnly = true; break;
      default: throw new Error(`argomento sconosciuto: ${key}`);
    }
  }
  return args;
}

function prng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const TITLE_WORDS = ['Infermiere', 'Cuoco', 'Magazziniere', 'Contabile', 'Ingegnere', 'Software', 'Developer', 'Elettricista',
  'Meccanico', 'Autista', 'Receptionist', 'Cameriere', 'Direttore', 'Assistente', 'Analista', 'Project', 'Manager', 'Venditore',
  'Pflegefachfrau', 'Sachbearbeiter', 'Ingénieur', 'Comptable', 'Technicien', 'Operatore', 'Responsabile', 'Addetto', 'Specialista'];
const QUALIFIERS = ['senior', 'junior', 'diplomato', '80-100%', 'part-time', 'Java', 'SAP', 'logistica', 'cantiere', 'sanità', 'banca', 'turni'];
const PLACES = [['Lugano', 'TI'], ['Bellinzona', 'TI'], ['Mendrisio', 'TI'], ['Chiasso', 'TI'], ['Locarno', 'TI'], ['Zürich', 'ZH'],
  ['Genève', 'GE'], ['Basel', 'BS'], ['Bern', 'BE'], ['Lausanne', 'VD'], ['St. Gallen', 'SG'], ['Chur', 'GR'], ['Luzern', 'LU'], ['Zug', 'ZG']];
const COMPANIES = ['EOC', 'Coop Ticino', 'Banca Stato SA', 'ABB Svizzera', 'Migros', 'Galaxus', 'Ospedale Regionale', 'Swisscom', 'SBB', 'Hotel Splendide', ''];
const CATEGORIES = ['sanità', 'informatica', 'finanza', 'ristorazione', 'engineering', 'vendite marketing', 'logistica', 'costruzioni'];
const SECTORS = ['healthcare', 'it', 'finance', 'hospitality', 'manufacturing', 'retail', 'construction'];
const CONTRACTS = ['full-time', 'part-time', 'temporary', 'apprenticeship'];
const FILLER_SENTENCES = [
  'Ambiente di lavoro dinamico, formazione continua e buone prospettive di crescita professionale.',
  'Offriamo un contratto a tempo indeterminato, orario flessibile e prestazioni sociali moderne.',
  'Si richiede esperienza nel ruolo, affidabilità, capacità di lavorare in team e buone conoscenze linguistiche.',
  'La sede di lavoro e raggiungibile con i mezzi pubblici; sono previste indennita di trasferta per i frontalieri.',
  'Inviate la vostra candidatura completa di curriculum vitae e certificati di lavoro entro la data indicata.',
];

function syntheticInventory(count, rand, nowMs) {
  const pick = (list) => list[Math.floor(rand() * list.length)];
  const jobs = [];
  for (let i = 0; i < count; i++) {
    const [location, canton] = pick(PLACES);
    const title = `${pick(TITLE_WORDS)} ${pick(QUALIFIERS)}`;
    let description = '';
    for (let s = 0; s < 18; s++) description += `${pick(FILLER_SENTENCES)} `;
    if (rand() < 0.2) description += `Cerchiamo ${pick(TITLE_WORDS).toLowerCase()} esperto. `;
    jobs.push({
      id: `bench-job-${i}`,
      slug: `bench-job-${i}`,
      title,
      titleByLocale: rand() < 0.5 ? { de: `${title} (DE)`, en: `${title} EN`, fr: `${title} FR` } : {},
      description,
      company: pick(COMPANIES),
      category: pick(CATEGORIES),
      sector: pick(SECTORS),
      location,
      canton,
      contract: pick(CONTRACTS),
      // Quasi tutto l'inventario è ri-crawlato nell'ultimo giorno, come in produzione.
      crawledAt: new Date(nowMs - Math.floor(rand() * 0.9 * DAY)).toISOString(),
      firstSeenAt: new Date(nowMs - Math.floor(rand() * 40) * DAY).toISOString(),
      ...(rand() < 0.01 ? { canary: true } : {}),
      ...(rand() < 0.03 ? { needsRetranslation: true, sourceLang: pick(['de', 'fr', 'en']) } : {}),
    });
  }
  return jobs;
}

function loadRealInventory(path, rebaseNow, nowMs) {
  const raw = JSON.parse(fs.readFileSync(path, 'utf8'));
  const rows = Array.isArray(raw) ? raw : (raw.jobs || []);
  if (rebaseNow) {
    // Trasla ogni crawledAt in modo che la riga più recente cada «adesso».
    const times = rows.map((job) => Date.parse(job.crawledAt)).filter(Number.isFinite);
    const shift = nowMs - Math.max(...times);
    for (const job of rows) {
      const at = Date.parse(job.crawledAt);
      if (Number.isFinite(at)) job.crawledAt = new Date(at + shift).toISOString();
      const first = Date.parse(job.firstSeenAt);
      if (Number.isFinite(first)) job.firstSeenAt = new Date(first + shift).toISOString();
    }
  }
  return rows;
}

/** Alert sintetici con la distribuzione dei criteri dei job alert reali (stime, non dati di subscriber). */
function syntheticAlerts(count, rand, jobs, { search = true } = {}) {
  const pick = (list) => list[Math.floor(rand() * list.length)];
  const words = [...new Set(jobs.slice(0, 2000).flatMap((job) => String(job.title || '').toLowerCase().split(/[^a-zà-ü]+/)).filter((w) => w.length >= 5))];
  const cities = [...new Set(jobs.slice(0, 2000).map((job) => job.location).filter(Boolean))];
  const alerts = [];
  const subscribers = new Map();
  for (let i = 0; i < count; i++) {
    const email = `bench-${i}@example.test`;
    const alert = { id: `bench-alert-${i}`, email, locale: pick(['it', 'it', 'it', 'de', 'fr', 'en']) };
    const subscriber = {};
    const roll = rand();
    if (roll < 0.04) alert.specificJobId = pick(jobs).id;
    else if (roll < 0.07) alert.specificCompanyKey = 'eoc';
    else if (roll < 0.52) { // keyword dure (le più comuni)
      alert.keywords = [pick(words), ...(rand() < 0.4 ? [pick(words)] : [])];
      if (rand() < 0.4) alert.locations = [pick(cities)];
      if (rand() < 0.3) alert.cantonFilter = [pick(['TI', 'ZH', 'GE', 'VD', 'BE'])];
    } else if (roll < 0.62) { alert.locations = [pick(cities)]; if (rand() < 0.5) alert.sectors = [pick(SECTORS)]; }
    else if (roll < 0.70) alert.cantonFilter = [pick(['TI', 'ZH', 'GE', 'VD'])];
    else if (roll < 0.80) { alert.sourceJobTitle = `${pick(TITLE_WORDS)} ${pick(QUALIFIERS)}`; subscriber.job_company = pick(COMPANIES.filter(Boolean)); }
    else if (roll < 0.86) { alert.sectors = [pick(SECTORS)]; alert.contractTypes = [pick(CONTRACTS)]; }
    else if (roll < 0.92 && search) subscriber.job_search_query = `${pick(words)} ${pick(['lugano', 'zurich', 'ticino'])}`;
    // else: profilo vuoto (discovery o nessun segnale)
    alerts.push(alert);
    subscribers.set(email, subscriber);
  }
  return { alerts, subscribers };
}

function summarize(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const q = (p) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] ?? 0;
  const sum = values.reduce((total, value) => total + value, 0);
  return { n: values.length, mean: sum / Math.max(1, values.length), p50: q(0.5), p95: q(0.95), max: sorted[sorted.length - 1] ?? 0, sum };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const rand = prng(args.seed);
  const nowMs = Date.parse('2026-11-14T05:00:00Z');
  const jobs = args.jobs
    ? loadRealInventory(args.jobs, args.rebaseNow, nowMs)
    : syntheticInventory(args.rows, rand, nowMs);
  const source = args.jobs ? `real:${args.jobs}` : 'synthetic';
  const { alerts, subscribers } = syntheticAlerts(args.alerts, rand, jobs, { search: args.search });

  const selector = createJobAlertCandidateSelector(jobs, { nowMs });
  const buildStarted = performance.now();
  const index = createJobAlertCandidateIndex(jobs, { nowMs });
  const indexBuildMs = performance.now() - buildStarted;

  // Le due cache sono separate per equità: stessa vita (una run), stesso batch.
  const legacyStore = createJobFeatureStore();
  const indexStore = createJobFeatureStore();
  const legacyMs = [];
  const indexMs = [];
  const legacyRows = [];
  const indexRows = [];
  const strategies = {};
  const byStrategy = {};
  let mismatches = 0;
  let legacySeconds = 0;
  let evaluated = 0;
  const windowOptionsFor = () => ({ recipientLastSentAt: new Date(nowMs - 1.2 * DAY), alertCreatedAt: 0, initialLookbackMs: DAY });

  for (const alert of alerts) {
    if (legacySeconds > args.maxLegacySeconds) break;
    const windowOptions = windowOptionsFor();
    const cursor = resolveJobAlertCursor({ ...windowOptions, nowMs });
    const context = {
      behaviorProfiles: new Map(),
      lastClickedUrlByEmail: new Map(),
      locationIndex: new Map(),
      cityToCanton: new Map([['lugano', 'ti']]),
      subscriberProfiles: new Map([[alert.email, subscribers.get(alert.email)]]),
      now: nowMs,
      compactMatches: true,
      allowDiscovery: false,
    };
    let started = performance.now();
    // `--index-only`: salta il legacy (serve a profilare il solo percorso a indice).
    const legacy = args.indexOnly ? null : planAlertMatch(alert, {
      ...context,
      featureCache: createJobFeatureCache(legacyStore),
      recentJobs: selector(windowOptions).jobs,
    });
    const legacyElapsed = performance.now() - started;
    started = performance.now();
    const indexed = planAlertMatch(alert, {
      ...context,
      featureCache: createJobFeatureCache(indexStore),
      candidateIndex: index,
      candidateCursorMs: cursor.cursorMs,
    });
    const indexElapsed = performance.now() - started;
    legacyMs.push(legacyElapsed);
    indexMs.push(indexElapsed);
    legacyRows.push(legacy ? legacy.scoredRows : 0);
    indexRows.push(indexed.scoredRows);
    const strategy = indexed.indexStrategy || 'n/a';
    strategies[strategy] = (strategies[strategy] || 0) + 1;
    const bucket = (byStrategy[strategy] ||= { alerts: 0, legacyMs: 0, indexMs: 0, legacyRows: 0, indexRows: 0 });
    bucket.alerts += 1;
    bucket.legacyMs += legacyElapsed;
    bucket.indexMs += indexElapsed;
    bucket.legacyRows += legacy ? legacy.scoredRows : 0;
    bucket.indexRows += indexed.scoredRows;
    legacySeconds += legacyElapsed / 1000;
    evaluated += 1;
    const verdict = legacy ? comparePlanOutcomes(legacy, indexed) : { equal: true };
    if (!verdict.equal) {
      mismatches += 1;
      console.error(`MISMATCH alert ${alert.id} (${nlNormLocale(alert.locale)}): ${verdict.field}`);
    }
  }

  const legacySummary = summarize(legacyMs);
  const indexSummary = summarize(indexMs);
  const rowsLegacy = summarize(legacyRows);
  const rowsIndex = summarize(indexRows);
  const result = {
    source,
    inventoryRows: jobs.length,
    openRows: index.rowCount,
    alertsEvaluated: evaluated,
    indexBuildMs: Math.round(indexBuildMs),
    legacy: { msPerAlert: Number(legacySummary.mean.toFixed(2)), p95: Number(legacySummary.p95.toFixed(2)), totalMs: Math.round(legacySummary.sum), rowsScoredPerAlert: Math.round(rowsLegacy.mean) },
    index: { msPerAlert: Number(indexSummary.mean.toFixed(2)), p95: Number(indexSummary.p95.toFixed(2)), totalMs: Math.round(indexSummary.sum), rowsScoredPerAlert: Math.round(rowsIndex.mean) },
    speedup: Number((legacySummary.sum / Math.max(1, indexSummary.sum + indexBuildMs)).toFixed(1)),
    rowsReductionPct: Number((100 * (1 - rowsIndex.sum / Math.max(1, rowsLegacy.sum))).toFixed(1)),
    strategies,
    byStrategy: Object.fromEntries(Object.entries(byStrategy).map(([name, b]) => [name, {
      alerts: b.alerts,
      legacyMsPerAlert: Number((b.legacyMs / b.alerts).toFixed(1)),
      indexMsPerAlert: Number((b.indexMs / b.alerts).toFixed(1)),
      legacyRowsPerAlert: Math.round(b.legacyRows / b.alerts),
      indexRowsPerAlert: Math.round(b.indexRows / b.alerts),
    }])),
    bitsets: index.stats(),
    mismatches,
    heapUsedMiB: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
  };
  if (args.json) console.log(JSON.stringify(result, null, 2));
  else {
    console.log(`Bench job-alert matching — ${source}, ${result.inventoryRows} righe (${result.openRows} aperte), ${result.alertsEvaluated} alert sintetici`);
    console.log(`  legacy : ${result.legacy.msPerAlert} ms/alert (p95 ${result.legacy.p95}), ${result.legacy.rowsScoredPerAlert} righe allo scorer per alert`);
    console.log(`  indice : ${result.index.msPerAlert} ms/alert (p95 ${result.index.p95}), ${result.index.rowsScoredPerAlert} righe allo scorer per alert; costruzione ${result.indexBuildMs} ms`);
    console.log(`  accelerazione totale ${result.speedup}x (costruzione compresa), righe valutate -${result.rowsReductionPct}%`);
    console.log(`  strategie: ${JSON.stringify(strategies)}`);
    for (const [name, b] of Object.entries(result.byStrategy)) {
      console.log(`    ${name.padEnd(13)} ${String(b.alerts).padStart(4)} alert · legacy ${b.legacyMsPerAlert} ms (${b.legacyRowsPerAlert} righe) → indice ${b.indexMsPerAlert} ms (${b.indexRowsPerAlert} righe)`);
    }
    console.log(`  bitset: ${JSON.stringify(result.bitsets)}`);
    console.log(`  piani diversi: ${mismatches}`);
  }
  if (mismatches > 0) process.exit(1);
}

main().catch((error) => {
  console.error(error?.stack || error);
  process.exit(1);
});
