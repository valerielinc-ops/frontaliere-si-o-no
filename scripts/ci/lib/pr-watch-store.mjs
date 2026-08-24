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
 * @returns {Array<{owner:string, repo:string, number:number, openedAt:string}>}
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
