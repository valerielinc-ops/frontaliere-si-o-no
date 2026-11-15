const WORKDAY_HOST_RE = /^(?:[a-z0-9-]+\.)+wd\d+\.myworkdayjobs\.com$/i;
const WORKDAY_LOCALE_SEGMENT_RE = /^[a-z]{2}(?:-[a-z]{2})?$/i;
// Workday tenants publish more than one requisition-id spelling. The
// standard `_R-...` form is joined by `_R...`, `_JR...`, `_REQ...`, and
// Roche's `_YYYYMM-...` ids. Keep arbitrary `/job/123` paths out of the
// posting identity, while accepting the tenant formats used by the public
// Workday routes.
const WORKDAY_REQUISITION_SLUG_RE = /^(?:.+)_(?:R-?[a-z0-9][a-z0-9-]*|JR[a-z0-9][a-z0-9-]*|REQ[a-z0-9][a-z0-9-]*|\d{6}-\d+(?:-\d+)*)$/i;
const WORKDAY_DETAILS_SLUG_RE = /^[^/]+$/i;
const WORKDAY_ACCOUNT_ROUTES = new Set([
  'login',
  'createaccount',
  'forgotpassword',
  'passwordreset',
  'resetpassword',
  'verifyemail',
  'activate',
]);

function workdaySiteSegments(segments) {
  const site = [...segments];
  if (WORKDAY_LOCALE_SEGMENT_RE.test(site[0] || '')) site.shift();
  return site;
}

export function isWorkdayTenantUrl(value) {
  try {
    return WORKDAY_HOST_RE.test(new URL(String(value || '')).hostname);
  } catch {
    return false;
  }
}

/** Parse a Workday posting and only its application entry routes. */
export function workdayJobRoute(value) {
  try {
    const url = new URL(String(value || ''));
    if (url.protocol !== 'https:' || url.username || url.password || url.hash
      || !WORKDAY_HOST_RE.test(url.hostname)) return null;
    const rawSegments = url.pathname.split('/');
    if (rawSegments[0] !== '') return null;
    let segments = rawSegments.slice(1);
    if (segments.at(-1) === '') segments.pop();
    if (segments.some((segment) => segment === '')) return null;
    let suffix = '';
    if (segments.at(-1)?.toLowerCase() === 'applymanually'
      && segments.at(-2)?.toLowerCase() === 'apply') {
      segments = segments.slice(0, -2);
      suffix = 'manual';
    } else if (segments.at(-1)?.toLowerCase() === 'apply') {
      segments = segments.slice(0, -1);
      suffix = 'apply';
    }
    const lowerSegments = segments.map((segment) => segment.toLowerCase());
    const jobIndex = lowerSegments.lastIndexOf('job');
    const detailsIndex = lowerSegments.lastIndexOf('details');
    const routeIndex = Math.max(jobIndex, detailsIndex);
    if (routeIndex < 0 || routeIndex === segments.length - 1) return null;
    const routeKind = routeIndex === detailsIndex ? 'details' : 'job';
    const site = workdaySiteSegments(segments.slice(0, routeIndex));
    const locationAndSlug = segments.slice(routeIndex + 1);
    const requisitionSlug = locationAndSlug.at(-1) || '';
    const validPostingPath = routeKind === 'details'
      ? locationAndSlug.length === 1 && WORKDAY_DETAILS_SLUG_RE.test(requisitionSlug)
      : locationAndSlug.length >= 2 && WORKDAY_REQUISITION_SLUG_RE.test(requisitionSlug);
    if (!site.length || !validPostingPath) return null;
    const basePath = `/${segments.join('/')}`;
    return {
      origin: url.origin,
      site,
      location: routeKind === 'details' ? [] : locationAndSlug.slice(0, -1),
      requisitionSlug,
      suffix,
      basePath,
      search: url.search,
    };
  } catch {
    return null;
  }
}

