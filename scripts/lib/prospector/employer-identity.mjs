import { normalizeCompanyName } from './coverage.mjs';
import { normalizeHost, registrableDomain } from './registrable.mjs';
import { loadRegistry, tenantIsInPath, verifiedEmployerDomain } from './platform-registry.mjs';

let platformRegistry;

function nameSimilarity(left, right) {
  const a = normalizeCompanyName(left).split(' ').filter((token) => token.length > 1);
  const b = normalizeCompanyName(right).split(' ').filter((token) => token.length > 1);
  if (!a.length || !b.length) return 0;
  const rightSet = new Set(b);
  const shared = a.filter((token) => rightSet.has(token)).length;
  return shared / Math.max(a.length, b.length);
}

function domainMatches(host, expected) {
  if (!host || !expected) return false;
  try {
    return registrableDomain(host) === registrableDomain(expected);
  } catch {
    return false;
  }
}

function parseUrl(raw) {
  const value = String(raw || '').trim();
  if (!value) return null;
  try {
    return new URL(value.startsWith('//') ? `https:${value}`
      : value.includes('://') ? value : `https://${value}`);
  } catch {
    return null;
  }
}

function normalizedPathSegment(value) {
  let pathname = typeof value === 'string' ? value : value?.pathname;
  if (typeof pathname !== 'string') return '';
  if (pathname.includes('://')) pathname = parseUrl(pathname)?.pathname || '';
  const segment = pathname.split(/[?#]/, 1)[0].split('/').filter(Boolean)[0];
  if (!segment) return '';
  let decoded = segment;
  try { decoded = decodeURIComponent(segment); } catch { /* keep malformed escapes stable */ }
  return decoded.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function tenantPathEvidence(host) {
  platformRegistry ||= loadRegistry();
  const platformDomain = registrableDomain(host);
  const platform = platformRegistry.platforms?.[platformDomain];
  if (!platform) return { platform: null, mode: 'unknown' };

  const owners = platform.hostEmployers?.[host];
  const ownerCount = Array.isArray(owners)
    ? new Set(owners.map(verifiedEmployerDomain).filter(Boolean)).size
    : 0;
  const hasExplicitListingPath = Array.isArray(platform.listingPaths)
    && platform.listingPaths.some((path) => normalizedPathSegment(path));
  // A tenant subdomain already identifies the employer; its path is usually a
  // listing/detail route (for example Umantis `/Jobs/All`).
  if ((platform.tenantShape === 'subdomain'
      && (host !== platformDomain || ownerCount === 1))
    || (platform.tenantShape === 'mixed' && ownerCount === 1)) return { platform, mode: 'host' };

  if (tenantIsInPath(platform) || platform.tenantShape === 'shared'
    || (platform.tenantShape === 'mixed' && ownerCount > 1)
    // A mixed host without owner data can use path identity only when the
    // registry explicitly identifies a common route before the tenant slug.
    || (platform.tenantShape === 'mixed' && ownerCount === 0 && hasExplicitListingPath)) {
    return { platform, mode: 'tenant' };
  }
  return { platform, mode: 'unknown' };
}

function isKnownListingPath(platform, segment) {
  const explicitListingPaths = new Set((platform?.listingPaths || []).map(normalizedPathSegment));
  if (explicitListingPaths.has(segment)) return true;

  const pathHits = Object.entries(platform?.pathHits || {});
  if (pathHits.length !== 1 || Number(pathHits[0][1]) < 2) return false;
  return normalizedPathSegment(pathHits[0][0]) === segment;
}

function tenantPathSegment(value, platform) {
  const url = parseUrl(value);
  if (!url) return '';
  const segments = url.pathname.split('/').filter(Boolean).map((segment) => normalizedPathSegment(`/${segment}`));
  let index = 0;
  while (index < segments.length && isKnownListingPath(platform, segments[index])) index++;
  return segments[index] || '';
}

function hostMatchesTenant(observedUrl, tenantHost, expectedTenantUrls = []) {
  if (!observedUrl || !tenantHost) return false;
  const observed = parseUrl(observedUrl);
  const expected = parseUrl(tenantHost);
  if (!observed || !expected) return false;
  const observedHost = normalizeHost(observed.hostname);
  const expectedHost = normalizeHost(expected.hostname);
  if (!expectedHost || !(observedHost === expectedHost || observedHost.endsWith(`.${expectedHost}`))) return false;

  const pathEvidence = tenantPathEvidence(expectedHost);
  if (pathEvidence.mode === 'unknown') return false;
  if (pathEvidence.mode !== 'tenant') return true;
  const expectedPath = [tenantHost, ...expectedTenantUrls]
    .filter((url) => normalizeHost(parseUrl(url)?.hostname || '') === expectedHost)
    .map((url) => tenantPathSegment(url, pathEvidence.platform))
    .find(Boolean);
  if (!expectedPath) return false;
  return observedHost === expectedHost
    && tenantPathSegment(observedUrl, pathEvidence.platform) === expectedPath;
}

/**
 * Compare page-level employer identity to the discovered source identity.
 * A structured mismatch is explicit triage evidence; absent evidence remains
 * unknown and cannot satisfy the promotion gate by itself.
 *
 * @param {{ company?: string }} detail
 * @param {string} observedUrl
 * @param {Record<string, any>} spec
 * @param {{ name?: string, secoName?: string, domain?: string, tenantHost?: string, careersUrl?: string }} [expected]
 * @returns {{ status: 'match'|'mismatch'|'unknown', evidence: string, expectedName: string, observedName: string, observedHost: string }}
 */
export function checkEmployerIdentity(detail = {}, observedUrl = '', spec = {}, expected = {}) {
  const expectedName = String(expected.name || spec.companyName || '').trim();
  const expectedNames = [...new Set([expected.name, expected.secoName, spec.companyName]
    .map((value) => String(value || '').trim())
    .filter(Boolean))];
  const observedName = String(detail.company || '').trim();
  let observedHost = '';
  try { observedHost = normalizeHost(new URL(observedUrl).hostname); } catch { /* no URL host proof */ }

  if (observedName) {
    const matchedName = expectedNames.find((name) => nameSimilarity(observedName, name) >= 0.8);
    if (matchedName) {
      const evidence = matchedName === expected.secoName && matchedName !== expected.name
        ? 'structured_seco_name'
        : 'structured_name';
      return { status: 'match', evidence, expectedName: matchedName, observedName, observedHost };
    }
    return { status: 'mismatch', evidence: 'structured_name_mismatch', expectedName, observedName, observedHost };
  }

  const companyDomains = [expected.domain, spec.companyHost, spec.companyDomain]
    .map((value) => String(value || '').trim())
    .filter(Boolean);
  if (companyDomains.some((domain) => domainMatches(observedHost, domain))) {
    return { status: 'match', evidence: 'company_domain', expectedName, observedName, observedHost };
  }

  const tenantHost = String(expected.tenantHost || spec.tenantHost || '').trim();
  const expectedTenantUrls = [expected.careersUrl, spec.careersUrl, ...(Array.isArray(spec.seedUrls) ? spec.seedUrls : [])]
    .filter((url) => typeof url === 'string' && url.trim());
  if (hostMatchesTenant(observedUrl, tenantHost, expectedTenantUrls)) {
    return { status: 'match', evidence: 'tenant_host', expectedName, observedName, observedHost };
  }

  return { status: 'unknown', evidence: 'identity_unavailable', expectedName, observedName, observedHost };
}
