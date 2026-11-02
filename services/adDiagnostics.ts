/** GA4 only, bounded fields and no raw errors, query strings or identifiers. */
export function emitAdDiagnostic(event: string, properties: Record<string, string | number> = {}) {
  try {
    const w = window as Window & { gtag?: (...args: unknown[]) => void; dataLayer?: unknown[] };
    const payload = { ...properties, page_location: window.location.origin + window.location.pathname, transport_type: 'beacon' };
    if (typeof w.gtag === 'function') w.gtag('event', event, payload);
    else {
      const queue = w.dataLayer = w.dataLayer || [];
      (function (..._args: unknown[]) { queue.push(arguments); })('event', event, payload);
    }
  } catch { /* Measurement never owns ad delivery. */ }
}