/** Parse the tenant-scoped login route Workday uses after opening a posting. */
export function workdayLoginRoute(value) {
  try {
    const url = new URL(String(value || ''));
    if (url.protocol !== 'https:' || url.username || url.password || url.hash
      || !WORKDAY_HOST_RE.test(url.hostname)) return null;
    const rawSegments = url.pathname.split('/');
    if (rawSegments[0] !== '') return null;
    let segments = rawSegments.slice(1);
    if (segments.at(-1) === '') segments.pop();
    if (segments.some((segment) => segment === '') || segments.at(-1)?.toLowerCase() !== 'login') return null;
    segments = segments.slice(0, -1);
    segments = workdaySiteSegments(segments);
    if (!segments.length) return null;
    return { origin: url.origin, site: segments };
  } catch {
    return null;
  }
}

function normalizedLocation(parts) {
  const normalized = [];
  for (const part of parts) {
    try {
      const value = decodeURIComponent(part).toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
      if (!value) return null;
      normalized.push(value);
    } catch {
      return null;
    }
  }
  return normalized;
}

export function sameWorkdayJobRoute(first, second) {
  const sameParts = (left, right) => left.length === right.length
    && left.every((part, index) => part === right[index]);
  const firstLocation = first && normalizedLocation(first.location);
  const secondLocation = second && normalizedLocation(second.location);
  const sameLocation = firstLocation?.length === 0 || secondLocation?.length === 0
    || (firstLocation && secondLocation && sameParts(firstLocation, secondLocation));
  return Boolean(first && second && first.origin === second.origin
    && first.requisitionSlug === second.requisitionSlug
    && sameParts(first.site, second.site)
    && sameLocation);
}

function sameWorkdaySite(first, second) {
  return Boolean(first && second && first.origin === second.origin
    && first.site.length === second.site.length
    && first.site.every((part, index) => part === second.site[index]));
}

/** Account pages on a Workday tenant are route-bound to the selected job's site and origin. */
export function isWorkdayTenantAccountRoute(pageUrl, applyUrl) {
  const expected = workdayJobRoute(applyUrl);
  if (!expected) return false;
  try {
    const url = new URL(String(pageUrl || ''));
    if (url.protocol !== 'https:' || url.username || url.password || url.hash
      || !WORKDAY_HOST_RE.test(url.hostname) || url.origin !== expected.origin) return false;
    const rawSegments = url.pathname.split('/');
    if (rawSegments[0] !== '') return false;
    const segments = rawSegments.slice(1);
    if (segments.at(-1) === '') segments.pop();
    if (segments.some((segment) => segment === '') || segments.length < 2) return false;
    const accountRoute = segments.at(-1).toLowerCase();
    const site = workdaySiteSegments(segments.slice(0, -1));
    return WORKDAY_ACCOUNT_ROUTES.has(accountRoute)
      && sameWorkdaySite({ origin: url.origin, site }, expected);
  } catch {
    return false;
  }
}

/** A Workday application route must carry the selected requisition and apply suffix. */
export function isWorkdayApplicationRouteBound(pageUrl, applyUrl) {
  const route = workdayJobRoute(pageUrl);
  return Boolean(route && ['apply', 'manual'].includes(route.suffix)
    && sameWorkdayJobRoute(route, workdayJobRoute(applyUrl)));
}

/** Canonical, single-hop return target after Workday account authentication. */
export function workdayManualApplicationUrl(value) {
  const route = workdayJobRoute(value);
  return route ? `${route.origin}${route.basePath}/apply/applyManually${route.search}` : '';
}

/** Workday application pages stay on the selected requisition or its bound login route. */
export function isWorkdayJobRouteBound(pageUrl, applyUrl) {
  if (!isWorkdayTenantUrl(applyUrl)) return true;
  const expected = workdayJobRoute(applyUrl);
  if (!expected) return false;
  return sameWorkdayJobRoute(workdayJobRoute(pageUrl), expected)
    || sameWorkdaySite(workdayLoginRoute(pageUrl), expected);
}
