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

/**
 * Page-lifetime fallback for optional localStorage preferences. Some browsers
 * throw while reading localStorage in privacy mode, while others only reject
 * writes after the quota is exhausted.
 */
const memoryFallback = new Map<string, string>();

export function readBestEffortLocalStorage(key: string): string | null {
 try {
  if (typeof window !== 'undefined') {
   const stored = window.localStorage.getItem(key);
   if (stored !== null) return stored;
  }
 } catch {
  // Browser storage is optional for non-critical UI preferences.
 }

 return memoryFallback.get(key) ?? null;
}

export function writeBestEffortLocalStorage(key: string, value: string): void {
 memoryFallback.set(key, value);

 try {
  if (typeof window !== 'undefined') window.localStorage.setItem(key, value);
 } catch {
  // Keep the in-memory value when privacy mode or quota blocks persistence.
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
