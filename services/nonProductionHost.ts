/**
 * Hosts whose JS errors are not production errors.
 *
 * The GA4 property is shared: `app_error` fired by the dev server
 * (`127.0.0.1:3000`, `localhost`) and by the Firebase service domains
 * (`<project>.firebaseapp.com` / `.web.app`, which serve the auth handler and
 * the default Hosting site, not the public site) landed in the same
 * `errorHealth.appErrors` table the backlog feeder reads — on one signature 13
 * hits out of 20 came from `127.0.0.1:3000` (issue 9465).
 *
 * A deny-list on purpose, not an allow-list of the production domain: an
 * unknown host keeps reporting, so a new production hostname can never go
 * silent because nobody added it here. The server side
 * (scripts/lib/app-error-recency.mjs) filters the report on the production
 * host independently.
 */
import { isLocalDevHost } from './posthogQuota';

const NON_PRODUCTION_HOST_SUFFIXES = ['.firebaseapp.com', '.web.app'] as const;

export function isNonProductionTelemetryHost(
  hostname: string = typeof window === 'undefined' ? '' : window.location.hostname,
): boolean {
  const host = hostname.trim().toLowerCase();
  if (!host) return false;
  return isLocalDevHost(host) || NON_PRODUCTION_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix));
}

/** GA4 events that feed `errorHealth` (app_error) and its fallback (exception). */
export const GA4_ERROR_EVENTS: ReadonlySet<string> = new Set(['app_error', 'exception']);
