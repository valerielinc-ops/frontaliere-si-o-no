/**
 * Gate B — allow one body write per PR, then require an explicit contract-fix
 * override. This is intentionally independent from pr-body-check-gate.mjs:
 * that validator checks the body contents, while this gate controls write
 * frequency. It never reads the body and never calls the network.
 *
 * Two properties make the block survivable, and both were missing until
 * 2026-09-20, when two sessions stalled on corpus #1599 with a validated body
 * correction they could not apply:
 *
 *  1. The override is declared INSIDE the command. A PreToolUse hook runs in
 *     the harness' process, so `export FRONTALIERE_ALLOW_PR_BODY_REWRITE_REASON=…`
 *     in the agent's shell never reaches it: the documented escape hatch was
 *     unreachable for exactly the caller the gate stops. The reason now rides
 *     the command line as a per-command assignment, which the hook does see.
 *  2. The claim expires. The marker is a claim by a live session, not a
 *     permanent verdict about the PR; a session that dies right after its
 *     first body write used to close that PR's body forever, with no way out
 *     short of deleting a file under `.scratch/` by hand.
 *
 * Neither weakens the reason the gate exists. An accidental second write in a
 * fleet still carries no declaration and still gets blocked, and the TTL is
 * far longer than the review cycle it protects.
 */
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EXIT_BLOCK } from './lib/hook-exit-codes.mjs';
import { findPrBodyWrite, readHookCommand } from './lib/hook-command-parser.mjs';
import { claimMarker, resolveHookRepositoryScope } from './lib/hook-state.mjs';

export const BODY_REWRITE_REASON_ENV = 'FRONTALIERE_ALLOW_PR_BODY_REWRITE_REASON';

/**
 * How long one body-write claim holds the slot. Long enough to cover a full
 * review cycle on either repo (the corpus loop runs ~8 min, the site's is
 * longer), short enough that a session killed mid-flight does not strand the
 * PR for the rest of the day.
 */
export const CLAIM_TTL_MS = 90 * 60 * 1000;

/** A reason must be an actual sentence, not a keystroke to get past the gate. */
export const MIN_REASON_LENGTH = 12;

