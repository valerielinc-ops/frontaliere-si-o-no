/** AdSense ad-unit registry — single source of truth for slot IDs and layout config.
 *
 * `placeholderMinHeight` reserves layout space before the ad loads, preventing CLS (FRO-385).
 * Heights are sized conservatively above real median ad heights measured in production:
 * - autorelaxed multiplex: 380-450px on mobile → 400px; ~550-650px on desktop
 *   (≥1280px) where the wider grid fits more ad rows. AdSenseBanner +
 *   the Suspense fallbacks reserve 600px on desktop (see getPlaceholderMinHeight
 *   and the `xl:min-h-[600px]` fallback classes); these constants are the
 *   mobile/SSR floor.
 * - fluid in-article: ~220px → 220px
 * - auto display: ~250-300px → 280px
 *
 * `format: 'auto'` + `fullWidthResponsive: true` slots (#4302, 2026-07-16):
 * raised 280 → 336px. Field CLS on pages that interleave several of these
 * per page (e.g. weekly-employer ranked lists via infeedAdListItemHtml —
 * up to ~9 on one page) was disproportionately high (p75 0.66 on
 * /aziende-che-assumono/ticino/settimana-corrente/) versus pages with only
 * 1-2 ad units, consistent with each responsive unit under-reserving in
 * narrow/mobile in-feed containers where Google can pick a taller creature
 * shape (compounds ×N when several are stacked in one list). 336px is a
 * conservative estimate (no lab/PostHog attribution data available to pin
 * the exact median, unlike the 400→1100 HOMEPAGE_MID_DISPLAY fix below) —
 * over-reservation is CLS-safe by construction, so this can only help or be
 * neutral. Re-check against scripts/monitor-cls-posthog.mjs field data
 * post-deploy and adjust up/down once real numbers are in.
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
 /** Job listing: desktop in-feed (responsive DISPLAY).
  *
  *  Switched 2026-06-25 from the FEED native unit (9770600968) to a responsive
  *  DISPLAY unit. 30d AdSense data showed the FEED in-feed units fill only
  *  ~43-45% (so the between-jobs ad collapsed >55% of the time — the "ad ogni 3
  *  non si carica" report) at RPM €0.11-0.23. The DISPLAY units fill ~85-92% at
  *  3-6× the RPM, so the ad now actually loads between listings.
  *
  *  Slot id REUSES FT_JOBDETAIL_SIDEBAR_DESKTOP_DISPLAY ('8164676143', 92% fill)
  *  — a desktop display unit that renders only in the job-detail sidebar, never
  *  on a job-LIST page, so no same-page cannibalization. Same console-only-unit
  *  reuse pattern as JOBDETAIL_TOP_BANNER / FT_DRIVEBY_ATF_DISPLAY (AdSense
  *  `adunits.create` returns 403). Owner upgrade for isolated reporting: create
  *  a dedicated `FT_JOBLIST_INLIST_DESKTOP_DISPLAY` unit and swap the slot. */
 JOBLIST_INFEED_DESKTOP: {
 slot: '8164676143',
 format: 'auto',
 fullWidthResponsive: true,
 placeholderMinHeight: 336,
 },
 /** Job listing: mobile in-feed (responsive DISPLAY).
  *  Switched 2026-06-25 from the FEED native unit (6979586981, ~45% fill, RPM
  *  €0.11) to a responsive DISPLAY unit for the same fill/RPM reason as
  *  JOBLIST_INFEED_DESKTOP above. Slot id REUSES JOBDETAIL_AUTH_GATE
  *  ('3205029282', 85% fill) — a display unit shown only to signed-out users on
  *  job-detail, never co-rendered with a job list. Owner upgrade: dedicated
  *  `FT_JOBLIST_INLIST_MOBILE_DISPLAY` unit. */
 JOBLIST_INFEED_MOBILE: {
 slot: '3205029282',
 format: 'auto',
 fullWidthResponsive: true,
 placeholderMinHeight: 336,
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
 placeholderMinHeight: 336,
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
 // Raised from 400→1100: lab shows render at 1166px → 766px CLS (#855/#886).
 // 1100 reduces shift to ~66px; collapses to 0 when unfilled (offscreen guard).
 placeholderMinHeight: 1100,
 },
 /** Drive-by SEO landings: above-the-fold display, right after the primary
  *  data area (health premiums, fuel daily, border wait — DRIVEBY_AD_SNIPPET).
  *
  *  Dedicated unit so the drive-by RPM lift can be measured in isolation
  *  instead of aggregated with the homepage placement (issue #1911 item 1).
  *
  *  Slot id currently MIRRORS HOMEPAGE_MID_DISPLAY ('2093992129') — the only
  *  ACTIVE display unit the build can reference today. A dedicated
  *  `FT_DRIVEBY_ATF_DISPLAY` ad unit CANNOT be created from this automation:
  *  AdSense Management API v2 `adClients.adunits.create` returns 403
  *  PERMISSION_DENIED even with a full `https://www.googleapis.com/auth/adsense`
  *  write-scope token (verified 2026-06-18 with a valid 300x250/1x3 payload —
  *  not a scope or format issue; ad-unit creation is console-only for this
  *  account/OAuth client). Owner action to isolate reporting:
  *    1. AdSense console → Ads → By ad unit → create a Display unit named
  *       `FT_DRIVEBY_ATF_DISPLAY` (responsive).
  *    2. Replace the `slot` below with the new data-ad-slot id — that single
  *       edit re-points every drive-by landing; nothing else changes.
  *  Config matches HOMEPAGE_MID_DISPLAY so the rendered <ins> and the
  *  CLS-reserving min-height stay identical until the swap. */
 FT_DRIVEBY_ATF_DISPLAY: {
 slot: '2093992129',
 format: 'autorelaxed',
 fullWidthResponsive: false,
 placeholderMinHeight: 1100,
 },
 /** Job detail: between related jobs and related articles sections */
 JOBDETAIL_BETWEEN_SECTIONS: {
 slot: '7767335647',
 format: 'autorelaxed',
 fullWidthResponsive: false,
 placeholderMinHeight: 400,
 },
 /** Job detail: top leaderboard banner — full content-width display above the
  * job header on desktop (lg+). Horizontal format so the slot is height-bounded
  * (~90px leaderboard) and CLS-safe at a 100px reserve, matching the thin top
  * banner in the desktop mock.
  *
  * Slot id REUSES JOBDETAIL_AUTH_GATE ('3205029282') — a job-detail-top display
  * unit that is NEVER co-rendered with the authenticated full detail (the gate
  * shows only to signed-out users), so there is no same-page cannibalization
  * (cf. the JOBDETAIL_SIDEBAR_2 prune, 2026-04-26). Same cross-context reuse
  * pattern as CALCULATOR_POST_RESULT / FT_DRIVEBY_ATF_DISPLAY: ships live ads
  * now without a new console unit (AdSense `adunits.create` returns 403 — unit
  * creation is console-only). Owner upgrade path for isolated reporting: create
  * a dedicated `FT_JOBDETAIL_TOP_BANNER` display unit in the AdSense console and
  * swap the `slot` id below. */
 JOBDETAIL_TOP_BANNER: {
 slot: '3205029282',
 format: 'horizontal',
 fullWidthResponsive: true,
 placeholderMinHeight: 100,
 },
 /** Job detail: auth gate — shown below sign-in form for unauthenticated users */
 JOBDETAIL_AUTH_GATE: {
 slot: '3205029282',
 format: 'auto',
 fullWidthResponsive: true,
 placeholderMinHeight: 336,
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

/** In-feed ad cadence for EVERY job/employer listing surface — SPA (JobBoard)
 *  and static build-plugins alike: place one in-feed ad after every Nth card.
 *  Single source of truth so the two render paths never drift (CLAUDE.md rule
 *  #6 — a cadence duplicated as a literal in ≥2 files would drift by-hand). */
export const JOBLIST_AD_EVERY_N = 3;

/** Safety cap on in-feed ads per single list. "One ad every 3 cards" on a long
 *  list (per-canton paginated listings carry ~100 jobs; the SPA main list grows
 *  via infinite scroll) would otherwise emit 30+ ads on one page — an AdSense
 *  ad-density policy risk that can get the whole account throttled (which would
 *  hurt the ~95%-of-revenue Auto Ads). Cap at 12: lists ≤36 cards are
 *  unaffected (they place ≤12 ads anyway); longer lists stop interleaving past
 *  card 36 (Auto Ads + the end-of-list multiplex still cover the tail).
 *
 *  Resolution of #2935 (follow-up of #2931): the SPA main list's mobile
 *  infinite scroll (`JobBoard.tsx` `loadMoreMobile`, +10 cards/batch) was
 *  re-checked — `displayJobs`/`mobileJobs` is re-sliced from position 0 on
 *  every batch, so `shouldPlaceInfeedAd` sees the ABSOLUTE cumulative
 *  position each render, never a per-batch-local one. The cap therefore
 *  applies correctly across scroll batches: total ads plateau at 12 once the
 *  accumulated list passes 36 cards, with no re-shuffling of already-placed
 *  ads as more cards load (regression-pinned in
 *  `tests/services/adsenseSlots.test.ts`). 12 remains a policy-safety default,
 *  not an explicit owner request — still a single constant to change if the
 *  owner later prefers a different value or no cap. */
export const JOBLIST_AD_MAX_PER_LIST = 12;

/** True when an in-feed ad should be placed immediately after the card at this
 *  1-based position. Ad after card 3, 6, 9, … (every `JOBLIST_AD_EVERY_N`), up
 *  to `JOBLIST_AD_MAX_PER_LIST` ads per list (see cap rationale above). */
export function shouldPlaceInfeedAd(position1Based: number): boolean {
 return (
 position1Based > 0 &&
 position1Based % JOBLIST_AD_EVERY_N === 0 &&
 position1Based <= JOBLIST_AD_EVERY_N * JOBLIST_AD_MAX_PER_LIST
 );
}
