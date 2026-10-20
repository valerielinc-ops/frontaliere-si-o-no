/**
 * followup-item-evidence.mjs — marker a grana ITEM dei bucket follow-up.
 *
 * Unica fonte dei letterali `FU_ITEM_*`: chi scrive un marker (il post-step del
 * fixer, il gate sul conio) e chi lo legge (reconciler, drainer) importano da
 * qui, cosi' il formato non puo' divergere fra scrittore e lettore.
 *
 * La prova vive nei COMMENTI della issue, mai nel corpo: nel corpo cambia solo
 * il campo `State` dell'item. Un marker dice cosa e' successo all'item, non
 * che l'item sia risolto: PR mergiata, commit su `main` e run verde provano
 * che la PR ESISTE, e il legame item↔PR resta il giudizio di un agente. Per
 * questo nessun marker di questo modulo equivale a `State: done`, con UNA
 * eccezione decisa dal proprietario (I4, 2026-10-05): `FU_ITEM_CI_SUITE`, la
 * prova che la CI required della PR ha eseguito verde la suite di un item
 * bloccato solo dalla guardia risorse locale (`followup-ci-suite-proof.mjs`).
 *
 * Modulo puro: nessuna I/O, nessun `gh`. Chi lo usa passa i commenti gia'
 * letti e il predicato che decide quali autori sono fidati.
 */
import {
  FOLLOWUP_ITEM_ID_SINGLE_RE,
  dailyBucketSourcePrNumbers,
  stripFencedBlocks,
} from '../followup-resolution-match.mjs';

export const ITEM_EVIDENCE_MARKER = 'FU_ITEM_EVIDENCE';
export const ITEM_ATTEMPT_MARKER = 'FU_ITEM_ATTEMPT';
export const ITEM_BLOCKED_MARKER = 'FU_ITEM_BLOCKED';
export const ITEM_BORN_SATISFIED_MARKER = 'FU_ITEM_BORN_SATISFIED';
export const ITEM_UNBLOCKED_MARKER = 'FU_ITEM_UNBLOCKED';
export const ITEM_CI_SUITE_MARKER = 'FU_ITEM_CI_SUITE';
// Un automatismo ha tolto `maybe-resolved` da un bucket perche' ha di nuovo
// item `open`: azzera i flag del reconciler precedenti, quindi NON vale come
// obiezione umana (`hasLiveReconcileFlag` in reconcile-followups.mjs). Conta
// solo da autore fidato. Lo scrivono il reconciler e route-already-fixed.mjs.
export const MAYBE_RESOLVED_RELEASE_MARKER = '<!-- FU_MAYBE_RESOLVED_RELEASED -->';

/** Forza del legame fra la PR di evidenza e l'item. */
export const ITEM_EVIDENCE_LINKS = Object.freeze(['target-file', 'source-pr', 'none']);

/**
 * Insieme CHIUSO dei motivi per cui un item esce dalla selezione del fixer.
 * - `awaiting-verification`: `already-fixed` con terna verificata e legame con
 *   l'item; aspetta il token o una verifica esplicita.
 * - `already-fixed-unverified`: secondo `already-fixed` senza prova verificabile.
 * - `no-root-cause`, `blocked-admin-settings`: verdetti non ritentabili del fixer.
 */
export const ITEM_BLOCKED_REASONS = Object.freeze([
  'awaiting-verification',
  'already-fixed-unverified',
  'no-root-cause',
  'blocked-admin-settings',
]);

const MARKER_TYPES = Object.freeze({
  [ITEM_EVIDENCE_MARKER]: 'evidence',
  [ITEM_ATTEMPT_MARKER]: 'attempt',
  [ITEM_BLOCKED_MARKER]: 'blocked',
  [ITEM_BORN_SATISFIED_MARKER]: 'born-satisfied',
  [ITEM_UNBLOCKED_MARKER]: 'unblocked',
  [ITEM_CI_SUITE_MARKER]: 'ci-suite',
});
const MARKER_RE = new RegExp(`<!--\\s*(${Object.keys(MARKER_TYPES).join('|')}):([^>]*?)-->`, 'gu');
const OUTCOME_RE = /^[a-z][a-z0-9-]{0,63}$/u;
const SHA_RE = /^[0-9a-f]{7,40}$/u;

function itemIdOrThrow(item) {
  const id = String(item ?? '').trim().toUpperCase();
  if (!FOLLOWUP_ITEM_ID_SINGLE_RE.test(id)) throw new TypeError(`item-id-invalido:${String(item)}`);
  return id;
}

