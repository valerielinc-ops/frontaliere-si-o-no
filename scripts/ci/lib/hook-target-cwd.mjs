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
 * The two `gh pr create` PreToolUse gates in this repo use this module for the
 * directory-shaped parts of their work: resolving relative `--body-file`
 * paths and choosing the repository in which to run `git`. Claude Code exposes
 * the session's tracked directory in `payload.cwd`; Codex and sub-agents can
 * leave that field at the workspace root because their `cd <worktree>` lives
 * inside the command that is about to run.
 *
 * `resolveHookTargetCwd` therefore prefers a literal `cd <dir> &&` in the
 * command prefix before `gh pr create`, and falls back to the validated
 * `payload.cwd`. The command is the only place where Codex's real directory is
 * available before execution; shell substitutions are deliberately ignored.
 * This same directory reaches both `readFileSync` and the sibling gate's
 * fallback `HEAD`, so the two gates judge the same worktree.
 *
 * Missing, malformed, variable-based, or nonexistent cwd signals still fall
 * back to the next available signal. An existing literal `cd` is different:
 * if it names a non-repository or a relative directory in another worktree,
 * the details object preserves that failure so a gate cannot silently inspect
 * a plausible but wrong checkout.
 */
import { existsSync, realpathSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SITE_REPOSITORY = 'valerielinc-ops/frontaliere-si-o-no';
const CORPUS_REPOSITORY = 'nanakokyobashi-rgb/frontaliere-articles';
const siteRepositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const localRepositories = new Map([
  [SITE_REPOSITORY, {
    repo: siteRepositoryRoot,
    checkScript: resolve(siteRepositoryRoot, 'scripts/ci/check-sibling-patterns.mjs'),
  }],
  [CORPUS_REPOSITORY, {
    repo: resolve(siteRepositoryRoot, '..', 'frontaliere-articles'),
    checkScript: resolve(siteRepositoryRoot, '..', 'frontaliere-articles', 'scripts/ci/check-sibling-patterns.mjs'),
  }],
]);

/**
 * Read the explicit repository flag from `gh pr create` without interpreting
 * the shell. The root hooks are shared by the site and corpus sessions, so
 * the repository named by the command — not this module's checkout — decides
 * whether a repository-local checker is available.
 *
 * @param {string} command command received by a PreToolUse hook
 * @returns {string|undefined}
 */
function explicitRepository(command) {
  const text = String(command ?? '');
  const bodyIndex = text.search(/\s--body(?:-file)?(?:[= ]|$)/);
  const cli = bodyIndex >= 0 ? text.slice(0, bodyIndex) : text;
  const flagRe = /(?:^|\s)(?:--repo[= ]+|-R[= ]*)(?:"([^"]*)"|'([^']*)'|(\S+))/g;
  for (const match of cli.matchAll(flagRe)) {
    const raw = (match[1] ?? match[2] ?? match[3] ?? '').trim();
    if (raw && !/[$`]/.test(raw)) return raw;
  }
  return undefined;
}

/**
 * Resolve the local repository and optional sibling checker for a PR command.
 * A repository without a local checker returns `null` instead of silently
 * running the site's checker against another repository's branch.
 *
 * @param {string} command command received by a PreToolUse hook
 * @returns {{repo:string, checkScript:string}|null}
 */
export function resolveHookRepository(command) {
  const requested = explicitRepository(command) ?? SITE_REPOSITORY;
  const target = localRepositories.get(requested);
  if (!target || !existsSync(target.checkScript)) return null;
  return target;
}

// Only inspect shell separators (plus the quote opened by `zsh -lc "..."`),
// and only the prefix before the first `gh pr create`. This avoids treating a
// phrase such as `cd /tmp && gh pr create` inside the PR body as the command's
// working-directory signal.
const COMMAND_CWD_RE =
  /(?:^|&&|;|\|\||\n|["'])\s*cd(?:\s+--)?\s+(?:"([^"\n]*)"|'([^'\n]*)'|([^\s;&|]+))\s*&&/g;

/**
 * @param {{ cwd?: unknown }} payload parsed PreToolUse stdin JSON
 * @param {string} [command] command received by the PreToolUse hook
 * @returns {{cwd:string|undefined, trackedCwd:string|undefined,
 *   commandCwd:string|undefined, error?:{kind:string,path:string}}}
 */
export function resolveHookTargetCwdDetails(payload, command = '') {
  const candidate = payload?.cwd;
  const trackedCwd =
    typeof candidate === 'string' && candidate && isDirectory(candidate) ? candidate : undefined;
  const baseCwd = trackedCwd ?? process.cwd();
  const commandResolution = resolveCommandCwd(command, baseCwd, baseCwd);
  if (commandResolution) {
    return {
      cwd: commandResolution.cwd,
      trackedCwd,
      commandCwd: commandResolution.commandCwd,
      ...(commandResolution.error ? { error: commandResolution.error } : {}),
    };
  }
  return { cwd: trackedCwd, trackedCwd, commandCwd: undefined };
}

export function resolveHookTargetCwd(payload, command = '') {
  return resolveHookTargetCwdDetails(payload, command).cwd;
}

/**
 * Resolve the literal directory change that belongs to the gated command.
 * Returns `undefined` for absent, malformed, variable-based, or nonexistent
 * paths so callers retain the old payload/ambient fallback.
 *
 * @param {string} command command received by the PreToolUse hook
 * @param {string} baseCwd directory from which a relative `cd` would run
 * @param {string} referenceCwd directory whose worktree a relative `cd` must share
 * @returns {{cwd:string|undefined, commandCwd:string,
 *   error?:{kind:string,path:string}}|undefined}
 */
function resolveCommandCwd(command, baseCwd = process.cwd(), referenceCwd = baseCwd) {
  const text = String(command ?? '');
  const cliIndex = text.indexOf('gh pr create');
  const prefix = cliIndex >= 0 ? text.slice(0, cliIndex) : text;
  let resolvedCwd;

  for (const match of prefix.matchAll(COMMAND_CWD_RE)) {
    const raw = (match[1] ?? match[2] ?? match[3] ?? '').trim();
    if (!raw || /[$`]/.test(raw)) continue;
    const candidate = resolve(baseCwd, raw);
    if (!isDirectory(candidate)) continue;

    const candidateRoot = resolveGitWorktreeRoot(candidate);
    if (!candidateRoot) {
      return {
        cwd: candidate,
        commandCwd: candidate,
        error: { kind: 'non-repository', path: candidate },
      };
    }

    if (!isAbsolute(raw)) {
      const referenceRoot = resolveGitWorktreeRoot(referenceCwd);
      if (!referenceRoot || referenceRoot !== candidateRoot) {
        return {
          cwd: undefined,
          commandCwd: candidate,
          error: { kind: 'different-worktree', path: candidate },
        };
      }
    }

    resolvedCwd = candidate;
  }
  return resolvedCwd ? { cwd: resolvedCwd, commandCwd: resolvedCwd } : undefined;
}

