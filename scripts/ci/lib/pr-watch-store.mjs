/**
 * pr-watch-store.mjs — persisted list of PRs this checkout opened that have
 * not yet reached a terminal state.
 *
 * Exists to make AGENTS.md's "Attesa PR = watch ATTIVO nel turno, MAI stop
 * idle" structural instead of a rule an agent can forget mid-session: #6318
 * and #6322 (2026-08-24) both sat with unresolved state — one with a real
 * 🔴 Important finding nobody was reading — because the session that opened
 * them moved on without checking back. `pr-watch-register.mjs` (PostToolUse
 * on `gh pr create`) writes an entry here; `pr-watch-gate.mjs` (Stop hook)
 * reads it and blocks the session from ending while an entry is unresolved.
 *
 * File lives under `.claude/`, which this repo's .gitignore excludes except
 * `settings.json` — this is per-checkout session state, not something to
 * commit. One file per checkout (not per-branch): a worktree opens at most a
 * few PRs at a time, and the gate reads the whole list on every Stop.
 *
 * ONE FILE, MANY SESSIONS — perché ogni entry porta la sua `sessionId`
 * ---------------------------------------------------------------------------
 * «Per-checkout» e «per-sessione» non sono la stessa cosa, e il primo giro lo
 * dava per scontato. Gli hook della root del workspace puntano allo script con
 * un path assoluto dentro il checkout principale, quindi TUTTE le sessioni —
 * quella che lavora nel checkout e ognuna che lavora in un worktree —
 * leggono e scrivono QUESTO file. Senza un discriminante, la sessione A viene
 * bloccata sulle PR della sessione B.
 *
 * Non è solo rumore: il messaggio del gate dice «leggi la review e applica il
 * fix», cioè manda un agente a spingere sul branch di un altro agente. È
 * esattamente la collisione che `pr-collision-detector` e `agent:in-progress`
 * esistono per impedire, reintrodotta dal meccanismo che doveva proteggere.
 *
 * Osservato il 2026-08-24: una sessione con la sua unica PR già mergiata è
 * rimasta bloccata su tre PR (#6363, #6364, #6365) aperte da un'altra sessione
 * nello stesso clone, con l'istruzione di andarci a lavorare sopra.
 *
 * Le entry SENZA `sessionId` (scritte prima di questo campo) restano
 * enforce-ate da chiunque: perdere la protezione su una PR reale sarebbe un
 * danno peggiore del rumore che questo campo toglie.
 */
import fs from 'node:fs';
import path from 'node:path';

/** Path relative to the repo root. Exported so tests and the hooks agree. */
export const STORE_REL_PATH = '.claude/pr-watch-state.json';

/**
 * @param {string} repoRoot absolute path to the frontaliere-si-o-no checkout
 * @returns {string}
 */
export function storePath(repoRoot) {
  return path.join(repoRoot, STORE_REL_PATH);
}

/**
 * @param {string} repoRoot
 * @returns {Array<{owner:string, repo:string, number:number, openedAt:string, sessionId?:string}>}
 */
export function readEntries(repoRoot) {
  try {
    const raw = fs.readFileSync(storePath(repoRoot), 'utf-8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(isValidEntry) : [];
  } catch {
    // Missing file, corrupt JSON, anything: an empty watch list, not a crash.
    return [];
  }
}

/** @param {unknown} e */
function isValidEntry(e) {
  return (
    e &&
    typeof e === 'object' &&
    typeof e.owner === 'string' &&
    typeof e.repo === 'string' &&
    Number.isInteger(e.number)
  );
}

/**
 * @param {string} repoRoot
 * @param {Array<object>} entries
 */
export function writeEntries(repoRoot, entries) {
  const p = storePath(repoRoot);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(entries, null, 2) + '\n', 'utf-8');
}

/**
 * Add an entry unless one for the same owner/repo/number already exists.
 * Pure w.r.t. its input array — callers persist the result.
 *
 * @param {Array<object>} entries
 * @param {{owner:string, repo:string, number:number, openedAt:string}} entry
 * @returns {Array<object>}
 */
export function addEntry(entries, entry) {
  const exists = entries.some(
    (e) => e.owner === entry.owner && e.repo === entry.repo && e.number === entry.number,
  );
  return exists ? entries : [...entries, entry];
}

/**
 * @param {Array<object>} entries
 * @param {{owner:string, repo:string, number:number}} target
 * @returns {Array<object>}
 */
export function removeEntry(entries, target) {
  return entries.filter(
    (e) => !(e.owner === target.owner && e.repo === target.repo && e.number === target.number),
  );
}

/**
 * Le entry che questa sessione deve enforce-are.
 *
 * Le proprie (stessa `sessionId`) e quelle senza padrone (legacy, o hook
 * invocato senza `session_id`). Quelle di ALTRE sessioni si vedono ma non
 * bloccano: chi le ha aperte le sta già seguendo, ed è l'unico che può
 * pushare sul loro branch senza collidere.
 *
 * `sessionId` assente o vuoto sul chiamante → nessun discriminante
 * disponibile → enforce TUTTO, che è il comportamento di prima di questo
 * campo. Un gate che si spegne quando non sa è un gate che non protegge.
 *
 * @param {Array<object>} entries
 * @param {string|null|undefined} sessionId
 * @returns {Array<object>}
 */
export function entriesForSession(entries, sessionId) {
  if (!sessionId) return entries;
  return entries.filter((e) => !e.sessionId || e.sessionId === sessionId);
}

/**
 * Le entry di ALTRE sessioni, da riscrivere invariate.
 *
 * Il gate riscrive il file con ciò che resta da seguire: senza questa metà,
 * filtrare per sessione cancellerebbe dal file le PR degli altri, e nessuno
 * le seguirebbe più. Il filtro deve restringere CHI blocca, non CHI è
 * tracciato.
 *
 * @param {Array<object>} entries
 * @param {string|null|undefined} sessionId
 * @returns {Array<object>}
 */
export function entriesOfOtherSessions(entries, sessionId) {
  if (!sessionId) return [];
  return entries.filter((e) => e.sessionId && e.sessionId !== sessionId);
}

/**
 * Extract `{owner, repo, number}` from anywhere in a string — used against
 * the PostToolUse `tool_response` for `gh pr create`, whose exact JSON shape
 * for the Bash tool is not part of the documented hook-input contract, but
 * whose PR URL always appears verbatim in the captured output.
 *
 * @param {string} text
 * @returns {{owner:string, repo:string, number:number}|null}
 */
export function extractPrRef(text) {
  const m = /github\.com\/([^\/"'\s]+)\/([^\/"'\s]+)\/pull\/(\d+)/.exec(String(text || ''));
  if (!m) return null;
  return { owner: m[1], repo: m[2], number: Number(m[3]) };
}
