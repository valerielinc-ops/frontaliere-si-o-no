/**
 * affiliatePartnersRegistry.mjs — SINGLE SOURCE of the affiliate/partner records.
 *
 * Plain ESM (no TS types) so it loads in BOTH runtimes without a bundler:
 *  - the React app / build plugins / tests, via services/affiliateService.ts,
 *    which re-exports PARTNERS_REGISTRY as the typed `PARTNERS` (AGENTS.md
 *    Non-Negotiable #6: one copy, no drift);
 *  - the Node newsletter/drip senders (services/newsletter-template.mjs,
 *    services/newsletter/recommendedBlock.mjs, scripts/send-onboarding-drip.mjs),
 *    which cannot import the .ts service, so they read the enabled/sponsored
 *    gate straight from here.
 *
 * The gate that MUST NOT drift — `enabled`, `sponsored`, and the /go/{id}/
 * redirect path — lives here once. Email presentation copy is separate
 * (services/newsletter/recommendedBlock.mjs) and is email-specific, not a
 * duplicate of this registry.
 *
 * Referral URLs are NOT re-typed here — they come from the single source
 * services/exchangePartners.mjs (AGENTS.md #6: a referral code rotates once,
 * everywhere), same as the SPA comparator + static SSG pages.
 */

import {
  WISE_REFERRAL_URL,
  FINECO_REFERRAL_URL,
  CREDIT_AGRICOLE_IT_REFERRAL_URL,
  REVOLUT_REFERRAL_URL,
  CAMBIAVALUTE_REFERRAL_URL,
} from './exchangePartners.mjs';

export const PARTNERS_REGISTRY = [
 // ─── Currency Exchange ───
 {
 id: 'wise',
 name: 'Wise',
 taglineKey: 'affiliate.wise.tagline',
 descriptionKey: 'affiliate.wise.description',
 url: WISE_REFERRAL_URL,
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
 url: FINECO_REFERRAL_URL,
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
 url: CREDIT_AGRICOLE_IT_REFERRAL_URL,
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
 url: REVOLUT_REFERRAL_URL,
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
 url: CAMBIAVALUTE_REFERRAL_URL,
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
 },];

/** Site-relative /go/{id}/ redirect path (trailing slash by construction). */
export function goPathFromId(id) {
  return `/go/${id}/`;
}

/**
 * True when the /go/{id}/ redirect page exists — i.e. the partner is enabled.
 * (The page is only emitted for enabled partners by
 * build-plugins/affiliateRedirectPlugin.ts, so a disabled/unknown id 404s.)
 */
export function isGoIdEnabled(goId) {
  return !!goId && PARTNERS_REGISTRY.some((p) => p.id === goId && p.enabled);
}

/** The enabled partner record for a goId, or null. */
export function getEnabledPartner(goId) {
  return (goId && PARTNERS_REGISTRY.find((p) => p.id === goId && p.enabled)) || null;
}
