// scripts/lib/company-alert-publication-gate.mjs
//
// Le CompanyAlert partono a pagine online (perf-plan email senders, punto 1).
//
// IL PROBLEMA. Il workflow partiva su `push` a data/jobs/by-crawler/**: cioe' quando
// i crawler committano gli annunci, PRIMA che il deploy pubblichi le pagine. Un'email
// poteva linkare una pagina non ancora online. Ora parte quando il deploy ha
// pubblicato (workflow_run) o col cron orario di sicurezza, e prima di reclamare
// un annuncio si verifica che la sua pagina sia pubblicata.
//
// LA REGOLA. Un annuncio la cui pagina non risulta pubblicata si RIMANDA: non si
// invia, non si marca come inviato (`sentJobIds` non lo vede mai) e non entra nel
// ledger. Resta nella finestra di novita' della run successiva, che e' abbastanza
// larga da sopravvivere a un deploy ritardato (vedi `resolveImmediateWindowHours`).
// Meglio un invio in ritardo che un link a una pagina che non c'e'.
//
//   fonte        quando                                   risposta a «la pagina e' online?»
//   manifest     manifest scaricabile, fresco e che       `lookup.has(url)`: locale, gratuita.
//                copre abbastanza annunci aperti          L'assenza e' «scaduta o non ancora
//                                                         pubblicata»: rimanda.
//   http         cron/manuale con manifest assente,       GET della pagina (checkPageBodyLive).
//                stantio o poco coerente                  Si invia solo cio' che una GET ha
//                                                         confermato; esito negativo,
//                                                         non verificato o oltre il tetto rimanda.
//   deferAll     workflow_run con manifest inutilizzabile  rimanda tutto: se il deploy e' appena
//                                                         finito e il manifest non e' leggibile,
//                                                         il cron orario riprovera'.
//
// DIFFERENZA CON LA JOBALERT. Il controllo HTTP della jobalert ha un fail-open (con
// poche pagine vive su un campione si presume un guasto di rete e si spedisce lo stesso):
// li' l'inventario e' quasi tutto vivo. Qui il campione e' fatto di annunci APPENA
// scoperti, cioe' proprio quelli che prima del deploy non hanno la pagina: una bassa
// frazione di pagine vive e' il caso normale, non un guasto. Quindi nessun fail-open:
// un guasto di rete si traduce in rinvio, non in invii non verificati. Se il filtro
// stesso dovesse dare problemi, il kill switch e' COMPANY_ALERT_LIVE_LINK_FILTER=off
// (Remote Config), che riporta al comportamento di prima.
//
// Privacy: le metriche sono contatori. Nessun id di annuncio, nessun indirizzo.

import { checkPageBodyLive, runWithConcurrency } from './live-link-check.mjs';
import {
  loadJobPagesManifest,
  manifestCoverage,
  resolveLiveLinkManifestConfig,
} from './job-pages-manifest-client.mjs';

export const LIVE_FILTER_MODES = Object.freeze(['on', 'off']);
export const DEFAULT_LIVE_FILTER_MODE = 'on';

/** Finestra di novita' di default: vedi `resolveImmediateWindowHours`. */
export const DEFAULT_IMMEDIATE_WINDOW_HOURS = 48;
export const MIN_IMMEDIATE_WINDOW_HOURS = 1;
/** Tetto: un valore Remote Config sbagliato non puo' riaprire settimane di annunci. */
export const MAX_IMMEDIATE_WINDOW_HOURS = 168;
/** GET HTTP al massimo per run nel percorso `http`: oltre, gli annunci si rimandano. */
export const DEFAULT_MAX_HTTP_CHECKS = 1500;
export const HTTP_CHECK_CONCURRENCY = 16;

/**
 * `COMPANY_ALERT_LIVE_LINK_FILTER` (Remote Config): `on` (default) | `off`.
 * Qualunque altro valore, o l'assenza, vale `on`: il default sicuro e' filtrare.
 */
export function resolveLiveFilterMode(env = process.env) {
  const raw = String(env?.COMPANY_ALERT_LIVE_LINK_FILTER ?? '').trim().toLowerCase();
  return LIVE_FILTER_MODES.includes(raw) ? raw : DEFAULT_LIVE_FILTER_MODE;
}

