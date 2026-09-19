#!/usr/bin/env node
/**
 * pr-watch-register.mjs — PostToolUse(Bash) hook: when the command was
 * `gh pr create` and it printed a PR URL, add that PR to the watch list
 * (pr-watch-store.mjs) that pr-watch-gate.mjs reads on Stop.
 *
 * Fail-safe: any internal error → exit 0, no output. A hook that could break
 * `gh pr create` itself would be worse than the problem it fixes — see
 * hook-exit-codes.mjs's note on the same principle for the sibling gates.
 *
 * Dopo la registrazione restituisce all'agente (additionalContext) il comando
 * di subscription event-driven con i waitFor della review oltre al terminale:
 * con il solo `merged,failed` di prima una review 🔴 non svegliava nessuno.
 */
import { fileURLToPath } from 'node:url';
import { readHookStdin } from './lib/hook-stdin.mjs';
import { dirname, join } from 'node:path';
import { readEntries, writeEntries, addEntry, extractPrRef } from './lib/pr-watch-store.mjs';
import { subscribeCommand } from './lib/pr-watch-classify.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..');

async function main() {
  let payload;
  try {
    // Timeout: uno stdin mai chiuso non deve appendere l'hook (lib/hook-stdin.mjs).
    payload = JSON.parse((await readHookStdin()).raw);
  } catch {
    return; // no stdin / malformed — nothing to register
  }

  const command = payload?.tool_input?.command ?? '';
  if (!/\bgh\s+pr\s+create\b/.test(command)) return;

  // The exact shape of tool_response for the Bash tool is not part of the
  // documented hook-input contract, so scan its whole JSON text rather than
  // guess a field name (stdout/output/etc.) that may not match this harness
  // version.
  const haystack = JSON.stringify(payload?.tool_response ?? '') + '\n' + JSON.stringify(payload);
  const ref = extractPrRef(haystack);
  if (!ref) return; // command ran but no PR URL surfaced (e.g. it errored)

  try {
    const entries = readEntries(REPO_ROOT);
    // `session_id` è nell'input documentato degli hook. Serve al gate per
    // bloccare solo CHI ha aperto la PR: lo store è per-checkout e tutte le
    // sessioni dello stesso clone (worktree compresi) ne condividono uno solo.
    // Assente → entry senza padrone, che il gate enforce-a per chiunque.
    const sessionId = typeof payload?.session_id === 'string' ? payload.session_id : undefined;
    const next = addEntry(entries, {
      ...ref,
      openedAt: new Date().toISOString(),
      ...(sessionId ? { sessionId } : {}),
    });
    writeEntries(REPO_ROOT, next);
  } catch {
    // Store write failed — the Stop gate will simply not know about this PR.
    // Not registering is safer than crashing the hook chain.
  }

  const context = [
    `PR #${ref.number} (${ref.owner}/${ref.repo}) registrata nel pr-watch.`,
    'Seguila event-driven, review comprese (niente polling di gh pr view/checks):',
    `  ${subscribeCommand(ref)}`,
    'poi UN solo `bin/gh-frontaliere events listen <subscription-id>`; a un evento `commented`/`needs_review` leggi la review.',
  ].join('\n');
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: context },
  }));
}

main().catch(() => {});
