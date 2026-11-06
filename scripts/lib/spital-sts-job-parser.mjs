#!/usr/bin/env node
/**
 * Spital STS AG (Thun-Simmental) job parser — Prospective.ch tenant 1000717.
 *
 * The public career-center URL is a JavaScript application. Its HTML shell no
 * longer contains the old `job job-N` cards, so discovery must use the
 * tenant's JSON listing feed. The shared Prospective parser also keeps the
 * source-body and location guards in one place with the other Prospective
 * tenants.
 */
import { createProspectiveChParser } from './prospective-ch-job-parser-common.mjs';

export const SPITAL_STS_KEY = 'spital-sts';
export const SPITAL_STS_COMPANY_NAME = 'Spital STS';
export const SPITAL_STS_COMPANY_DOMAIN = 'spitalstsag.ch';

const PROSPECTIVE_TENANT = '1000717';
const PROSPECTIVE_REDIRECT_RE = /^\/public\/v1\/redirect\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/ats\/?$/i;

function isSpitalStsRedirectUrl(rawUrl = '') {
  try {
    const url = new URL(rawUrl);
    return (
      url.protocol === 'https:'
      && url.hostname.toLowerCase() === 'ohws.prospective.ch'
      && PROSPECTIVE_REDIRECT_RE.test(url.pathname)
    );
  } catch {
    return false;
  }
}

function prospectiveRedirectUrl(listing, { directLink = '' } = {}) {
  const viewkey = String(listing?.viewkey || '').trim();
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(viewkey)) {
    return `https://ohws.prospective.ch/public/v1/redirect/${viewkey}/ats/`;
  }
  return directLink;
}

const parser = createProspectiveChParser({
  companyKey: SPITAL_STS_KEY,
  companyName: SPITAL_STS_COMPANY_NAME,
  companyDomain: SPITAL_STS_COMPANY_DOMAIN,
  mediumId: PROSPECTIVE_TENANT,
  apiLang: 'de',
  defaultCanton: 'BE',
  defaultCity: 'Thun',
  defaultPostalCode: '3600',
  publicCareerUrl: 'https://jobs.spitalstsag.ch/',
  defaultSourceLang: 'de',
  // Keep the stable Prospective redirect used by the existing published
  // slice; the UUID survives changes to the employer's detail-page slug.
  sourceUrlFn: prospectiveRedirectUrl,
});

export const fetchAllSpitalStsJobs = parser.fetchAllJobs;
export const isSpitalStsJob = parser.isCompanyJob;

// The canonical public URL is the tenant-scoped Prospective redirect. The
// shared factory deliberately accepts only tenant-scoped detail/API paths, so
// keep this narrow, UUID-shaped exception at the consumer boundary.
export function isTrustedDomain(rawUrl = '') {
  return isSpitalStsRedirectUrl(rawUrl) || parser.isTrustedDomain(rawUrl);
}
