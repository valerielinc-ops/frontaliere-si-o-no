/** AdSense ad-unit registry — single source of truth for slot IDs and layout config.
 *
 * `placeholderMinHeight` reserves layout space before the ad loads, preventing CLS (FRO-385).
 * Heights are sized conservatively above real median ad heights measured in production:
 * - autorelaxed multiplex: 380-450px on mobile → 400px
 * - fluid in-article: ~220px → 220px
 * - auto display: ~250-300px → 280px
 *
 * Pruned 2026-04-20: 14 low-earner slots (30d AdSense report showed €0.00-0.10 each).
 * Auto-ads (Anchor €16.01, In-page €10.42) cover those placements more effectively.
 *
 * Pruned 2026-04-26: 5 desktop-rail / sidebar-2 slots (30d earnings €0.05–0.10 each,
 * RPM €0.11–0.18 — bottom decile). Combined €0.35/30d for ~2.4k inflated ad-requests
 * that depressed coverage globally. Removed: ARTICLE_RAIL_LEFT/RIGHT,
 * AUTHGATE_RAIL_LEFT/RIGHT, JOBDETAIL_SIDEBAR_2 (cannibalized JOBDETAIL_SIDEBAR).
 */

export const AD_CLIENT = 'ca-pub-8628054934855353';

export const AD_SLOTS = {
 /** Blog: mobile in-article native */
 ARTICLE_INLINE_MOBILE: {
 slot: '1982411173',
 format: 'fluid',
 layout: 'in-article',
 fullWidthResponsive: false,
 placeholderMinHeight: 220,
 },
 /** Blog: end-of-article multiplex */
 ARTICLE_END_MULTIPLEX: {
 slot: '5196931137',
 format: 'autorelaxed',
 fullWidthResponsive: false,
 placeholderMinHeight: 400,
 },
 /** Job listing: desktop in-feed native */
 JOBLIST_INFEED_DESKTOP: {
 slot: '9770600968',
 format: 'fluid',
 layoutKey: '-f9+5v+4m-d8+7b',
 fullWidthResponsive: false,
 placeholderMinHeight: 220,
 },
 /** Job listing: mobile in-feed native */
 JOBLIST_INFEED_MOBILE: {
 slot: '6979586981',
 format: 'fluid',
 layoutKey: '-f9+5v+4m-d8+7b',
 fullWidthResponsive: false,
 placeholderMinHeight: 220,
 },
 /** Job listing: end-of-list multiplex */
 JOBLIST_END_MULTIPLEX: {
 slot: '8414202909',
 format: 'autorelaxed',
 fullWidthResponsive: false,
 placeholderMinHeight: 400,
 },
 /** Job detail: desktop sidebar display */
 JOBDETAIL_SIDEBAR: {
 slot: '8164676143',
 format: 'auto',
 fullWidthResponsive: true,
 placeholderMinHeight: 280,
 },
 /** Job detail: end multiplex */
 JOBDETAIL_END_MULTIPLEX: {
 slot: '3205192616',
 format: 'autorelaxed',
 fullWidthResponsive: false,
 placeholderMinHeight: 400,
 },
 /** Homepage: mid-content multiplex (in-page RPM €6.64 vs display €0.20 — 2026-04-20 change) */
 HOMEPAGE_MID_DISPLAY: {
 slot: '2093992129',
 format: 'autorelaxed',
 fullWidthResponsive: false,
 placeholderMinHeight: 400,
 },
 /** Job detail: between related jobs and related articles sections */
 JOBDETAIL_BETWEEN_SECTIONS: {
 slot: '7767335647',
 format: 'autorelaxed',
 fullWidthResponsive: false,
 placeholderMinHeight: 400,
 },
 /** Job detail: auth gate — shown below sign-in form for unauthenticated users */
 JOBDETAIL_AUTH_GATE: {
 slot: '3205029282',
 format: 'auto',
 fullWidthResponsive: true,
 placeholderMinHeight: 280,
 },
 /** Job detail: auth gate — end multiplex below content */
 AUTHGATE_END_MULTIPLEX: {
 slot: '5826714385',
 format: 'autorelaxed',
 fullWidthResponsive: false,
 placeholderMinHeight: 400,
 },
 /** Article: 2nd inline-mobile ad (position 2 in the scalable placer). */
 ARTICLE_INLINE_MOBILE_2: {
 slot: '6483829128',
 format: 'fluid',
 layout: 'in-article',
 fullWidthResponsive: false,
 placeholderMinHeight: 220,
 },
 /** Article: 3rd inline-mobile ad (position 3 in the scalable placer).
  *  AdSense unit: FT_ARTICLE_INLINE_MOBILE_3_INARTICLE (created 2026-05-18). */
 ARTICLE_INLINE_MOBILE_3: {
 slot: '1120754984',
 format: 'fluid',
 layout: 'in-article',
 fullWidthResponsive: false,
 placeholderMinHeight: 220,
 },
 /** Article: 4th inline-mobile ad (position 4 in the scalable placer).
  *  AdSense unit: FT_ARTICLE_INLINE_MOBILE_4_INARTICLE (created 2026-05-18). */
 ARTICLE_INLINE_MOBILE_4: {
 slot: '3084573347',
 format: 'fluid',
 layout: 'in-article',
 fullWidthResponsive: false,
 placeholderMinHeight: 220,
 },
 /** Article: 5th inline-mobile ad (position 5 in the scalable placer).
  *  AdSense unit: FT_ARTICLE_INLINE_MOBILE_5_INARTICLE (created 2026-05-18). */
 ARTICLE_INLINE_MOBILE_5: {
 slot: '4692185947',
 format: 'fluid',
 layout: 'in-article',
 fullWidthResponsive: false,
 placeholderMinHeight: 220,
 },
 /** Calculator: in-page multiplex after simulation_complete (high-intent moment) */
 CALCULATOR_POST_RESULT: {
 slot: '5196931137', // reuses ARTICLE_END_MULTIPLEX id (cross-context multiplex)
 format: 'autorelaxed',
 fullWidthResponsive: false,
 placeholderMinHeight: 400,
 },
} as const;

/** Returns true when an ad-unit's slot id is still a `TBD-` placeholder.
 *  Callers MUST check this before rendering an `<ins data-ad-slot="…">` —
 *  shipping a literal `TBD-…` to AdSense violates publisher policy. */
export function isPlaceholderAdSlot(slotId: string): boolean {
 return slotId.startsWith('TBD-');
}