/** `"$VAR"` reaches a hook unexpanded: the hook reads the command, never runs it. */
const UNEXPANDED_RE = /^\$\{?[A-Za-z_(]/;

const EXAMPLE =
  `${BODY_REWRITE_REASON_ENV}='la review #123 chiede la correzione del body' \\\n` +
  '  gh pr edit 123 --repo owner/name --body-file /path/body.md';

/**
 * Where the declared reason came from, and whether it is usable.
 *
 * @param {Record<string,string>} assignments per-command assignments on the line
 * @param {Record<string, unknown>} env the hook process environment
 * @returns {{ok:true, reason:string, source:'command'|'env'}|{ok:false, problem?:string}}
 */
export function resolveRewriteReason(assignments = {}, env = process.env) {
  const inline = String(assignments?.[BODY_REWRITE_REASON_ENV] ?? '').trim();
  const ambient = String(env?.[BODY_REWRITE_REASON_ENV] ?? '').trim();
  const declared = inline || ambient;
  if (!declared) return { ok: false };

  if (UNEXPANDED_RE.test(declared)) {
    return {
      ok: false,
      problem:
        `la ragione e' arrivata non espansa (${declared}): il gate LEGGE la riga di comando, ` +
        'non la esegue. Scrivi il testo letterale, non una variabile.',
    };
  }
  if (declared.length < MIN_REASON_LENGTH) {
    return {
      ok: false,
      problem:
        `la ragione e' lunga ${declared.length} caratteri, ne servono almeno ${MIN_REASON_LENGTH}: ` +
        'deve dire CHI ha chiesto la riscrittura e perche\'.',
    };
  }
  return { ok: true, reason: declared, source: inline ? 'command' : 'env' };
}

/**
 * The block text. Built here (not a constant) because the remaining life of
 * the claim is the one number that tells the caller whether to declare a
 * reason or simply come back later.
 *
 * @param {number|undefined} ageMs
 */
export function blockMessage(ageMs) {
  const remaining = typeof ageMs === 'number' ? Math.max(0, CLAIM_TTL_MS - ageMs) : undefined;
  const ttlLine = remaining === undefined
    ? `Il claim scade da solo dopo ${Math.round(CLAIM_TTL_MS / 60000)} min.\n`
    : `Il claim scade da solo fra ~${Math.ceil(remaining / 60000)} min ` +
      `(TTL ${Math.round(CLAIM_TTL_MS / 60000)} min): dopo la scadenza questa riscrittura passa senza dichiarazione.\n`;

  return (
    '\n🚫 pr-body-write-gate: seconda riscrittura del body della PR bloccata.\n' +
    "Il body si scrive una sola volta, alla fine e dopo l'ultimo push: una riscrittura genera un nuovo run di tests/review sulla stessa SHA.\n" +
    "\nSe e' una review a chiedere la correzione, l'uscita e' raggiungibile DAL COMANDO STESSO — " +
    "l'hook gira in un altro processo e non vede l'ambiente della tua shell, quindi un `export` non arriva.\n" +
    `Dichiara la ragione come assegnazione sulla stessa riga (almeno ${MIN_REASON_LENGTH} caratteri, testo letterale):\n\n` +
    `  ${EXAMPLE}\n\n` +
    ttlLine +
    '\n'
  );
}

async function main() {
  const input = await readHookCommand();
  if (!input.ok) return;

  const bodyWrite = findPrBodyWrite(input.command, process.env);
  if (!bodyWrite || !bodyWrite.prNumber) return;

  const repo = bodyWrite.repo ?? resolveHookRepositoryScope(input.cwd);
  // Without an explicit repository or a readable local git identity, do not
  // collapse unrelated PR numbers into one ambient marker. Passing is the
  // required fail-safe result for an unknown target.
  if (!repo) return;
  const marker = claimMarker({
    scope: 'pr-body-writes',
    key: `${repo}:${bodyWrite.prNumber}`,
    ttlMs: CLAIM_TTL_MS,
    record: {
      prNumber: bodyWrite.prNumber,
      repo,
      bodyFlag: bodyWrite.bodyFlag,
      createdAt: new Date().toISOString(),
    },
  });

  if (marker.status === 'claimed') {
    if (marker.takeover) {
      process.stderr.write(
        'ℹ️  pr-body-write-gate: claim precedente scaduto ' +
          `(${Math.round((marker.ageMs ?? 0) / 60000)} min > TTL ${Math.round(CLAIM_TTL_MS / 60000)} min) — ` +
          'scrittura consentita e claim rinnovato.\n',
      );
    }
    return;
  }
  if (marker.status === 'unavailable') return;

  const declared = resolveRewriteReason(bodyWrite.assignments, process.env);
  if (declared.ok) {
    process.stderr.write(
      '✓ pr-body-write-gate: riscrittura autorizzata per correzione del contratto ' +
        `(${declared.source === 'command' ? 'dichiarata nel comando' : 'ambiente del processo hook'}) — ${declared.reason}\n`,
    );
    return;
  }

  if (declared.problem) {
    process.stderr.write(
      `\n🚫 pr-body-write-gate: dichiarazione rifiutata — ${declared.problem}\n\n  ${EXAMPLE}\n\n`,
    );
    process.exit(EXIT_BLOCK);
  }

  process.stderr.write(blockMessage(marker.ageMs));
  process.exit(EXIT_BLOCK);
}

// Run only when executed directly (the hook does `node pr-body-write-gate.mjs`).
// Importing it — which the test does, to exercise the pure helpers — must not
// start a hook that then waits on stdin. Same guard as pr-body-check-gate.mjs.
const isMain = Boolean(process.argv[1]) && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isMain) main().catch(() => process.exit(0));
