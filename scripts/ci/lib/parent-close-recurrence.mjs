/**
 * PARENT-CLOSE e monitor ricorrenti: chi ha l'autorità di chiudere un padre
 * decomposto che un monitor ha RIAPERTO dopo la decomposizione.
 *
 * Il PARENT-CLOSE del followup-drainer chiude un padre `decomposed:1` quando
 * tutte le figlie dichiarate dall'ultimo marker `DECOMPOSED_INTO` sono chiuse.
 * Ma un padre può essere anche la issue canonica di un monitor
 * (`scripts/lib/github-issue-creator.mjs`, dedup per titolo): a ogni ricorrenza
 * il creator riapre la issue chiusa con `🔁 **Reopened**`, oppure annota una
 * issue già aperta con `🔁 Recurrence on workflow run.`, e la label
 * `decomposed:1` resta attaccata. Il drainer la richiudeva al tick dopo e il
 * monitor la riapriva alla ricorrenza dopo: ping-pong senza significato
 * (site 5661, 140 chiusure e 141 riaperture misurate al 2026-10-04).
 *
 * Una riapertura/ricorrenza del monitor POSTERIORE alla decomposizione dice che la
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

/** Prefissi dei due commenti emessi dal monitor (`RECURRENCE_MARKER` +
 * `**Reopened**` quando riapre una issue chiusa, oppure `Recurrence on
 * workflow run.` quando la issue è già aperta). Solo in testa al body: una
 * citazione dentro un altro commento non è una ricorrenza del monitor. */
const REOPENED_PREFIX = '🔁 **Reopened**';
const RECURRENCE_PREFIX = '🔁 Recurrence on workflow run.';

/** Default conservativi del tetto durevole, sovrascrivibili dal drainer via env. */
export const DEFAULT_PARENT_REARM_MAX_PER_WINDOW = 2;
export const DEFAULT_PARENT_REARM_WINDOW_DAYS = 30;
export const PARENT_REARM_MARKER = '<!-- PARENT_REARM:';

