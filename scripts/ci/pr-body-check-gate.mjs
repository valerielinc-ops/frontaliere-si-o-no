/**
 * pr-body-check-gate.mjs — shared deterministic validator for PR bodies.
 * The PreToolUse hook uses it locally; CI workflows invoke its `--body-file`
 * entrypoint before calling `gh pr create`/`gh pr edit`.
 *
 * Today that CI check only runs AFTER the PR is opened, wasting a full review
 * cycle when the headers are missing. This hook catches the same gap locally,
 * before `gh pr create` ever runs — mirrors the interception pattern of
 * `sibling-check-gate.mjs` (#3275).
 *
 * The section taxonomy is intentionally imported from
 * `scripts/lib/pr-body-sections-check.mjs`. Keep the pure validation here and
 * expose it to both callers; do not duplicate the state vocabulary.
 *
 * Fail-safe: any internal error, or body we can't confidently extract from the
 * command string (e.g. unrecognized `--body`/`--body-file` shape) → exit 0
 * (never block PR creation on this hook's own inability to parse the command).
 *
 * Blocking uses EXIT_BLOCK (2), not 1: for PreToolUse hooks Claude Code treats
 * 1 as a NON-blocking error and runs the tool anyway, so this gate printed
 * «PR bloccata» and then let `gh pr create` through. See lib/hook-exit-codes.mjs.
 */
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EXIT_BLOCK } from './lib/hook-exit-codes.mjs';
import {
  resolveHookRepository,
  resolveHookTargetCwd,
  resolveGatedHeadRef,
} from './lib/hook-target-cwd.mjs';
// La tassonomia degli stati vive in UN posto solo: riscriverla qui produrrebbe
// due copie che divergono al primo stato nuovo, in silenzio.
import { bulletsWithoutState, checkPrBodySections, extractSection, filesUncitedInBody } from '../lib/pr-body-sections-check.mjs';

const NON_IMPL_ANCORA_RE = /^[ \t]{0,3}#{2,3}[ \t]+Non[ \t]+implementato[^\n]*/im;

const BODY_FILE_RE = /--body-file[= ]+(?:"([^"]+)"|'([^']+)'|(\S+))/;

/** Exit code used by the workflow-facing CLI for an unreadable body file. */
export const BODY_FILE_INFRA = 3;

/**
 * Perche' `extractPrBody` non ha restituito un body — la stessa analisi, ma
 * con la CAUSA invece di un `undefined` muto.
 *
 * `extractPrBody` collassa tre situazioni diverse in un solo `undefined`:
 * il flag non c'e' affatto, il `--body-file` c'e' ma il path non e' leggibile,
 * oppure c'e' un `--body` in una forma che le sue regex non riconoscono. I
 * chiamanti sono gate: quando non leggono il body ricadono (giustamente) sul
 * comportamento conservativo, ma il messaggio che stampano parla d'altro — e
 * chi lo legge insegue candidati invece del path sbagliato. Questa funzione
 * sta ACCANTO a `extractPrBody` invece di cambiarne la firma proprio perche'
 * quella e' esportata e usata altrove: la diagnosi e' additiva.
 *
 * @param {string} command la command line di `gh pr create`
 * @param {string} [cwd] directory contro cui risolvere un `--body-file` relativo
 * @returns {{ kind: 'body-file'|'body-inline'|'assente', ok: boolean, cwd: string,
 *   path?: string, resolved?: string, reason?: string }}
 */
export function describePrBodySource(command, cwd = process.cwd()) {
  const cmd = String(command ?? '');
  const fileMatch = cmd.match(BODY_FILE_RE);
  if (fileMatch) {
    const path = fileMatch[1] ?? fileMatch[2] ?? fileMatch[3];
    const resolved = resolve(cwd, path);
    try {
      readFileSync(resolved, 'utf8');
      return { kind: 'body-file', ok: true, cwd, path, resolved };
    } catch (err) {
      return {
        kind: 'body-file',
        ok: false,
        cwd,
        path,
        resolved,
        reason: `path non leggibile (${err?.code ?? err?.message ?? 'errore sconosciuto'})`,
      };
    }
  }
  if (/--body[= ]/.test(cmd)) {
    const ok = extractPrBody(cmd, cwd) !== undefined;
    return {
      kind: 'body-inline',
      ok,
      cwd,
      reason: ok ? undefined : 'forma di --body non riconosciuta dalle regex del parser',
    };
  }
  return { kind: 'assente', ok: false, cwd, reason: 'nessun --body / --body-file nel comando' };
}

