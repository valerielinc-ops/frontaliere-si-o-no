// scripts/lib/job-pages-manifest-client.mjs
//
// Il lato sender del manifest delle pagine annuncio (perf-plan PR 5). Lo scrive
// il build (build-plugins/shared/jobPagesManifest.mjs, dentro jobsSeoPagesPlugin);
// qui lo si scarica UNA volta e lo si usa al posto di un GET per annuncio.
//
// La regola e' prudente: il manifest e' un'ottimizzazione, non una fonte di
// verita' da cui dipendere. Se manca, non si legge, e' stantio rispetto ai dati,
// o non copre abbastanza annunci aperti (segno che la corrispondenza fra il
// percorso che calcola il sender e quello che emette il build non regge), il
// chiamante ripiega sul controllo HTTP di sempre, invariato, con il suo
// fail-open. Mai su un manifest di cui non ci si puo' fidare.

import { JOB_PAGES_MANIFEST_URL_PATH, createJobPagesManifestLookup } from '../../build-plugins/shared/jobPagesManifest.mjs';
import { DEFAULT_LIVE_CHECK_USER_AGENT } from './live-link-check.mjs';

export const DEFAULT_JOB_PAGES_MANIFEST_URL = `https://frontaliereticino.ch${JOB_PAGES_MANIFEST_URL_PATH}`;
export const DEFAULT_MANIFEST_MAX_AGE_HOURS = 36;
export const DEFAULT_MANIFEST_MIN_COVERAGE = 0.5;
export const MANIFEST_MODES = Object.freeze(['auto', 'off']);

/**
 * Configurazione, da ambiente (Remote Config → env):
 *  - JOB_ALERT_LIVE_LINK_MANIFEST: `auto` (default) | `off` (solo controllo HTTP);
 *  - JOB_ALERT_LIVE_LINK_MANIFEST_MAX_AGE_HOURS: eta' massima del manifest
 *    rispetto ai dati (default 36);
 *  - JOB_PAGES_MANIFEST_URL e JOB_ALERT_LIVE_LINK_MANIFEST_MIN_COVERAGE: solo
 *    ambiente (non sono parametri Remote Config).
 */
export function resolveLiveLinkManifestConfig(env = process.env) {
  const rawMode = String(env.JOB_ALERT_LIVE_LINK_MANIFEST ?? '').trim().toLowerCase();
  const mode = MANIFEST_MODES.includes(rawMode) ? rawMode : 'auto';
  // Una stringa vuota e' «non impostato», non zero: Number('') vale 0.
  const numberOrNaN = (value) => {
    const text = String(value ?? '').trim();
    return text === '' ? Number.NaN : Number(text);
  };
  const age = numberOrNaN(env.JOB_ALERT_LIVE_LINK_MANIFEST_MAX_AGE_HOURS);
  const coverage = numberOrNaN(env.JOB_ALERT_LIVE_LINK_MANIFEST_MIN_COVERAGE);
  return {
    mode,
    url: String(env.JOB_PAGES_MANIFEST_URL || '').trim() || DEFAULT_JOB_PAGES_MANIFEST_URL,
    maxAgeHours: Number.isFinite(age) && age > 0 ? age : DEFAULT_MANIFEST_MAX_AGE_HOURS,
    minCoverage: Number.isFinite(coverage) && coverage >= 0 && coverage <= 1 ? coverage : DEFAULT_MANIFEST_MIN_COVERAGE,
  };
}

/**
 * Scarica e valida il manifest. Non lancia mai. `onRequest` e' chiamato a ogni
 * richiesta HTTP effettiva (per la telemetria).
 *
 * @returns {Promise<{usable: true, lookup: object, ageHours: number}
 *   | {usable: false, reason: string, detail?: string}>}
 */
export async function loadJobPagesManifest({
  url = DEFAULT_JOB_PAGES_MANIFEST_URL,
  fetchImpl = globalThis.fetch,
  timeoutMs = 20_000,
  attempts = 2,
  datasetAtMs,
  maxAgeHours = DEFAULT_MANIFEST_MAX_AGE_HOURS,
  onRequest = () => {},
} = {}) {
  let manifest = null;
  let lastReason = 'fetch-failed';
  let lastDetail = '';
  for (let attempt = 1; attempt <= attempts && !manifest; attempt += 1) {
    try {
      onRequest();
      const response = await fetchImpl(url, {
        headers: { 'User-Agent': DEFAULT_LIVE_CHECK_USER_AGENT, Accept: 'application/json' },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) {
        lastReason = `http-${response.status}`;
        // Un 404 e' definitivo (non ancora pubblicato): inutile riprovare.
        if (response.status === 404 || response.status === 410) break;
        continue;
      }
      manifest = JSON.parse(await response.text());
    } catch (error) {
      lastReason = error?.name === 'SyntaxError' ? 'malformed' : 'fetch-failed';
      lastDetail = String(error?.name || 'Error');
    }
  }
  if (!manifest) return { usable: false, reason: lastReason, detail: lastDetail };

  const lookup = createJobPagesManifestLookup(manifest);
  if (!lookup) return { usable: false, reason: 'malformed' };

  const referenceMs = Number.isFinite(datasetAtMs) ? datasetAtMs : Date.now();
  const ageHours = (referenceMs - lookup.generatedAtMs) / 3_600_000;
  // Un manifest «dal futuro» rispetto ai dati non e' sospetto: i dati possono
  // essere quelli di un'ora fa. Conta solo la distanza nel passato.
  if (ageHours > maxAgeHours) return { usable: false, reason: 'stale', detail: `${ageHours.toFixed(1)}h` };
  return { usable: true, lookup, ageHours };
}

/**
 * Copertura del manifest sugli annunci aperti dell'inventario: la frazione delle
 * righe (nel locale dato) la cui pagina e' nel manifest. Un valore basso non vuol
 * dire che gli annunci sono morti: vuol dire che il percorso calcolato dal sender
 * non coincide con quello emesso dal build, o che il manifest e' di un altro
 * giorno. In entrambi i casi non ci si puo' fidare per decidere cosa spedire.
 *
 * @param {{has: (path: string) => boolean}} lookup
 * @param {Iterable<object>} jobs
 * @param {(job: object) => string|null} urlFor URL della pagina nel locale scelto
 * @param {{sample?: number}} [options] campione deterministico (le prime N con URL)
 */
export function manifestCoverage(lookup, jobs, urlFor, { sample = 5000 } = {}) {
  let checked = 0;
  let present = 0;
  for (const job of jobs) {
    const url = urlFor(job);
    if (!url) continue;
    checked += 1;
    if (lookup.has(url)) present += 1;
    if (checked >= sample) break;
  }
  return { checked, present, ratio: checked === 0 ? 0 : present / checked };
}
