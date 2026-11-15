// scripts/lib/job-alert-candidate-index.mjs
//
// Indice dei candidati per TUTTA la run (perf-plan PR 2): la fix del tempo.
//
// IL PROBLEMA. `planAlertMatch` chiama lo scorer di `createAlertScorer` su ogni
// riga della finestra del destinatario, e la finestra è quasi tutto
// l'inventario (il cursore è `last_sent_at`, ogni annuncio vivo viene ri-crawlato
// ogni giorno). Run 43572400758: 3.791 alert × ~32.800 righe = 124,5M valutazioni,
// 5.079 s. Eppure i predicati dello scorer dipendono solo dalla singola riga e da
// una stringa del profilo: «la riga contiene la keyword K», «la sua località
// contiene L», «il suo cantone è C». Non dipendono dall'alert intero.
//
// L'IDEA. Ogni predicato si calcola UNA volta per run come bitset sulle righe
// aperte dell'inventario (4,4 KB per 35k righe) e lo condividono tutti gli
// alert. Per ogni alert si compone, con AND/OR di bitset, un insieme di righe
// CANDIDATE: una CONDIZIONE NECESSARIA perché lo score sia > 0. Lo scorer
// esistente, senza modifiche, gira poi solo sui candidati. L'indice non decide
// MAI un punteggio: scarta soltanto righe che lo scorer avrebbe dato a 0.
//
// INVARIANTE (da dimostrare, e dimostrata dai test): per ogni profilo e ogni
// riga, `scorer(riga) > 0  ⇒  riga ∈ candidati`. Il ramo-per-ramo è qui sotto,
// accanto a ogni composizione. Dove un ramo non è esprimibile come bitset esatto
// l'indice usa la finestra intera (strategia `window`), mai un'approssimazione.
// In produzione la proprietà è ricontrollata a campione (`on`/`shadow` in
// send-job-alerts.mjs): chi diverge torna al percorso legacy.
//
// ORDINE. Lo sort di `planAlertMatch` è stabile, quindi l'ordine di parità fra
// righe con lo stesso (score, firstSeen) è l'ordine di inserimento = l'ordine
// dell'inventario. Le righe candidate escono SEMPRE nell'ordine originale
// dell'inventario (indice crescente), non per `inventoryAt`: l'output di
// `planAlertMatch` resta identico bit per bit.
//
// LA FINESTRA. Il legacy prende le righe `ROW_OPEN` con `inventoryAt > cursorMs`
// (createJobAlertCandidateSelector). Qui la finestra non è un bitset: si
// applica come filtro sulle righe che sopravvivono ai predicati, e il conteggio
// `candidateCount` (righe eleggibili nella finestra, per la diagnosi zero-match)
// si ottiene da un array ordinato per ricerca binaria, senza toccare le righe.

import {
  DESCRIPTION_TRIGRAM_BLOOM_WORDS,
  buildDescriptionTrigramBloom,
  defaultPartitionCanton,
  defaultPartitionPaddedLoc,
  descriptionTrigramBloomQueryBits,
  freshnessBoost,
  jobFirstSeenMs,
  jobMatchFeatures,
  jobMatchFeaturesByLocale,
  keywordAcrossTextJoin,
  matchesSearchQuery,
  compileSearchQuery,
  paddedLocHaystack,
  paddedLocNeedles,
  pinnedCompanyIdentityKeys,
  searchHaystack,
  searchHaystackInputs,
  searchHaystackShared,
  searchHaystackText,
} from '../../services/jobAlertMatching.mjs';
import { employerDiversityKey } from './job-alert-discovery.mjs';
import { isOpenJobAlertJob, jobInventoryTimestampMs } from './job-alert-newness.mjs';
import { isCanaryJob } from './canaryAd.mjs';
import { createHash } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import { VOCABULARY_INPUT_FIELDS, createVocabularyBuilder } from './job-alert-vocabulary.mjs';

export const CANDIDATE_INDEX_MODES = Object.freeze(['off', 'shadow', 'on']);
export const DEFAULT_CANDIDATE_INDEX_MODE = 'on';
// 0,5%: con la fast path (risposte di ricerca e predicati dell'indice nello
// scorer, perf-plan P1/P4) lo scorer si fida di piu' dell'indice, quindi la
// verifica DEVE restare indipendente — il percorso legacy, senza vocabolario ne'
// risposte dell'indice — e per costare poco si riduce il campione invece di
// renderla dipendente. Circa 25 alert per run (il 2% erano ~118, ~218 s di
// planning) bastano a vedere una divergenza nell'arco di pochi giorni;
// JOB_ALERT_CANDIDATE_INDEX_SHADOW_SAMPLE in Remote Config lo alza.
export const DEFAULT_SHADOW_SAMPLE_LIVE = 0.005;
export const DEFAULT_SHADOW_SAMPLE_DRY_RUN = 0.10;
export const DEFAULT_BITSET_BUDGET_BYTES = 128 * 1024 * 1024;

/**
 * Configurazione del rollout, letta dall'ambiente (Remote Config → env).
 *
 *  - JOB_ALERT_CANDIDATE_INDEX_MODE: `off` (solo legacy, kill switch) | `shadow`
 *    (decide il legacy, l'indice è confrontato su un campione) | `on` (decide
 *    l'indice, un campione è ricalcolato col legacy). Default locale `on`; un
 *    valore non riconosciuto ripiega su `shadow`, che non cambia nessun esito.
 *  - JOB_ALERT_CANDIDATE_INDEX_SHADOW_SAMPLE: frazione di alert verificati, in
 *    [0, 1]. Default 0,005 in LIVE e 0,10 in --dry-run.
 *  - JOB_ALERT_PLANNING_FASTPATH: `on` (default) | `off`. `off` e' il kill switch
 *    della fast path del planning (perf-plan P1–P5): l'indice resta in uso ma lo
 *    scorer e il ranking tornano a quelli di prima. Un valore non riconosciuto
 *    vale `off` (il percorso che non cambia nessun esito).
 *  - JOB_ALERT_CANDIDATE_INDEX_BUDGET_MB: budget in MB della cache dei bitset
 *    (default 128). Solo ambiente: non è un parametro Remote Config.
 */
export function resolveCandidateIndexConfig(env = process.env, { dryRun = false } = {}) {
  const rawMode = String(env.JOB_ALERT_CANDIDATE_INDEX_MODE ?? '').trim().toLowerCase();
  let mode = DEFAULT_CANDIDATE_INDEX_MODE;
  let invalidMode = false;
  if (rawMode) {
    if (CANDIDATE_INDEX_MODES.includes(rawMode)) mode = rawMode;
    else { mode = 'shadow'; invalidMode = true; }
  }
  const defaultSample = dryRun ? DEFAULT_SHADOW_SAMPLE_DRY_RUN : DEFAULT_SHADOW_SAMPLE_LIVE;
  const rawSample = String(env.JOB_ALERT_CANDIDATE_INDEX_SHADOW_SAMPLE ?? '').trim();
  let sampleRate = defaultSample;
  if (rawSample) {
    const parsed = Number(rawSample);
    if (Number.isFinite(parsed)) sampleRate = Math.min(1, Math.max(0, parsed));
  }
  const rawBudget = Number(String(env.JOB_ALERT_CANDIDATE_INDEX_BUDGET_MB ?? '').trim());
  const budgetBytes = Number.isFinite(rawBudget) && rawBudget > 0
    ? Math.floor(rawBudget * 1024 * 1024)
    : DEFAULT_BITSET_BUDGET_BYTES;
  const planningFastpath = resolveOnOffSwitch(env.JOB_ALERT_PLANNING_FASTPATH);
  const vocabularyWorkers = resolveOnOffSwitch(env.JOB_ALERT_VOCABULARY_WORKERS);
  return {
    mode,
    sampleRate,
    budgetBytes,
    invalidMode,
    planningFastpath: planningFastpath.on,
    vocabularyWorkers: vocabularyWorkers.on,
    invalidSwitches: [
      ...(planningFastpath.invalid ? ['JOB_ALERT_PLANNING_FASTPATH'] : []),
      ...(vocabularyWorkers.invalid ? ['JOB_ALERT_VOCABULARY_WORKERS'] : []),
    ],
  };
}

