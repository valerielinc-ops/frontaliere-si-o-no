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
  descriptionTrigramBloomQueryBits,
  jobMatchFeatures,
  keywordAcrossTextJoin,
  matchesSearchQuery,
  compileSearchQuery,
  paddedLocHaystack,
  paddedLocNeedles,
  pinnedCompanyIdentityKeys,
  searchHaystack,
} from '../../services/jobAlertMatching.mjs';
import { isOpenJobAlertJob, jobInventoryTimestampMs } from './job-alert-newness.mjs';
import { isCanaryJob } from './canaryAd.mjs';
import { createHash } from 'node:crypto';

export const CANDIDATE_INDEX_MODES = Object.freeze(['off', 'shadow', 'on']);
export const DEFAULT_CANDIDATE_INDEX_MODE = 'on';
export const DEFAULT_SHADOW_SAMPLE_LIVE = 0.02;
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
 *    [0, 1]. Default 0,02 in LIVE e 0,10 in --dry-run.
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
  return { mode, sampleRate, budgetBytes, invalidMode };
}

/** Frazione deterministica in [0, 1) dell'id di un alert: mai l'email. */
export function alertSampleFraction(alertId) {
  const digest = createHash('sha256').update(`job-alert-candidate-index:${String(alertId ?? '')}`).digest();
  return digest.readUInt32BE(0) / 0x1_0000_0000;
}

export function isAlertSampledForIndexCheck(alertId, sampleRate) {
  return sampleRate > 0 && alertSampleFraction(alertId) < sampleRate;
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
  const ids = new Map();
  let pairWord = new Int32Array(1 << 16);
  let pairRow = new Int32Array(1 << 16);
  let pairs = 0;
  let lastRowOfWord = [];
  for (let i = 0; i < rows.length; i++) {
    const job = rows[i];
    const haystack = haystackOf(job, jobMatchFeatures(job, locale), locale);
    for (const word of haystack.split(' ')) {
      if (word === '') continue;
      let id = ids.get(word);
      if (id === undefined) { id = ids.size; ids.set(word, id); lastRowOfWord.push(-1); }
      if (lastRowOfWord[id] === i) continue;
      lastRowOfWord[id] = i;
      if (pairs === pairWord.length) {
        const grownWord = new Int32Array(pairs * 2); grownWord.set(pairWord); pairWord = grownWord;
        const grownRow = new Int32Array(pairs * 2); grownRow.set(pairRow); pairRow = grownRow;
      }
      pairWord[pairs] = id;
      pairRow[pairs] = i;
      pairs += 1;
    }
  }
  lastRowOfWord = null;

  const sortedWords = [...ids.keys()].sort();
  const rankOf = new Int32Array(sortedWords.length);
  for (let rank = 0; rank < sortedWords.length; rank++) rankOf[ids.get(sortedWords[rank])] = rank;
  ids.clear();

  const offsets = new Int32Array(sortedWords.length + 1);
  for (let k = 0; k < pairs; k++) offsets[rankOf[pairWord[k]] + 1] += 1;
  for (let rank = 0; rank < sortedWords.length; rank++) offsets[rank + 1] += offsets[rank];
  const cursor = offsets.slice(0, sortedWords.length);
  const postings = new Int32Array(pairs);
  for (let k = 0; k < pairs; k++) postings[cursor[rankOf[pairWord[k]]]++] = pairRow[k];

  let wordChars = 0;
  for (const word of sortedWords) wordChars += word.length;
  // Stima: ~1 byte/carattere (stringhe a un byte di V8) + ~24 byte di intestazione
  // e puntatore per parola. I tipizzati sono esatti.
  const wordBytes = wordChars + sortedWords.length * 24;
  const typed = offsets.byteLength + postings.byteLength;
  return {
    words: sortedWords,
    offsets,
    postings,
    bytes: { words: sortedWords.length, wordChars, postings: pairs, typed, total: typed + wordBytes },
    buildMs: Math.round(performance.now() - startedAt),
  };
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
  const searchMask = (locale, query, need) => {
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
    return result;
  };

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
  const candidateMask = (profile, locale, eligible) => {
    if (!profile) return { mask: emptyBitset, strategy: 'never' };

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
          narrowed = bitsetAnd(narrowed, searchMask(locale, query, narrowed));
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
      for (const query of softSearchQueries) {
        if (bitsetIsEmpty(remaining)) break;
        const hit = bitsetAnd(remaining, searchMask(locale, query, remaining));
        bitsetOrInto(mask, hit);
        remaining = bitsetAndNot(remaining, hit);
      }
    }
    return { mask, strategy: hasLegacyIntentProfile ? 'soft-legacy' : 'soft-signals' };
  };

  const select = (profile, { locale, ownerAlert = false, cursorMs, forceWindow = false } = {}) => {
    const eligible = eligibleMask(locale, ownerAlert);
    const sorted = eligibleSortedAt(locale, ownerAlert);
    const candidateCount = sorted.length - upperBound(sorted, cursorMs);
    let strategy = 'window';
    let mask = eligible;
    if (!forceWindow) {
      const composed = candidateMask(profile, locale, eligible);
      strategy = composed.strategy;
      mask = bitsetAnd(eligible, composed.mask);
    }
    const selected = [];
    forEachSetBit(mask, (i) => {
      if (inventoryAt[i] > cursorMs) selected.push(rows[i]);
    });
    return { rows: selected, candidateCount, strategy };
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
