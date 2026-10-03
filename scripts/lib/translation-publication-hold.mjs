/**
 * translation-publication-hold — soglia di ammissione dei job di agenzia.
 *
 * DECISIONE DEL PROPRIETARIO (2026-10-03): «Soglia di ammissione: ammetto job
 * di agenzia solo finché c'è capacità di traduzione: quelli in eccesso restano
 * fuori finché non sono tradotti.» Quattro crawler di agenzia (fachkraft, sta,
 * stellentreff, stellenpartner) portavano da soli ~6.200 job di origine tedesca
 * con il titolo copiato in it/en/fr: più di quanti translate-pending ne
 * traduca, e la maggioranza degli slot titolo non tradotti del ratchet
 * `tests/job-locale-consistency.test.ts`.
 *
 * CONTRATTO. Un job di uno di questi crawler che ARRIVA con un titolo non
 * tradotto resta nello slice (quindi nella coda di translate-pending, che legge
 * gli slice) ma non entra nella pubblicazione: niente pagina, sitemap, hub,
 * conteggi, feed, alert. Appena tutti i suoi titoli sono tradotti viene
 * pubblicato come un job nuovo. Nessun job esce per sempre per questo motivo e
 * nessuna traduzione va persa: il job non lascia mai lo slice.
 *
 * STATO. Il crawler (writeJobsCrawlerSlice) timbra `translationHoldSince` sui
 * soli job NUOVI che arrivano non tradotti. Un job che c'era già (pubblicato dal
 * codice di prima, oppure già rilasciato) non viene mai trattenuto: toglierlo
 * dalla pubblicazione renderebbe 404 (o soft landing) un URL già servito.
 * Questa è anche la regola di transizione: gli slice scritti prima di questo
 * cambio non hanno timbri, quindi tutto ciò che è già online resta online.
 *
 * Il timbro da solo non trattiene: trattiene `timbro && titoli non tradotti`,
 * valutato al momento della lettura (assemblaggio, mining degli slug, archivio
 * degli scaduti). Così un job tradotto da translate-pending viene pubblicato al
 * deploy successivo anche prima che qualcuno tolga il timbro, e il rilascio
 * (`releaseTranslatedHolds`, chiamato da translate-pending e dal crawler) serve
 * a renderlo definitivo e a dargli l'orologio di novità `translationHoldReleasedAt`.
 *
 * «TITOLO TRADOTTO» riusa i predicati condivisi, non ne inventa uno:
 * `hasUsableTitle` (translation-quality.mjs, soglia del validatore di deploy),
 * `isTitleSourceCopy` e `titleContainsLlmReasoning` (job-locale-utils.mjs, gli
 * stessi con cui `scripts/fix-untranslated-titles.mjs` mette in coda i titoli).
 * Deliberatamente NON `titleLooksUntranslated()` intero: i suoi segnali lessicali
 * (residui composti, parole funzione) non hanno un traduttore che li chiuda per
 * certo — la valvola di resa `localeMismatchSuppressed` toglie il job dalla coda
 * di Argos e di 2b — e un job trattenuto per un residuo potrebbe restare fuori
 * per sempre. Ogni condizione qui sotto invece è nella coda di un traduttore che
 * non si arrende: copia/ragionamento LLM in fix-untranslated-titles (fasi 2a.2 e
 * 2d, ogni run), slot mancante via `needsRetranslation` dell'assemblatore (2b).
 */
import {
  DEFAULT_JOB_LOCALES,
  isTitleSourceCopy,
  normalizeJobLocale,
  titleContainsLlmReasoning,
} from './job-locale-utils.mjs';
import { hasUsableTitle } from './translation-quality.mjs';
import { buildStableJobIdentity } from './job-identity.mjs';

/**
 * I crawler di agenzia ammessi solo a traduzione avvenuta. Un'unica lista:
 * chiave del crawler = `companyKey` dei suoi job = nome dello slice.
 */
