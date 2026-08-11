/**
 * Safely invoke the native `history.pushState` / `history.replaceState`
 * implementation from inside a monkeypatch wrapper.
 *
 * Two independent hooks (`hooks/useUIState.ts`, `hooks/useSeoPageTracking.ts`)
 * patch these methods for SPA pageview tracking and both fall back to
 * `History.prototype[method]` when the captured `original` reference has
 * gone stale (React StrictMode double-invocation / interleaved mount order,
 * #4304). That fallback itself was not crash-proof: if
 * `History.prototype[method]` is ALSO unavailable (observed in the wild —
 * #5606, 18 occurrences/7d, "Cannot read properties of undefined (reading
 * 'apply')" persisting weeks after the #4304 fix shipped), calling `.apply`
 * on it threw the exact same TypeError. A broken navigation tracker must
 * never crash the whole app to the top-level ErrorBoundary, so this helper
 * is the single place that tries both references and swallows any failure.
 */
export function callNativeHistory(
  method: 'pushState' | 'replaceState',
  original: unknown,
  thisArg: History,
  args: unknown[],
): unknown {
  const impl = typeof original === 'function' ? original : History.prototype[method];
  if (typeof impl !== 'function') return undefined;
  try {
    return impl.apply(thisArg, args as any);
  } catch {
    return undefined;
  }
}
