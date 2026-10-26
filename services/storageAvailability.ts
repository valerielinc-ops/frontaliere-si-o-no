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

/** Read browser storage without allowing privacy mode or quota errors to escape. */
export function readLocalStorage(key: string): string | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

/** Write browser storage best-effort; callers can continue when it is blocked. */
export function writeLocalStorage(key: string, value: string): boolean {
  if (typeof window === 'undefined') return false;
  try {
    window.localStorage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}
