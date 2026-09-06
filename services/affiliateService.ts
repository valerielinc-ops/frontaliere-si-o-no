/**
 * Affiliate & Partner Service
 * 
 * Manages contextual affiliate recommendations for each comparator section.
 * Links are designed to feel like natural "recommended tools" rather than ads.
 * 
 * Revenue model:
 * - Affiliate signups (Wise, Fineco, Crédit Agricole, N26, etc.)
 * - Partner referrals (insurance brokers, tax consultants)
 * - Contextual recommendations based on active comparator
 * 
 * Active partner referral programs: canonical referral URLs live in
 * services/exchangePartners.ts (ONE definition — AGENTS.md #6); Wise: Partnerize
 * affiliate deeplink, NO signup bonus for the user · Fineco: codice AA8381747, bonus 50€ ·
 * Crédit Agricole: buono Amazon 50€.
 */

import {
  PARTNERS_REGISTRY,
  goPathFromId,
  isGoIdEnabled as isGoIdEnabledRegistry,
} from './affiliatePartnersRegistry.mjs';

export type ComparatorContext =
 | 'exchange'
 | 'mobile'
 | 'transport'
 | 'health'
 | 'banks'
 | 'traffic'
 | 'jobs'
 | 'shopping'
 | 'cost-of-living'
 | 'ral'
 | 'parental-leave'
 | 'pension'
 | 'simulator';

export interface AffiliatePartner {
 id: string;
 name: string;
 /** Short tagline that sounds like a tip, not an ad */
 taglineKey: string;
 /** Why it's useful for frontalieri */
 descriptionKey: string;
 url: string;
 /** Optional badge text, e.g. "Consigliato", "Più usato" */
 badgeKey?: string;
 /** Tailwind gradient for subtle branding */
 color: string;
 /** Emoji or icon hint */
 emoji: string;
 /** Which comparator sections this partner is relevant for */
 contexts: ComparatorContext[];
 /** Priority for ordering (higher = shown first) */
 priority: number;
 /**
  * Config-driven activation gate. Disabled partners stay in the registry
  * (structure ready, owner signs the program → flip to `true`, optionally
  * swapping `url` with the signed affiliate deep-link) but are excluded
  * from every surface (cards, /go/ redirect pages, SSG partner blocks).
  * With zero enabled partners for a context the surface renders nothing.
  */
 enabled: boolean;
 /**
  * True when the link is a paid/referral program → rendered with
  * rel="sponsored". False for non-paid institutional links (e.g. the
  * official FOPH premium comparator) which must NOT claim sponsorship.
  */
 sponsored: boolean;
}

/**
 * Partner/Affiliate database — the records live in
 * affiliatePartnersRegistry.mjs (single source, shared with the Node newsletter
 * senders). Re-exported here with the AffiliatePartner type applied.
 */
export const PARTNERS: AffiliatePartner[] = PARTNERS_REGISTRY as unknown as AffiliatePartner[];


/**
 * Get partners relevant to a specific comparator context.
 * Only enabled partners are returned (disabled entries are dormant config).
 * Returns sorted by priority (highest first), max 2 by default.
 */
export function getPartnersForContext(context: ComparatorContext, maxResults = 2): AffiliatePartner[] {
 return PARTNERS
 .filter(p => p.enabled && p.contexts.includes(context))
 .sort((a, b) => b.priority - a.priority)
 .slice(0, maxResults);
}

/**
 * Get all unique enabled partners for the "Servizi Partner" overview page/section.
 */
export function getAllPartners(): AffiliatePartner[] {
 return PARTNERS.filter(p => p.enabled).sort((a, b) => b.priority - a.priority);
}

/**
 * Site-relative path of the static /go/{partner}/ redirect page emitted by
 * build-plugins/affiliateRedirectPlugin.ts. Every partner click MUST route
 * through this page (uniform edge tracking) instead of linking the partner
 * URL directly. Trailing slash by construction (site-wide canonical rule).
 */
export function buildGoPath(partner: Pick<AffiliatePartner, 'id'>): string {
  return goPathFromId(partner.id);
}

/**
 * Resolve the href for a component-local goId against the PARTNERS registry:
 * the /go/{id}/ page only exists for partners with enabled:true (see
 * build-plugins/affiliateRedirectPlugin.ts), so a disabled/unknown id must
 * fall back to the direct URL instead of linking a 404.
 */
export function resolveGoHref(goId: string | undefined, fallback: string | undefined): string {
 if (isGoIdEnabledRegistry(goId)) return buildGoPath({ id: goId });
 return fallback || '#';
}

/** True when the /go/{id}/ redirect page exists (partner enabled). */
export function isGoIdEnabled(goId: string | undefined): boolean {
  return isGoIdEnabledRegistry(goId);
}

/**
 * rel attribute for a partner link: paid/referral programs must carry
 * rel="sponsored"; non-paid institutional links must not.
 */
export function partnerRelAttr(partner: Pick<AffiliatePartner, 'sponsored'>): string {
 return partner.sponsored ? 'noopener noreferrer sponsored' : 'noopener noreferrer';
}

/**
 * Characters a Partnerize `pubref` may NOT contain. The value travels through
 * the `prf.hn` redirect and lands verbatim in the dashboard reports, so it is
 * normalised to a lowercase slug — anything else is collapsed to `-`.
 * Exported because the /go/ redirect page has to apply the same rule inline in
 * the browser (build-plugins/affiliateRedirectPlugin.ts): one definition.
 */
export const PUBREF_INVALID_RE = /[^a-z0-9_-]+/g;
/** Partnerize truncates long publisher references; keep them short by design. */
export const PUBREF_MAX_LEN = 48;

/** True for Partnerize tracking deeplinks (the paid destination is the redirect). */
export function isPartnerizeUrl(url: string): boolean {
 return url.includes('prf.hn');
}

/** Normalise an arbitrary placement label into a Partnerize-safe `pubref`. */
export function sanitizePubref(raw: string): string {
 return String(raw ?? '')
 .toLowerCase()
 .replace(PUBREF_INVALID_RE, '-')
 .replace(/^-+|-+$/g, '')
 .slice(0, PUBREF_MAX_LEN)
 .replace(/-+$/, '');
}

/**
 * Build the full affiliate URL with optional tracking params.
 *
 * `placement` identifies WHICH slot produced the click (newsletter row 2,
 * article body, comparator card…). On Partnerize deeplinks it becomes the
 * `pubref` parameter — the only per-position signal the dashboard reports on,
 * without which every surface collapses into one undifferentiated click count.
 * UTMs stay off those links: extra query params would rewrite the paid
 * destination, while `pubref` is the parameter Partnerize itself expects.
 */
export function buildAffiliateUrl(
 partner: AffiliatePartner,
 source: string,
 placement?: string,
): string {
 try {
 const url = new URL(partner.url);
 if (isPartnerizeUrl(partner.url)) {
 const pubref = sanitizePubref(placement || source);
 if (pubref) url.searchParams.set('pubref', pubref);
 return url.toString();
 }
 // Add UTM tracking only to regular URLs (not invite/referral links —
 // extra query params rewrite the paid destination).
 if (!partner.url.includes('invite') && !partner.url.includes('referral')) {
 url.searchParams.set('utm_source', 'frontaliereticino');
 url.searchParams.set('utm_medium', 'partner');
 url.searchParams.set('utm_campaign', source);
 }
 return url.toString();
 } catch {
 return partner.url;
 }
}
