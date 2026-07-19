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
 * Active partner referral programs:
 * - Wise: https://wise.com/invite/ihpn/luigis147 (free card or zero fees up to CHF 600)
 * - Fineco: https://fineco.mobi/passaparola (codice AA8381747 — bonus 50€)
 * - Crédit Agricole: https://www.credit-agricole.it/invito?mgm=LUIGSAGG112A (buono Amazon 50€)
 */

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
 * Partner/Affiliate database.
 * URLs below are placeholder — replace with actual affiliate tracking links.
 */
export const PARTNERS: AffiliatePartner[] = [
 // ─── Currency Exchange ───
 {
 id: 'wise',
 name: 'Wise',
 taglineKey: 'affiliate.wise.tagline',
 descriptionKey: 'affiliate.wise.description',
 url: 'https://wise.com/invite/ihpn/luigis147',
 badgeKey: 'affiliate.badge.mostUsed',
 color: 'from-success-strong to-success-strong',
 emoji: '💸',
 contexts: ['exchange', 'banks', 'simulator', 'ral', 'shopping', 'jobs'],
 priority: 10,
 enabled: true,
 sponsored: true,
 },

 // ─── Banking ───
 {
 id: 'fineco',
 name: 'Fineco Bank',
 taglineKey: 'affiliate.fineco.tagline',
 descriptionKey: 'affiliate.fineco.description',
 url: 'https://fineco.mobi/passaparola',
 badgeKey: 'affiliate.badge.recommended',
 color: 'from-info-strong to-info-strong',
 emoji: '🇮🇹',
 contexts: ['banks', 'exchange', 'simulator', 'ral', 'jobs'],
 priority: 9,
 enabled: true,
 sponsored: true,
 },
 {
 id: 'creditagricole',
 name: 'Crédit Agricole',
 taglineKey: 'affiliate.creditagricole.tagline',
 descriptionKey: 'affiliate.creditagricole.description',
 url: 'https://www.credit-agricole.it/invito?mgm=LUIGSAGG112A',
 badgeKey: 'affiliate.badge.recommended',
 color: 'from-success-strong to-info-strong-hover',
 emoji: '🏦',
 contexts: ['banks', 'exchange'],
 priority: 8,
 enabled: true,
 sponsored: true,
 },
 {
 id: 'revolut',
 name: 'Revolut',
 taglineKey: 'affiliate.revolut.tagline',
 descriptionKey: 'affiliate.revolut.description',
 url: 'https://revolut.com/referral/?referral-code=luigi4mdv!FEB1-26-AR-H1&geo-redirect',
 color: 'from-accent-strong to-accent-strong-hover',
 emoji: '💱',
 contexts: ['exchange', 'banks'],
 priority: 6,
 enabled: true,
 sponsored: true,
 },
 {
 id: 'cambiavalute',
 name: 'CambiaValute.ch',
 taglineKey: 'affiliate.cambiavalute.tagline',
 descriptionKey: 'affiliate.cambiavalute.description',
 url: 'https://dashboard.cambiavalute.ch/r/28693',
 color: 'from-info-strong to-accent-strong',
 emoji: '🇨🇭',
 contexts: ['exchange'],
 priority: 7,
 enabled: true,
 sponsored: true,
 },
 // ─── Health / LAMal ───
 {
 id: 'priminfo',
 name: 'Priminfo (UFSP)',
 taglineKey: 'affiliate.priminfo.tagline',
 descriptionKey: 'affiliate.priminfo.description',
 url: 'https://www.priminfo.admin.ch/it/praemien',
 badgeKey: 'affiliate.badge.official',
 color: 'from-danger-strong to-danger-strong-hover',
 emoji: '🏥',
 contexts: ['health'],
 priority: 6,
 // Non-paid institutional link (official FOPH comparator): fills the
 // health context with real user value until affiliate programs are
 // signed. NOT sponsored — plain rel, no commission claim.
 enabled: true,
 sponsored: false,
 },
 {
 id: 'comparis',
 name: 'Comparis',
 taglineKey: 'affiliate.comparis.tagline',
 descriptionKey: 'affiliate.comparis.description',
 url: 'https://www.comparis.ch/krankenkassen/default',
 badgeKey: 'affiliate.badge.recommended',
 color: 'from-info-strong to-info-strong',
 emoji: '🔍',
 contexts: ['health'],
 priority: 8,
 // OWNER ACTIVATION: flip `enabled` to true once the affiliate program
 // (free network: Awin/Impact/Partnerize) is signed, replacing `url`
 // with the tracked deep-link. Until then this entry is dormant and no
 // surface renders it.
 enabled: false,
 sponsored: true,
 },
 // ─── Mobile ───
 {
 id: 'fastweb',
 name: 'Fastweb Mobile',
 taglineKey: 'affiliate.fastweb.tagline',
 descriptionKey: 'affiliate.fastweb.description',
 url: 'https://www.fastweb.it/porta-un-amico/?code=TOPZR3FBEYGDMEUXYYA',
 color: 'from-warning to-warning-strong',
 emoji: '📱',
 contexts: ['mobile'],
 priority: 5,
 enabled: true,
 sponsored: true,
 },
];

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
 return `/go/${partner.id}/`;
}

/**
 * Resolve the href for a component-local goId against the PARTNERS registry:
 * the /go/{id}/ page only exists for partners with enabled:true (see
 * build-plugins/affiliateRedirectPlugin.ts), so a disabled/unknown id must
 * fall back to the direct URL instead of linking a 404.
 */
export function resolveGoHref(goId: string | undefined, fallback: string | undefined): string {
 if (goId && PARTNERS.some(p => p.id === goId && p.enabled)) return buildGoPath({ id: goId });
 return fallback || '#';
}

/** True when the /go/{id}/ redirect page exists (partner enabled). */
export function isGoIdEnabled(goId: string | undefined): boolean {
 return !!goId && PARTNERS.some(p => p.id === goId && p.enabled);
}

/**
 * rel attribute for a partner link: paid/referral programs must carry
 * rel="sponsored"; non-paid institutional links must not.
 */
export function partnerRelAttr(partner: Pick<AffiliatePartner, 'sponsored'>): string {
 return partner.sponsored ? 'noopener noreferrer sponsored' : 'noopener noreferrer';
}

/**
 * Build the full affiliate URL with optional tracking params.
 */
export function buildAffiliateUrl(partner: AffiliatePartner, source: string): string {
 try {
 const url = new URL(partner.url);
 // Add UTM tracking only to regular URLs (not invite/referral links that would break)
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