function positiveInteger(value) {
  const text = String(value ?? '').trim();
  if (!/^[1-9][0-9]{0,15}$/u.test(text)) return null;
  const n = Number(text);
  return Number.isSafeInteger(n) ? n : null;
}

/**
 * `<!-- FU_ITEM_EVIDENCE: item=FU-… pr=<N> commit=<sha> run=<id> link=<…> -->`
 * `pr` e' facoltativa (evidenza per solo commit); il resto e' obbligatorio.
 */
export function itemEvidenceMarker({ item, pr = null, commit, run, link }) {
  const id = itemIdOrThrow(item);
  if (pr !== null && positiveInteger(pr) === null) throw new TypeError(`pr-invalida:${String(pr)}`);
  if (!SHA_RE.test(String(commit ?? ''))) throw new TypeError(`commit-invalido:${String(commit)}`);
  if (positiveInteger(run) === null) throw new TypeError(`run-invalida:${String(run)}`);
  if (!ITEM_EVIDENCE_LINKS.includes(link)) throw new TypeError(`link-invalido:${String(link)}`);
  const parts = [`item=${id}`, pr !== null ? `pr=${positiveInteger(pr)}` : null, `commit=${commit}`, `run=${positiveInteger(run)}`, `link=${link}`];
  return `<!-- ${ITEM_EVIDENCE_MARKER}: ${parts.filter(Boolean).join(' ')} -->`;
}

/** `<!-- FU_ITEM_ATTEMPT: item=FU-… outcome=<codice> run=<id> -->` (`run` facoltativa). */
export function itemAttemptMarker({ item, outcome, run = null }) {
  const id = itemIdOrThrow(item);
  const code = String(outcome ?? '').trim().toLowerCase();
  if (!OUTCOME_RE.test(code)) throw new TypeError(`outcome-invalido:${String(outcome)}`);
  if (run !== null && positiveInteger(run) === null) throw new TypeError(`run-invalida:${String(run)}`);
  const parts = [`item=${id}`, `outcome=${code}`, run !== null ? `run=${positiveInteger(run)}` : null];
  return `<!-- ${ITEM_ATTEMPT_MARKER}: ${parts.filter(Boolean).join(' ')} -->`;
}

/** `<!-- FU_ITEM_BLOCKED: item=FU-… reason=<motivo> -->`, motivo nell'insieme chiuso. */
export function itemBlockedMarker({ item, reason }) {
  const id = itemIdOrThrow(item);
  if (!ITEM_BLOCKED_REASONS.includes(reason)) throw new TypeError(`reason-invalida:${String(reason)}`);
  return `<!-- ${ITEM_BLOCKED_MARKER}: item=${id} reason=${reason} -->`;
}

/**
 * `<!-- FU_ITEM_BORN_SATISFIED: item=FU-… -->`. Il token di accettazione NON
 * entra nel marker: e' testo libero (spazi, backtick, anche `-->`) e non si
 * puo' serializzare in una coppia chiave=valore senza ambiguita'. Chi scrive
 * il marker lo riporta in prosa nel commento.
 */
export function itemBornSatisfiedMarker({ item }) {
  return `<!-- ${ITEM_BORN_SATISFIED_MARKER}: item=${itemIdOrThrow(item)} -->`;
}

/**
 * `<!-- FU_ITEM_UNBLOCKED: item=FU-… commit=<sha> -->`: l'item `blocked` e'
 * rientrato in `open` per un commit nuovo sul suo `Target file`. Il rientro e'
 * UNO per item: la presenza del marker (autore fidato) lo esclude per sempre.
 * In lettura `commit` e' facoltativo: anche un marker scritto a mano senza
 * commit vale come «gia' rientrato».
 */
export function itemUnblockedMarker({ item, commit }) {
  const id = itemIdOrThrow(item);
  if (!SHA_RE.test(String(commit ?? ''))) throw new TypeError(`commit-invalido:${String(commit)}`);
  return `<!-- ${ITEM_UNBLOCKED_MARKER}: item=${id} commit=${commit} -->`;
}

/**
 * `<!-- FU_ITEM_CI_SUITE: item=FU-… pr=<N> commit=<sha> run=<id> job=<id> -->`:
 * la run `run` (job `job`) di `tests.yml` sullo sha `commit` della PR `pr` ha
 * eseguito verde la suite dell'item. Tutti i campi sono obbligatori.
 */