/**
 * Best-effort extraction of the PR body text from a `gh pr create` shell
 * command string. Returns `undefined` when no recognizable `--body` /
 * `--body-file` argument is found (caller should fail-safe / allow).
 *
 * `cwd` resolves a RELATIVE `--body-file` path against the directory selected
 * by `hook-target-cwd.mjs` (a literal command `cd` when available, otherwise
 * the tracked payload/ambient directory).
 *
 * Quando ritorna `undefined` e ti serve sapere PERCHE', usa
 * `describePrBodySource` qui sopra: questa firma non lo distingue.
 */
export function extractPrBody(command, cwd = process.cwd()) {
  // --body-file <path> | --body-file=<path> (quoted or bare)
  const fileMatch = command.match(BODY_FILE_RE);
  if (fileMatch) {
    const path = fileMatch[1] ?? fileMatch[2] ?? fileMatch[3];
    try {
      return readFileSync(resolve(cwd, path), 'utf8');
    } catch {
      return undefined; // unreadable path → can't verify, fail-safe
    }
  }

  // --body "$(cat <<'EOF' ... EOF)" heredoc pattern (the documented pattern
  // for multi-line PR bodies, see CLAUDE.md's `gh pr create` example).
  const heredocMatch = command.match(
    /--body\s+"\$\(cat\s*<<-?\s*['"]?(\w+)['"]?\s*\n([\s\S]*?)\n\s*\1\s*\)"/,
  );
  if (heredocMatch) {
    return heredocMatch[2];
  }

  // --body "text" (double-quoted, possibly with escaped quotes)
  const doubleQuoted = command.match(/--body[= ]+"((?:[^"\\]|\\.)*)"/);
  if (doubleQuoted) {
    return doubleQuoted[1].replace(/\\"/g, '"');
  }

  // --body 'text' (single-quoted)
  const singleQuoted = command.match(/--body[= ]+'([^']*)'/);
  if (singleQuoted) {
    return singleQuoted[1];
  }

  return undefined;
}

/**
 * Validate a body against the shipped section checker, promoting the existing
 * state-less-bullet warning to a violation at the PR-writing boundary.
 *
 * `scripts/lib/pr-body-sections-check.mjs` remains the one source of the state
 * taxonomy. That module deliberately keeps the warning advisory for consumers
 * that still inspect historical bodies; this boundary is stricter because a
 * new remote write must never create or destroy a residual state.
 *
 * @param {string} body
 * @param {{ diffPaths?: string[] }} [options]
 * @returns {{ok:boolean, violations:Array<object>, warnings:Array<object>}}
 */
export function validatePrBody(body, options = {}) {
  const result = checkPrBodySections(body, options);
  const stateWarnings = (result.warnings ?? []).filter(
    (warning) => warning.type === 'bullet-without-state',
  );
  return {
    ...result,
    ok: result.ok && stateWarnings.length === 0,
    violations: [...result.violations, ...stateWarnings],
    warnings: (result.warnings ?? []).filter(
      (warning) => warning.type !== 'bullet-without-state',
    ),
  };
}

/**
 * Read and validate a body file for a remote workflow.
 *
 * An unreadable file is infrastructure, not a contract violation. The caller
 * gets a distinct result/code and can skip the remote write without turning a
 * completed fix into a failed job.
 *
 * @param {string} bodyPath
 * @param {string} [cwd]
 * @param {{ diffPaths?: string[] }} [options]
 * @returns {{kind:'ok'|'contract-violation'|'infrastructure-error', path?:string, reason?:string, validation?:object}}
 */
export function validatePrBodyFile(bodyPath, cwd = process.cwd(), options = {}) {
  if (!bodyPath) {
    return {
      kind: 'infrastructure-error',
      reason: 'nessun path passato a --body-file',
    };
  }

  const resolved = resolve(cwd, bodyPath);
  let body;
  try {
    body = readFileSync(resolved, 'utf8');
  } catch (err) {
    return {
      kind: 'infrastructure-error',
      path: resolved,
      reason: `path non leggibile (${err?.code ?? err?.message ?? 'errore sconosciuto'})`,
    };
  }

  const validation = validatePrBody(body, options);
  return {
    kind: validation.ok ? 'ok' : 'contract-violation',
    path: resolved,
    validation,
  };
}