const PARENT_REARM_RE = /<!--\s*PARENT_REARM:\s*reopened-at=([^\s>]+)(?:\s+children=([#\d,\s]+))?\s*-->/i;
const DECOMPOSED_MARKER_RE = /<!--\s*DECOMPOSED_INTO\s*:/i;

function isMonitorRecurrence(body) {
  const text = String(body || '').trimStart();
  return text.startsWith(REOPENED_PREFIX) || text.startsWith(RECURRENCE_PREFIX);
}

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
 * `true` se un monitor ha riaperto/riconfermato la issue DOPO l'ultima
 * decomposizione: esiste un commento che inizia con uno dei due prefissi
 * emessi da `github-issue-creator.mjs` (`🔁 **Reopened**` o `🔁 Recurrence on
 * workflow run.`) con `createdAt` posteriore a quello dell'ultimo commento che
 * porta un marker `DECOMPOSED_INTO` valido (stessa regola di
 * `decomposedChildNumbers`: l'ultimo vince).
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
  let decompositionIndex = -1;
  list.forEach((c, index) => {
    if (decomposedIntoNumbers(c?.body).length) {
      decomposition = c;
      decompositionIndex = index;
    }
  });
  if (!decomposition) return false;
  const decomposedAt = createdAtMs(decomposition);
  if (decomposedAt === null) return false;
  return list.some((c, index) => {
    if (!isMonitorRecurrence(c?.body)) return false;
    const at = createdAtMs(c);
    return at !== null && isAfter(at, index, decomposedAt, decompositionIndex);
  });
}

/**
 * «Dopo», per due commenti dello stesso thread. GitHub data i commenti al
 * secondo, quindi due eventi distinti possono avere lo stesso istante: in quel
 * caso decide la posizione nell'elenco, che arriva in ordine cronologico. È
 * la stessa autorità di `decomposedChildNumbers` (l'ultimo commento vince).
 */
function isAfter(atMs, index, referenceAtMs, referenceIndex) {
  return atMs > referenceAtMs || (atMs === referenceAtMs && index > referenceIndex);
}

function skipDecision(reason, extra = {}) {
  return { action: 'skip', reason, ...extra };
}

/**
 * Ultima decomposizione leggibile, con il dato temporale necessario a
 * confrontarla con la ricorrenza. Qui un marker presente ma malformato è un
 * errore, non un'assenza: il PARENT-REARM non deve reinterpretare il vicino.
 */
function latestRearmDecomposition(comments) {
  let latest = null;
  for (const [index, comment] of comments.entries()) {
    const body = typeof comment?.body === 'string' ? comment.body : '';
    if (!DECOMPOSED_MARKER_RE.test(body)) continue;
    const childNumbers = decomposedIntoNumbers(body);
    const at = createdAtMs(comment);
    if (!childNumbers.length || at === null) return { ok: false, latest: null };
    // A parità di istante vince il commento successivo, come in
    // `decomposedChildNumbers`: una seconda decomposizione nello stesso
    // secondo, che aggiunge una figlia aperta, deve decidere lei.
    if (!latest || at >= latest.atMs) {
      latest = { atMs: at, index, createdAt: comment.createdAt, childNumbers };
    }
  }
  return { ok: true, latest };
}

/**
 * Raccoglie le ricorrenze del monitor e fallisce chiuso se una ricorrenza
 * riconoscibile non porta `createdAt`: senza quel dato non si può sapere se è
 * posteriore alla decomposizione.
 */
function monitorRecurrences(comments) {
  const events = [];
  for (const [index, comment] of comments.entries()) {
    if (!isMonitorRecurrence(comment?.body)) continue;
    const at = createdAtMs(comment);
    if (at === null) return { ok: false, events: [] };
    events.push({ atMs: at, index, createdAt: comment.createdAt });
  }
  return { ok: true, events };
}

/** Marker di riarmo già scritto sul thread, oppure dato illeggibile. */
function parentRearmMarkers(comments) {
  const markers = [];
  for (const [index, comment] of comments.entries()) {
    const body = typeof comment?.body === 'string' ? comment.body : '';
    if (!/PARENT_REARM/i.test(body)) continue;
    const match = PARENT_REARM_RE.exec(body);
    const createdAt = createdAtMs(comment);
    const reopenedAt = match ? Date.parse(match[1]) : Number.NaN;
    if (!match || !Number.isFinite(reopenedAt) || createdAt === null) {
      return { ok: false, markers: [] };
    }
    markers.push({
      reopenedAtMs: reopenedAt,
      createdAtMs: createdAt,
      index,
      reopenedAt: new Date(reopenedAt).toISOString(),
    });
  }
  return { ok: true, markers };
}

function closedChildState(childNumbers, childStates) {
  if (!Array.isArray(childStates)) return { ok: false, allClosed: false };
  const byNumber = new Map();
  for (const child of childStates) {
    const number = Number(child?.number);
    const state = String(child?.state || '').toUpperCase();
    if (!Number.isInteger(number) || number <= 0 || byNumber.has(number)
      || !['OPEN', 'CLOSED'].includes(state)) {
      return { ok: false, allClosed: false };
    }
    byNumber.set(number, state);
  }
  for (const number of childNumbers) {
    if (!byNumber.has(number)) return { ok: false, allClosed: false };
    if (byNumber.get(number) !== 'CLOSED') return { ok: true, allClosed: false };
  }
  return { ok: true, allClosed: true };
}

/**
 * Decisione pura del PARENT-REARM. Il primo passaggio può essere chiamato con
 * `childStates:null` per riparare una mutazione commentata ma non etichettata:
 * l'idempotenza viene verificata prima di richiedere lo stato delle figlie.
 *
 * @param {{
 *   parentState?: string,
 *   comments?: Array<{body?: string, createdAt?: string}> | null,
 *   childStates?: Array<{number?: number|string, state?: string}> | null,
 *   now?: number,
 *   maxRearms?: number,
 *   windowMs?: number,
 * }} options
 * @returns {{action:'rearm'|'skip', reason:string, reopenedAt?:string, childNumbers?:number[]}}
 */
export function decideParentRearm({
  parentState,
  comments,
  childStates,
  now = Date.now(),
  maxRearms = DEFAULT_PARENT_REARM_MAX_PER_WINDOW,
  windowMs = DEFAULT_PARENT_REARM_WINDOW_DAYS * 24 * 60 * 60 * 1000,
} = {}) {
  if (String(parentState || '').toUpperCase() !== 'OPEN') return skipDecision('unreadable');
  if (!Array.isArray(comments) || !Number.isFinite(now)
    || !Number.isInteger(maxRearms) || maxRearms <= 0
    || !Number.isFinite(windowMs) || windowMs <= 0) {
    return skipDecision('unreadable');
  }

  const decomposition = latestRearmDecomposition(comments);
  if (!decomposition.ok || !decomposition.latest) return skipDecision('unreadable');

  const recurrences = monitorRecurrences(comments);
  if (!recurrences.ok) return skipDecision('unreadable');
  const reopened = recurrences.events
    .filter((event) => isAfter(event.atMs, event.index, decomposition.latest.atMs, decomposition.latest.index))
    .sort((a, b) => a.atMs - b.atMs || a.index - b.index)
    .at(-1);
  if (!reopened) return skipDecision('not-reopened');

  const markerState = parentRearmMarkers(comments);
  if (!markerState.ok) return skipDecision('unreadable');
  // GitHub data i commenti al secondo, quindi il marker scritto nello stesso
  // secondo della ricorrenza che registra ha il suo stesso istante: va
  // riconosciuto, altrimenti (se la rimozione delle label era fallita) il
  // passaggio successivo ne scriverebbe un altro fino al tetto della finestra.
  // A parità di istante decide però la posizione nel thread, come per le altre
  // due comparazioni di questo modulo: un marker che PRECEDE la ricorrenza non
  // può averla registrata, anche se porta lo stesso secondo (è il marker di
  // una ricorrenza precedente caduta in quel secondo). Accettarlo farebbe
  // uscire il padre come «già riarmato» senza leggere lo stato delle figlie.
  const matchingMarker = markerState.markers.find(
    (marker) => marker.reopenedAtMs === reopened.atMs
      && isAfter(marker.createdAtMs, marker.index, reopened.atMs, reopened.index),
  );
  if (matchingMarker) return skipDecision('already-rearmed', { reopenedAt: reopened.createdAt });

  const windowStart = now - windowMs;
  const rearmCount = markerState.markers.filter(
    (marker) => marker.createdAtMs >= windowStart && marker.createdAtMs <= now,
  ).length;
  if (rearmCount >= maxRearms) {
    return skipDecision('window-cap', { reopenedAt: reopened.createdAt, rearmCount, maxRearms });
  }

  const childDecision = closedChildState(decomposition.latest.childNumbers, childStates);
  if (!childDecision.ok) return skipDecision('unreadable');
  if (!childDecision.allClosed) return skipDecision('child-open');
  return {
    action: 'rearm',
    reason: 'children-closed',
    reopenedAt: reopened.createdAt,
    childNumbers: decomposition.latest.childNumbers,
  };
}

/**
 * Corpo del commento di riarmo. Il marker conserva l'istante della ricorrenza
 * e la fotografia delle figlie che ha autorizzato il passaggio.
 */
export function parentRearmCommentBody({ reopenedAt, childNumbers = [] } = {}) {
  const at = Date.parse(String(reopenedAt || ''));
  if (!Number.isFinite(at)) throw new TypeError('reopenedAt non parsabile');
  const children = [...new Set(childNumbers.map(Number))]
    .filter((number) => Number.isInteger(number) && number > 0)
    .sort((a, b) => a - b);
  if (!children.length) throw new TypeError('childNumbers vuoto');
  return [
    `${PARENT_REARM_MARKER} reopened-at=${new Date(at).toISOString()} children=${children.join(',')} -->`,
    '🔄 **PARENT-REARM** — riapertura del monitor riammessa nel triage deterministico: '
      + 'la decomposizione precedente aveva tutte le figlie chiuse.',
  ].join('\n');
}