/** `on` (or absent) | `off`; anything else is `off` and flagged — the path that changes no outcome. */
function resolveOnOffSwitch(raw) {
  const value = String(raw ?? '').trim().toLowerCase();
  if (value === '' || value === 'on') return { on: true, invalid: false };
  if (value === 'off') return { on: false, invalid: false };
  return { on: false, invalid: true };
}

/**
 * Chiave di campionamento di un alert: il PERCORSO completo del documento
 * (`job_alert_subscribers/{email}/alerts/{id}`) o, senza riferimento, email
 * minuscola + NUL + id. L'id da solo NON basta: tutti gli alert nati dal backfill
 * si chiamano `backfill-newsletter` (sottocollezioni di email diverse), quindi
 * l'hash dell'id e' identico per migliaia di alert e il campione sarebbe «tutti o
 * nessuno» (dry-run di produzione: 14 alert verificati su ~117 attesi). La chiave
 * entra solo nell'hash e non viene mai stampata.
 */
export function alertSampleKey(alert) {
  const path = String(alert?.ref?.path || '').trim();
  if (path) return path;
  return `${String(alert?.email || '').trim().toLowerCase()}\u0000${String(alert?.id ?? '')}`;
}

/**
 * Identificatore NON personale e univoco per i log: i primi 12 caratteri esadecimali
 * dello sha256 della chiave. Non e' reversibile ne' contiene l'email.
 */
export function alertDiagnosticId(alert) {
  return createHash('sha256').update(`job-alert-diagnostic:${alertSampleKey(alert)}`).digest('hex').slice(0, 12);
}

/** Frazione deterministica in [0, 1) di una chiave di campionamento (mai l'email in chiaro nei log). */
export function alertSampleFraction(key) {
  const digest = createHash('sha256').update(`job-alert-candidate-index:${String(key ?? '')}`).digest();
  return digest.readUInt32BE(0) / 0x1_0000_0000;
}

/** `key` e' la chiave di `alertSampleKey(alert)`. */
export function isAlertSampledForIndexCheck(key, sampleRate) {
  return sampleRate > 0 && alertSampleFraction(key) < sampleRate;
}

// ── Bitset ──────────────────────────────────────────────────────────────

function newBitset(words) {
  return new Uint32Array(words);
}

function setBit(bitset, index) {
  bitset[index >>> 5] |= (1 << (index & 31));
}

function hasBit(bitset, index) {
  return (bitset[index >>> 5] & (1 << (index & 31))) !== 0;
}

function bitsetAnd(a, b) {
  const out = new Uint32Array(a.length);
  for (let i = 0; i < a.length; i++) out[i] = a[i] & b[i];
  return out;
}

function bitsetOrInto(target, source) {
  for (let i = 0; i < target.length; i++) target[i] |= source[i];
  return target;
}

function bitsetAndNot(a, b) {
  const out = new Uint32Array(a.length);
  for (let i = 0; i < a.length; i++) out[i] = a[i] & ~b[i];
  return out;
}

function bitsetPopcount(bitset) {
  let total = 0;
  for (let i = 0; i < bitset.length; i++) {
    let x = bitset[i];
    x -= (x >>> 1) & 0x55555555;
    x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
    x = (x + (x >>> 4)) & 0x0f0f0f0f;
    total += Math.imul(x, 0x01010101) >>> 24;
  }
  return total;
}

function bitsetIsEmpty(bitset) {
  for (let i = 0; i < bitset.length; i++) if (bitset[i] !== 0) return false;
  return true;
}

/** Visita i bit accesi in ordine crescente. */
function forEachSetBit(bitset, visit) {
  for (let w = 0; w < bitset.length; w++) {
    let x = bitset[w];
    while (x !== 0) {
      const lowest = x & -x;
      visit((w << 5) + (31 - Math.clz32(lowest)));
      x ^= lowest;
    }
  }
}

