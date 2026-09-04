/**
 * Shared concurrency gate for raw DNS `lookupImpl` calls.
 *
 * `node:dns/promises`' `lookup()` has no cancellation hook: a caller that
 * races it against a timeout (redirect-chain budgets, per-request abort
 * signals) can only stop *waiting* for it, not stop the underlying getaddrinfo
 * call — it keeps running in the background until it settles on its own
 * (#7149 item 3). Left ungated, the number of these abandoned lookups grows
 * with however many hostnames a run processes.
 *
 * `gateLookup` bounds how many real lookups (including abandoned stragglers)
 * can be in flight at once, so that count stays a constant instead of
 * growing with the size of the work queue.
 */

/** Shared ceiling for real in-flight DNS lookups across every call site, so the budget can't drift between them. */
export const MAX_CONCURRENT_LOOKUPS = 16;

function createLookupGate(maxConcurrent) {
  let active = 0;
  const queue = [];
  return async function gatedLookup(lookupImpl, hostname, options) {
    if (active >= maxConcurrent) await new Promise((resolve) => queue.push(resolve));
    active += 1;
    try {
      return await lookupImpl(hostname, options);
    } finally {
      active -= 1;
      const next = queue.shift();
      if (next) next();
    }
  };
}

/** @param {(hostname: string, options: unknown) => Promise<unknown>} lookupImpl @param {number} maxConcurrent */
export function gateLookup(lookupImpl, maxConcurrent) {
  const gate = createLookupGate(maxConcurrent);
  return (hostname, options) => gate(lookupImpl, hostname, options);
}