export const TRANSLATION_HOLD_CRAWLER_KEYS = Object.freeze([
  'fachkraft',
  'sta',
  'stellenpartner',
  'stellentreff',
]);
const HOLD_KEY_SET = new Set(TRANSLATION_HOLD_CRAWLER_KEYS);

/** ISO del primo crawl in cui il job è arrivato non tradotto. */
export const TRANSLATION_HOLD_FIELD = 'translationHoldSince';
/** ISO del rilascio: l'orologio di novità del job una volta pubblicato. */
export const TRANSLATION_HOLD_RELEASED_FIELD = 'translationHoldReleasedAt';

/**
 * translate-pending deve vedere anche i job trattenuti in data/jobs.json: la
 * fase 2b (relocalize-pending-jobs.mjs) e i marcatori leggono quel file, non
 * gli slice. Con questa variabile a '1' l'assemblatore li include; il default
 * (deploy, test, alert) li esclude.
 */
export const INCLUDE_TRANSLATION_HELD_ENV = 'JOBS_INCLUDE_TRANSLATION_HELD';

export function includeTranslationHeldFromEnv(env = process.env) {
  return String(env?.[INCLUDE_TRANSLATION_HELD_ENV] || '') === '1';
}

function normalizeKey(value) {
  return String(value || '').trim().toLowerCase();
}

export function isTranslationHoldCrawlerKey(crawlerKey) {
  return HOLD_KEY_SET.has(normalizeKey(crawlerKey));
}

export function isTranslationGatedJob(job) {
  return HOLD_KEY_SET.has(normalizeKey(job?.companyKey));
}

function resolveSourceLang(job) {
  const lang = normalizeJobLocale(job?.sourceLang || 'it');
  return DEFAULT_JOB_LOCALES.includes(lang) ? lang : 'it';
}

/**
 * Locale il cui titolo non è ancora pubblicabile: slot assente o troppo corto,
 * copia del titolo sorgente, oppure ragionamento di un LLM al posto del titolo.
 *
 * @param {object} job
 * @returns {string[]}
 */
export function untranslatedTitleLocales(job) {
  const titles = job?.titleByLocale && typeof job.titleByLocale === 'object' ? job.titleByLocale : {};
  const sourceLang = resolveSourceLang(job);
  const crawledTitle = String(job?.title || '').trim();
  const sourceTitle = String(titles[sourceLang] || crawledTitle).trim();
  const pending = [];
  for (const locale of DEFAULT_JOB_LOCALES) {
    const title = String(titles[locale] || '').trim();
    if (locale === sourceLang) {
      if (!hasUsableTitle(title || crawledTitle)) pending.push(locale);
      continue;
    }
    if (
      !hasUsableTitle(title)
      || isTitleSourceCopy(title, sourceTitle)
      || isTitleSourceCopy(title, crawledTitle)
      || titleContainsLlmReasoning(title)
    ) {
      pending.push(locale);
    }
  }
  return pending;
}

export function hasPublishableTitles(job) {
  return untranslatedTitleLocales(job).length === 0;
}

/**
 * Il job è fuori dalla pubblicazione in questo momento?
 *
 * @param {object} job
 * @returns {boolean}
 */
export function isHeldFromPublication(job) {
  return isTranslationGatedJob(job)
    && Boolean(job?.[TRANSLATION_HOLD_FIELD])
    && !hasPublishableTitles(job);
}

/**
 * @param {object[]} jobs
 * @returns {{ published: object[], held: object[] }}
 */
export function partitionHeldFromPublication(jobs) {
  const published = [];
  const held = [];
  for (const job of Array.isArray(jobs) ? jobs : []) {
    (isHeldFromPublication(job) ? held : published).push(job);
  }
  return { published, held };
}

/** Il solo filtro che i lettori diretti degli slice devono applicare. */
export function excludeHeldFromPublication(jobs) {
  return (Array.isArray(jobs) ? jobs : []).filter((job) => !isHeldFromPublication(job));
}

