/**
 * Shared localStorage-availability probe.
 *
 * The same try/setItem/removeItem/catch pattern was independently
 * copy-pasted into behaviorTracker.ts, adBlockAbTest.ts and jobMatchProfile.ts
 * (sibling-pattern-fix, AGENTS.md #6) — centralized here so a future
 * storage-detection tweak can't drift between the three call sites.
 */
export function isStorageAvailable(testKey = '__fs_test__'): boolean {
  try {
    localStorage.setItem(testKey, '1');
    localStorage.removeItem(testKey);
    return true;
  } catch {
    return false;
  }
}