function isDirectory(candidate) {
  try {
    return statSync(candidate).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Resolve the Git worktree root for a directory without inheriting the
 * process cwd. `undefined` means the directory cannot run a repository-local
 * gate.
 */
export function resolveGitWorktreeRoot(candidate) {
  if (!candidate || !isDirectory(candidate)) return undefined;
  try {
    const root = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd: candidate,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'ignore'],
    }).trim();
    if (!root) return undefined;
    try { return realpathSync(root); } catch { return resolve(root); }
  } catch {
    return undefined;
  }
}

/**
 * @param {{error?:{kind:string,path:string}}|undefined} resolution
 * @returns {string|undefined}
 */
export function describeHookTargetCwdFailure(resolution) {
  const failure = resolution?.error;
  if (!failure) return undefined;
  if (failure.kind === 'different-worktree') {
    return `cd relativo verso ${failure.path} risolve un worktree diverso da quello tracciato`;
  }
  return `cwd ${failure.path} non appartiene a una repository Git`;
}

/**
 * Il ref da analizzare: il BRANCH che il comando sta proponendo, non la
 * directory da cui l'hook crede di girare.
 *
 * Un sub-agente puo' ancora avere `payload.cwd` inchiodato alla directory di
 * lancio. Quando il comando contiene un `cd` letterale, pero', i chiamanti lo
 * hanno gia' trasformato nella cwd effettiva prima di arrivare qui; senza quel
 * segnale resta importante passare un `--head <branch>` letterale. Quel ref
 * viene cercato anche in `fallbackCwd` — il repo a cui appartiene il gate — e
 * i worktree condividono `.git`, quindi il branch risolve allo stesso commit da
 * qualunque checkout. La funzione restituisce anche la directory in cui il ref
 * ha risolto, quella in cui il chiamante deve far girare git.
 *
 * Resta un caso che nessun parser puo' salvare: `--head` come sostituzione di
 * shell non espansa. L'hook gira PRIMA che bash la espanda, quindi ricade su
 * `HEAD` della cwd gia' risolta; se quella e' la directory di lancio sbagliata,
 * il diff vuoto lo dice invece di accusare file estranei. L'uscita e' passare il
 * nome letterale del branch, oppure includere il `cd` letterale nel comando.
 *
 * COROLLARIO PER CHI DEBUGGA QUESTI GATE: un probe senza `--body-file` non
 * distingue i casi. `extractPrBody` ritorna `undefined`, il gate entra
 * (giustamente) in modalita' conservativa e blocca comunque — quindi un blocco
 * osservato in quelle condizioni non prova che l'albero analizzato sia sbagliato.
 * Simula sempre col body vero.
 *
 * @param {string} command la command line di `gh pr create`
 * @param {string|undefined} cwd directory gia' risolta per il comando
 * @param {string|undefined} [fallbackCwd] repo di cui il gate fa parte, usato solo
 *   per un `--head` letterale che `cwd` non sa risolvere
 * @returns {{ ref: string, source: 'head-flag'|'head-flag-fallback'|'cwd-head', cwd: string|undefined }}
 */
