// Sweep dei pack temporanei lasciati da fetch abortiti.
//
// PERCHÉ ESISTE (incidente 2026-08-17): un `git fetch` ucciso o morto a metà
// trasferimento NON rimuove il suo `.git/objects/pack/tmp_pack_*`. Git li conta
// come `garbage` (li vedi in `git count-objects -vH`) e NON li pota mai da solo:
// nemmeno `gc`/`maintenance` li toccano, restano lì a occupare disco per sempre.
// Con i fetch concorrenti degli hook si sono accumulati fino a 38.8 GB di
// `tmp_pack_*` in un `.git` da 55 GB — 39 GB recuperati cancellandoli a mano.
// Questo sweep chiude il buco: dopo ogni fetch dell'hook, i residui vecchi vanno
// via da soli.
//
// SICUREZZA: la soglia d'età è l'unica cosa che distingue un residuo da un fetch
// VIVO che sta scrivendo. Un fetch in corso scrive in continuazione → mtime
// recente; un residuo ha mtime fermo al momento della morte. Va chiamato solo
// tenendo il lock single-flight (nessun fetch nostro in volo) e con una soglia
// abbondante rispetto al più lento fetch plausibile.

import { readdirSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

// Il fetch di catch-up più lento misurato su questo repo (24k commit di
// arretrato) è durato ~20 minuti: 60 minuti è ~3x quel caso e non può colpire un
// trasferimento vivo.
export const STALE_PACK_AGE_MS = 60 * 60 * 1000;

const TMP_PACK_RE = /^tmp_pack_/;

// Elenca i residui potabili. Separato dalla cancellazione così il dry-run può
// stamparli e il test può verificare la selezione senza toccare il disco.
export function listStaleFetchPacks(
  packDir,
  { now = Date.now(), maxAgeMs = STALE_PACK_AGE_MS, readdir = readdirSync, stat = statSync } = {},
) {
  let entries;
  try {
    entries = readdir(packDir);
  } catch {
    return []; // pack dir assente (clone appena nato) → niente da fare
  }
  const stale = [];
  for (const name of entries) {
    if (!TMP_PACK_RE.test(name)) continue;
    const path = join(packDir, name);
    try {
      const st = stat(path);
      if (now - st.mtimeMs > maxAgeMs) stale.push({ path, bytes: st.size });
    } catch {
      /* sparito sotto di noi: se non c'è più, non è un residuo da potare */
    }
  }
  return stale;
}

// Cancella i residui e ritorna quanto ha liberato. Best-effort per file: un
// unlink fallito (permessi, file svanito) non deve fermare lo sweep.
export function sweepStaleFetchPacks(packDir, options = {}) {
  const { unlink = unlinkSync, ...listOptions } = options;
  const stale = listStaleFetchPacks(packDir, listOptions);
  let removed = 0;
  let bytes = 0;
  for (const { path, bytes: size } of stale) {
    try {
      unlink(path);
      removed++;
      bytes += size;
    } catch {
      /* best-effort */
    }
  }
  return { removed, bytes, candidates: stale.length };
}