export function itemCiSuiteMarker({ item, pr, commit, run, job }) {
  const id = itemIdOrThrow(item);
  if (positiveInteger(pr) === null) throw new TypeError(`pr-invalida:${String(pr)}`);
  if (!/^[0-9a-f]{40}$/u.test(String(commit ?? ''))) throw new TypeError(`commit-invalido:${String(commit)}`);
  if (positiveInteger(run) === null) throw new TypeError(`run-invalida:${String(run)}`);
  if (positiveInteger(job) === null) throw new TypeError(`job-invalido:${String(job)}`);
  return `<!-- ${ITEM_CI_SUITE_MARKER}: item=${id} pr=${positiveInteger(pr)} commit=${commit} run=${positiveInteger(run)} job=${positiveInteger(job)} -->`;
}

const FIELD_PARSERS = Object.freeze({
  item: (value) => (FOLLOWUP_ITEM_ID_SINGLE_RE.test(value.toUpperCase()) ? value.toUpperCase() : undefined),
  pr: (value) => positiveInteger(value) ?? undefined,
  run: (value) => positiveInteger(value) ?? undefined,
  job: (value) => positiveInteger(value) ?? undefined,
  commit: (value) => (SHA_RE.test(value) ? value : undefined),
  link: (value) => (ITEM_EVIDENCE_LINKS.includes(value) ? value : undefined),
  outcome: (value) => (OUTCOME_RE.test(value) ? value : undefined),
  reason: (value) => (ITEM_BLOCKED_REASONS.includes(value) ? value : undefined),
});
const REQUIRED_FIELDS = Object.freeze({
  evidence: ['item', 'commit', 'run', 'link'],
  attempt: ['item', 'outcome'],
  blocked: ['item', 'reason'],
  'born-satisfied': ['item'],
  unblocked: ['item'],
  'ci-suite': ['item', 'pr', 'commit', 'run', 'job'],
});
const ALLOWED_FIELDS = Object.freeze({
  evidence: ['item', 'pr', 'commit', 'run', 'link'],
  attempt: ['item', 'outcome', 'run'],
  blocked: ['item', 'reason'],
  'born-satisfied': ['item'],
  unblocked: ['item', 'commit'],
  'ci-suite': ['item', 'pr', 'commit', 'run', 'job'],
});

/** Un marker con chiavi ignote, duplicate o valori malformati non e' un marker. */
function parseMarkerFields(type, raw) {
  const fields = {};
  for (const token of raw.trim().split(/\s+/u).filter(Boolean)) {
    const m = /^([a-z]+)=(.+)$/u.exec(token);
    if (!m) return null;
    const [, key, value] = m;
    if (!ALLOWED_FIELDS[type].includes(key) || key in fields) return null;
    const parsed = FIELD_PARSERS[key](value);
    if (parsed === undefined) return null;
    fields[key] = parsed;
  }
  return REQUIRED_FIELDS[type].every((key) => key in fields) ? fields : null;
}

/**
 * Elenco tipizzato dei marker, nell'ordine dei commenti, letto dai SOLI
 * commenti di autori fidati. Senza un predicato `isTrusted` non si fida di
 * nessuno (elenco vuoto): chiunque puo' commentare una issue pubblica.
 *
 * @param {Array<{body?: string, createdAt?: string}>} comments
 * @param {{isTrusted?: (comment: object) => boolean}} [options]
 * @returns {Array<{type: 'evidence'|'attempt'|'blocked'|'born-satisfied'|'unblocked'|'ci-suite', item: string,
 *   pr?: number, commit?: string, run?: number, job?: number, link?: string, outcome?: string,
 *   reason?: string, createdAt: string|null}>}
 */
export function parseItemMarkers(comments, { isTrusted } = {}) {
  if (!Array.isArray(comments) || typeof isTrusted !== 'function') return [];
  const out = [];
  for (const comment of comments) {
    if (!isTrusted(comment)) continue;
    for (const match of String(comment?.body ?? '').matchAll(MARKER_RE)) {
      const type = MARKER_TYPES[match[1]];
      const fields = parseMarkerFields(type, match[2]);
      if (fields) out.push({ type, ...fields, createdAt: typeof comment?.createdAt === 'string' ? comment.createdAt : null });
    }
  }
  return out;
}

/**
 * Quanti tentativi con quell'esito ha gia' ricevuto l'item. `excludeRun` toglie
 * dal conteggio i marker della run corrente («da run precedenti»).
 */
export function countItemAttempts(markers, itemId, outcome, { excludeRun = null } = {}) {
  const id = String(itemId ?? '').trim().toUpperCase();
  const code = String(outcome ?? '').trim().toLowerCase();
  const skip = positiveInteger(excludeRun);
  return (Array.isArray(markers) ? markers : []).filter((marker) => marker?.type === 'attempt'
    && marker.item === id
    && marker.outcome === code
    && (skip === null || marker.run !== skip)).length;
}

