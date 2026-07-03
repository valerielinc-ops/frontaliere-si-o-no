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
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HEADER_IMPL_RE = /^\s{0,3}#{2,3}\s+Implementato\b/im;
const HEADER_NON_RE = /^\s{0,3}#{2,3}\s+Non implementato\b/im;

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
  process.exit(1);
}

// Only run when executed directly (e.g. `node pr-body-check-gate.mjs` as a
// hook) — not when imported (e.g. by tests importing `extractPrBody`).
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isMain) {
  main();
}
