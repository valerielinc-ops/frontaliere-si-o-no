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

const GLOBAL_SANA_LEGACY_KEY = 'ch';
const GLOBAL_SANA_LOGO_KEY = 'global-sana';
const GLOBAL_SANA_NAME_KEY = 'global-sana';
const GLOBAL_SANA_SOURCE_HOST = 'ch.talent.com';
const GLOBAL_SANA_EMPLOYER_HOST = 'globalsana.ch';

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

export function companyLogoKeyFromEmployer(employer = '') {
  return slugify(employer);
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

  const explicit = String(job?.companyLogoKey || '').trim();
  const sharedSource = EMPLOYER_SCOPED_LOGO_SOURCE_KEYS.includes(normalizedCompanyKey);

  if (explicit && (!sharedSource || !EMPLOYER_SCOPED_LOGO_SOURCE_KEYS.includes(explicit))) {
    return explicit;
  }
  const verifiedEmployerLogoKey = VERIFIED_EMPLOYER_LOGO_KEY_OVERRIDES[normalizedCompanyKey];
  if (verifiedEmployerLogoKey) return verifiedEmployerLogoKey;
  if (!sharedSource) return companyKey;
  return companyLogoKeyFromEmployer(job?.company || job?.employer || '');
}
