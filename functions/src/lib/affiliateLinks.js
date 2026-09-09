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

/** Characters Partnerize does not accept in a publisher reference. */
export const PUBREF_INVALID_RE = /[^a-z0-9_-]+/g;
/** Partnerize truncates publisher references; keep the cap explicit. */
export const PUBREF_MAX_LEN = 48;

const SENSITIVE_ATTRIBUTION_RE = /@|%40|(?:^|[-_])(email|token|auth|secret|password|phone|uid|user)(?:$|[-_])/i;

/**
 * Convert an attribution identifier to the network-safe alphabet.
 *
 * Attribution inputs are identifiers chosen by the product, never recipient
 * data. If a caller accidentally hands us an email/token-like value, omit it
 * instead of laundering it into a plausible-looking slug.
 */
export function safeAffiliateToken(raw, fallback = '') {
  const value = String(raw ?? '').trim();
  if (!value || SENSITIVE_ATTRIBUTION_RE.test(value)) return fallback;
  return value
    .toLowerCase()
    .replace(PUBREF_INVALID_RE, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, PUBREF_MAX_LEN)
    .replace(/-+$/, '');
}

/** Normalise one Partnerize publisher reference. */
export function sanitizeAffiliatePubref(raw) {
  return safeAffiliateToken(raw).slice(0, PUBREF_MAX_LEN).replace(/-+$/, '');
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
    surface,
    position,
    campaign,
    variant,
    partnerId,
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
