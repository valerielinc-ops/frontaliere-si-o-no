/**
 * Best-effort storage for calculator input preferences.
 *
 * Safari private browsing and exhausted browser quotas can make even reading
 * localStorage throw. Keep a page-lifetime fallback so the calculator still
 * remembers preferences and easter-egg deduplication when persistence is not
 * available.
 */
const memoryFallback = new Map<string, string>();

export function readCalculatorInputStorage(key: string): string | null {
 try {
  if (typeof window !== 'undefined') {
   const stored = window.localStorage.getItem(key);
   if (stored !== null) return stored;
  }
 } catch {
  // Browser storage is optional for calculator interactions.
 }

 return memoryFallback.get(key) ?? null;
}

export function writeCalculatorInputStorage(key: string, value: string): void {
 memoryFallback.set(key, value);

 try {
  if (typeof window !== 'undefined') window.localStorage.setItem(key, value);
 } catch {
  // Keep the in-memory value when privacy mode or quota blocks persistence.
 }
}
