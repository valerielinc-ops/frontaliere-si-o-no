/**
 * Commit del checkout che sta eseguendo questo codice.
 *
 * Serve a firmare ciò che un crawler pubblica (summary slice) col codice che
 * lo ha prodotto: senza, monitor e fixer non possono distinguere «la fix non
 * funziona» da «la fix non ha ancora girato» — il caso delle ondate lanciate
 * dal fallback di contratto su un commit del sito arretrato.
 *
 * Si legge da git e non da `GITHUB_SHA`: i gruppi crawler girano nel repo
 * corpus con un checkout cross-repo del sito, quindi lì `GITHUB_SHA` è il
 * commit del CORPUS, non quello del codice eseguito. La directory di partenza
 * è quella di questo modulo, non la cwd del processo, per lo stesso motivo.
 *
 * Non determinabile (niente `.git`, git assente, output inatteso) → `null`:
 * chi scrive omette il campo, non inventa un valore.
 */
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const COMMIT_RE = /^[0-9a-f]{40}$/;
const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));

export function resolveCheckoutCodeCommit({ cwd = MODULE_DIR, exec = execFileSync } = {}) {
  try {
    const head = String(exec('git', ['rev-parse', 'HEAD'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5_000,
    })).trim();
    return COMMIT_RE.test(head) ? head : null;
  } catch {
    return null;
  }
}

let cached;

/** Risolto una sola volta per processo: il checkout non cambia sotto un crawler. */
export function currentCheckoutCodeCommit() {
  if (cached === undefined) cached = resolveCheckoutCodeCommit();
  return cached;
}

/**
 * Firma una summary col commit del checkout. Un `codeCommit` già presente
 * nell'oggetto (per esempio ereditato da una summary precedente) viene sempre
 * sostituito o rimosso: il campo descrive QUESTA esecuzione.
 */
export function stampCodeCommit(summary, codeCommit = currentCheckoutCodeCommit()) {
  const stamped = { ...summary };
  delete stamped.codeCommit;
  if (COMMIT_RE.test(codeCommit ?? '')) stamped.codeCommit = codeCommit;
  return stamped;
}
