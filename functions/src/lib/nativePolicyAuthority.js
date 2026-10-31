/** A private server mandate is authority for pure application policy, never a candidate qualification. */
import { ASSISTED_APPLICATION_CONSENT_VERSIONS } from '../assistedApplicationConstants.js';
import { OPERATIONAL_DEFAULTS_VERSION } from '../assistedApplicationOperationalAnswers.js';
export const NATIVE_POLICY_AUTHORITY_VERSION = 'server-application-policy-authority-v1';
const PURPOSES = ['application_consent', 'optional_consent_refusal', 'operational_preference', 'individual_application_origin'];
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const equal = (left, right) => JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));

/** Input is supplied exclusively by the current-order provider, never a proof body. */
export function nativePolicyAuthoritySource(authority) {
  if (!authority || authority.version !== NATIVE_POLICY_AUTHORITY_VERSION || authority.paid !== true
    || typeof authority.orderId !== 'string' || !authority.orderId || !Number.isSafeInteger(authority.round) || authority.round < 1
    || !ASSISTED_APPLICATION_CONSENT_VERSIONS.includes(authority.consentVersion)
    || !Number.isFinite(authority.consentedAt) || authority.consentedAt <= 0 || authority.consentedAt > Date.now()
    || !Array.isArray(authority.scopes) || !authority.scopes.length || new Set(authority.scopes).size !== authority.scopes.length
    || authority.scopes.some(scope => !PURPOSES.includes(scope))
    || authority.operationalPreferencesVersion !== OPERATIONAL_DEFAULTS_VERSION) return null;
  return { policyRecord: { version: authority.version, consentVersion: authority.consentVersion,
    consentedAt: authority.consentedAt, paid: true, scopes: [...authority.scopes].sort(),
    operationalPreferencesVersion: authority.operationalPreferencesVersion },
  policyBinding: { orderId: authority.orderId, round: authority.round } };
}

/** A tag restricts authority selection; only the shared full native classifier can validate it. */
export function nativePolicyAuthorityMatches({ claim, source, scope, classify }) {
  const needed = claim?.policyAuthorityNeeded;
  if (!needed || typeof classify !== 'function' || source?.kind !== 'policy_authority'
    || source.policyBinding?.orderId !== scope?.orderId || source.policyBinding?.round !== scope?.round) return false;
  const classified = classify(claim);
  if (!classified || !equal(needed, classified) || !source.policyRecord?.scopes?.includes(classified.purpose)) return false;
  return nativePolicyAuthoritySource({ ...source.policyRecord, ...source.policyBinding }) !== null;
}
