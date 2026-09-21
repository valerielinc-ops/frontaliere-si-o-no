/**
 * Content threshold shared by the live AdSense pre-review audit and the
 * static manual-slot eligibility guard.
 *
 * Keep this in one place: a page below this word count is classified as thin
 * by the audit, so it must not receive the manual multiplex unit. Auto Ads
 * remain enabled independently.
 */
export const ADSENSE_THIN_WORDS = 140;
