/**
 * Prospector — un flag sconosciuto non si ignora in silenzio.
 *
 * Ogni stadio della coda ha un `--dry-run` che decide se la corsa SCRIVE:
 * `candidates.json`, il registro `ledger.jsonl`, gli scaffolding di
 * `prospect-promote`. Il consumo e' `argv.includes('--dry-run')` (token nudo):
 * un refuso (`--dryrun`, `-n`, `--dry-run=1`, `-dry-run`) non e' un flag
 * diverso, e' nessun flag, e la corsa scrive davvero. Su `prospect-reject` il
 * danno non e' recuperabile — `rejected` e' terminale e `setStatus` e'
 * forward-only (`candidate-store.mjs`).
 *
 * La lista dei noti distingue booleani (token nudo `--name`) da valued
 * (`--name=valore`), perche' e' la stessa forma con cui ogni stadio li legge.
 * Qui sta solo il confronto, cosi' un refuso muore allo stesso modo
 * dappertutto invece di dipendere da come ogni script filtra il suo argv.
 */

/**
 * Forme canoniche: esattamente due trattini, poi un carattere che non e' un
 * trattino. `-dry-run` e `---dry-run` cadono qui: `replace(/^-+/, '')` li
 * rendeva uguali a `--dry-run`, e il consumo a `includes('--dry-run')` li
 * perdeva.
 *
 * @param {string} token la parte prima di `=`, o l'argomento intero
 */
function isCanonicalFlagToken(token) {
  return /^--[^-]/.test(token);
}

/**
 * @typedef {{ booleans?: Iterable<string>, valued?: Iterable<string> }} KnownFlags
 *   `booleans`: accettati solo nudi (`--dry-run`). `--dry-run=1` e' sconosciuto.
 *   `valued`: accettati solo con `=` (`--limit=40`). `--limit` nudo e' sconosciuto.
 */

/**
 * @param {string[]} argv
 * @param {KnownFlags} known
 * @returns {string[]} i token che nessuno stadio conosce, com'erano scritti
 */
export function unknownFlags(argv, known) {
  // Un array al posto di `{ booleans, valued }` e' il vecchio contratto che
  // accettava `--dry-run=1`. Fail-closed: ogni `-…` e' sconosciuto, cosi' un
  // call site non aggiornato esce 2 invece di scrivere.
  if (!known || typeof known !== 'object' || Array.isArray(known)) {
    return argv.filter((a) => typeof a === 'string' && a.startsWith('-'));
  }
  const booleans = new Set(known.booleans || []);
  const valued = new Set(known.valued || []);
  const out = [];
  for (const a of argv) {
    if (typeof a !== 'string' || !a.startsWith('-')) continue;
    const eq = a.indexOf('=');
    const token = eq === -1 ? a : a.slice(0, eq);
    if (!isCanonicalFlagToken(token)) {
      out.push(a);
      continue;
    }
    const name = token.slice(2);
    const hasValue = eq !== -1;
    if (booleans.has(name)) {
      if (hasValue) out.push(a);
      continue;
    }
    if (valued.has(name)) {
      if (!hasValue) out.push(a);
      continue;
    }
    out.push(a);
  }
  return out;
}

/**
 * Variante da entrypoint: stampa e esce `2` invece di restituire. Esce PRIMA di
 * qualunque scrittura, cosi' il refuso costa una riga di stderr e non una
 * transizione irreversibile.
 *
 * @param {string[]} argv
 * @param {KnownFlags} known
 * @param {string} [usage] riga di usage da stampare dopo l'errore
 */
export function assertKnownFlags(argv, known, usage) {
  const unknown = unknownFlags(argv, known);
  if (!unknown.length) return;
  console.error(`Flag sconosciuto: ${unknown.join(' ')} — un refuso su --dry-run fa scrivere la corsa.`);
  if (usage) console.error(usage);
  process.exit(2);
}