function normalizeRepoPath(value) {
  return String(value ?? '').trim()
    .replace(/^`+|`+$/gu, '')
    .replace(/:L?\d+(?:-L?\d+)?$/u, '')
    .replace(/^\.\//u, '');
}

const TEST_FILE_RE = /(?:^|[\s(`'":=])((?:[\w.-]+\/)*[\w.-]+\.(?:test|spec)\.[a-z]{2,4})(?=$|[\s`'":,;.)\]}])/gimu;

/**
 * I file che legano una PR all'item: il suo `Target file` e i file di test
 * citati nella scheda (blocchi di codice esclusi: sono esempi, non riferimenti).
 * @param {{targetFile?: string, text?: string}} item
 * @returns {string[]}
 */
export function itemLinkFiles(item) {
  const files = new Set();
  const target = normalizeRepoPath(item?.targetFile);
  if (target) files.add(target);
  for (const match of stripFencedBlocks(item?.text ?? '').matchAll(TEST_FILE_RE)) files.add(normalizeRepoPath(match[1]));
  return [...files];
}

/**
 * Il `Target file` dell'item come path relativo al repository (senza backtick,
 * `./` o suffisso di riga), o stringa vuota se manca o non e' un path
 * relativo semplice (niente spazi, niente `..`, niente path assoluto).
 * @param {{targetFile?: string}} item
 * @returns {string}
 */
export function itemTargetPath(item) {
  const target = normalizeRepoPath(item?.targetFile);
  if (!/^[\w.@+-][\w.@+/-]*$/u.test(target) || target.split('/').some((part) => part === '..' || part === '.' || part === '')) return '';
  return target;
}

/**
 * Forza del legame fra la PR di evidenza e l'item:
 * - `target-file`: la PR ha toccato il `Target file` o un test citato nella scheda;
 * - `source-pr`: la PR e' una delle `Sources` dell'item (il residuo e' stato
 *   soddisfatto dal merge che l'ha dichiarato);
 * - `none`: nessun legame verificabile (anche: evidenza senza PR).
 *
 * @param {{raw?: string, targetFile?: string, text?: string}} item item di `parseFollowupItems`
 * @param {{pr: number|null, files?: string[]}} evidence numero e file toccati dalla PR
 * @returns {'target-file'|'source-pr'|'none'}
 */
export function itemEvidenceLink(item, { pr, files = [] }) {
  if (!item || positiveInteger(pr) === null) return 'none';
  const touched = new Set((Array.isArray(files) ? files : []).map(normalizeRepoPath).filter(Boolean));
  if (itemLinkFiles(item).some((file) => touched.has(file))) return 'target-file';
  if (dailyBucketSourcePrNumbers(item.raw ?? '').includes(Number(pr))) return 'source-pr';
  return 'none';
}

const METRIC_LINE_RE = /^\s*(?:-\s+METRICA\s*:|\*{0,2}\d+\s*-\s*METRICA(?:\s*[.:]\s*\*{0,2}|\s*\*{0,2}\s*[.:]))\s*(.*?)\s*$/iu;

const COMMENT_DELIMITER_RE = /<!--|-->/gu;

/**
 * Testo libero (corpo di un item, messaggio d'errore) reso innocuo prima di
 * entrare in un commento firmato da un bot fidato: senza delimitatori di
 * commento HTML non puo' comporre un marker (`FU_ITEM_*`, `FIX_OUTCOME`, …).
 * La sostituzione si ripete fino a punto fisso: una sola passata lascia che
 * sequenze annidate (`<!<!----`) si ricompongano in un delimitatore integro.
 * @param {unknown} value
 * @returns {string} una sola riga, senza `<!--` ne' `-->`
 */
export function inertCommentText(value) {
  let text = String(value ?? '');
  for (let previous = null; previous !== text;) {
    previous = text;
    text = text.replace(COMMENT_DELIMITER_RE, '');
  }
  return text.replace(/\s+/gu, ' ').trim();
}

/**
 * La riga `METRICA` della scheda dell'item, o stringa vuota. Il testo finisce
 * in un commento firmato da un bot fidato: passa da `inertCommentText`,
 * altrimenti il corpo dell'item potrebbe iniettare un marker.
 * @param {{text?: string}} item
 */
export function itemMetricLine(item) {
  for (const line of stripFencedBlocks(item?.text ?? '').split('\n')) {
    if (/^\s*>/u.test(line)) continue;
    const match = METRIC_LINE_RE.exec(line);
    if (!match) continue;
    const text = inertCommentText(match[1]);
    if (text) return text.length > 400 ? `${text.slice(0, 399)}…` : text;
  }
  return '';
}
