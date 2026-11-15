// scripts/lib/job-alert-inventory.mjs
//
// L'inventario in memoria del sender dei job alert, nella sua forma snella
// (perf-plan PR 3).
//
// IL PROBLEMA (R2 del piano). `loadJobs()` teneva ogni riga di `data/jobs.json`
// con tutti i campi: ~15,7 KB di JSON e ~26 KB di heap per riga, di cui il 70% e'
// `descriptionByLocale` (11 KB), che serve soltanto alla ricerca testuale di un
// alert, nel suo locale. Sommato alle cache delle feature, l'heap di picco e'
// stato 5,7 GiB e ha richiesto `--max-old-space-size=8192`.
//
// COSA FA QUESTO MODULO.
//  1. Costruisce `locationIndex` e `cityToCanton` mentre scorre le righe, tenendo
//     di ognuna solo `{geo, company}`: le righe intere non servono a questo.
//  2. Tiene per il matching una proiezione delle sole righe con un timestamp
//     d'inventario valido (le altre sono in quarantena, come prima), senza i campi
//     che il percorso del sender non legge mai (vedi INVENTORY_DROPPED_FIELDS), e
//     con `descriptionByLocale` FUORI dall'heap di V8: un Buffer con il JSON della
//     mappa e un getter che lo decodifica solo quando la ricerca di un alert la
//     legge. Per tutti gli altri accessi la riga si comporta come prima.
//  3. Non crea il secondo array `recent`: serviva solo al log, ora e' un conteggio.
//
// I CAMPI SCARTATI sono una lista esplicita, non una lista di campi da tenere: un
// campo nuovo nel dataset resta nella riga e non viene perso in silenzio. Che
// nessuno di quelli scartati sia letto dal percorso del sender lo dimostra
// tests/job-alert-inventory.test.ts con un Proxy che registra ogni lettura.

import { jobInventoryTimestampMs } from './job-alert-newness.mjs';

/**
 * Campi grandi che nessun consumatore del sender legge: matching
 * (services/jobAlertMatching.mjs), ranking, email, live-link, manifest,
 * discovery. Sono campi dei crawler e delle pagine pubbliche.
 */
export const INVENTORY_DROPPED_FIELDS = Object.freeze([
  'previousSlugs',
  'previousSlugsByLocale',
  'requirements',
  'requirementsByLocale',
  'applyUrl',
  '_migrosBenefits',
  '_migrosResponsibilities',
]);

const DROPPED = new Set(INVENTORY_DROPPED_FIELDS);

/**
 * La riga per il matching: una copia superficiale senza i campi scartati e con
 * `descriptionByLocale` in un Buffer fuori dall'heap, esposta da un getter.
 * Il getter e' non enumerabile: un `{...riga}` non copia la mappa (e nessun
 * lettore ne ha bisogno: la legge solo la ricerca dello scorer, dalla riga
 * originale).
 */
export function projectJobForAlerts(job, { offHeapLocaleDescriptions = true } = {}) {
  const projected = {};
  for (const key of Object.keys(job)) {
    if (DROPPED.has(key)) continue;
    if (offHeapLocaleDescriptions && key === 'descriptionByLocale') continue;
    projected[key] = job[key];
  }
  const byLocale = job.descriptionByLocale;
  if (offHeapLocaleDescriptions && byLocale && typeof byLocale === 'object' && Object.keys(byLocale).length > 0) {
    const encoded = Buffer.from(JSON.stringify(byLocale), 'utf8');
    Object.defineProperty(projected, 'descriptionByLocale', {
      configurable: true,
      enumerable: false,
      get: () => JSON.parse(encoded.toString('utf8')),
    });
  } else if (!offHeapLocaleDescriptions && byLocale !== undefined) {
    projected.descriptionByLocale = byLocale;
  }
  return projected;
}

/**
 * @param {unknown} jobs righe di `data/jobs.json` (l'array intero, gia' letto)
 * @param {object} options
 * @param {number} options.nowMs
 * @param {number} options.windowMs finestra «recente» del solo log
 * @param {Record<string, string>} options.cityCantonFloor citta' -> cantone di partenza
 * @param {(job: object) => boolean} [options.isFresh] per il conteggio dei nuovi (log)
 * @param {boolean} [options.lean] `false` tiene le righe com'erano (kill switch)
 */
export function buildAlertInventory(jobs, {
  nowMs,
  windowMs,
  cityCantonFloor = {},
  isFresh = () => false,
  lean = true,
} = {}) {
  const inventory = [];
  const locationIndex = new Map();
  // City → canton index over the FULL dataset, so the graduated geo preference
  // (#2993) can resolve a subscriber's preferred city (e.g. "bellinzona") to its
  // canton ("ti") and treat every TI job as in-area — not just exact-city hits.
  // Seeded with the static floor; dataset entries never override it.
  const cityToCanton = new Map(Object.entries(cityCantonFloor));
  const cutoff = nowMs - windowMs;
  let recentCount = 0;
  let freshCount = 0;
  if (!Array.isArray(jobs)) return { inventory, recentCount, freshCount, locationIndex, cityToCanton };

  for (const j of jobs) {
    const geo = [j.location || j.addressLocality || '', j.canton || ''].filter(Boolean);
    const company = j.company || '';
    if (geo.length > 0 || company) {
      const meta = { geo, company };
      for (const key of [j.slug, ...Object.values(j.slugByLocale || {}), j.id]) {
        if (key) locationIndex.set(String(key).toLowerCase(), meta);
      }
    }
    const canton = String(j.canton || '').toLowerCase();
    if (canton) {
      for (const city of [j.location, j.addressLocality]) {
        const c = String(city || '').toLowerCase().trim();
        if (c && !cityToCanton.has(c)) cityToCanton.set(c, canton);
      }
    }
    // needsRetranslation is NOT checked here: this pool is shared across every
    // subscriber alert regardless of locale, and the flag only means
    // translations FROM the job's source locale are stale — it never means
    // the source locale's own title/description is bad. Blanket-excluding
    // here wrongly dropped a job from EVERY alert (including ones in its own
    // source language) whenever any other locale's translation was pending.
    // The locale-aware exemption is applied per-alert below, where the
    // recipient's locale is actually known (#4715).
    const inventoryAt = jobInventoryTimestampMs(j);
    // A future crawl timestamp is malformed input, not a reason to send a job
    // before it can exist. Rows without any usable inventory timestamp are
    // quarantined from matching rather than widening the pool to all history.
    if (inventoryAt > 0 && inventoryAt <= nowMs) {
      inventory.push(lean ? projectJobForAlerts(j) : j);
      if (inventoryAt >= cutoff) {
        recentCount += 1;
        if (isFresh(j)) freshCount += 1;
      }
    }
  }
  return { inventory, recentCount, freshCount, locationIndex, cityToCanton };
}
