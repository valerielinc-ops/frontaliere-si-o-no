/**
 * Merge two Umantis listing views without silently hiding non-empty conflicts.
 *
 * Callers MUST process listing sources sequentially (not via `Promise.all`/
 * `Promise.allSettled`): `existing` is trusted to be the first-seen view and
 * `incoming` the later one, and that ordering \u2014 not any timestamp on the
 * records \u2014 decides which value survives a conflict. All current callers
 * (gkb/tschuggen/spital-davos job parsers) satisfy this with a plain
 * `for...of` loop over `LISTING_URLS` with `await` inside, so first-seen
 * order matches array declaration order.
 */
export function mergeUmantisListing(existing = {}, incoming = {}, label = 'Umantis') {
  const merged = { ...existing };
  for (const [key, value] of Object.entries(incoming)) {
    const current = merged[key];
    const currentMissing = current == null || (typeof current === 'string' && current.trim() === '');
    const incomingPresent = value != null && (typeof value !== 'string' || value.trim() !== '');
    if (currentMissing && incomingPresent) {
      merged[key] = value;
    } else if (incomingPresent && current !== value) {
      const vacancyId = existing.vacancyId || incoming.vacancyId || 'unknown';
      console.warn(
        `\u26a0\ufe0f ${label} vacancy ${vacancyId}: conflicting ${key} across listing views `
          + `(kept=${JSON.stringify(current)}, discarded=${JSON.stringify(value)}); keeping first value.`,
      );
    }
  }
  return merged;
}