/**
 * Finestra di novita' in ore, contata da `firstSeenAt`.
 *
 * 6 h andavano bene col push-trigger (la run partiva quando l'annuncio nasceva).
 * Col trigger a deploy avvenuto non bastano: dal commit del crawler alla pagina
 * online passano la build (circa 4-4,5 h nelle run riuscite, 243-270 min) e la
 * pubblicazione (76 min nell'unica run riuscita del 2026-11-13), e i deploy che
 * falliscono e si ripetono (decine di run in dieci giorni) portano la latenza a
 * mezza giornata o piu'. Un annuncio visto 20 ore prima del deploy uscirebbe dalla
 * finestra senza essere mai stato inviato. 48 h coprono un giro di deploy mancato
 * con margine; la dedup per alert resta `sentJobIds` (30 giorni), quindi allargare
 * la finestra non puo' far inviare due volte lo stesso annuncio.
 *
 * `COMPANY_ALERT_IMMEDIATE_WINDOW_HOURS` (Remote Config) la sposta; il vecchio nome
 * `COMPANY_ALERT_WINDOW_HOURS` (solo ambiente) resta come ripiego. Valori non
 * numerici o non positivi → default; oltre MAX → MAX.
 */
export function resolveImmediateWindowHours(env = process.env) {
  for (const name of ['COMPANY_ALERT_IMMEDIATE_WINDOW_HOURS', 'COMPANY_ALERT_WINDOW_HOURS']) {
    const text = String(env?.[name] ?? '').trim();
    if (text === '') continue;
    const value = Number(text);
    if (Number.isFinite(value) && value > 0) {
      return Math.min(MAX_IMMEDIATE_WINDOW_HOURS, Math.max(MIN_IMMEDIATE_WINDOW_HOURS, value));
    }
  }
  return DEFAULT_IMMEDIATE_WINDOW_HOURS;
}

/**
 * Chi ha avviato la run, per la telemetria. Il `push` non e' piu' un trigger
 * (`legacy-push` esiste solo per riconoscere una run lanciata da un workflow
 * vecchio e non va mai contato come nuovo).
 */
export function resolveCompanyAlertTrigger(env = process.env) {
  const raw = String(env?.COMPANY_ALERT_TRIGGER || env?.GITHUB_EVENT_NAME || '').trim().toLowerCase();
  if (raw === 'workflow_run') return 'workflow_run';
  if (raw === 'schedule') return 'schedule';
  if (raw === 'workflow_dispatch' || raw === 'dispatch') return 'dispatch';
  if (raw === 'push') return 'legacy-push';
  return 'other';
}

const jobKey = (job) => String(job?.id ?? job?.slug ?? job?.url ?? '');

/**
 * Costruisce il filtro per questa run.
 *
 * @param {object} options
 * @param {'workflow_run'|'schedule'|'dispatch'|'legacy-push'|'other'} options.trigger
 * @param {'on'|'off'} [options.mode]
 * @param {object[]} [options.inventory]   annunci aperti dell'inventario (copertura del manifest)
 * @param {number} [options.datasetAtMs]   eta' di riferimento dei dati (freschezza del manifest)
 * @param {(job: object, locale: string) => string|null} options.jobPageUrl
 * @param {object} [options.config]        resolveLiveLinkManifestConfig()
 * @param {typeof fetch} [options.fetchImpl]
 * @param {(url: string) => Promise<boolean>} [options.httpCheck]
 * @param {number} [options.maxHttpChecks]
 * @param {object} [options.metrics]       createSenderMetrics()
 * @param {(line: string) => void} [options.log]
 * @param {(line: string) => void} [options.warn]
 */
