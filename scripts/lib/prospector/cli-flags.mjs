/**
 * Prospector — un flag sconosciuto non si ignora in silenzio.
 *
 * Ogni stadio della coda ha un `--dry-run` che decide se la corsa SCRIVE:
 * `candidates.json`, il registro `ledger.jsonl`, gli scaffolding di
 * `prospect-promote`. Il flag e' riconosciuto per confronto letterale, quindi
 * un refuso (`--dryrun`, `--dry`, `-n`) non e' un flag diverso: e' nessun flag,
 * e la corsa scrive davvero. Su `prospect-reject` il danno non e' recuperabile
 * per la via sanzionata — `rejected` e' terminale e `setStatus` e' forward-only
 * (`candidate-store.mjs`), quindi non esiste comando che riporti la spec a
 * `promoted` — ma vale per ogni stadio: nessuno di loro sa disfare cio' che ha
 * scritto.
 *
 * La lista dei flag noti sta accanto al parsing di ciascuno stadio, perche' e'
 * li' che si aggiunge un flag; qui sta solo il confronto, cosi' un refuso muore
 * allo stesso modo dappertutto invece di dipendere da come ogni script filtra
 * il suo argv.
 */

/**
 * Il confronto parte da UN trattino, non da due: `-n` e' il refuso piu' comune
 * di `--dry-run` e non e' mai un argomento posizionale valido di questi stadi
 * (i posizionali di `prospect-reject` sono `<ref>='<causa>'`, e un `ref` non
 * comincia con un trattino).
 *
 * @param {string[]} argv
 * @param {Iterable<string>} known nomi SENZA il prefisso `--` (`dry-run`, `limit`)
 * @returns {string[]} i token che nessuno stadio conosce, com'erano scritti
 */
export function unknownFlags(argv, known) {
  const allowed = new Set(known);
  const out = [];
  for (const a of argv) {
    if (typeof a !== 'string' || !a.startsWith('-')) continue;
    const name = a.replace(/^-+/, '').split('=')[0];
    if (!allowed.has(name)) out.push(a);
  }
  return out;
}

/**
 * Variante da entrypoint: stampa e esce `2` invece di restituire. Esce PRIMA di
 * qualunque scrittura, cosi' il refuso costa una riga di stderr e non una
 * transizione irreversibile.
 *
 * @param {string[]} argv
 * @param {Iterable<string>} known
 * @param {string} [usage] riga di usage da stampare dopo l'errore
 */
export function assertKnownFlags(argv, known, usage) {
  const unknown = unknownFlags(argv, known);
  if (!unknown.length) return;
  console.error(`Flag sconosciuto: ${unknown.join(' ')} — un refuso su --dry-run fa scrivere la corsa.`);
  if (usage) console.error(usage);
  process.exit(2);
}