export function resolveGatedHeadRef(command, cwd, fallbackCwd, run = defaultRevParse) {
  // Due difetti in una regex sola, entrambi misurati il 2026-09-05.
  //
  // (1) L'alias corto del flag esiste e non era riconosciuto. Un `-H
  //     mio-branch` cadeva sul fallback `HEAD`, e dal checkout principale
  //     fermo su main quel diff e' vuoto → il gate blocca un comando che il
  //     branch lo dichiarava, esattamente il caso che questa funzione esiste
  //     per servire.
  //
  // (2) Il match gira sull'INTERA command line, body compreso. I messaggi di
  //     questi gate consigliano testualmente di passare il nome letterale del
  //     branch al flag, quindi quella stringa finira' nei body delle PR
  //     future: un'occorrenza dentro la prosa che PRECEDE il flag vero
  //     vinceva, perche' si teneva solo il primo match.
  //
  // Il rimedio per (2) non e' un parser di shell — e' smettere di fidarsi
  // della posizione. Si raccolgono TUTTI i candidati nell'ordine in cui
  // compaiono e si tiene il PRIMO CHE RISOLVE a un commit vero: un flag
  // citato in prosa e' seguito da prosa, che non e' un ref. L'ancoraggio al
  // confine di token scarta il grosso del rumore, il rev-parse fa il resto —
  // e il rev-parse e' un oracolo che la regex da sola non puo' avere.
  const flagRe = /(?:^|\s)(?:--head[= ]+|-H[= ]*)(?:"([^"]*)"|'([^']*)'|(\S+))/g;
  for (const m of String(command ?? '').matchAll(flagRe)) {
    const raw = (m[1] ?? m[2] ?? m[3] ?? '').trim();
    // `owner:branch` è la forma cross-fork accettata da gh; a noi serve il branch.
    const branch = raw.includes(':') ? raw.slice(raw.indexOf(':') + 1) : raw;
    const unexpanded = /[$`]/.test(branch);
    if (!branch || unexpanded) continue;
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
