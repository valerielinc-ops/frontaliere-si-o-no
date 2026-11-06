/**
 * hook-exit-codes.mjs — Claude Code hook exit-code semantics, in one place.
 *
 * These are NOT Unix conventions, and the difference is silent: for a
 * PreToolUse hook only **exit 2** blocks the tool call and feeds stderr back
 * to Claude. Exit 1 is classified as a *non-blocking* error — stderr is
 * surfaced and the tool call proceeds anyway.
 * (https://code.claude.com/docs/en/hooks — "Claude Code treats exit code 1 as
 * a non-blocking error and proceeds with the action, even though 1 is the
 * conventional Unix failure code. If your hook is meant to enforce a policy,
 * use exit 2".)
 *
 * Both PreToolUse gates in this repo printed «PR bloccata …» and then exited
 * 1, so neither had ever blocked `gh pr create`: the message asserted an
 * enforcement that never happened. Found while fixing #5195, and it is the
 * same defect class — a guard shaped like a guard that cannot fail. Shared
 * here so the two gates cannot drift apart on it again (AGENTS.md #6).
 *
 * NOTE for anyone reusing this outside PreToolUse: the exit-2 semantics vary
 * per hook event (e.g. on Stop/SubagentStop exit 2 blocks stoppage). These
 * constants are named for the PreToolUse contract the two gates use.
 */

/** Blocks the tool call; stderr goes back to Claude as feedback. */
export const EXIT_BLOCK = 2;

/** Allows the tool call. */
export const EXIT_ALLOW = 0;