function release(job, nowIso) {
  delete job[TRANSLATION_HOLD_FIELD];
  if (!job[TRANSLATION_HOLD_RELEASED_FIELD]) job[TRANSLATION_HOLD_RELEASED_FIELD] = nowIso;
}

/**
 * Rilascia i job trattenuti i cui titoli sono ormai tutti tradotti: toglie il
 * timbro (l'ammissione diventa definitiva) e fissa l'orologio di novità.
 * Muta i job in place.
 *
 * @param {object[]} jobs
 * @param {{ now?: string }} [opts]
 * @returns {number} job rilasciati
 */
export function releaseTranslatedHolds(jobs, { now = new Date().toISOString() } = {}) {
  let released = 0;
  for (const job of Array.isArray(jobs) ? jobs : []) {
    if (!job || !job[TRANSLATION_HOLD_FIELD] || !isTranslationGatedJob(job)) continue;
    if (!hasPublishableTitles(job)) continue;
    release(job, now);
    released++;
  }
  return released;
}

function lookupKeys(job) {
  const keys = new Set();
  const add = (value) => {
    const key = String(value || '').trim();
    if (key) keys.add(key);
  };
  add(buildStableJobIdentity(job));
  const url = String(job?.url || '').trim();
  if (url) add(`url-raw:${url}`);
  const id = String(job?.id || '').trim();
  if (id) add(`id-raw:${id}`);
  const slug = String(job?.slug || '').trim().toLowerCase();
  if (slug) add(`slug-raw:${slug}`);
  for (const value of Object.values(job?.slugByLocale || {})) {
    const s = String(value || '').trim().toLowerCase();
    if (s) add(`slug-raw:${s}`);
  }
  return keys;
}

/**
 * Timbra lo stato di ammissione al momento in cui il crawler scrive lo slice.
 *
 * - job già presente nello slice su disco e non trattenuto (pubblicato prima di
 *   questo cambio o già rilasciato): resta ammesso, anche se oggi il titolo è
 *   tornato una copia. Ritirare un URL già servito non è mai accettabile.
 * - job già trattenuto: resta trattenuto (stesso timbro) finché una delle due
 *   copie ha i titoli tradotti, poi viene rilasciato.
 * - job nuovo: trattenuto se arriva con un titolo non tradotto.
 *
 * La ricerca del job precedente usa più chiavi (identità stabile, url, id,
 * slug): nel dubbio il job è considerato già visto, cioè ammesso. È il lato
 * sicuro: un falso «già visto» pubblica un job non tradotto, un falso «nuovo»
 * ritirerebbe un URL pubblico.
 *
 * Per un crawler che non è (più) nella lista i timbri vengono tolti, così una
 * chiave reinserita in futuro non può ritirare job pubblicati nel frattempo.
 *
 * @param {string} crawlerKey
 * @param {object[]} nextJobs   job che stanno per essere scritti (mutati)
 * @param {object[]} existingJobs job dello slice su disco
 * @param {{ now?: string }} [opts]
 * @returns {{ gated: boolean, held: number, newlyHeld: number, released: number, admittedOnArrival: number }}
 */
