const WORKDAY_HOST_RE = /^(?:[a-z0-9-]+\.)+wd\d+\.myworkdayjobs\.com$/i;
const WORKDAY_LOCALE_SEGMENT_RE = /^[a-z]{2}(?:-[a-z]{2})?$/i;
const WORKDAY_REQUISITION_SLUG_RE = /^.+_R-[a-z0-9][a-z0-9-]*$/i;

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
    const jobIndex = segments.map((segment) => segment.toLowerCase()).lastIndexOf('job');
    if (jobIndex < 0 || jobIndex === segments.length - 1) return null;
    const site = segments.slice(0, jobIndex);
    if (WORKDAY_LOCALE_SEGMENT_RE.test(site[0] || '')) site.shift();
    const locationAndSlug = segments.slice(jobIndex + 1);
    const requisitionSlug = locationAndSlug.at(-1) || '';
    if (!site.length || locationAndSlug.length < 2 || !WORKDAY_REQUISITION_SLUG_RE.test(requisitionSlug)) return null;
    const basePath = `/${segments.join('/')}`;
    return {
      origin: url.origin,
      site,
      location: locationAndSlug.slice(0, -1),
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
    if (WORKDAY_LOCALE_SEGMENT_RE.test(segments[0] || '')) segments.shift();
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
  return Boolean(first && second && first.origin === second.origin
    && first.requisitionSlug === second.requisitionSlug
    && sameParts(first.site, second.site)
    && firstLocation && secondLocation && sameParts(firstLocation, secondLocation));
}

function sameWorkdaySite(first, second) {
  return Boolean(first && second && first.origin === second.origin
    && first.site.length === second.site.length
    && first.site.every((part, index) => part === second.site[index]));
}

/** Workday wizard pages must remain on the selected requisition's job route. */
export function isWorkdayJobRouteBound(pageUrl, applyUrl) {
  if (!isWorkdayTenantUrl(applyUrl)) return true;
  const expected = workdayJobRoute(applyUrl);
  if (!expected) return false;
  return sameWorkdayJobRoute(workdayJobRoute(pageUrl), expected)
    || sameWorkdaySite(workdayLoginRoute(pageUrl), expected);
}
