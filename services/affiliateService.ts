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
    color: 'from-emerald-500 to-green-600',
    emoji: '💸',
    contexts: ['exchange', 'banks', 'simulator'],
    priority: 10,
  },

  // ─── Banking ───
  {
    id: 'fineco',
    name: 'Fineco Bank',
    taglineKey: 'affiliate.fineco.tagline',
    descriptionKey: 'affiliate.fineco.description',
    url: 'https://fineco.mobi/passaparola',
    badgeKey: 'affiliate.badge.recommended',
    color: 'from-sky-500 to-blue-600',
    emoji: '🇮🇹',
    contexts: ['banks', 'exchange', 'simulator'],
    priority: 9,
  },
  {
    id: 'creditagricole',
    name: 'Crédit Agricole',
    taglineKey: 'affiliate.creditagricole.tagline',
    descriptionKey: 'affiliate.creditagricole.description',
    url: 'https://www.credit-agricole.it/invito?mgm=LUIGSAGG112A',
    badgeKey: 'affiliate.badge.recommended',
    color: 'from-green-600 to-blue-700',
    emoji: '🏦',
    contexts: ['banks', 'exchange'],
    priority: 8,
  },
  {
    id: 'n26',
    name: 'N26',
    taglineKey: 'affiliate.n26.tagline',
    descriptionKey: 'affiliate.n26.description',
    url: 'https://n26.com/r/',
    color: 'from-blue-500 to-blue-600',
    emoji: '💳',
    contexts: ['banks', 'exchange'],
    priority: 7,
  },
  {
    id: 'yuh',
    name: 'Yuh',
    taglineKey: 'affiliate.yuh.tagline',
    descriptionKey: 'affiliate.yuh.description',
    url: 'https://www.yuh.com/',
    color: 'from-fuchsia-500 to-orange-600',
    emoji: '🇨🇭',
    contexts: ['banks', 'exchange', 'pension'],
    priority: 6,
  },

  // ─── Pension / Investing ───
  {
    id: 'traderepublic',
    name: 'Trade Republic',
    taglineKey: 'affiliate.traderepublic.tagline',
    descriptionKey: 'affiliate.traderepublic.description',
    url: 'https://traderepublic.com/referral/',
    color: 'from-slate-700 to-slate-900',
    emoji: '📈',
    contexts: ['pension', 'cost-of-living'],
    priority: 5,
  },

  // ─── Transport ───
  {
    id: 'tilo',
    name: 'TILO / FFS',
    taglineKey: 'affiliate.tilo.tagline',
    descriptionKey: 'affiliate.tilo.description',
    url: 'https://www.sbb.ch/it',
    color: 'from-red-500 to-red-700',
    emoji: '🚆',
    contexts: ['transport', 'traffic'],
    priority: 4,
  },

  // ─── Mobile ───
  {
    id: 'fastweb',
    name: 'Fastweb Mobile',
    taglineKey: 'affiliate.fastweb.tagline',
    descriptionKey: 'affiliate.fastweb.description',
    url: 'https://www.fastweb.it/porta-un-amico/?code=TOPZR3FBEYGDMEUXYYA',
    color: 'from-yellow-500 to-orange-600',
    emoji: '📱',
    contexts: ['mobile'],
    priority: 5,
  },
];

/**
 * Get partners relevant to a specific comparator context.
 * Returns sorted by priority (highest first), max 2 by default.
 */
export function getPartnersForContext(context: ComparatorContext, maxResults = 2): AffiliatePartner[] {
  return PARTNERS
    .filter(p => p.contexts.includes(context))
    .sort((a, b) => b.priority - a.priority)
    .slice(0, maxResults);
}

/**
 * Get all unique partners for the "Servizi Partner" overview page/section.
 */
export function getAllPartners(): AffiliatePartner[] {
  return PARTNERS.sort((a, b) => b.priority - a.priority);
}

/**
 * Build the full affiliate URL with optional tracking params.
 */
export function buildAffiliateUrl(partner: AffiliatePartner, source: string): string {
  const url = new URL(partner.url);
  // Add UTM tracking if the URL supports query params
  if (!partner.url.includes('invite') && !partner.url.includes('referral')) {
    url.searchParams.set('utm_source', 'frontaliereticino');
    url.searchParams.set('utm_medium', 'partner');
    url.searchParams.set('utm_campaign', source);
  }
  return url.toString();
}
