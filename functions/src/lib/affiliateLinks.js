/**
 * affiliateLinks.js — canonical, PII-free affiliate link attribution.
 *
 * The web app and email renderers share the same /go/ destination, but their
 * callers run in different module graphs. Keeping the safe token and URL
 * composition here prevents a surface from silently losing the Partnerize
 * `pubref` dimensions or attaching subscriber credentials to a paid click.
 */

import { getEnabledPartner, goPathFromId } from './affiliatePartnersRegistry.js';

const BASE_URL = 'https://frontaliereticino.ch';

/** Keep the network-facing reference to the documented-safe alphanumeric/hyphen alphabet. */
export const PUBREF_INVALID_RE = /[^a-z0-9-]+/g;
/** UTM identifiers keep the existing underscore-compatible campaign contract. */
const TOKEN_INVALID_RE = /[^a-z0-9_-]+/g;
/** Network-facing publisher-reference cap; keep it explicit and observable. */
export const PUBREF_MAX_LEN = 48;
export const PUBREF_HASH_LEN = 7;
export const PUBREF_HASH_SEED = 0x811c9dc5;
export const PUBREF_HASH_MULTIPLIER = 0x01000193;

const SENSITIVE_ATTRIBUTION_RE = /@|%40|(?:^|[-_])(email|token|auth|secret|password|phone|uid|user)(?:$|[-_])/i;

function normaliseAffiliateToken(raw, invalidRe) {
  const value = String(raw ?? '').trim();
  if (!value || SENSITIVE_ATTRIBUTION_RE.test(value)) return '';
  return value
    .toLowerCase()
    .replace(invalidRe, '-')
    .replace(/^-+|-+$/g, '');
}

function capAffiliateToken(normalized, hashSeparator) {
  if (normalized.length <= PUBREF_MAX_LEN) return normalized;

  let hash = PUBREF_HASH_SEED;
  for (let index = 0; index < normalized.length; index += 1) {
    hash = Math.imul(hash ^ normalized.charCodeAt(index), PUBREF_HASH_MULTIPLIER);
  }
  const suffix = `${hashSeparator}${(hash >>> 0).toString(36).padStart(PUBREF_HASH_LEN, '0')}`;
  const prefix = normalized
    .slice(0, PUBREF_MAX_LEN - suffix.length)
    .replace(/[-_]+$/, '');
  return `${prefix}${suffix}`;
}

/**
 * Convert an attribution identifier to the network-safe alphabet.
 *
 * Attribution inputs are identifiers chosen by the product, never recipient
 * data. If a caller accidentally hands us an email/token-like value, omit it
 * instead of laundering it into a plausible-looking slug.
 */
export function safeAffiliateToken(raw, fallback = '') {
  const normalized = normaliseAffiliateToken(raw, TOKEN_INVALID_RE);
  return normalized ? capAffiliateToken(normalized, '_') : fallback;
}

/** Normalise one Partnerize publisher reference. */
export function sanitizeAffiliatePubref(raw) {
  const normalized = normaliseAffiliateToken(raw, PUBREF_INVALID_RE);
  return normalized ? capAffiliateToken(normalized, '-') : '';
}

/**
 * Build the dimensions that reach Partnerize as `pubref`.
 *
 * All five dimensions are bounded, categorical identifiers. No email,
 * autologin code, token, or user identifier is accepted by safeAffiliateToken.
 * @param {{ partnerId?: string, surface?: string, position?: string,
 *   campaign?: string, variant?: string }} [args]
 * @returns {string}
 */
export function buildAffiliatePubref({ partnerId, surface, position, campaign, variant = '' } = {}) {
  return sanitizeAffiliatePubref([
    partnerId,
    variant,
    surface,
    position,
    campaign,
  ].map((value) => safeAffiliateToken(value)).filter(Boolean).join('-'));
}

/**
 * Build the canonical site redirect URL for a partner click.
 *
 * `placement` is an escape hatch for existing email contracts whose `pos`
 * shape is already observed in the Partnerize dashboard. New surfaces should
 * omit it and provide all five dimensions instead.
 *
 * @param {{ partnerId: string, surface: string, position: string,
 *   campaign: string, variant?: string, placement?: string,
 *   acquisitionSource?: string|null, source?: string, medium?: string }} args
 * @returns {string}
 */
export function buildAffiliateHref({
  partnerId,
  surface,
  position,
  campaign,
  variant = 'control',
  placement,
  acquisitionSource = null,
  source = 'frontaliereticino',
  medium,
} = {}) {
  if (!getEnabledPartner(partnerId)) return '#';

  const safeSurface = safeAffiliateToken(surface, 'web');
  const safePosition = safeAffiliateToken(position, 'unknown');
  const safeCampaign = safeAffiliateToken(campaign, 'affiliate');
  const safeVariant = safeAffiliateToken(variant, 'control');
  const safePartnerId = safeAffiliateToken(partnerId, 'unknown');
  const pubref = sanitizeAffiliatePubref(placement || buildAffiliatePubref({
    partnerId: safePartnerId,
    surface: safeSurface,
    position: safePosition,
    campaign: safeCampaign,
    variant: safeVariant,
  }));

  const url = new URL(`${BASE_URL}${goPathFromId(partnerId)}`);
  if (pubref) url.searchParams.set('pos', pubref);
  url.searchParams.set('utm_source', safeAffiliateToken(source, 'frontaliereticino'));
  url.searchParams.set('utm_medium', safeAffiliateToken(medium, safeSurface === 'newsletter' ? 'email' : 'web'));
  url.searchParams.set('utm_campaign', safeCampaign);
  url.searchParams.set('utm_content', safeAffiliateToken(`${safePosition}-${safeVariant}-${safePartnerId}`, 'affiliate'));
  const safeAcquisitionSource = safeAffiliateToken(acquisitionSource);
  if (safeAcquisitionSource) url.searchParams.set('as', safeAcquisitionSource);
  return url.toString();
}
