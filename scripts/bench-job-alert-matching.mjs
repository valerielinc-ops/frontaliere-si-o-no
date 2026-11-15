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
 *        [--max-legacy-seconds 600] [--no-search] [--index-only] [--production-mix]
 *        [--strategy-mix] [--recrawl-all] [--lean] [--legacy-alerts 12]
 *        [--prepare-vocabulary workers|single-pass]
 *
 * Con `node --expose-gc` il bench misura anche la memoria VIVA (heap + buffer
 * esterni dopo un GC forzato ogni 25 alert): `heapUsed` senza GC include i rifiuti
 * non ancora raccolti e non dice quanto resta davvero referenziato.
 *
 * `--no-search` toglie gli alert con ricerca testuale (`job_search_query`):
 * la ricerca stemmed costa lo stesso nei due percorsi (haystack per riga) e,
 * con pochi alert, nasconde il guadagno degli altri rami.
 *
 * `--strategy-mix` genera alert delle SOLE tre strategie che dominano il planning
 * di produzione (soft-legacy, hard-search, hard-keyword, in parti uguali) e confronta
 * tre piani sullo stesso alert: legacy (lo scorer su tutta la finestra), indice con la
 * fast path spenta (`planningFastpath: false`: lo scorer di prima) e indice con la
 * fast path accesa. Riporta ms/alert e µs/riga per strategia e il numero di piani
 * divergenti (deve essere 0). `--recrawl-all` ri-data tutte le righe dell'ultimo giorno
 * come in produzione (dove quasi tutto l'inventario e' ri-crawlato ogni giorno);
 * `--lean` proietta le righe come l'inventario del sender (descriptionByLocale fuori heap).
 * `--prepare-vocabulary workers|single-pass` costruisce prima del ciclo, con
 * `prepareSearchVocabularies`, i vocabolari dei locali degli alert e ne riporta il
 * tempo a parete (il costo che il planning di una run paga una volta sola).
 * L'ordine dei due piani indicizzati si alterna alert per alert (chi gira per primo
 * paga le maschere condivise dell'indice); le cache di feature sono separate e durano
 * tutta la run. Un giro di riscaldamento sullo stesso alert NON si fa: le memo di
 * ricerca di run (per query e riga) lo renderebbero irrealisticamente a buon mercato.
 *
 * `--production-mix` usa la distribuzione delle strategie misurata dal dry-run di
 * produzione (1.171 alert eleggibili): ricerca dura (`hard-search`) 32%, nessun
 * criterio (`never`) 43%, keyword dure 20%, intento legacy (`soft-legacy`) 2,5%,
 * geo senza risultati 1,6%, annuncio fisso 0,5%. Gli alert di ricerca dura sono
 * quelli nati dal backfill (`backfilled_from`) con `job_search_query`.
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
import { projectJobForAlerts } from './lib/job-alert-inventory.mjs';
import { createJobAlertCandidateSelector, resolveJobAlertCursor } from './lib/job-alert-newness.mjs';
import { planAlertMatch } from './send-job-alerts.mjs';
import { nlNormLocale } from '../services/newsletter-template.mjs';

const DAY = 24 * 60 * 60 * 1000;

// Tempo di CPU del processo (user + system), in ms, al posto del tempo a parete:
// il planning e' a un thread solo e su una macchina condivisa il tempo a parete
// misura anche il carico degli altri. I thread di GC sono compresi, i worker del
// vocabolario no (fermi durante la misura).
const cpuNowMs = () => { const u = process.cpuUsage(); return (u.user + u.system) / 1000; };

