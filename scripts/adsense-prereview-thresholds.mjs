/**
 * Content threshold shared by the live AdSense pre-review audit and the
 * static manual-slot eligibility guard.
 *
 * Keep this in one place: a page below this word count is classified as thin
 * by the audit, so it must not receive the manual multiplex unit. Auto Ads
 * remain enabled independently.
 */
export const ADSENSE_THIN_WORDS = 140;

/**
 * Minimum visible characters per static `<ins>` slot. This is the same
 * account-safety ratio enforced by the live pre-review audit. The shared
 * static-slot helper uses it before adding the end multiplex, so an indexable
 * page can keep its content and Auto Ads without shipping a manual slot that
 * makes the audit fail.
 */
export const ADSENSE_MIN_CHARS_PER_AD_SLOT = 500;

const STRIP_SCRIPT = /<script[\s\S]*?<\/script>/gi;
const STRIP_STYLE = /<style[\s\S]*?<\/style>/gi;
const STRIP_NOSCRIPT = /<noscript[\s\S]*?<\/noscript>/gi;
const STRIP_SVG = /<svg[\s\S]*?<\/svg>/gi;
const STRIP_TAGS = /<[^>]+>/g;
const COLLAPSE_WHITESPACE = /\s+/g;
const STATIC_AD_INS = /<ins[^>]*\badsbygoogle\b[^>]*>/gi;

/** Match the live audit's visible-text normalization without reading a blob. */
export function normalizeVisibleHtmlText(html = '') {
  return String(html || '')
    .replace(STRIP_SCRIPT, ' ')
    .replace(STRIP_STYLE, ' ')
    .replace(STRIP_NOSCRIPT, ' ')
    .replace(STRIP_SVG, ' ')
    .replace(STRIP_TAGS, ' ')
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(COLLAPSE_WHITESPACE, ' ')
    .trim();
}

export function countVisibleHtmlChars(html = '') {
  return normalizeVisibleHtmlText(html).length;
}

export function countStaticAdSlots(html = '') {
  return String(html || '').match(STATIC_AD_INS)?.length ?? 0;
}

/**
 * Whether adding one more static slot preserves the audit's content/slot
 * ratio. The caller passes the content before the new slot is appended; any
 * existing static slots are included in the denominator.
 */
export function hasEnoughContentForStaticAd(html = '', additionalSlots = 1) {
  const slots = countStaticAdSlots(html) + Math.max(0, additionalSlots);
  return countVisibleHtmlChars(html) >= ADSENSE_MIN_CHARS_PER_AD_SLOT * slots;
}