export function applyTranslationHold(crawlerKey, nextJobs, existingJobs, { now = new Date().toISOString() } = {}) {
  const stats = { gated: false, held: 0, newlyHeld: 0, released: 0, admittedOnArrival: 0 };
  const jobs = Array.isArray(nextJobs) ? nextJobs : [];
  if (!isTranslationHoldCrawlerKey(crawlerKey)) {
    for (const job of jobs) {
      if (job && job[TRANSLATION_HOLD_FIELD]) delete job[TRANSLATION_HOLD_FIELD];
    }
    return stats;
  }
  stats.gated = true;
  const priorByKey = new Map();
  for (const prior of Array.isArray(existingJobs) ? existingJobs : []) {
    if (!prior || typeof prior !== 'object') continue;
    for (const key of lookupKeys(prior)) {
      if (!priorByKey.has(key)) priorByKey.set(key, prior);
    }
  }
  for (const job of jobs) {
    if (!job || typeof job !== 'object') continue;
    let prior = null;
    for (const key of lookupKeys(job)) {
      prior = priorByKey.get(key) || null;
      if (prior) break;
    }
    if (prior?.[TRANSLATION_HOLD_RELEASED_FIELD] && !job[TRANSLATION_HOLD_RELEASED_FIELD]) {
      job[TRANSLATION_HOLD_RELEASED_FIELD] = prior[TRANSLATION_HOLD_RELEASED_FIELD];
    }
    if (prior && !prior[TRANSLATION_HOLD_FIELD]) {
      // Già ammesso: un URL pubblico non torna mai indietro.
      delete job[TRANSLATION_HOLD_FIELD];
      continue;
    }
    if (prior) {
      if (hasPublishableTitles(job) || hasPublishableTitles(prior)) {
        job[TRANSLATION_HOLD_FIELD] = prior[TRANSLATION_HOLD_FIELD];
        release(job, now);
        stats.released++;
      } else {
        job[TRANSLATION_HOLD_FIELD] = prior[TRANSLATION_HOLD_FIELD];
        stats.held++;
      }
      continue;
    }
    if (hasPublishableTitles(job)) {
      delete job[TRANSLATION_HOLD_FIELD];
      stats.admittedOnArrival++;
      continue;
    }
    if (!job[TRANSLATION_HOLD_FIELD]) {
      job[TRANSLATION_HOLD_FIELD] = now;
      stats.newlyHeld++;
    }
    stats.held++;
  }
  return stats;
}

/**
 * Conteggio osservabile della coda di ammissione: quanti job sono fuori dalla
 * pubblicazione in attesa di traduzione, per crawler, e da quanto aspetta il
 * più vecchio. Misura la capacità di traduzione contro l'afflusso.
 *
 * @param {object[]} jobs
 * @param {{ nowMs?: number }} [opts]
 * @returns {{ held: number, byCrawler: Record<string, number>, oldestHeldSince: string|null, oldestHeldDays: number|null }}
 */
export function summarizeTranslationHold(jobs, { nowMs = Date.now() } = {}) {
  const byCrawler = {};
  let held = 0;
  let oldestMs = null;
  let oldestHeldSince = null;
  for (const job of Array.isArray(jobs) ? jobs : []) {
    if (!isHeldFromPublication(job)) continue;
    held++;
    const key = normalizeKey(job.companyKey);
    byCrawler[key] = (byCrawler[key] || 0) + 1;
    const since = Date.parse(String(job[TRANSLATION_HOLD_FIELD] || ''));
    if (Number.isFinite(since) && (oldestMs === null || since < oldestMs)) {
      oldestMs = since;
      oldestHeldSince = new Date(since).toISOString();
    }
  }
  const oldestHeldDays = oldestMs === null ? null : Math.max(0, Math.floor((nowMs - oldestMs) / 86_400_000));
  return { held, byCrawler, oldestHeldSince, oldestHeldDays };
}

export function formatTranslationHoldSummary(summary) {
  const parts = Object.entries(summary?.byCrawler || {})
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, count]) => `${key}×${count}`);
  const oldest = summary?.oldestHeldSince
    ? `, il più vecchio dal ${summary.oldestHeldSince.slice(0, 10)} (${summary.oldestHeldDays}g)`
    : '';
  return `⏸️  Soglia di ammissione agenzie: ${summary?.held || 0} job fuori dalla pubblicazione in attesa di traduzione del titolo`
    + (parts.length > 0 ? ` (${parts.join(', ')}${oldest})` : '');
}

/**
 * Orologio di novità per gli alert: per un job rilasciato il momento in cui è
 * diventato pubblico, non quello in cui il crawler l'ha visto per la prima volta.
 *
 * @param {object} job
 * @returns {number} epoch ms del rilascio, 0 se il job non è mai stato trattenuto
 */
export function translationHoldReleasedMs(job) {
  const ms = Date.parse(String(job?.[TRANSLATION_HOLD_RELEASED_FIELD] || ''));
  return Number.isFinite(ms) ? ms : 0;
}
