/**
 * PARENT-CLOSE e monitor ricorrenti: chi ha l'autorità di chiudere un padre
 * decomposto che un monitor ha RIAPERTO dopo la decomposizione.
 *
 * Il PARENT-CLOSE del followup-drainer chiude un padre `decomposed:1` quando
 * tutte le figlie dichiarate dall'ultimo marker `DECOMPOSED_INTO` sono chiuse.
 * Ma un padre può essere anche la issue canonica di un monitor
 * (`scripts/lib/github-issue-creator.mjs`, dedup per titolo): a ogni ricorrenza
 * il creator la riapre con un commento `🔁 **Reopened**`, e la label
 * `decomposed:1` resta attaccata. Il drainer la richiudeva al tick dopo e il
 * monitor la riapriva alla ricorrenza dopo: ping-pong senza significato
 * (site 5661, 140 chiusure e 141 riaperture misurate al 2026-10-04).
 *
 * Una riapertura del monitor POSTERIORE alla decomposizione dice che la
 * condizione è ricomparsa dopo che le figlie erano state pianificate: le figlie
 * chiuse non provano più nulla, e la chiusura spetta al closer del monitor,
 * non al drainer. Una decomposizione rifatta DOPO la ricorrenza ridà invece
 * l'autorità al PARENT-CLOSE (le figlie nuove coprono la condizione nuova).
 *
 * Modulo puro: niente I/O, testabile senza `gh`.
 */

/** Marker scritto dal run planner della decomposizione. Unica definizione:
 * il drainer la importa da qui, così il parse delle figlie e la data della
 * decomposizione non possono divergere. */
export const DECOMPOSED_INTO_RE = /<!--\s*DECOMPOSED_INTO:\s*((?:#?\d+[\s,]*)+)-->/i;

/** Prefisso del commento di riapertura del creator (`RECURRENCE_MARKER` +
 * `**Reopened**`, github-issue-creator.mjs). Solo in testa al body: una
 * citazione dentro un altro commento non è una riapertura. */
const REOPENED_PREFIX = '🔁 **Reopened**';

/**
 * Numeri delle sub-issue dichiarati dal marker `DECOMPOSED_INTO` di un body,
 * deduplicati e ordinati; `[]` se il marker manca o non porta numeri validi.
 * @param {unknown} body
 * @returns {number[]}
 */
export function decomposedIntoNumbers(body) {
  const m = DECOMPOSED_INTO_RE.exec(String(body || ''));
  if (!m) return [];
  return [...new Set(
    (m[1].match(/\d+/g) || []).map(Number).filter((n) => Number.isInteger(n) && n > 0),
  )].sort((a, b) => a - b);
}

/**
 * Numeri delle sub-issue dichiarate dall'ULTIMO marker `DECOMPOSED_INTO` nei
 * commenti (l'ultimo vince: una decomposizione corretta a mano sovrascrive la
 * precedente). Dedup, ordina, ignora garbage. Vive qui, e il drainer la
 * ri-esporta, perché anche `decompose-route-check.mjs` la usa: importarla dal
 * drainer porterebbe tutto il suo grafo di import nel job `decompose`.
 * @param {Array<{body?: string}> | null | undefined} comments
 * @returns {number[]}
 */
export function decomposedChildNumbers(comments) {
  let nums = null;
  for (const c of comments || []) {
    const parsed = decomposedIntoNumbers(c?.body);
    if (parsed.length) nums = parsed;
  }
  return nums || [];
}

/** Millisecondi epoch di `createdAt`, o `null` se manca o non è parsabile. */
function createdAtMs(comment) {
  const raw = comment?.createdAt;
  if (typeof raw !== 'string' || !raw) return null;
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * `true` se un monitor ha riaperto la issue DOPO l'ultima decomposizione: esiste
 * un commento che inizia con `🔁 **Reopened**` con `createdAt` posteriore a
 * quello dell'ultimo commento che porta un marker `DECOMPOSED_INTO` valido
 * (stessa regola di `decomposedChildNumbers`: l'ultimo vince).
 *
 * Fail-open verso il comportamento precedente SOLO sul dato mancante: nessun
 * marker, nessuna riapertura, `createdAt` della decomposizione assente o non
 * parsabile → `false`. Una riapertura senza data valida non prova di essere
 * posteriore e viene ignorata.
 * @param {Array<{body?: string, createdAt?: string}> | null | undefined} comments
 *   commenti di `gh issue view --json comments`, in ordine cronologico.
 * @returns {boolean}
 */
export function reopenedAfterDecomposition(comments) {
  const list = Array.isArray(comments) ? comments : [];
  let decomposition = null;
  for (const c of list) {
    if (decomposedIntoNumbers(c?.body).length) decomposition = c;
  }
  if (!decomposition) return false;
  const decomposedAt = createdAtMs(decomposition);
  if (decomposedAt === null) return false;
  return list.some((c) => {
    if (!String(c?.body || '').trimStart().startsWith(REOPENED_PREFIX)) return false;
    const at = createdAtMs(c);
    return at !== null && at > decomposedAt;
  });
}