function printValidationFailure(validation) {
  for (const violation of validation.violations ?? []) {
    process.stderr.write(`✗ [${violation.type}] ${violation.message}\n`);
  }
}

function runBodyFileCli(bodyPath) {
  const result = validatePrBodyFile(bodyPath);
  if (result.kind === 'infrastructure-error') {
    process.stderr.write(
      `::warning::pr-body-check-gate: body-file non leggibile; nessun body PR scritto` +
        `${result.path ? ` (${result.path})` : ''}: ${result.reason}\n`,
    );
    return BODY_FILE_INFRA;
  }

  if (result.kind === 'contract-violation') {
    process.stderr.write(
      '\n🚫 pr-body-check-gate: body PR non conforme; scrittura bloccata.\n',
    );
    printValidationFailure(result.validation);
    process.stderr.write('\n');
    return EXIT_BLOCK;
  }

  process.stdout.write(
    '✓ pr-body-check-gate: body PR conforme; scrittura autorizzata.\n',
  );
  return 0;
}

/**
 * Stampa (senza bloccare) i bullet di `## Non implementato (ancora)` privi di
 * stato letterale. Esportata per il test.
 *
 * @param {string} body corpo della PR
 * @returns {string[]} i bullet segnalati
 */
export function warnAboutStatelessBullets(body) {
  const section = extractSection(String(body ?? ''), NON_IMPL_ANCORA_RE);
  if (section === null) return [];
  const stateless = bulletsWithoutState(section);
  if (stateless.length === 0) return [];
  process.stderr.write(
    `\n⚠️  pr-body-check-gate (advisory, NON blocca): ${stateless.length} bullet di `
    + '`## Non implementato (ancora)` non dichiara uno stato letterale.\n'
    + 'Ogni voce residua vuole `in questa PR` / `PR concatenata #N` / `per scelta` / '
    + '`by construction` / `blocked: <causa>` (AGENTS.md #8, REVIEW.md).\n'
    + 'Senza stato la voce viene riaperta come issue di follow-up da '
    + 'scripts/ci/followup-has-candidates.mjs, anche quando è già chiusa.\n'
    + stateless.map((b) => `  · ${b.slice(0, 140)}\n`).join('')
    + '\n',
  );
  return stateless;
}

/**
 * Repo-relative paths changed on this branch vs `origin/main`, best-effort. Returns
 * `[]` on any git failure (no `origin/main` locally, detached checkout, etc.) — this
 * feeds an advisory-only check, never worth blocking `gh pr create` over.
 *
 * `cwd` (see lib/hook-target-cwd.mjs) picks WHICH REPO git runs in; `headRef`
 * picks WHICH BRANCH is compared. Il secondo parametro e' arrivato il
 * 2026-09-05 con la stessa fix di `sibling-check-gate.mjs` (AGENTS.md #6,
 * classe intera): `origin/main...HEAD` legge l'HEAD della directory TRACCIATA
 * della sessione, che in una flotta e' spesso il checkout principale condiviso
 * — li' l'avviso «file non citati nel body» elencava i file di un'altra
 * sessione, o taceva del tutto perche' quel checkout e' fermo su main. Il
 * chiamante passa il ref del branch che sta proponendo, risolto da
 * `resolveGatedHeadRef`.
 *
 * @param {string} [cwd]
 * @param {string} [headRef]
 * @returns {string[]}
 */
