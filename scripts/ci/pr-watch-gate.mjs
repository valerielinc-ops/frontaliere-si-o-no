#!/usr/bin/env node
/**
 * pr-watch-gate.mjs — Stop hook: blocks the session from ending while a PR
 * this checkout opened (via pr-watch-register.mjs) has not reached a
 * terminal state.
 *
 * Makes AGENTS.md's "Attesa PR = watch ATTIVO nel turno, MAI stop idle"
 * structural. On 2026-08-24, #6318 and #6322 both sat unresolved after the
 * session that opened them reported "PR aperta, CI verde" and moved on —
 * #6318 had a REAL 🔴 Important finding from the automated review that
 * nobody read for roughly two hours, because nothing forced a second look.
 *
 * Fires on every Stop, including /clear, resume, and compact (not only a
 * genuine end-of-turn) — cheap by design: an empty watch list exits before
 * any network call.
 *
 * Fail-safe on INFRASTRUCTURE failure (no `gh`, no auth, no network at all):
 * exit 0, never wedge a session shut for a reason it cannot fix. Fail-BLOCK
 * on a successfully-read PR state that is not yet terminal — that is the
 * one thing this hook exists to catch, and staying silent there is the
 * exact defect it is patching.
 *
 * A single entry whose repo/PR no longer resolves (renamed, deleted) is
 * dropped rather than blocking forever on something nobody can fix from here.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readEntries, writeEntries, removeEntry, entriesForSession, entriesOfOtherSessions } from './lib/pr-watch-store.mjs';
import { classifyPr, RESOLVED_STATUSES } from './lib/pr-watch-classify.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..');
const GH_TIMEOUT_MS = 12_000;

function gh(args) {
  return execFileSync('gh', args, { encoding: 'utf-8', timeout: GH_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 });
}

/**
 * @param {{owner:string, repo:string, number:number}} ref
 * @returns {{status:string, detail:string}|null} null = could not resolve at all
 */
function checkOne(ref) {
  const slug = `${ref.owner}/${ref.repo}`;
  let state, headSha, reviews;
  try {
    const pr = JSON.parse(gh(['api', `repos/${slug}/pulls/${ref.number}`]));
    state = pr.merged_at ? 'MERGED' : String(pr.state || '').toUpperCase();
    headSha = pr.head?.sha;
  } catch {
    return null; // PR/repo not resolvable — drop rather than block forever
  }
  try {
    reviews = JSON.parse(gh(['api', `repos/${slug}/pulls/${ref.number}/reviews`]));
  } catch {
    reviews = []; // reviews endpoint failing is not a reason to assume LGTM
  }
  return classifyPr({ state, headSha, reviews });
}

/**
 * `session_id` dall'input dell'hook Stop, se c'è.
 *
 * Lettura sincrona di stdin: l'hook riceve un JSON, ma un harness che non lo
 * passasse lascerebbe il fd vuoto e non deve far fallire il gate — senza id si
 * torna al comportamento precedente (enforce tutto).
 */
function readSessionId() {
  try {
    const raw = readFileSync(0, 'utf-8');
    if (!raw.trim()) return null;
    const payload = JSON.parse(raw);
    return typeof payload?.session_id === 'string' ? payload.session_id : null;
  } catch {
    return null;
  }
}

function main() {
  let allEntries;
  try {
    allEntries = readEntries(REPO_ROOT);
  } catch {
    return; // can't even read the store — nothing to enforce
  }
  if (allEntries.length === 0) return;

  // Blocca solo sulle PR di QUESTA sessione (più quelle senza padrone). Lo
  // store è per-checkout e gli hook della root puntano al checkout principale
  // con un path assoluto, quindi ogni sessione del clone — worktree compresi —
  // legge lo stesso file: senza questo filtro la sessione A resta bloccata
  // sulle PR della sessione B, con l'istruzione di andarci a lavorare sopra.
  const sessionId = readSessionId();
  const entries = entriesForSession(allEntries, sessionId);
  const foreign = entriesOfOtherSessions(allEntries, sessionId);
  if (entries.length === 0) return;

  // Confirm `gh` is usable at all before treating any failure as a real
  // "not terminal yet" — otherwise a laptop with no network would wedge
  // every session shut, which is worse than the bug this hook fixes.
  try {
    execFileSync('gh', ['auth', 'status'], { timeout: 5_000, stdio: 'ignore' });
  } catch {
    return; // gh unusable right now — fail open
  }

  const remaining = [];
  const blockers = [];
  for (const entry of entries) {
    const verdict = checkOne(entry);
    if (verdict === null) continue; // unresolvable — drop, do not carry forward
    if (RESOLVED_STATUSES.has(verdict.status)) continue; // resolved — drop
    remaining.push(entry);
    blockers.push(`  #${entry.number} (${entry.owner}/${entry.repo}): ${verdict.detail}`);
  }

  try {
    // Le entry delle altre sessioni tornano nel file INVARIATE: il filtro
    // restringe chi blocca, non chi è tracciato. Scrivendo solo `remaining` le
    // cancelleremmo, e le PR degli altri non le seguirebbe più nessuno.
    writeEntries(REPO_ROOT, [...foreign, ...remaining]);
  } catch {
    // Persisting the shrunk list failed; still decide this turn's block
    // below from what was just computed.
  }

  if (blockers.length === 0) return;

  const reason = [
    'PR aperte da questa sessione non hanno ancora raggiunto uno stato terminale',
    '(AGENTS.md: "Attesa PR = watch ATTIVO nel turno, MAI stop idle").',
    'Non fermarti: ricontrolla con `gh pr view <numero> --json state,reviews`,',
    'e se la review più recente sull\'ultimo commit non è "## LGTM", leggila e',
    'applica il fix — non limitarti ad aspettare di nuovo.',
    '',
    ...blockers,
  ].join('\n');

  console.log(JSON.stringify({ decision: 'block', reason, systemMessage: reason }));
  process.exit(2);
}

try {
  main();
} catch {
  // Any unexpected failure in the gate itself must never be the reason a
  // session cannot end.
}
