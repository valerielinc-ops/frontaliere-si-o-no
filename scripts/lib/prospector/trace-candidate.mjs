import { resolveDomain as defaultResolveDomain } from './domain-resolve.mjs';
import { isRetryableTraceStatus, traceCareers as defaultTraceCareers, traceFromCareersUrl as defaultTraceFromCareersUrl } from './careers-trail.mjs';
import { registrableDomain } from './registrable.mjs';

/**
 * Trace one candidate, preferring a supplied careers URL over guessing an
 * employer domain. A URL without an independently known employer domain is
 * still fetched, but its host is not promoted to an employer identity here.
 *
 * @param {Record<string, any>} candidate
 * @param {{ resolveDomain?: typeof defaultResolveDomain, traceCareers?: typeof defaultTraceCareers, traceFromCareersUrl?: (careersUrl: string, employerDomain: string|null) => ReturnType<typeof defaultTraceFromCareersUrl> }} [deps]
 * @returns {Promise<Record<string, any>>}
 */
export async function traceCandidate(candidate, deps = {}) {
  const resolve = deps.resolveDomain || defaultResolveDomain;
  const trace = deps.traceCareers || defaultTraceCareers;
  const traceFromUrl = deps.traceFromCareersUrl || defaultTraceFromCareersUrl;

  let domain = candidate.domain ? registrableDomain(candidate.domain) : null;
  let resolution = null;
  if (!domain && !candidate.careersUrl) {
    resolution = await resolve({ name: candidate.name, city: candidate.city, zip: candidate.zip });
    domain = resolution.domain;
  }
  if (!domain && !candidate.careersUrl) {
    return {
      c: candidate,
      verdict: 'retry',
      reason: resolution?.retryable ? 'dominio temporaneamente non verificabile' : 'dominio non risolto',
      resolution,
    };
  }

  // `traceFromCareersUrl` uses the supplied employer domain only as contextual
  // metadata; null is valid when the page is a direct observation without a
  // separately verified employer domain.
  const trail = candidate.careersUrl
    ? await traceFromUrl(candidate.careersUrl, domain)
    : await trace(domain);
  if (!trail.reachable) {
    const retryable = typeof trail.retryable === 'boolean'
      ? trail.retryable
      : (trail.failureStatuses || []).some(isRetryableTraceStatus);
    return {
      c: candidate,
      domain,
      verdict: retryable ? 'retry' : 'dead',
      reason: 'sito irraggiungibile',
      resolution,
      trail,
    };
  }
  if (!trail.externalHosts?.length && trail.retryable
    && trail.rejectedHosts?.some((host) => host.retryable)) {
    return {
      c: candidate,
      domain,
      verdict: 'retry',
      reason: 'verifica ATS temporaneamente non riuscita',
      resolution,
      trail,
    };
  }
  if (!trail.careersUrls.length && !trail.externalHosts.length) {
    return {
      c: candidate,
      domain,
      verdict: trail.retryable ? 'retry' : 'dead',
      reason: 'nessuna pagina carriere',
      resolution,
      trail,
    };
  }

  // A direct careers URL can be hosted by an ATS or job board. Reaching it is
  // useful evidence, but its host alone does not identify the employer. Resolve
  // the employer independently before allowing the candidate into SYNTHESIZE
  // or attributing any outbound host to it.
  if (!domain && candidate.careersUrl) {
    resolution = await resolve({ name: candidate.name, city: candidate.city, zip: candidate.zip });
    domain = resolution?.domain ? registrableDomain(resolution.domain) : null;
  }
  if (!domain) {
    return {
      c: candidate,
      domain: null,
      verdict: 'retry',
      reason: resolution?.retryable ? 'dominio temporaneamente non verificabile' : 'dominio non risolto',
      resolution,
      trail,
    };
  }

  // The trail helper can only call a direct URL self-hosted when its origin is
  // the independently resolved employer domain. A career page on another
  // origin with no ATS outlink has unknown ownership, not proof of self-hosting.
  const blockedAtsVerification = trail.rejectedHosts?.some((host) => host.blockedByRobots || host.policyBlocked);
  let selfHosted = blockedAtsVerification && !trail.externalHosts.length ? null : trail.selfHosted;
  if (candidate.careersUrl && !trail.externalHosts.length && !blockedAtsVerification) {
    try {
      const resolvedCareersUrl = trail.careersUrls?.[0] || candidate.careersUrl;
      selfHosted = registrableDomain(new URL(resolvedCareersUrl).hostname) === domain
        ? true
        : null;
    } catch {
      selfHosted = null;
    }
  }
  return { c: candidate, domain, verdict: 'traced', trail, resolution, selfHosted };
}

/**
 * Return only outlinks attributable to a known employer identity.
 *
 * @param {{ domain?: string|null, trail?: { externalHosts?: unknown[] } }} result
 * @returns {unknown[]}
 */
export function attributableTraceHosts(result) {
  return result.domain ? (result.trail?.externalHosts || []) : [];
}