function parseArgs(argv) {
  const args = { rows: 35_000, alerts: 60, seed: 42, jobs: null, rebaseNow: false, json: false, maxLegacySeconds: 600, search: true, indexOnly: false, productionMix: false, strategyMix: false, recrawlAll: false, lean: false, legacyAlerts: null, prepareVocabulary: null };
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
      case '--production-mix': args.productionMix = true; break;
      case '--strategy-mix': args.strategyMix = true; break;
      case '--recrawl-all': args.recrawlAll = true; break;
      case '--lean': args.lean = true; break;
      case '--legacy-alerts': args.legacyAlerts = Number(next()); break;
      case '--prepare-vocabulary': args.prepareVocabulary = next(); break;
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
function syntheticAlerts(count, rand, jobs, { search = true, productionMix = false, strategyMix = false } = {}) {
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
    if (strategyMix) {
      // Le tre strategie che dominano il planning di produzione, in parti uguali.
      const family = ['soft-legacy', 'hard-search', 'hard-keyword'][i % 3];
      if (family === 'soft-legacy') {
        // Nessuna keyword dura: la ricerca del profilo e' un intento soft con
        // fallback di ricerca (il caso che costa 1,38 s per alert in produzione).
        subscriber.job_search_query = rand() < 0.6 ? pick(words) : `${pick(words)} ${pick(words)}`;
        if (rand() < 0.5) subscriber.location_interest = pick(cities);
        if (rand() < 0.3) subscriber.job_category = pick(CATEGORIES);
        if (rand() < 0.3) subscriber.job_company = pick(COMPANIES.filter(Boolean));
        if (rand() < 0.2) alert.contractTypes = [pick(CONTRACTS)];
      } else if (family === 'hard-search') {
        const query = rand() < 0.4 ? pick(words) : `${pick(words)} ${rand() < 0.5 ? pick(words) : pick(['lugano', 'zurich', 'ticino'])}`;
        alert.backfilled_from = 'newsletter_subscribers:job_gate';
        alert.keywords = [query];
        subscriber.job_search_query = query;
      } else {
        alert.keywords = [pick(words), ...(rand() < 0.4 ? [pick(words)] : [])];
        if (rand() < 0.3) alert.locations = [pick(cities)];
      }
      alerts.push(alert);
      subscribers.set(email, subscriber);
      continue;
    }
    if (productionMix) {
      // Distribuzione del dry-run di produzione (vedi l'intestazione).
      if (roll < 0.32) {
        const query = `${pick(words)} ${rand() < 0.5 ? pick(words) : pick(['lugano', 'zurich', 'ticino'])}`;
        alert.backfilled_from = 'newsletter_subscribers:job_gate';
        alert.keywords = [query];
        subscriber.job_search_query = query;
      } else if (roll < 0.75) { /* never: nessun criterio */ }
      else if (roll < 0.95) {
        alert.keywords = [pick(words), ...(rand() < 0.4 ? [pick(words)] : [])];
        if (rand() < 0.4) alert.locations = [pick(cities)];
      } else if (roll < 0.975) { alert.sourceJobTitle = `${pick(TITLE_WORDS)} ${pick(QUALIFIERS)}`; subscriber.job_company = pick(COMPANIES.filter(Boolean)); }
      else if (roll < 0.991) alert.locations = ['Nowhereville'];
      else alert.specificJobId = pick(jobs).id;
      alerts.push(alert);
      subscribers.set(email, subscriber);
      continue;
    }
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

/** Stesso confronto di `comparePlanOutcomes` piu' i metadata di ranking dei job di `matched`. */
function planDivergence(reference, candidate) {
  const verdict = comparePlanOutcomes(reference, candidate);
  if (!verdict.equal) return verdict.field;
  for (let i = 0; i < reference.matched.length; i++) {
    const a = reference.rankingMetadata?.get(reference.matched[i]);
    const b = candidate.rankingMetadata?.get(candidate.matched[i]);
    if (JSON.stringify(a) !== JSON.stringify(b)) return `matched[${i}].metadata`;
  }
  return null;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const rand = prng(args.seed);
  const nowMs = Date.parse('2026-11-14T05:00:00Z');
  let jobs = args.jobs
    ? loadRealInventory(args.jobs, args.rebaseNow, nowMs)
    : syntheticInventory(args.rows, rand, nowMs);
  if (args.recrawlAll) {
    // Come in produzione: quasi tutto l'inventario e' ri-crawlato nell'ultimo giorno.
    jobs.forEach((job) => { job.crawledAt = new Date(nowMs - Math.floor(rand() * 0.9 * DAY)).toISOString(); });
  }
  if (args.lean) jobs = jobs.map((job) => projectJobForAlerts(job));
  const source = args.jobs ? `real:${args.jobs}` : 'synthetic';
  const { alerts, subscribers } = syntheticAlerts(args.alerts, rand, jobs, { search: args.search, productionMix: args.productionMix, strategyMix: args.strategyMix });

  const selector = createJobAlertCandidateSelector(jobs, { nowMs });
  const buildStarted = performance.now();
  const index = createJobAlertCandidateIndex(jobs, { nowMs });
  const indexBuildMs = performance.now() - buildStarted;

  // Le cache sono separate per equità: stessa vita (una run), stesso batch.
  const legacyStore = createJobFeatureStore();
  const baseStore = createJobFeatureStore();
  const fastStore = createJobFeatureStore();
  const legacyMs = [];
  const baseMs = [];
  const fastMs = [];
  const legacyRows = [];
  const indexRows = [];
  const strategies = {};
  const live = { baselineMiB: null, peakMiB: 0, samples: [] };
  const liveMiB = () => { global.gc(); global.gc(); const u = process.memoryUsage(); return Math.round((u.heapUsed + u.external + u.arrayBuffers) / 1048576); };
  if (typeof global.gc === 'function') live.baselineMiB = liveMiB();
  const byStrategy = {};
  let mismatches = 0;
  let legacySeconds = 0;
  let legacyRun = 0;
  let evaluated = 0;
  const windowOptionsFor = () => ({ recipientLastSentAt: new Date(nowMs - 1.2 * DAY), alertCreatedAt: 0, initialLookbackMs: DAY });
  const vocabularyMs = () => index.stats().searchVocabularyBuildMs;
  let vocabularyPrepare = null;
  if (args.prepareVocabulary) {
    if (typeof index.prepareSearchVocabularies !== 'function') throw new Error('prepareSearchVocabularies non disponibile in questo checkout');
    const locales = [...new Set(alerts.map((alert) => nlNormLocale(alert.locale)))];
    const t0 = performance.now();
    const cpu0 = cpuNowMs();
    const report = await index.prepareSearchVocabularies({ locales, workers: args.prepareVocabulary === 'workers', workerMinRows: 1 });
    // `cpuMs` somma anche i worker: con i worker deve restare vicino alla passata unica.
    vocabularyPrepare = { ...report, requestedMode: args.prepareVocabulary, wallMs: Math.round(performance.now() - t0), cpuMs: Math.round(cpuNowMs() - cpu0) };
  } else {
    // Costruzione pigra (il checkout senza `prepareSearchVocabularies`): si forza qui,
    // fuori dal cronometro, cosi' nessun piano ne porta il costo.
    const t0 = performance.now();
    const cpu0 = cpuNowMs();
    for (const locale of new Set(alerts.map((alert) => nlNormLocale(alert.locale)))) {
      index.select({
        hardKeywords: new Set(['x']), hardCategoryKeys: new Set(), hardTaxonomyValues: new Set(), hardSearchQueries: ['infermiere'],
        softTokens: new Set(), softSearchQueries: [], company: '', locations: [], alertLocations: [], cantons: [], sectors: [],
        contractTypes: [], specificJobIds: [], specificCompanyKey: '', preferredLocations: [], preferredCantons: [],
      }, { locale, ownerAlert: true, cursorMs: 0 });
    }
    vocabularyPrepare = { mode: 'lazy-sequential', requestedMode: 'lazy', wallMs: Math.round(performance.now() - t0), cpuMs: Math.round(cpuNowMs() - cpu0) };
  }

  for (const alert of alerts) {
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
    // `--index-only`: salta il legacy (serve a profilare il solo percorso a indice).
    // `--legacy-alerts N`: il legacy gira solo sui primi N alert (e' il piu' lento).
    const runLegacy = !args.indexOnly
      && legacySeconds <= args.maxLegacySeconds
      && (args.legacyAlerts === null || legacyRun < args.legacyAlerts);
    let started = cpuNowMs();
    const legacy = runLegacy ? planAlertMatch(alert, {
      ...context,
      featureCache: createJobFeatureCache(legacyStore),
      recentJobs: selector(windowOptions).jobs,
    }) : null;
    const legacyElapsed = cpuNowMs() - started;
    if (runLegacy) { legacyRun += 1; legacySeconds += legacyElapsed / 1000; }

    // Indice con la fast path spenta (lo scorer di prima) e accesa. Il vocabolario
    // della ricerca si costruisce UNA volta per locale alla prima ricerca: lo si
    // separa, perche' una run vera lo ammortizza su migliaia di alert.
    const timeIndexed = (planningFastpath, store) => {
      const before = vocabularyMs();
      const t0 = cpuNowMs();
      const plan = planAlertMatch(alert, {
        ...context,
        featureCache: createJobFeatureCache(store),
        candidateIndex: index,
        candidateCursorMs: cursor.cursorMs,
        planningFastpath,
      });
      const elapsed = cpuNowMs() - t0;
      return { plan, elapsed: elapsed - (vocabularyMs() - before) };
    };
    // L'ordine si alterna fra un alert e l'altro: chi gira per primo paga le
    // maschere dell'indice dell'alert (condivise), quindi con l'ordine fisso si
    // confronterebbe l'ordine di esecuzione. Le cache di feature sono invece
    // separate e vivono per tutta la run, come in produzione.
    let base;
    let fast;
    if (evaluated % 2 === 0) { base = timeIndexed(false, baseStore); fast = timeIndexed(true, fastStore); }
    else { fast = timeIndexed(true, fastStore); base = timeIndexed(false, baseStore); }

    legacyMs.push(legacyElapsed);
    baseMs.push(base.elapsed);
    fastMs.push(fast.elapsed);
    legacyRows.push(legacy ? legacy.scoredRows : 0);
    indexRows.push(fast.plan.scoredRows);
    const strategy = fast.plan.indexStrategy || 'n/a';
    strategies[strategy] = (strategies[strategy] || 0) + 1;
    const bucket = (byStrategy[strategy] ||= { alerts: 0, legacyAlerts: 0, legacyMs: 0, baseMs: 0, fastMs: 0, legacyRows: 0, indexRows: 0 });
    bucket.alerts += 1;
    if (legacy) { bucket.legacyAlerts += 1; bucket.legacyMs += legacyElapsed; bucket.legacyRows += legacy.scoredRows; }
    bucket.baseMs += base.elapsed;
    bucket.fastMs += fast.elapsed;
    bucket.indexRows += fast.plan.scoredRows;
    evaluated += 1;
    if (typeof global.gc === 'function' && evaluated % 25 === 0) { const mib = liveMiB(); live.peakMiB = Math.max(live.peakMiB, mib); live.samples.push(mib); }
    // Il riferimento e' il legacy quando c'e', altrimenti lo scorer di prima sull'indice.
    const reference = legacy || base.plan;
    for (const [label, candidate] of [['fastpath', fast.plan], ['index-base', base.plan]]) {
      if (candidate === reference) continue;
      const field = planDivergence(reference, candidate);
      if (field) {
        mismatches += 1;
        console.error(`MISMATCH alert ${alert.id} (${nlNormLocale(alert.locale)}) [${label}]: ${field}`);
      }
    }
  }

  const legacySummary = summarize(legacyMs);
  const baseSummary = summarize(baseMs);
  const fastSummary = summarize(fastMs);
  const rowsLegacy = summarize(legacyRows);
  const rowsIndex = summarize(indexRows);
  const perAlert = (summary) => Number(summary.mean.toFixed(2));
  const usPerRow = (ms, rowCount) => (rowCount > 0 ? Number(((ms * 1000) / rowCount).toFixed(2)) : null);
  const result = {
    source,
    inventoryRows: jobs.length,
    openRows: index.rowCount,
    alertsEvaluated: evaluated,
    legacyAlertsEvaluated: legacyRun,
    indexBuildMs: Math.round(indexBuildMs),
    legacy: { msPerAlert: perAlert(legacySummary), p95: Number(legacySummary.p95.toFixed(2)), totalMs: Math.round(legacySummary.sum), rowsScoredPerAlert: Math.round(rowsLegacy.mean) },
    indexBase: { msPerAlert: perAlert(baseSummary), p95: Number(baseSummary.p95.toFixed(2)), totalMs: Math.round(baseSummary.sum) },
    indexFastpath: { msPerAlert: perAlert(fastSummary), p95: Number(fastSummary.p95.toFixed(2)), totalMs: Math.round(fastSummary.sum), rowsScoredPerAlert: Math.round(rowsIndex.mean) },
    speedupFastpath: Number((baseSummary.sum / Math.max(1, fastSummary.sum)).toFixed(2)),
    rowsReductionPct: Number((100 * (1 - rowsIndex.sum / Math.max(1, rowsLegacy.sum))).toFixed(1)),
    strategies,
    byStrategy: Object.fromEntries(Object.entries(byStrategy).map(([name, b]) => [name, {
      alerts: b.alerts,
      legacyMsPerAlert: b.legacyAlerts ? Number((b.legacyMs / b.legacyAlerts).toFixed(1)) : null,
      indexBaseMsPerAlert: Number((b.baseMs / b.alerts).toFixed(1)),
      indexFastpathMsPerAlert: Number((b.fastMs / b.alerts).toFixed(1)),
      indexBaseUsPerRow: usPerRow(b.baseMs, b.indexRows),
      indexFastpathUsPerRow: usPerRow(b.fastMs, b.indexRows),
      fastpathSpeedup: Number((b.baseMs / Math.max(0.001, b.fastMs)).toFixed(2)),
      indexRowsPerAlert: Math.round(b.indexRows / b.alerts),
    }])),
    bitsets: index.stats(),
    vocabularyPrepare,
    mismatches,
    liveMemory: typeof global.gc === 'function' ? { baselineAfterIndexBuildMiB: live.baselineMiB, peakAfterGcMiB: live.peakMiB, samplesMiB: live.samples } : null,
    heapUsedMiB: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
    rssMiB: Math.round(process.memoryUsage().rss / 1024 / 1024),
  };
  if (args.json) console.log(JSON.stringify(result, null, 2));
  else {
    console.log(`Bench job-alert matching — ${source}, ${result.inventoryRows} righe (${result.openRows} aperte), ${result.alertsEvaluated} alert sintetici (legacy su ${result.legacyAlertsEvaluated})`);
    console.log(`  legacy        : ${result.legacy.msPerAlert} ms/alert (p95 ${result.legacy.p95}), ${result.legacy.rowsScoredPerAlert} righe allo scorer per alert`);
    console.log(`  indice (base) : ${result.indexBase.msPerAlert} ms/alert (p95 ${result.indexBase.p95}); costruzione indice ${result.indexBuildMs} ms`);
    console.log(`  indice+fast   : ${result.indexFastpath.msPerAlert} ms/alert (p95 ${result.indexFastpath.p95}), ${result.indexFastpath.rowsScoredPerAlert} righe per alert; fast path ${result.speedupFastpath}x`);
    console.log(`  strategie: ${JSON.stringify(strategies)}`);
    for (const [name, b] of Object.entries(result.byStrategy)) {
      console.log(`    ${name.padEnd(13)} ${String(b.alerts).padStart(4)} alert · legacy ${b.legacyMsPerAlert ?? 'n/a'} ms · indice ${b.indexBaseMsPerAlert} ms (${b.indexBaseUsPerRow} µs/riga) → fast path ${b.indexFastpathMsPerAlert} ms (${b.indexFastpathUsPerRow} µs/riga), ${b.fastpathSpeedup}x, ${b.indexRowsPerAlert} righe`);
    }
    if (result.liveMemory) console.log(`  memoria viva (dopo GC): ${result.liveMemory.baselineAfterIndexBuildMiB} MiB dopo la costruzione dell'indice, picco ${result.liveMemory.peakAfterGcMiB} MiB (heap + buffer esterni), campioni ${result.liveMemory.samplesMiB.join(' ')}; rss ${result.rssMiB} MiB`);
    if (result.vocabularyPrepare) console.log(`  vocabolari preparati: ${JSON.stringify(result.vocabularyPrepare)}`);
    const { searchVocabulary, ...bitsetStats } = result.bitsets;
    console.log(`  bitset: ${JSON.stringify(bitsetStats)}`);
    for (const [locale, v] of Object.entries(searchVocabulary || {})) {
      console.log(`  vocabolario ricerca [${locale}]: ${v.words} parole, ${v.postings} posting, ${(v.typed / 1048576).toFixed(2)} MiB tipizzati + ~${((v.total - v.typed) / 1048576).toFixed(2)} MiB di stringhe = ~${(v.total / 1048576).toFixed(2)} MiB, costruito in ${v.buildMs} ms (una volta per run)`);
    }
    console.log(`  piani diversi: ${mismatches}`);
  }
  if (mismatches > 0) process.exit(1);
}

main().catch((error) => {
  console.error(error?.stack || error);
  process.exit(1);
});
