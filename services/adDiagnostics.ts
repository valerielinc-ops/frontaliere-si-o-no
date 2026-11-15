/** GA4 only, bounded fields and no raw errors, query strings or identifiers. */
export function emitAdDiagnostic(event: string, properties: Record<string, string | number> = {}) {
  try {
    const w = window as Window & { gtag?: (...args: unknown[]) => void; dataLayer?: unknown[] };
    // These EVENT dimensions already exist in GA4. Its dimension quota is
    // full: retain native fields for debugging while making recovery reasons,
    // probe sources, and CMP states queryable in ordinary reports.
    const action = properties.action ?? properties.outcome ?? properties.state ?? properties.result
      ?? properties.reason ?? properties.fallback_reason;
    const component = properties.component ?? properties.library ?? properties.source
      ?? properties.cmp_state ?? properties.probe ?? properties.campaign ?? properties.reason;
    const payload = {
      ...properties,
      ...(action !== undefined ? { action } : {}),
      ...(component !== undefined ? { component } : {}),
      ...(properties.surface !== undefined ? { cta_surface: properties.surface } : {}),
      page_location: window.location.origin + window.location.pathname,
      transport_type: 'beacon',
    };
    if (typeof w.gtag === 'function') w.gtag('event', event, payload);
    else {
      const queue = w.dataLayer = w.dataLayer || [];
      (function (..._args: unknown[]) { queue.push(arguments); })('event', event, payload);
    }
  } catch { /* Measurement never owns ad delivery. */ }
}
