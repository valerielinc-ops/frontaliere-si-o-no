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
 * Extended 2026-04-20 (2nd pass): wired 4 previously-orphaned AdSense units
 * that already existed in the console but were never mounted in the DOM:
 *   - AUTHGATE_RAIL_LEFT / AUTHGATE_RAIL_RIGHT — desktop rails around gate
 *   - JOBDETAIL_SIDEBAR_2 — secondary sidebar slot on authenticated detail
 *   - ARTICLE_INLINE_MOBILE_2 — second mid-body inline (reserved for long form)
 */

export const AD_CLIENT = 'ca-pub-8628054934855353';

export const AD_SLOTS = {
 /** Blog: desktop left rail */
 ARTICLE_RAIL_LEFT: {
 slot: '2663155183',
 format: 'auto',
 fullWidthResponsive: true,
 placeholderMinHeight: 280,
 },
 /** Blog: desktop right rail */
 ARTICLE_RAIL_RIGHT: {
 slot: '9739778973',
 format: 'auto',
 fullWidthResponsive: true,
 placeholderMinHeight: 280,
 },
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
 /** Auth gate: desktop left rail (shared between job + blog gate) */
 AUTHGATE_RAIL_LEFT: {
 slot: '2190721703',
 format: 'auto',
 fullWidthResponsive: true,
 placeholderMinHeight: 280,
 },
 /** Auth gate: desktop right rail (shared between job + blog gate) */
 AUTHGATE_RAIL_RIGHT: {
 slot: '7139796055',
 format: 'auto',
 fullWidthResponsive: true,
 placeholderMinHeight: 280,
 },
 /** Job detail: secondary sidebar slot (below primary JOBDETAIL_SIDEBAR) */
 JOBDETAIL_SIDEBAR_2: {
 slot: '6065026724',
 format: 'auto',
 fullWidthResponsive: true,
 placeholderMinHeight: 280,
 },
 /** Article: second inline-mobile ad for long-form articles (>1500 words) */
 ARTICLE_INLINE_MOBILE_2: {
 slot: '6483829128',
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
