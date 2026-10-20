import { normalizeCompanyName } from './coverage.mjs';
import { normalizeHost, registrableDomain } from './registrable.mjs';

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

function hostMatchesTenant(host, tenantHost) {
  if (!host || !tenantHost) return false;
  const expected = normalizeHost(tenantHost);
  return Boolean(expected && (host === expected || host.endsWith(`.${expected}`)));
}

/**
 * Compare page-level employer identity to the discovered source identity.
 * A structured mismatch is explicit triage evidence; absent evidence remains
 * unknown and cannot satisfy the promotion gate by itself.
 *
 * @param {{ company?: string }} detail
 * @param {string} observedUrl
 * @param {Record<string, any>} spec
 * @param {{ name?: string, domain?: string, tenantHost?: string }} [expected]
 * @returns {{ status: 'match'|'mismatch'|'unknown', evidence: string, expectedName: string, observedName: string, observedHost: string }}
 */
export function checkEmployerIdentity(detail = {}, observedUrl = '', spec = {}, expected = {}) {
  const expectedName = String(expected.name || spec.companyName || '').trim();
  const observedName = String(detail.company || '').trim();
  let observedHost = '';
  try { observedHost = normalizeHost(new URL(observedUrl).hostname); } catch { /* no URL host proof */ }

  if (observedName) {
    const similarity = nameSimilarity(observedName, expectedName);
    if (similarity >= 0.8) {
      return { status: 'match', evidence: 'structured_name', expectedName, observedName, observedHost };
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
  if (hostMatchesTenant(observedHost, tenantHost)) {
    return { status: 'match', evidence: 'tenant_host', expectedName, observedName, observedHost };
  }

  return { status: 'unknown', evidence: 'identity_unavailable', expectedName, observedName, observedHost };
}
