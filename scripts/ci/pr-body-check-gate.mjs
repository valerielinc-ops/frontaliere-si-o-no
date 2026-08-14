/**
 * pr-body-check-gate.mjs — PreToolUse hook: blocks `gh pr create` locally when
 * the PR body is missing the mandatory `## Implementato` / `## Non implementato`
 * headers (AGENTS.md § Workflow, Non-Negotiable #8; enforced remotely by
 * `.github/workflows/pr-body-contract.yml`).
 *
 * Today that CI check only runs AFTER the PR is opened, wasting a full review
 * cycle when the headers are missing. This hook catches the same gap locally,
 * before `gh pr create` ever runs — mirrors the interception pattern of
 * `sibling-check-gate.mjs` (#3275).
 *
 * Header regexes are intentionally identical to pr-body-contract.yml's
 * `hasImpl` / `hasNon` checks — keep both in sync if the contract changes.
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
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EXIT_BLOCK } from './lib/hook-exit-codes.mjs';
// La tassonomia degli stati vive in UN posto solo: riscriverla qui produrrebbe
// due copie che divergono al primo stato nuovo, in silenzio.
import { bulletsWithoutState, extractSection } from '../lib/pr-body-sections-check.mjs';

const HEADER_IMPL_RE = /^\s{0,3}#{2,3}\s+Implementato\b/im;
const HEADER_NON_RE = /^\s{0,3}#{2,3}\s+Non implementato\b/im;
const NON_IMPL_ANCORA_RE = /^[ \t]{0,3}#{2,3}[ \t]+Non[ \t]+implementato[^\n]*/im;

/**
 * Best-effort extraction of the PR body text from a `gh pr create` shell
 * command string. Returns `undefined` when no recognizable `--body` /
 * `--body-file` argument is found (caller should fail-safe / allow).
 */
export function extractPrBody(command) {
  // --body-file <path> | --body-file=<path> (quoted or bare)
  const fileMatch = command.match(
    /--body-file[= ]+(?:"([^"]+)"|'([^']+)'|(\S+))/,
  );
  if (fileMatch) {
    const path = fileMatch[1] ?? fileMatch[2] ?? fileMatch[3];
    try {
      return readFileSync(resolve(path), 'utf8');
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

async function main() {
  let command = '';
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
      } catch {
        command = raw; // raw text fallback — grep for gh pr create
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
    body = extractPrBody(command);
  } catch {
    process.exit(0); // extraction error → fail-safe
  }

  if (body === undefined) {
    // Couldn't confidently locate/read a --body / --body-file argument —
    // don't block on our own parsing gap.
    process.exit(0);
  }

  const hasImpl = HEADER_IMPL_RE.test(body);
  const hasNon = HEADER_NON_RE.test(body);

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

  if (hasImpl && hasNon) {
    process.exit(0);
  }

  const missing = [];
  if (!hasImpl) missing.push('`## Implementato`');
  if (!hasNon) missing.push('`## Non implementato (ancora)`');

  process.stderr.write(
    '\n\u{1F6AB} pr-body-check-gate: PR bloccata — header obbligatori mancanti nel body: ' +
      `${missing.join(', ')}.\n` +
      'AGENTS.md § Workflow richiede ENTRAMBI gli header letterali `## Implementato` e ' +
      '`## Non implementato (ancora)` nel PR body (Non-Negotiable #8, REVIEW.md).\n' +
      'Aggiungi le sezioni mancanti al `--body`/`--body-file` prima di rilanciare `gh pr create`.\n\n',
  );
  process.exit(EXIT_BLOCK);
}

// Only run when executed directly (e.g. `node pr-body-check-gate.mjs` as a
// hook) — not when imported (e.g. by tests importing `extractPrBody`).
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isMain) {
  main();
}
