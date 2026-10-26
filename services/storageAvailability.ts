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
