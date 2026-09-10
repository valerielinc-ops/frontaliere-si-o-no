/**
 * Minimal, dependency-free marker contract used by claude-rate-limit.mjs.
 *
 * The preflight fallback is snapshotted into an ephemeral runtime directory;
 * keeping this parser primitive standalone prevents that runtime from loading
 * the full issue-reconciliation graph (and its GitHub side effects).
 */
export const FIX_OUTCOME_RE = /<!--\s*FIX_OUTCOME:\s*([a-z0-9-]+)\s*-->/i;
