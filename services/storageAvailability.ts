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

/** Read an optional localStorage value without making storage a UI dependency. */
export function readStorageItem(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

/** Persist an optional localStorage value; callers continue when storage is blocked. */
export function writeStorageItem(key: string, value: string): boolean {
  try {
    localStorage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

/** Read an optional sessionStorage value without making a UI flow brittle. */
export function readSessionStorageItem(key: string): string | null {
  try {
    return sessionStorage.getItem(key);
  } catch {
    return null;
  }
}

/** Persist an optional sessionStorage value; callers continue when it is blocked. */
export function writeSessionStorageItem(key: string, value: string): boolean {
  try {
    sessionStorage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}