export function localDiffPaths(cwd = process.cwd(), headRef = 'HEAD') {
  try {
    const out = execFileSync(
      'git',
      ['diff', '--name-only', `origin/main...${headRef}`],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], cwd },
    );
    return out.split('\n').map((l) => l.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Stampa (senza bloccare) i file funnel-critical modificati dal diff locale ma non
 * citati nel body (#6301 — riprodotto su #6279: `.github/workflows/prospector-loop.yml`
 * modificato e mai citato). Esportata per il test.
 *
 * @param {string} body corpo della PR
 * @param {string} [cwd] vedi localDiffPaths
 * @param {string} [headRef] vedi localDiffPaths
 * @returns {string[]} i path segnalati
 */
export function warnAboutUncitedFiles(body, cwd, headRef = 'HEAD') {
  const diffPaths = localDiffPaths(cwd, headRef);
  if (diffPaths.length === 0) return [];
  const uncited = filesUncitedInBody(diffPaths, body);
  if (uncited.length === 0) return [];
  process.stderr.write(
    `\n⚠️  pr-body-check-gate (advisory, NON blocca): ${uncited.length} file funnel-critical `
    + 'modificati dal diff locale non sono citati nel body (né path né basename).\n'
    + 'Aggiungi un bullet in `## Implementato` che li menziona (recidiva: PR #6279).\n'
    + uncited.map((p) => `  · ${p}\n`).join('')
    + '\n',
  );
  return uncited;
}

async function main() {
  let command = '';
  let targetCwd;
  try {
    const chunks = [];
    for await (const chunk of process.stdin) {
      chunks.push(chunk);
    }
    const raw = Buffer.concat(chunks).toString('utf8').trim();
    if (raw) {
      try {
        const payload = JSON.parse(raw);
        command = payload?.tool_input?.command ?? payload?.command ?? '';
        targetCwd = resolveHookTargetCwd(payload, command);
      } catch {
        command = raw; // raw text fallback — grep for gh pr create
        targetCwd = resolveHookTargetCwd(undefined, command);
      }
    }
  } catch {
    process.exit(0); // stdin failure → fail-safe
  }

  if (!command.includes('gh pr create')) {
    process.exit(0);
  }

  let body;
  try {
    body = extractPrBody(command, targetCwd);
  } catch {
    process.exit(0); // extraction error → fail-safe
  }

  if (body === undefined) {
    // Couldn't confidently locate/read a --body / --body-file argument —
    // don't block on our own parsing gap.
    process.exit(0);
  }

  // ADVISORY (mai bloccante): i bullet di `## Non implementato (ancora)` che
  // non dichiarano uno stato letterale. È l'unico momento in cui l'autore vede
  // il difetto PRIMA che diventi una issue di follow-up spuria — a valle
  // `scripts/ci/followup-has-candidates.mjs` riapre ogni bullet senza stato.
  // Stampato anche quando gli header ci sono, cioè sul percorso di uscita
  // verde: se lo stampassimo solo in caso di blocco non lo vedrebbe nessuno.
  // Tutto dentro try/catch: un difetto di QUESTO avviso non deve mai impedire
  // a una PR di nascere.
  try {
    warnAboutStatelessBullets(body);
  } catch { /* advisory: non blocca mai */ }
  try {
    // Stesso ref del sibling-gate: il branch proposto, non l'HEAD della
    // directory tracciata (2026-09-05, AGENTS.md #6 — la classe intera).
    // Se il repository esplicito non ha un checker locale, saltiamo solo
    // questo avviso advisory: la validazione obbligatoria del body continua.
    const gateTarget = resolveHookRepository(command);
    if (gateTarget) {
      const head = resolveGatedHeadRef(command, targetCwd, gateTarget.repo);
      warnAboutUncitedFiles(body, head.cwd, head.ref);
    }
  } catch { /* advisory: non blocca mai */ }

  // The same pure validator is used by this hook and by the workflow CLI.
  // Its failure is a contract violation, so it blocks with EXIT_BLOCK.
  let validation;
  try {
    validation = validatePrBody(body);
  } catch {
    process.exit(0); // internal validation error → preserve the hook fail-safe
  }
  if (!validation.ok) {
    process.stderr.write(
      '\n🚫 pr-body-check-gate: PR bloccata — body non conforme.\n',
    );
    printValidationFailure(validation);
    process.stderr.write('\n');
    process.exit(EXIT_BLOCK);
  }

  process.exit(0);
}

// Only run when executed directly (e.g. `node pr-body-check-gate.mjs` as a
// hook) — not when imported (e.g. by tests importing `extractPrBody`).
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isMain) {
  const bodyFileArg = process.argv[2] === '--body-file'
    ? process.argv[3]
    : process.argv[2]?.startsWith('--body-file=')
      ? process.argv[2].slice('--body-file='.length)
      : undefined;
  if (process.argv[2]?.startsWith('--body-file')) {
    process.exitCode = runBodyFileCli(bodyFileArg);
  } else {
    main();
  }
}
