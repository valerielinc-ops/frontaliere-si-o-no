/** Merge two Umantis listing views without silently hiding non-empty conflicts. */
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
        `\u26a0\ufe0f ${label} vacancy ${vacancyId}: conflicting ${key} across listing views; keeping first value.`,
      );
    }
  }
  return merged;
}
