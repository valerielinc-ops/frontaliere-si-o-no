#!/usr/bin/env node
/**
 * pr-watch-register.mjs — PostToolUse(Bash) hook: when the command was
 * `gh pr create` and it printed a PR URL, add that PR to the watch list
 * (pr-watch-store.mjs) that pr-watch-gate.mjs reads on Stop.
 *
 * Fail-safe: any internal error → exit 0, no output. A hook that could break
 * `gh pr create` itself would be worse than the problem it fixes — see
 * hook-exit-codes.mjs's note on the same principle for the sibling gates.
 */
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readEntries, writeEntries, addEntry, extractPrRef } from './lib/pr-watch-store.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..');

async function main() {
  let payload;
  try {
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
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
    const next = addEntry(entries, { ...ref, openedAt: new Date().toISOString() });
    writeEntries(REPO_ROOT, next);
  } catch {
    // Store write failed — the Stop gate will simply not know about this PR.
    // Not registering is safer than crashing the hook chain.
  }
}

main().catch(() => {});
