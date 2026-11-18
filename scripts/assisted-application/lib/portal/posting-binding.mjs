/**
 * Shared contract for proving that the current application surface belongs to
 * the selected posting. A route discriminator may prove a binding, but an
 * incomplete or ambiguous discriminator must remain unknown.
 */
export const POSTING_BINDING_STATUS = Object.freeze({
  BOUND: 'bound',
  MISMATCH: 'mismatch',
  UNKNOWN: 'unknown',
});

function parsed(value) {
  try {
    return new URL(String(value || ''));
  } catch {
    return null;
  }
}

/** Compare a route without allowing credentials or a different query/hash. */
export function samePostingRouteAddress(firstUrl, secondUrl) {
  const first = parsed(firstUrl);
  const second = parsed(secondUrl);
  if (!first || !second || first.username || first.password || second.username || second.password) return false;
  return first.origin === second.origin
    && first.pathname.replace(/\/+$/u, '') === second.pathname.replace(/\/+$/u, '')
    && first.search === second.search
    && first.hash === second.hash;
}

function verdict(status, via, reason = '') {
  return { status, via, ...(reason ? { reason } : {}) };
}

/**
 * Reconcile independent binding evidence into one fail-closed verdict.
 *
 * `routeExpected` is set only for a recognized adapter/ATS route (for example
 * Workday or the query-bound BrassRing page). `routeBound` must then be
 * calculated by that adapter, not inferred from a title or host substring.
 * An employer-site handoff is valid only when its clicked entry and current
 * application URL are both present and identical.
 */
export function resolvePostingBinding({
  currentUrl = '',
  postingUrl = '',
  routeKind = '',
  routeExpected = false,
  routeBound = false,
  selectedPostingRoute = false,
  applicationEntryUrl = '',
  applicationEntryProven = false,
  postingEntryProven = false,
  formMatch = 'unknown',
  explicitMismatch = false,
} = {}) {
  if (explicitMismatch === true || formMatch === 'mismatch') {
    return verdict(POSTING_BINDING_STATUS.MISMATCH, routeKind || 'binding', 'explicit_conflict');
  }

  if (routeExpected === true && routeBound !== true) {
    return verdict(POSTING_BINDING_STATUS.MISMATCH, routeKind || 'route', 'route_discriminator_conflict');
  }

  if (routeBound === true) {
    return verdict(POSTING_BINDING_STATUS.BOUND, routeKind || 'route');
  }

  if (selectedPostingRoute === true) {
    return verdict(POSTING_BINDING_STATUS.BOUND, 'selected-posting-route');
  }

  if (applicationEntryProven === true
    && samePostingRouteAddress(currentUrl, applicationEntryUrl)) {
    return verdict(POSTING_BINDING_STATUS.BOUND, 'application-entry');
  }

  // A source posting entry is evidence only while the browser is still on
  // that exact route. It cannot be carried to an arbitrary same-origin page.
  if (postingEntryProven === true
    && samePostingRouteAddress(currentUrl, postingUrl)) {
    return verdict(POSTING_BINDING_STATUS.BOUND, 'posting-entry');
  }

  if (formMatch === 'match') {
    return verdict(POSTING_BINDING_STATUS.BOUND, 'form-match');
  }

  return verdict(POSTING_BINDING_STATUS.UNKNOWN, 'insufficient-evidence', 'ambiguous_or_missing_discriminator');
}
