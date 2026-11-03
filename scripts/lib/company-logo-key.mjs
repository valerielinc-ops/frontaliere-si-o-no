/**
 * Resolve the key used by the company-logo manifest.
 *
 * Resolve employer-scoped keys for multi-employer sources while preserving
 * municipality scope for the Ticino commune family. SECO/job-room rows carry
 * `companyLogoKey`; this helper also derives the same key for historical rows
 * that predate the field.
 */
import { slugify } from './slugify.mjs';
import {
  TICINO_COMUNI_FAMILY_KEY,
  scopedEmployerKey,
  ticinoComuneEmployerKey,
} from './ticino-comune-employer-identity.mjs';

export const EMPLOYER_SCOPED_LOGO_SOURCE_KEYS = Object.freeze(['seco-jobroom']);

// These source keys are tenant identities, not employer identities. The
// employer domain was verified from the tenant's public employer source, so
// historical rows without companyLogoKey need the same stable logo key as new
// parser output.
export const VERIFIED_EMPLOYER_LOGO_KEY_OVERRIDES = Object.freeze({
  'recruitingapp-2563': 'switch',
});

// `company.sbb.ch` is a shared legacy tenant. Its historical Elvetino rows
// carry `company` as the crawler key, so the tenant alone cannot identify the
// employer. Keep this mapping narrow: both the declared employer and an
// employer-owned domain or the known legacy source context must corroborate
// the logo key. The tenant host is source context, never employer proof.
const LEGACY_EMPLOYER_LOGO_IDENTITIES = Object.freeze({
  company: Object.freeze({
    employerKeys: Object.freeze(['elvetino', 'elvetino-ag']),
    legacyTenantDomains: Object.freeze(['company.sbb.ch']),
    officialDomains: Object.freeze(['elvetino.ch']),
    logoKey: 'elvetino',
  }),
});

const GLOBAL_SANA_LEGACY_KEY = 'ch';
const GLOBAL_SANA_LOGO_KEY = 'global-sana';
const GLOBAL_SANA_NAME_KEY = 'global-sana';
const GLOBAL_SANA_SOURCE_HOST = 'ch.talent.com';
const GLOBAL_SANA_EMPLOYER_HOST = 'globalsana.ch';
const PRADA_LEGACY_KEY = 'prada-group';
const PRADA_LOGO_KEY = 'prada';
const PRADA_NAME_KEY = 'prada-group';
const PRADA_SOURCE_HOST = 'pradagroup.com';

function normalizedHost(value = '') {
  const raw = String(value || '').trim();
  if (!raw) return '';
  try {
    const url = new URL(/^[a-z][a-z\d+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`);
    return url.hostname.toLowerCase().replace(/^www\./, '').replace(/\.$/, '');
  } catch {
    return '';
  }
}

function isGlobalSanaSourceHost(value = '') {
  const host = normalizedHost(value);
  return host === GLOBAL_SANA_SOURCE_HOST || host.endsWith(`.${GLOBAL_SANA_SOURCE_HOST}`);
}

function isPradaGroupSourceHost(value = '') {
  const host = normalizedHost(value);
  return host === PRADA_SOURCE_HOST || host.endsWith(`.${PRADA_SOURCE_HOST}`);
}

/**
 * `ch` is the legacy crawler key for Global Sana, not an employer identity.
 * Resolve it only when the exact employer name and both source-domain fields
 * corroborate the dedicated Global Sana source. A generic `ch` row, a name
 * containing the brand, or a Talent.com URL for another employer stays `ch`.
 */
function isGlobalSanaLogoContext(job = {}) {
  if (String(job?.companyKey || '').trim().toLowerCase() !== GLOBAL_SANA_LEGACY_KEY) return false;
  if (companyLogoKeyFromEmployer(job?.company || job?.employer || '') !== GLOBAL_SANA_NAME_KEY) return false;

  const companyDomain = normalizedHost(job?.companyDomain);
  if (companyDomain !== GLOBAL_SANA_SOURCE_HOST && companyDomain !== GLOBAL_SANA_EMPLOYER_HOST) {
    return false;
  }
  return isGlobalSanaSourceHost(job?.url);
}

/**
 * `prada-group` is a legacy company key from the dedicated Prada Group
 * source, whose canonical crawler/logo key is `prada`. Require the exact
 * employer identity plus both official source-domain fields so an unrelated
 * row cannot inherit the Prada asset from a string-only key match.
 */
function isPradaGroupLogoContext(job = {}) {
  if (String(job?.companyKey || '').trim().toLowerCase() !== PRADA_LEGACY_KEY) return false;
  if (companyLogoKeyFromEmployer(job?.company || job?.employer || '') !== PRADA_NAME_KEY) return false;

  if (!isPradaGroupSourceHost(job?.companyDomain)) return false;
  return isPradaGroupSourceHost(job?.url);
}

export function companyLogoKeyFromEmployer(employer = '') {
  return slugify(employer);
}

function isWithinOfficialDomain(hostname, domain) {
  return hostname === domain || hostname.endsWith(`.${domain}`);
}

function legacyEmployerLogoKey(job = {}, normalizedCompanyKey = '') {
  const identity = LEGACY_EMPLOYER_LOGO_IDENTITIES[normalizedCompanyKey];
  if (!identity) return '';

  const employerKey = companyLogoKeyFromEmployer(job?.company || job?.employer || '');
  if (!identity.employerKeys.includes(employerKey)) return '';

  const knownHosts = [job?.companyDomain, job?.url]
    .map(normalizedHost)
    .filter(Boolean);
  const hasKnownContext = knownHosts.some((hostname) => identity.legacyTenantDomains
    .some((domain) => hostname === domain)
    || identity.officialDomains.some((domain) => isWithinOfficialDomain(hostname, domain)));
  return hasKnownContext ? identity.logoKey : '';
}

export function companyLogoKeyForJob(job = {}) {
  const companyKey = String(job?.companyKey || '').trim();
  const normalizedCompanyKey = companyKey.toLowerCase();
  const isComuneIdentity = normalizedCompanyKey === TICINO_COMUNI_FAMILY_KEY
    || Boolean(ticinoComuneEmployerKey(normalizedCompanyKey));

  // Use municipality scoping only for the family or a canonical Comune key.
  // A stray municipalityKey on another source must not suppress its identity.
  if (isComuneIdentity) {
    return scopedEmployerKey(job);
  }

  if (isGlobalSanaLogoContext(job)) return GLOBAL_SANA_LOGO_KEY;
  if (isPradaGroupLogoContext(job)) return PRADA_LOGO_KEY;

  const explicit = String(job?.companyLogoKey || '').trim();
  const sharedSource = EMPLOYER_SCOPED_LOGO_SOURCE_KEYS.includes(normalizedCompanyKey);

  if (explicit && (!sharedSource || !EMPLOYER_SCOPED_LOGO_SOURCE_KEYS.includes(explicit))) {
    return explicit;
  }
  const verifiedEmployerLogoKey = VERIFIED_EMPLOYER_LOGO_KEY_OVERRIDES[normalizedCompanyKey];
  if (verifiedEmployerLogoKey) return verifiedEmployerLogoKey;
  const contextualLegacyKey = legacyEmployerLogoKey(job, normalizedCompanyKey);
  if (contextualLegacyKey) return contextualLegacyKey;
  if (!sharedSource) return companyKey;
  return companyLogoKeyFromEmployer(job?.company || job?.employer || '');
}