/** Primo indice con `sorted[i] > value` (sorted crescente). */
function upperBound(sorted, value) {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (sorted[mid] <= value) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** LRU con budget in byte: la cache dei bitset non cresce con il pubblico. */
function createBitsetCache(budgetBytes) {
  const map = new Map();
  let bytes = 0;
  const stats = { hits: 0, builds: 0, evictions: 0 };
  return {
    stats,
    get bytes() { return bytes; },
    get size() { return map.size; },
    getOrBuild(key, build) {
      const found = map.get(key);
      if (found) {
        // Riporta in coda: il più recente sopravvive all'evizione.
        map.delete(key);
        map.set(key, found);
        stats.hits += 1;
        return found;
      }
      const built = build();
      stats.builds += 1;
      map.set(key, built);
      bytes += built.byteLength ?? (built.known.byteLength + built.hit.byteLength);
      while (bytes > budgetBytes && map.size > 1) {
        const oldestKey = map.keys().next().value;
        const oldest = map.get(oldestKey);
        map.delete(oldestKey);
        bytes -= oldest.byteLength ?? (oldest.known.byteLength + oldest.hit.byteLength);
        stats.evictions += 1;
      }
      return built;
    },
  };
}

// ── Vocabolario di prefissi per la ricerca ──────────────────────────────

/**
 * Primo indice `i` di `sorted` con `sorted[i] >= value` (confronto per unità di
 * codice UTF-16, lo stesso ordine di `Array.prototype.sort()` senza comparatore).
 */
function lowerBoundString(sorted, value) {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (sorted[mid] < value) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * Vocabolario ordinato `parola → righe` dell'haystack di ricerca di OGNI riga.
 *
 * ESATTEZZA. `matchesSearchQuery` con token vale
 *   `compiled.tokens.every((t) => haystack.includes(' ' + t))`
 * e l'haystack è `' w1 w2 … '`: le parole stemmate di `buildStemmedHaystack`,
 * separate da UNO spazio e con spazio iniziale e finale; nessuna parola contiene
 * uno spazio (si ottengono con `split(' ')`). Un token `t` stemmato non ha spazi
 * (esce da `normalizeSearchText(query).split(' ')`) e non è vuoto (verificato dal
 * chiamante). `haystack.includes(' ' + t)` richiede quindi che esista una
 * posizione in cui compare uno spazio seguito da `t`: lo spazio è un
 * separatore (o quello iniziale), perciò `t` coincide con l'INIZIO di una parola
 * e, non contenendo spazi, sta tutto dentro quella parola. Equivale a «esiste
 * una parola dell'haystack che inizia con `t`». Le parole che iniziano con `t`
 * sono contigue in un elenco ordinato (stesso ordine di `<` fra stringhe): le
 * trova una ricerca binaria del lower bound di `t`, poi si avanza finché
 * `startsWith(t)`. Una query è l'AND dei suoi token.
 *
 * L'haystack di riga è calcolato con la STESSA `searchHaystack(job,
 * jobMatchFeatures(job, locale), locale)` dello scorer, non con una copia: se
 * cambia la composizione del testo cambia anche qui. Le stringhe dell'haystack
 * sono scartate riga per riga; restano le parole uniche (ordinate), un array di
 * offset (`Int32Array`, V+1 valori) e le righe per parola (`Int32Array`, in
 * ordine crescente di riga perché le righe si visitano in ordine).
 *
 * @returns {{words: string[], offsets: Int32Array, postings: Int32Array, buildMs: number, bytes: {words: number, wordChars: number, postings: number, typed: number, total: number}}}
 */
export function buildSearchVocabulary(rows, locale, haystackOf = searchHaystack) {
  const startedAt = performance.now();
  const builder = createVocabularyBuilder();
  for (let i = 0; i < rows.length; i++) {
    const job = rows[i];
    builder.addHaystack(i, haystackOf(job, jobMatchFeatures(job, locale), locale));
  }
  return { ...builder.finish(), buildMs: Math.round(performance.now() - startedAt) };
}

/**
 * Vocabolari di PIU' locali in una passata sola (perf-plan W1). Per ogni riga si
 * fa una volta cio' che `buildSearchVocabulary` rifaceva per locale: il
 * `JSON.parse` di `descriptionByLocale` (il getter fuori heap lo ripete a ogni
 * lettura), la base delle feature di riga, categoria e nomi di cantone. L'haystack
 * di ogni locale e' poi `searchHaystackText` sugli stessi testi che usa
 * `searchHaystack`: il vocabolario di un locale e' identico a quello di
 * `buildSearchVocabulary(rows, locale)` (parole, offset, posting).
 *
 * @param {object[]} rows
 * @param {string[]} locales
 * @returns {Map<string, ReturnType<typeof buildSearchVocabulary>>}
 */
export function buildSearchVocabularies(rows, locales) {
  const builders = locales.map(() => createVocabularyBuilder());
  const busyMs = locales.map(() => 0);
  for (let i = 0; i < rows.length; i++) {
    const inputs = rowHaystackInputs(rows[i], locales);
    for (let l = 0; l < locales.length; l++) {
      const startedAt = performance.now();
      builders[l].addHaystack(i, searchHaystackText(inputs[l]));
      busyMs[l] += performance.now() - startedAt;
    }
  }
  const out = new Map();
  locales.forEach((locale, l) => {
    const startedAt = performance.now();
    const vocabulary = builders[l].finish();
    out.set(locale, { ...vocabulary, buildMs: Math.round(busyMs[l] + performance.now() - startedAt) });
  });
  return out;
}

/**
 * `searchHaystackInputs` di una riga per ogni locale, con il parse di
 * `descriptionByLocale` e la base delle feature fatti una volta. La vista della
 * riga eredita ogni campo dalla riga e sovrascrive solo `descriptionByLocale`
 * con il valore gia' letto: un campo nuovo letto da `searchHaystackInputs` resta
 * letto dalla riga.
 */
function rowHaystackInputs(job, locales) {
  const view = Object.create(job, { descriptionByLocale: { value: job.descriptionByLocale } });
  const shared = searchHaystackShared(job);
  const features = jobMatchFeaturesByLocale(job, locales);
  return locales.map((locale, l) => searchHaystackInputs(view, features[l], locale, shared));
}

const VOCABULARY_WORKER_URL = new URL('./job-alert-vocabulary-worker.mjs', import.meta.url);
const VOCABULARY_WORKER_CHUNK_ROWS = 1000;
// Sotto questa taglia il vocabolario costa meno dell'avvio di un worker.
const VOCABULARY_WORKERS_MIN_ROWS = 20_000;

/**
 * I vocabolari dei `locales` costruiti in parallelo, un worker thread per
 * locale (perf-plan W2). Il thread principale risolve i testi di ogni riga una
 * volta (`rowHaystackInputs`) e li manda a blocchi di 1.000 righe; ogni worker
 * compone l'haystack con `searchHaystackText` e accumula con
 * `createVocabularyBuilder`. Al massimo due blocchi in volo: la memoria
 * trasportata non cresce con l'inventario. Rifiuta se un worker fallisce.
 *
 * @returns {Promise<Map<string, ReturnType<typeof buildSearchVocabulary>>>}
 */
export async function buildSearchVocabulariesInWorkers(rows, locales, { chunkRows = VOCABULARY_WORKER_CHUNK_ROWS } = {}) {
  const workers = [];
  try {
    const states = locales.map(() => ({ acks: 0, done: null, error: null, wake: null }));
    const settle = (state) => { const wake = state.wake; state.wake = null; if (wake) wake(); };
    locales.forEach((locale, l) => {
      const worker = new Worker(VOCABULARY_WORKER_URL);
      workers.push(worker);
      worker.on('message', (message) => {
        if (message.type === 'ack') states[l].acks += 1;
        else if (message.type === 'done') states[l].done = message;
        else if (message.type === 'error') states[l].error = new Error(`vocabulary worker ${locale}: ${message.message}`);
        settle(states[l]);
      });
      worker.on('error', (error) => { states[l].error = error; settle(states[l]); });
      worker.on('exit', (code) => {
        if (code !== 0 && !states[l].done && !states[l].error) states[l].error = new Error(`vocabulary worker ${locale} exited with code ${code}`);
        settle(states[l]);
      });
    });
    const waitFor = async (predicate) => {
      for (const state of states) {
        while (!state.error && !predicate(state)) await new Promise((resolve) => { state.wake = resolve; });
        if (state.error) throw state.error;
      }
    };

    let sent = 0;
    for (let start = 0; start < rows.length; start += chunkRows) {
      const end = Math.min(rows.length, start + chunkRows);
      const chunks = locales.map(() => Object.fromEntries(VOCABULARY_INPUT_FIELDS.map((field) => [field, []])));
      for (let i = start; i < end; i++) {
        const inputs = rowHaystackInputs(rows[i], locales);
        for (let l = 0; l < locales.length; l++) {
          for (const field of VOCABULARY_INPUT_FIELDS) chunks[l][field].push(inputs[l][field]);
        }
      }
      // Al piu' due blocchi non ancora riscontrati: la preparazione del blocco
      // successivo si sovrappone al lavoro dei worker sul precedente.
      await waitFor((state) => state.acks >= sent - 1);
      locales.forEach((_locale, l) => workers[l].postMessage({ type: 'rows', start, inputs: chunks[l] }));
      sent += 1;
    }
    await waitFor((state) => state.acks >= sent);
    workers.forEach((worker) => worker.postMessage({ type: 'finish' }));
    await waitFor((state) => state.done !== null);

    const out = new Map();
    locales.forEach((locale, l) => {
      const { vocabulary, buildMs } = states[l].done;
      out.set(locale, { ...vocabulary, buildMs });
    });
    return out;
  } finally {
    await Promise.all(workers.map((worker) => worker.terminate().catch(() => {})));
  }
}

// ── Indice ──────────────────────────────────────────────────────────────

/**
 * @param {Iterable<object>} jobs Inventario completo, nell'ordine in cui lo
 *   vede `createJobAlertCandidateSelector` (l'ordine di parità dipende da qui).
 * @param {{nowMs?: number, budgetBytes?: number}} [options]
 */
export function createJobAlertCandidateIndex(jobs, { nowMs, budgetBytes = DEFAULT_BITSET_BUDGET_BYTES } = {}) {
  const now = Number.isFinite(nowMs) ? nowMs : Date.now();
  const startedAt = performance.now();

  // Righe ROW_OPEN, stesso criterio di createJobAlertCandidateSelector:
  // timestamp assente → fuori; timestamp futuro → fuori; non aperta → fuori.
  const rows = [];
  const atValues = [];
  for (const job of jobs || []) {
    const at = jobInventoryTimestampMs(job);
    if (!at || at > now) continue;
    if (!isOpenJobAlertJob(job, now)) continue;
    rows.push(job);
    atValues.push(at);
  }
  const n = rows.length;
  const words = Math.max(1, Math.ceil(n / 32));
  const inventoryAt = Float64Array.from(atValues);

  const allRows = newBitset(words);
  for (let i = 0; i < n; i++) setBit(allRows, i);

  const cache = createBitsetCache(budgetBytes);
  const lazy = new Map(); // strutture per-riga costruite una volta, fuori dal budget

  const once = (key, build) => {
    if (!lazy.has(key)) lazy.set(key, build());
    return lazy.get(key);
  };

  const fromIndices = (indices) => {
    const bitset = newBitset(words);
    for (const i of indices) setBit(bitset, i);
    return bitset;
  };

  const emptyBitset = newBitset(words);

  // ── dati per riga, locale-indipendenti: UNA sola passata, alla prima richiesta ──
  //
  // I valori vengono da `jobMatchFeatures` (la funzione con cui lo scorer
  // costruisce le sue feature di riga), non da espressioni duplicate qui: se
  // domani cambia il modo di normalizzare una località o una categoria, l'indice
  // cambia con lo scorer.
  const baseData = () => once('baseData', () => {
    const paddedLocs = new Array(n);
    const cantons = new Array(n);
    const sectorTexts = new Array(n);
    const contractTexts = new Array(n);
    const descriptions = new Array(n);
    const categoryPostings = new Map();
    const taxonomyPostings = new Map();
    const post = (map, key, i) => {
      let list = map.get(key);
      if (!list) { list = []; map.set(key, list); }
      list.push(i);
    };
    for (let i = 0; i < n; i++) {
      const features = jobMatchFeatures(rows[i], '');
      // Stessa stringa che lo scorer normalizza con paddedLocHaystack.
      paddedLocs[i] = paddedLocHaystack(features.jobLoc);
      cantons[i] = features.jobCanton;
      sectorTexts[i] = features.jobSector;
      contractTexts[i] = features.jobContract;
      descriptions[i] = features.descriptionText;
      for (const key of features.jobCategoryKeys) post(categoryPostings, key, i);
      for (const value of features.jobTaxonomyValues) post(taxonomyPostings, value, i);
    }
    return { paddedLocs, cantons, sectorTexts, contractTexts, descriptions, categoryPostings, taxonomyPostings };
  });

  const companyPostings = () => once('companyPostings', () => {
    const postings = new Map();
    rows.forEach((job, i) => {
      for (const key of new Set(pinnedCompanyIdentityKeys(job))) {
        let list = postings.get(key);
        if (!list) { list = []; postings.set(key, list); }
        list.push(i);
      }
    });
    return postings;
  });

  const idPostings = () => once('idPostings', () => {
    const postings = new Map();
    const add = (key, i) => {
      if (!key) return;
      let list = postings.get(key);
      if (!list) { list = []; postings.set(key, list); }
      if (list[list.length - 1] !== i) list.push(i);
    };
    rows.forEach((job, i) => {
      add(String(job.id || ''), i);
      add(String(job.publisherJobId || ''), i);
    });
    return postings;
  });

  /** Dati per locale: testo titolo e indice invertito token → righe. */
  const localeData = (locale) => once(`locale:${locale || ''}`, () => {
    const titleTexts = new Array(n);
    const postings = new Map();
    for (let i = 0; i < n; i++) {
      const features = jobMatchFeatures(rows[i], locale);
      titleTexts[i] = features.titleText;
      for (const token of features.jobTokens) {
        let list = postings.get(token);
        if (!list) { list = []; postings.set(token, list); }
        list.push(i);
      }
    }
    return { titleTexts, postings };
  });

  // ── bitset di predicato ──

  const canaryMask = () => cache.getOrBuild('canary', () => {
    const bitset = newBitset(words);
    rows.forEach((job, i) => { if (isCanaryJob(job)) setBit(bitset, i); });
    return bitset;
  });

  /** `needsRetranslation === true && locale !== (sourceLang || 'it')`: escluso dall'alert. */
  const retranslationMask = (locale) => cache.getOrBuild(`retr:${locale || ''}`, () => {
    const bitset = newBitset(words);
    rows.forEach((job, i) => {
      if (job.needsRetranslation === true && locale !== (job.sourceLang || 'it')) setBit(bitset, i);
    });
    return bitset;
  });

  /** Righe che `planAlertMatch` conta e può valutare: ¬canary (salvo proprietario) ∧ ¬retranslation. */
  const eligibleMask = (locale, owner) => cache.getOrBuild(`elig:${locale || ''}:${owner ? 1 : 0}`, () => {
    let mask = bitsetAndNot(allRows, retranslationMask(locale));
    if (!owner) mask = bitsetAndNot(mask, canaryMask());
    return mask;
  });

  const eligibleSortedAt = (locale, owner) => once(`eligSorted:${locale || ''}:${owner ? 1 : 0}`, () => {
    const values = [];
    forEachSetBit(eligibleMask(locale, owner), (i) => values.push(inventoryAt[i]));
    return Float64Array.from(values).sort();
  });
  const allSortedAt = () => once('allSorted', () => Float64Array.from(inventoryAt).sort());

  const cantonMask = (code) => cache.getOrBuild(`canton:${code}`, () => {
    const bitset = newBitset(words);
    const cantons = baseData().cantons;
    for (let i = 0; i < n; i++) if (cantons[i] === code) setBit(bitset, i);
    return bitset;
  });

  /** Località: `includesAny(paddedLoc, [needle])`, un bit per riga che contiene il needle già con gli spazi. */
  const locMask = (paddedNeedle) => cache.getOrBuild(`loc:${paddedNeedle}`, () => {
    const bitset = newBitset(words);
    const haystacks = baseData().paddedLocs;
    for (let i = 0; i < n; i++) if (haystacks[i].includes(paddedNeedle)) setBit(bitset, i);
    return bitset;
  });

  /**
   * Predicato PIGRO a tre stati (noto / risultato) su un sottoinsieme di righe.
   * Si valutano solo le righe di `need` non ancora note e il risultato è
   * valido solo su `need`: il chiamante lo interseca. Serve ai predicati che
   * leggono testo lungo (keyword nella descrizione, ricerca): valutarli su
   * tutte le righe pagherebbe anche quelle che un altro predicato dell'alert
   * ha già deciso. La risposta per riga è la stessa di una valutazione completa.
   */
  const lazyMask = (key, need, evaluate) => {
    const memo = cache.getOrBuild(key, () => ({ known: newBitset(words), hit: newBitset(words) }));
    forEachSetBit(bitsetAndNot(need, memo.known), (i) => {
      setBit(memo.known, i);
      if (evaluate(i)) setBit(memo.hit, i);
    });
    return memo.hit;
  };

  /**
   * Filtro di Bloom sui trigrammi della descrizione, uno per riga (512 byte,
   * 18 MB per 35k righe), costruito alla prima keyword. Stessa struttura che lo
   * scorer usa per rifiutare in O(1) una keyword assente: un falso si legge
   * come «la descrizione NON contiene la keyword» con certezza, un vero va
   * confermato con `includes`. Non ha falsi negativi.
   */
  const descriptionBlooms = () => once('descriptionBlooms', () => {
    const descriptions = baseData().descriptions;
    const blooms = new Uint32Array(n * DESCRIPTION_TRIGRAM_BLOOM_WORDS);
    for (let i = 0; i < n; i++) {
      // Stessa condizione dello scorer: sotto 3 caratteri nessun trigramma.
      if (descriptions[i].length >= 3) blooms.set(buildDescriptionTrigramBloom(descriptions[i]), i * DESCRIPTION_TRIGRAM_BLOOM_WORDS);
    }
    return blooms;
  });

  /**
   * `keywordInTextParts(titleText, descriptionText, keyword)` — la risposta
   * dello scorer — con tre scorciatoie ESATTE:
   *   1. il titolo (breve) per primo;
   *   2. la descrizione solo se il Bloom dei trigrammi non la esclude;
   *   3. la giunzione titolo/descrizione solo per una keyword con uno spazio:
   *      il testo unito è `${titolo} ${descrizione}`, una keyword senza spazio
   *      che lo attraversa non può includere il separatore, quindi sta tutta
   *      nel titolo o tutta nella descrizione e il passo 1/2 l'ha già trovata.
   */
  const keywordMask = (locale, keyword, need) => {
    const { titleTexts } = localeData(locale);
    const descriptions = baseData().descriptions;
    const blooms = descriptionBlooms();
    const queryBits = keyword.length >= 3 ? descriptionTrigramBloomQueryBits(keyword) : [];
    const spansJoin = keyword.includes(' ');
    return lazyMask(`kw:${locale || ''}:${keyword}`, need, (i) => {
      if (titleTexts[i].includes(keyword)) return true;
      const text = descriptions[i];
      let mayContain = true;
      if (queryBits.length > 0 && keyword.length <= text.length) {
        const offset = i * DESCRIPTION_TRIGRAM_BLOOM_WORDS;
        for (const bit of queryBits) {
          if ((blooms[offset + (bit >>> 5)] & (1 << (bit & 31))) === 0) { mayContain = false; break; }
        }
      }
      if (mayContain && text.includes(keyword)) return true;
      return spansJoin && keywordAcrossTextJoin(titleTexts[i], text, keyword);
    });
  };

  const categoryMask = (key) => cache.getOrBuild(`cat:${key}`, () => fromIndices(baseData().categoryPostings.get(key) || []));
  const taxonomyMask = (value) => cache.getOrBuild(`tax:${value}`, () => fromIndices(baseData().taxonomyPostings.get(value) || []));
  const companyMask = (key) => cache.getOrBuild(`company:${key}`, () => fromIndices(companyPostings().get(key) || []));
  const tokenMask = (locale, token) => cache.getOrBuild(`tok:${locale || ''}:${token}`,
    () => fromIndices(localeData(locale).postings.get(token) || []));
  const idMask = (id) => cache.getOrBuild(`id:${id}`, () => fromIndices(idPostings().get(id) || []));

  /** `jobSector.includes(s) || titleText.includes(s)` (titleText dipende dal locale). */
  const sectorMask = (locale, sector) => cache.getOrBuild(`sector:${locale || ''}:${sector}`, () => {
    const bitset = newBitset(words);
    const sectors = baseData().sectorTexts;
    const { titleTexts } = localeData(locale);
    for (let i = 0; i < n; i++) if (sectors[i].includes(sector) || titleTexts[i].includes(sector)) setBit(bitset, i);
    return bitset;
  });

  /** `jobContract.includes(c)`. */
  const contractMask = (contract) => cache.getOrBuild(`contract:${contract}`, () => {
    const bitset = newBitset(words);
    const contracts = baseData().contractTexts;
    for (let i = 0; i < n; i++) if (contracts[i].includes(contract)) setBit(bitset, i);
    return bitset;
  });

  /**
   * Ricerca (`matchesSearchQuery`). L'haystack stemmato di una riga NON dipende
   * dalla query, quindi non si ricostruisce per ogni coppia (query, riga): alla
   * prima ricerca di un locale si costruisce UNA volta il vocabolario di prefissi
   * (`buildSearchVocabulary`, dove sta la dimostrazione di esattezza) e ogni
   * token diventa l'OR delle posting delle parole con quel prefisso, memoizzato
   * per tutta la run nella LRU; la query è l'AND dei token.
   *
   * Tre casi restano sul percorso per-riga, identico a `matchesSearchQuery`:
   *  - `tokens.length === 0` (alfabeto non supportato): non è un AND vuoto, è
   *    `keywordInTextParts` sulla query → `keywordMask`, già esatto;
   *  - un token vuoto o con uno spazio (non prodotto da `compileSearchQuery`, ma
   *    non si assume): per-riga, tri-stato e pigro sulle righe di `need`.
   *
   * Il risultato del percorso a vocabolario è valido su TUTTE le righe; quello
   * per-riga solo su `need`. Il chiamante interseca sempre con `need`.
   */
  const compiledQueries = new Map();
  const searchVocabulary = (locale) => once(`vocab:${locale || ''}`, () => buildSearchVocabulary(rows, locale));
  const prefixTokenMask = (locale, token) => cache.getOrBuild(`stok:${locale || ''}:${token}`, () => {
    const vocabulary = searchVocabulary(locale);
    const bitset = newBitset(words);
    const { words: vocabularyWords, offsets, postings } = vocabulary;
    for (let k = lowerBoundString(vocabularyWords, token); k < vocabularyWords.length && vocabularyWords[k].startsWith(token); k++) {
      for (let p = offsets[k]; p < offsets[k + 1]; p++) setBit(bitset, postings[p]);
    }
    return bitset;
  });
  /**
   * `answers` (optional Map query → bitset) collects the results that are valid
   * on EVERY row — the vocabulary path only — by reference, so the planner can
   * hand them to the scorer for the length of one alert without re-reading the
   * LRU (perf-plan P1). The per-row paths are valid on `need` only and are
   * never recorded.
   */
  const searchMask = (locale, query, need, answers = null) => {
    let compiled = compiledQueries.get(query);
    if (!compiled) { compiled = compileSearchQuery(query); compiledQueries.set(query, compiled); }
    if (compiled.tokens.length === 0) return keywordMask(locale, compiled.query, need);
    if (compiled.tokens.some((token) => token === '' || token.includes(' '))) {
      return lazyMask(`search:${locale || ''}:${query}`, need, (i) => {
        const job = rows[i];
        return matchesSearchQuery(compiled, job, jobMatchFeatures(job, locale), locale);
      });
    }
    let result = null;
    for (const token of compiled.tokens) {
      const mask = prefixTokenMask(locale, token);
      result = result ? bitsetAnd(result, mask) : mask;
      if (bitsetIsEmpty(result)) break;
    }
    if (answers) answers.set(query, result);
    return result;
  };

  // ── predicati per riga dell'alert (perf-plan P4) ──

  /** OR di bitset di predicato; con un solo operando restituisce quello della cache (mai mutato). */
  const orOf = (masks) => {
    if (masks.length === 1) return masks[0];
    const out = newBitset(words);
    for (const mask of masks) bitsetOrInto(out, mask);
    return out;
  };

  /**
   * I sei fatti per riga che la formula dello scorer legge nel ramo soft-legacy
   * (nessuna keyword dura, intento legacy), ciascuno già come maschera esatta:
   *
   *  - `geo`: il filtro geo DURO dello scorer, `includesAny(paddedLoc, needle di
   *    alertLocations) || (cantons.length>0 && jobCanton && cantons.includes(jobCanton))`
   *    = OR(loc:needle) ∪ OR(canton:c con c non vuoto). `null` senza scope geo;
   *  - `softOverlap`: quanti `softTokens` sono in `jobTokens` della riga, contato
   *    dalle liste righe-per-token (le stesse da cui `tokenMask` legge i token).
   *    Un `jobTokens` è un Set, quindi ogni token conta una volta per riga. Il
   *    contatore satura a 255: la formula usa `min(5, 2·overlap)` e `overlap === 0`;
   *  - `company`: `companyKeys.some(k => jobCompanyKeys.includes(k))` = OR(company:k),
   *    solo con `profile.company` non vuota;
   *  - `location`: `includesAny(paddedLoc, locationNeedles)` = OR(loc:needle);
   *  - `canton`: `cantons.includes(jobCanton)` (senza il `jobCanton &&` del filtro
   *    geo: una stringa vuota in `cantons` combacia con un cantone vuoto) =
   *    OR(canton:c per ogni c);
   *  - `sector`: `sectors.some(s => jobSector.includes(s) || titleText.includes(s))`
   *    = OR(sector:s); `contract`: `contractTypes.some(c => jobContract.includes(c))`.
   *
   * Sono le stesse maschere che `candidateMask` compone per scegliere le righe,
   * quindi si leggono dalla cache. `null` = predicato falso su ogni riga.
   */
  const softLegacyPredicates = (profile, locale, parts) => {
    const {
      softTokens, companyKeys, alertLocationNeedles, locationNeedles, cantons, sectors, contractTypes, hasGeoScope,
    } = parts;
    let geo = null;
    if (hasGeoScope) {
      const masks = [];
      for (const needle of alertLocationNeedles) masks.push(locMask(needle));
      for (const code of cantons) if (code) masks.push(cantonMask(code));
      geo = masks.length > 0 ? orOf(masks) : emptyBitset;
    }
    let softOverlap = null;
    if (softTokens.size > 0) {
      softOverlap = new Uint8Array(n);
      const { postings } = localeData(locale);
      for (const token of softTokens) {
        const list = postings.get(token);
        if (!list) continue;
        for (let k = 0; k < list.length; k++) {
          const row = list[k];
          if (softOverlap[row] < 255) softOverlap[row] += 1;
        }
      }
    }
    const maskOf = (values, build) => (values.length > 0 ? orOf(values.map(build)) : null);
    return {
      profile,
      geo,
      softOverlap,
      company: profile.company && companyKeys.length > 0 ? orOf(companyKeys.map((key) => companyMask(key))) : null,
      location: maskOf(locationNeedles, (needle) => locMask(needle)),
      canton: maskOf(cantons, (code) => cantonMask(code)),
      sector: maskOf(sectors, (sector) => sectorMask(locale, sector)),
      contract: maskOf(contractTypes, (contract) => contractMask(contract)),
    };
  };

  // ── colonne per riga del ranking (perf-plan P2) ──

  /**
   * Valori per riga che il planner ricalcolava per ogni alert, ora UNA volta per
   * run. Ognuno è la stessa espressione di prima, valutata su quella riga:
   *  - `firstSeenMs`: `jobFirstSeenMs(job)` (NaN compreso per un `firstSeenAt` malformato);
   *  - `freshness`: `freshnessBoost(job, nowMs)` con il `now` della run;
   *  - `companyId`: id intero della chiave di `employerDiversityKey(job)` (stesse
   *    chiavi uguali ⇔ stessi id);
   *  - `canton` / `paddedLoc`: i valori che `partitionByGeoPreference` confronta.
   */
  const rankingColumns = () => once('rankingColumns', () => {
    const firstSeenMs = new Float64Array(n);
    const freshness = new Uint8Array(n);
    const companyId = new Int32Array(n);
    const canton = new Array(n);
    const paddedLoc = new Array(n);
    const ids = new Map();
    for (let i = 0; i < n; i++) {
      const job = rows[i];
      firstSeenMs[i] = jobFirstSeenMs(job);
      freshness[i] = freshnessBoost(job, now);
      const key = employerDiversityKey(job);
      let id = ids.get(key);
      if (id === undefined) { id = ids.size; ids.set(key, id); }
      companyId[i] = id;
      canton[i] = defaultPartitionCanton(job);
      paddedLoc[i] = defaultPartitionPaddedLoc(job);
    }
    return { nowMs: now, firstSeenMs, freshness, companyId, canton, paddedLoc };
  });

  // ── composizione per alert ──

  /**
   * Insieme di righe candidate (una condizione NECESSARIA per score > 0) e
   * strategia usata. Ramo per ramo di `createAlertScorer`:
   *
   * 0. `!profile`: lo scorer risponde 0 per ogni riga → insieme vuoto.
   *
   * 1. PINNED (`specificJobIds` o `specificCompanyKey`): lo scorer risponde
   *    `10+boost` se e solo se `idHit || companyHit`, altrimenti 0, ignorando
   *    ogni altro criterio. idHit = id/publisherJobId ∈ pinnedJobs (indice
   *    id → righe); companyHit = pinnedCompany ∈ pinnedCompanyIdentityKeys(riga)
   *    (indice chiave → righe, calcolato con la stessa funzione). L'insieme è
   *    ESATTO: OR dei due. Nessun altro predicato partecipa.
   *
   * 2. `neverMatches` (nessuna keyword, nessuno scope geo, nessun intento legacy,
   *    nessuna ricerca soft, nessun needle di località, settore o contratto): lo
   *    scorer risponde 0 per ogni riga → insieme vuoto. Per costruzione i rami
   *    seguenti darebbero comunque un OR vuoto.
   *
   * 3. SCOPE GEO DURO (`hasGeoScope = alertLocations.length>0 || cantons.length>0`):
   *    lo scorer risponde 0 se `!(includesAny(paddedLoc, alertLocationNeedles) ||
   *    (cantons.length>0 && jobCanton && cantons.includes(jobCanton)))`. Quindi
   *    ogni riga con score>0 appartiene a G = OR(loc:needle) ∪ OR(canton:c),
   *    e G si interseca con tutti i rami seguenti. I needle sono quelli di
   *    `paddedLocNeedles(alertLocations)`, i cantoni quelli minuscoli del profilo:
   *    gli stessi valori che legge lo scorer. Esatto.
   *
   * 4. KEYWORD DURE (`hardList = [...hardKeywords]` non vuota): dopo il filtro
   *    geo, lo scorer risponde 0 se `!hit` e `> 0` altrimenti (nessun `return 0`
   *    successivo nel ramo con keyword: company/soft/località/settore/contratto
   *    possono solo SOMMARE). `hit` vale:
   *      - con `hardSearchQueries` non vuote: l'AND di `matchesSearchQuery` su
   *        tutte le query (le keyword, la categoria e la tassonomia NON
   *        partecipano in quel caso, lo scorer li salta con `searchTests.length === 0`);
   *      - altrimenti l'OR di: keywordInTextParts(titolo_locale, descrizione, k)
   *        per ogni k ∈ hardList; jobCategoryKeys ∋ c per c ∈ hardCategoryKeys;
   *        jobTaxonomyValues ∋ t per t ∈ hardTaxonomyValues.
   *    Insieme ESATTO: G ∧ hit.
   *
   * 5. NESSUNA KEYWORD, INTENTO LEGACY (`softTokens.size>0 || profile.company`):
   *    lo scorer risponde `> 0` se `!needsFallback` e, altrimenti, solo se una
   *    ricerca soft combacia. `needsFallback = softOverlap===0 && !companyMatch
   *    && !sectorMatch && !locationMatch`. Candidati = G ∧ (OR(tok:t) ∪
   *    OR(company:k per k ∈ companyKeys) ∪ OR(sector:s) ∪ OR(loc:needle di
   *    `locations`) ∪ OR(search soft)). Contratto e cantone NON salvano una riga
   *    in questo ramo (non entrano in needsFallback) e quindi non sono nell'OR.
   *    Esatto.
   *
   * 6. NESSUNA KEYWORD, SENZA INTENTO LEGACY: `needsFallback = score===0`, con
   *    score = 2·loc + 1·canton + 2·sector + 1·contratto (company e soft-overlap
   *    sono 0 per costruzione). Candidati = G ∧ (OR(loc) ∪ OR(canton:c) ∪
   *    OR(sector) ∪ OR(contract) ∪ OR(search soft)). Esatto.
   *
   * In ogni ramo il punteggio finale lo calcola lo scorer, non questo modulo.
   */
  const candidateMask = (profile, locale, eligible, collect = null) => {
    if (!profile) return { mask: emptyBitset, strategy: 'never' };
    const answers = collect ? collect.answers : null;

    const pinnedJobs = profile.specificJobIds || [];
    const pinnedCompany = profile.specificCompanyKey || '';
    if (pinnedJobs.length > 0 || pinnedCompany) {
      let mask = newBitset(words);
      for (const id of pinnedJobs) bitsetOrInto(mask, idMask(String(id)));
      if (pinnedCompany) bitsetOrInto(mask, companyMask(pinnedCompany));
      return { mask, strategy: 'pinned' };
    }

    const hardList = [...profile.hardKeywords];
    const softTokens = profile.softTokens;
    const cantons = profile.cantons;
    const sectors = profile.sectors;
    const contractTypes = profile.contractTypes;
    const hardSearchQueries = hardList.length > 0 ? (profile.hardSearchQueries || []) : [];
    const softSearchQueries = hardList.length === 0 ? (profile.softSearchQueries || []) : [];
    const companyKeys = profile.companyKeys || [profile.company].filter(Boolean);
    const alertLocationNeedles = paddedLocNeedles(profile.alertLocations);
    const locationNeedles = paddedLocNeedles(profile.locations);
    const hasGeoScope = profile.alertLocations.length > 0 || cantons.length > 0;
    const hasLegacyIntentProfile = softTokens.size > 0 || Boolean(profile.company);
    const neverMatches = hardList.length === 0 && !hasGeoScope && !hasLegacyIntentProfile
      && softSearchQueries.length === 0
      && locationNeedles.length === 0 && sectors.length === 0 && contractTypes.length === 0;
    if (neverMatches) return { mask: emptyBitset, strategy: 'never' };

    // 3. Scope geo duro.
    let base = eligible;
    if (hasGeoScope) {
      const geo = newBitset(words);
      for (const needle of alertLocationNeedles) bitsetOrInto(geo, locMask(needle));
      for (const code of cantons) bitsetOrInto(geo, cantonMask(code));
      base = bitsetAnd(eligible, geo);
    }
    if (bitsetIsEmpty(base)) return { mask: emptyBitset, strategy: 'geo-empty' };

    // 4. Keyword dure.
    if (hardList.length > 0) {
      if (hardSearchQueries.length > 0) {
        let narrowed = base;
        for (const query of hardSearchQueries) {
          narrowed = bitsetAnd(narrowed, searchMask(locale, query, narrowed, answers));
          if (bitsetIsEmpty(narrowed)) break;
        }
        return { mask: narrowed, strategy: 'hard-search' };
      }
      // Prima i predicati a indice (categoria, tassonomia): restringono le righe
      // che le keyword, più costose, devono ancora valutare. L'OR è commutativo,
      // quindi l'insieme finale non dipende dall'ordine.
      const hit = newBitset(words);
      for (const category of profile.hardCategoryKeys || []) bitsetOrInto(hit, categoryMask(category));
      for (const value of profile.hardTaxonomyValues || []) bitsetOrInto(hit, taxonomyMask(value));
      let remaining = bitsetAndNot(base, hit);
      for (const keyword of hardList) {
        if (bitsetIsEmpty(remaining)) break;
        const found = bitsetAnd(remaining, keywordMask(locale, keyword, remaining));
        bitsetOrInto(hit, found);
        remaining = bitsetAndNot(remaining, found);
      }
      return { mask: bitsetAnd(base, hit), strategy: 'hard-keyword' };
    }

    // 5/6. Nessuna keyword.
    const any = newBitset(words);
    if (hasLegacyIntentProfile) {
      for (const token of softTokens) bitsetOrInto(any, tokenMask(locale, token));
      if (profile.company) for (const key of companyKeys) bitsetOrInto(any, companyMask(key));
    } else {
      for (const code of cantons) bitsetOrInto(any, cantonMask(code));
      for (const contract of contractTypes) bitsetOrInto(any, contractMask(contract));
    }
    for (const sector of sectors) bitsetOrInto(any, sectorMask(locale, sector));
    for (const needle of locationNeedles) bitsetOrInto(any, locMask(needle));
    let mask = bitsetAnd(base, any);
    if (softSearchQueries.length > 0) {
      // La ricerca soft si valuta solo sulle righe che gli altri predicati non
      // hanno già accettato: sono le uniche per cui può cambiare la risposta.
      let remaining = bitsetAndNot(base, mask);
      // Una query ripetuta non aggiunge righe (la sua seconda passata trova gia'
      // tolte le righe che accetta): la si valuta una volta. La risposta in
      // `answers` resta comunque quella del vocabolario su tutte le righe.
      for (const query of new Set(softSearchQueries)) {
        if (bitsetIsEmpty(remaining)) break;
        const hit = bitsetAnd(remaining, searchMask(locale, query, remaining, answers));
        bitsetOrInto(mask, hit);
        remaining = bitsetAndNot(remaining, hit);
      }
    }
    const strategy = hasLegacyIntentProfile ? 'soft-legacy' : 'soft-signals';
    if (collect && collect.predicates && strategy === 'soft-legacy') {
      collect.predicatesOut = softLegacyPredicates(profile, locale, {
        softTokens, companyKeys, alertLocationNeedles, locationNeedles, cantons, sectors, contractTypes, hasGeoScope,
      });
    }
    return { mask, strategy };
  };

  /**
   * `rowIndices[k]` è l'indice di `rows[k]` nell'indice (Int32Array parallelo a
   * `rows`). `searchAnswers` (`{locale, byQuery}`) porta le risposte di ricerca
   * valide su tutte le righe, solo del percorso a vocabolario. Con `fastpath`
   * `select` prepara anche i predicati per riga del ramo soft-legacy e le
   * colonne del ranking: sono dati che il solo piano indicizzato legge; il piano
   * legacy di verifica non passa mai di qui.
   */
  const select = (profile, { locale, ownerAlert = false, cursorMs, forceWindow = false, fastpath = false } = {}) => {
    const eligible = eligibleMask(locale, ownerAlert);
    const sorted = eligibleSortedAt(locale, ownerAlert);
    const candidateCount = sorted.length - upperBound(sorted, cursorMs);
    let strategy = 'window';
    let mask = eligible;
    const collect = fastpath && !forceWindow ? { answers: new Map(), predicates: true, predicatesOut: null } : null;
    if (!forceWindow) {
      const composed = candidateMask(profile, locale, eligible, collect);
      strategy = composed.strategy;
      mask = bitsetAnd(eligible, composed.mask);
    }
    const selected = [];
    const selectedIndices = [];
    forEachSetBit(mask, (i) => {
      if (inventoryAt[i] > cursorMs) { selected.push(rows[i]); selectedIndices.push(i); }
    });
    const selection = { rows: selected, rowIndices: Int32Array.from(selectedIndices), candidateCount, strategy };
    if (collect) {
      selection.searchAnswers = { locale, byQuery: collect.answers };
      selection.predicates = collect.predicatesOut;
      selection.columns = rankingColumns();
    }
    return selection;
  };

  const builtMs = performance.now() - startedAt;
  return {
    rowCount: n,
    /** Righe aperte con `inventoryAt > cursorMs` (= `candidateWindow.jobs.length`, canary compresi). */
    windowRowCount(cursorMs) {
      const sorted = allSortedAt();
      return sorted.length - upperBound(sorted, cursorMs);
    },
    select,
    /**
     * Costruisce in anticipo i vocabolari di ricerca dei `locales` che non ci sono
     * ancora, prima del planning: in una passata sola (W1) oppure, con `workers`
     * e un inventario grande, in parallelo su worker thread (W2). Il risultato e'
     * identico a quello della costruzione pigra. Non rifiuta mai: se i worker
     * falliscono ripiega sulla passata unica e riporta `fallback`.
     *
     * @returns {Promise<{mode: 'none'|'single-pass'|'workers', locales: string[], wallMs: number, fallback?: string}>}
     */
    async prepareSearchVocabularies({ locales = [], workers = false, workerMinRows = VOCABULARY_WORKERS_MIN_ROWS, log = () => {} } = {}) {
      const startedAt = performance.now();
      const missing = [...new Set(locales.map((locale) => locale || ''))].filter((locale) => !lazy.has(`vocab:${locale}`));
      if (missing.length === 0) return { mode: 'none', locales: [], wallMs: 0 };
      let mode = 'single-pass';
      let fallback;
      let built = null;
      if (workers && n >= workerMinRows && missing.length >= 2) {
        try {
          built = await buildSearchVocabulariesInWorkers(rows, missing);
          mode = 'workers';
        } catch (error) {
          fallback = String(error?.message || error);
          log(`vocabulary workers failed (${fallback}); building on the main thread`);
        }
      }
      if (!built) built = buildSearchVocabularies(rows, missing);
      for (const [locale, vocabulary] of built) lazy.set(`vocab:${locale}`, vocabulary);
      return { mode, locales: missing, wallMs: Math.round(performance.now() - startedAt), ...(fallback ? { fallback } : {}) };
    },
    /** Millisecondi cumulati di costruzione dei vocabolari di ricerca (per la telemetria). */
    searchVocabularyBuildMs: () => [...lazy.entries()]
      .filter(([key]) => key.startsWith('vocab:'))
      .reduce((sum, [, value]) => sum + value.buildMs, 0),
    /** Solo per i test: la riga all'indice dato. */
    rowAt: (i) => rows[i],
    /** Solo per i test: la maschera di `searchMask` su TUTTE le righe. */
    searchMaskForTest: (locale, query) => searchMask(locale, query, allRows),
    hasBit,
    stats() {
      return {
        rows: n,
        buildMs: Math.round(builtMs),
        bitsets: cache.size,
        bitsetBytes: cache.bytes,
        bitsetBuilds: cache.stats.builds,
        bitsetHits: cache.stats.hits,
        bitsetEvictions: cache.stats.evictions,
        searchVocabulary: Object.fromEntries([...lazy.entries()]
          .filter(([key]) => key.startsWith('vocab:'))
          .map(([key, value]) => [key.slice(6) || 'base', { ...value.bytes, buildMs: value.buildMs }])),
        searchVocabularyBuildMs: [...lazy.entries()]
          .filter(([key]) => key.startsWith('vocab:'))
          .reduce((sum, [, value]) => sum + value.buildMs, 0),
      };
    },
  };
}

/**
 * Confronto fra due piani di `planAlertMatch` (legacy contro indice) sui campi
 * che il sender consuma: conteggi, causa dello zero-match, e la lista `matched`
 * (identità della riga, ordine e score di pertinenza). Restituisce la prima
 * differenza trovata, mai dati dell'utente.
 *
 * @returns {{equal: true} | {equal: false, field: string}}
 */
export function comparePlanOutcomes(legacy, indexed) {
  if (legacy.candidateCount !== indexed.candidateCount) return { equal: false, field: 'candidateCount' };
  if (legacy.rankedCount !== indexed.rankedCount) return { equal: false, field: 'rankedCount' };
  if ((legacy.zeroCause ?? null) !== (indexed.zeroCause ?? null)) return { equal: false, field: 'zeroCause' };
  if (Boolean(legacy.discoveryMode) !== Boolean(indexed.discoveryMode)) return { equal: false, field: 'discoveryMode' };
  const a = legacy.matched || [];
  const b = indexed.matched || [];
  if (a.length !== b.length) return { equal: false, field: 'matched.length' };
  const relevance = (plan, job) => plan.rankingMetadata?.get(job)?.relevanceScore ?? job?.relevanceScore;
  for (let i = 0; i < a.length; i++) {
    const sameRow = a[i] === b[i] || (a[i]?.id != null && a[i].id === b[i]?.id);
    if (!sameRow) return { equal: false, field: `matched[${i}].id` };
    if (relevance(legacy, a[i]) !== relevance(indexed, b[i])) return { equal: false, field: `matched[${i}].score` };
  }
  return { equal: true };
}
