const BRASSRING_ORIGIN = 'https://jobs.ubs.com';

export const BRASSRING_HOME_WITH_PRELOAD_RE = /^\/tgnewui\/search\/home\/homewithpreload\/?$/i;

/** BrassRing may canonicalize siteid, parameter case, and query order. */
function brassRingQueryParams(url) {
  const params = new Map();
  const duplicateIdentityKeys = new Set();
  for (const [key, value] of url.searchParams.entries()) {
    const normalizedKey = String(key || '').toLowerCase();
    if (params.has(normalizedKey)) {
      if (normalizedKey === 'jobid' || normalizedKey === 'partnerid') duplicateIdentityKeys.add(normalizedKey);
      continue;
    }
    const normalizedValue = String(value || '').trim();
    params.set(normalizedKey, normalizedKey === 'jobid' || normalizedKey === 'partnerid'
      ? normalizedValue
      : normalizedValue.toLowerCase());
  }
  return { params, duplicateIdentityKeys };
}

/**
 * Compare two UBS BrassRing posting addresses without treating a different
 * requisition as the same page. This is shared by entry and stage guards so a
 * route accepted before a SPA transition cannot be widened by a second copy.
 */
export function sameBrassRingPostingAddress(firstUrl, secondUrl) {
  try {
    const first = new URL(String(firstUrl || ''));
    const second = new URL(String(secondUrl || ''));
    if (first.protocol !== 'https:' || second.protocol !== 'https:'
      || first.origin !== BRASSRING_ORIGIN || second.origin !== first.origin
      || first.username || first.password || second.username || second.password
      || !BRASSRING_HOME_WITH_PRELOAD_RE.test(first.pathname)
      || !BRASSRING_HOME_WITH_PRELOAD_RE.test(second.pathname)
      || first.pathname.replace(/\/+$/u, '').toLowerCase() !== second.pathname.replace(/\/+$/u, '').toLowerCase()) {
      return false;
    }
    const firstQuery = brassRingQueryParams(first);
    const secondQuery = brassRingQueryParams(second);
    if (firstQuery.duplicateIdentityKeys.size || secondQuery.duplicateIdentityKeys.size) return false;
    const firstParams = firstQuery.params;
    const secondParams = secondQuery.params;
    const firstJobId = firstParams.get('jobid') || '';
    const secondJobId = secondParams.get('jobid') || '';
    if (!firstJobId || firstJobId !== secondJobId) return false;
    const firstPartner = firstParams.get('partnerid') || '';
    const secondPartner = secondParams.get('partnerid') || '';
    if ((firstPartner || secondPartner) && firstPartner !== secondPartner) return false;
    const firstType = firstParams.get('pagetype') || 'jobdetails';
    const secondType = secondParams.get('pagetype') || 'jobdetails';
    return firstType === 'jobdetails' && secondType === 'jobdetails';
  } catch {
    return false;
  }
}