export async function createCompanyAlertPublicationGate({
  trigger = 'other',
  mode = DEFAULT_LIVE_FILTER_MODE,
  inventory = [],
  datasetAtMs,
  jobPageUrl,
  config = resolveLiveLinkManifestConfig(),
  fetchImpl = globalThis.fetch,
  httpCheck = (url) => checkPageBodyLive(url),
  maxHttpChecks = DEFAULT_MAX_HTTP_CHECKS,
  metrics = null,
  log = () => {},
  warn = () => {},
} = {}) {
  const deferredKeys = new Set();
  const decisions = new WeakMap();
  const httpResults = new Map();
  let httpRequests = 0;
  let source = 'off';
  let reason = 'disabled';
  let lookup = null;
  let deferAll = false;

  const report = () => {
    if (!metrics) return;
    metrics.set('liveFilterMode', mode);
    metrics.set('liveFilterSource', source);
    metrics.set('liveFilterDeferred', deferredKeys.size);
    metrics.set('liveFilterHttpRequests', httpRequests);
    if (lookup) metrics.set('liveFilterManifestPages', lookup.pageCount);
  };

  if (mode === 'off') {
    report();
  } else {
    if (config.mode === 'off') {
      source = 'http';
      reason = 'manifest-disabled';
    } else {
      const loaded = await loadJobPagesManifest({
        url: config.url,
        fetchImpl,
        datasetAtMs,
        maxAgeHours: config.maxAgeHours,
        onRequest: () => { httpRequests += 1; },
      });
      if (!loaded.usable) {
        reason = loaded.reason;
        warn(`   ⚠️  Job-pages manifest unusable (${loaded.reason}${loaded.detail ? ` ${loaded.detail}` : ''})`);
        source = 'http';
      } else {
        const coverage = manifestCoverage(loaded.lookup, inventory, (job) => jobPageUrl(job, 'it'));
        if (coverage.ratio < config.minCoverage) {
          reason = 'low-coverage';
          warn(`   ⚠️  Job-pages manifest covers only ${(coverage.ratio * 100).toFixed(1)}% of ${coverage.checked} sampled open listings (< ${(config.minCoverage * 100).toFixed(0)}%)`);
          source = 'http';
        } else {
          source = 'manifest';
          reason = 'ok';
          lookup = loaded.lookup;
          log(`   📇 Publication gate via job-pages manifest: ${loaded.lookup.pageCount} active pages, ${loaded.ageHours.toFixed(1)} h old, covers ${(coverage.ratio * 100).toFixed(1)}% of ${coverage.checked} sampled open listings`);
        }
      }
    }
    if (source === 'http' && trigger === 'workflow_run') {
      // Il deploy e' appena finito e non si riesce a leggere il manifest che lo
      // descrive: prudenza, si rimanda tutto. Il cron orario riprovera'.
      deferAll = true;
      source = 'none';
    }
    report();
  }

  const decide = (job) => {
    if (mode === 'off') return true;
    if (deferAll) return false;
    const url = jobPageUrl(job, 'it');
    // Senza slug la pagina non esiste per costruzione e l'email ricade sul sito
    // radice (sempre online): niente da filtrare, come nella jobalert.
    if (!url) return true;
    if (source === 'manifest') return lookup.has(url);
    // Nel percorso HTTP gli annunci non verificati — fuori dal pool, o oltre
    // `maxHttpChecks` — si rimandano; si invia solo cio' che una GET ha confermato.
    return httpResults.get(url) === true;
  };

  return {
    mode,
    trigger,
    get source() { return source; },
    get reason() { return reason; },
    get deferAll() { return deferAll; },
    get httpRequests() { return httpRequests; },
    get deferredCount() { return deferredKeys.size; },
    /**
     * Nel percorso `http` verifica in anticipo le pagine degli annunci dati (una
     * GET per URL distinto, al massimo `maxHttpChecks`). Gli annunci non verificati
     * — fuori dal pool, o oltre il tetto — si rimandano; si invia solo cio' che una
     * GET ha confermato. Negli altri percorsi non fa niente. Non lancia mai.
     */
    async prepare(jobs) {
      if (mode === 'off' || source !== 'http') return;
      const urls = [...new Set((jobs || []).map((job) => jobPageUrl(job, 'it')).filter(Boolean))];
      const toCheck = urls.filter((url) => !httpResults.has(url)).slice(0, Math.max(0, maxHttpChecks));
      await runWithConcurrency(toCheck, HTTP_CHECK_CONCURRENCY, async (url) => {
        httpRequests += 1;
        let live = false;
        try { live = (await httpCheck(url)) === true; } catch { live = false; }
        httpResults.set(url, live);
      });
      report();
    },
    /** `true` se l'email puo' linkare questo annuncio. Sincrona e memoizzata per riga. */
    isLive(job) {
      if (!job || typeof job !== 'object') return true;
      let decision = decisions.get(job);
      if (decision === undefined) {
        decision = decide(job);
        decisions.set(job, decision);
        if (!decision) {
          deferredKeys.add(jobKey(job));
          report();
        }
      }
      return decision;
    },
  };
}
