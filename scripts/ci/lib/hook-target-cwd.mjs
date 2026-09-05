/**
 * hook-target-cwd.mjs — the directory a PreToolUse `Bash` hook should
 * actually operate on, in one place.
 *
 * Claude Code's PreToolUse payload carries a top-level `cwd` field: the
 * session's tracked working directory, updated after every `cd` in a prior
 * Bash call (https://code.claude.com/docs/en/hooks — confirmed 2026-08-25).
 * What it does NOT mean is that the hook's own OS subprocess is spawned
 * there — Claude Code pins that independently (in this repo, both gates are
 * declared as `sh -c '... node "$d/scripts/ci/<gate>.mjs"'` with no `cd`), so
 * `process.cwd()` inside the hook reflects wherever the hook runner itself
 * launched from, not the worktree the gated command is about to run in.
 *
 * The two `gh pr create` PreToolUse gates in this repo used to read only
 * `tool_input.command` and let their child `git`/`readFileSync` calls
 * inherit the hook's own ambient cwd. Observed 2026-08-25: a PR opened from
 * a worktree got the wrong gate verdict, citing a file that was dirty only
 * in an unrelated main checkout the gated branch never touched at all. The
 * agent worked around it by calling the GitHub API directly instead of
 * `gh pr create`; this module addresses the half of that incident where
 * `payload.cwd` IS the right directory and only the hook subprocess was
 * running elsewhere.
 *
 * WHAT IT DOES NOT FIX, and used to claim it did (corrected 2026-09-05).
 * `payload.cwd` is the session's TRACKED working directory — the result of
 * `cd`s in PREVIOUS Bash calls. A `cd` written in the same call as the gated
 * command does not count: the hook runs BEFORE the command. So in a fleet of
 * parallel agents the tracked cwd is very often the shared main checkout, and
 * a gate that analyses THAT DIRECTORY'S WORKING TREE is reading whatever the
 * other sessions left uncommitted there. Measured 2026-09-05 on this
 * repository: `check-sibling-patterns.mjs` reported 5 changed files and 44
 * candidates from the main checkout (dirty with another session's
 * `scripts/lib/prospector/**` work) and 0/0 from a clean worktree at the same
 * instant. A branch touching 1 file was blocked over 50 candidates that
 * belonged to nobody's branch — unsatisfiable, because no per-file false
 * positive declaration can cover files the author never touched.
 *
 * The directory is therefore the WRONG UNIT for a gate. `sibling-check-gate.mjs`
 * now resolves WHICH BRANCH the gated `gh pr create` is proposing (its `--head`,
 * else the tracked directory's `HEAD`) and analyses that ref against
 * `origin/main`. Worktrees share `.git`, so a branch ref resolves identically
 * from any directory of the repo, and uncommitted foreign work is invisible to
 * a commit-to-commit diff. This module is still the right answer for the
 * remaining directory-shaped question — WHERE to resolve a relative
 * `--body-file`, and which repo to run git in — which is what its callers use
 * it for now.
 *
 * Fail-safe by construction: any missing/malformed/nonexistent `cwd` returns
 * `undefined`, which `execFileSync`'s own `cwd` option treats identically to
 * "not passed" — i.e. today's behaviour (inherit the ambient cwd), never a
 * new failure mode.
 */
import { statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

/**
 * @param {{ cwd?: unknown }} payload parsed PreToolUse stdin JSON
 * @returns {string|undefined} an existing directory, or `undefined`
 */
export function resolveHookTargetCwd(payload) {
  const candidate = payload?.cwd;
  if (typeof candidate !== 'string' || !candidate) return undefined;
  try {
    return statSync(candidate).isDirectory() ? candidate : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Il ref da analizzare: il BRANCH che il comando sta proponendo, non la
 * directory da cui l'hook crede di girare.
 *
 * DA UN SUB-AGENTE `payload.cwd` NON SI MUOVE AFFATTO (misurato 2026-09-05, il
 * quinto difetto della stessa giornata). In un thread di sub-agente la cwd viene
 * resettata a ogni chiamata Bash, quindi il campo resta inchiodato alla
 * directory di lancio e `resolveHookTargetCwd` restituisce sempre quella: la
 * ricetta «entra nel worktree in una chiamata isolata, apri la PR in quella dopo»
 * funziona solo dalla sessione principale. Un agente si e' visto 44 candidati
 * calcolati sul checkout principale — quel giorno 57 commit dietro `origin/main`
 * e sporco del lavoro di un'altra sessione — che non poteva ne' dichiarare
 * onestamente ne' ripulire. Non e' un caso limite: rende il gate strutturalmente
 * inaffidabile per l'intera flotta, perche' ogni agente riceve un verdetto
 * calcolato su un albero che non e' il suo.
 *
 * Per questo un `--head <branch>` LETTERALE viene cercato anche in `fallbackCwd`
 * — il repo a cui appartiene il gate stesso, ricavato dal proprio path e quindi
 * sempre giusto — e la funzione restituisce ANCHE la directory in cui il ref ha
 * risolto, che e' quella in cui il chiamante deve far girare git. I worktree
 * condividono `.git`: un nome di branch risolve identico dal checkout principale
 * e da qualunque worktree, quindi con un `--head` letterale il verdetto non
 * dipende piu' da `payload.cwd` in nessun modo. E' una fix sola per il difetto 1
 * e per questo quinto.
 *
 * Resta un caso che nessuna directory puo' salvare: `--head` come sostituzione
 * di shell non espansa. `--head "$(git rev-parse --abbrev-ref HEAD)"` e' la
 * ricetta raccomandata altrove, e l'hook gira PRIMA che bash la espanda, quindi
 * non c'e' niente da leggere. Li' si ricade su `HEAD` della directory tracciata:
 * comunque meglio del working tree, perche' un diff commit-a-commit non vede il
 * lavoro non committato altrui, ma da un sub-agente sara' l'HEAD sbagliato — e
 * allora il gate se ne accorge (diff vuoto) e lo dice, invece di accusare file
 * estranei. L'uscita e' passare il nome letterale del branch.
 *
 * COROLLARIO PER CHI DEBUGGA QUESTI GATE: un probe senza `--body-file` non
 * distingue i casi. `extractPrBody` ritorna `undefined`, il gate entra
 * (giustamente) in modalita' conservativa e blocca comunque — quindi un blocco
 * osservato in quelle condizioni non prova che l'albero analizzato sia sbagliato.
 * Simula sempre col body vero.
 *
 * @param {string} command la command line di `gh pr create`
 * @param {string|undefined} cwd directory tracciata dalla sessione (`payload.cwd`)
 * @param {string|undefined} [fallbackCwd] repo di cui il gate fa parte, usato solo
 *   per un `--head` letterale che `cwd` non sa risolvere
 * @returns {{ ref: string, source: 'head-flag'|'head-flag-fallback'|'cwd-head', cwd: string|undefined }}
 */
export function resolveGatedHeadRef(command, cwd, fallbackCwd, run = defaultRevParse) {
  const m = String(command ?? '').match(/--head[= ]+(?:"([^"]*)"|'([^']*)'|(\S+))/);
  const raw = (m?.[1] ?? m?.[2] ?? m?.[3] ?? '').trim();
  // `owner:branch` è la forma cross-fork accettata da gh; a noi serve il branch.
  const branch = raw.includes(':') ? raw.slice(raw.indexOf(':') + 1) : raw;
  const unexpanded = /[$`]/.test(branch);
  if (branch && !unexpanded) {
    if (run(branch, cwd)) return { ref: branch, source: 'head-flag', cwd };
    if (fallbackCwd && fallbackCwd !== cwd && run(branch, fallbackCwd)) {
      return { ref: branch, source: 'head-flag-fallback', cwd: fallbackCwd };
    }
  }
  // Nessun branch leggibile: `HEAD` della directory tracciata, esattamente come
  // prima. Non ricadiamo su `fallbackCwd` qui — l'HEAD di un altro checkout non
  // e' un'ipotesi migliore, e' solo un albero diverso e altrettanto arbitrario.
  return { ref: 'HEAD', source: 'cwd-head', cwd };
}

function defaultRevParse(ref, cwd) {
  try {
    execFileSync('git', ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], {
      cwd,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    return true;
  } catch {
    return false;
  }
}
