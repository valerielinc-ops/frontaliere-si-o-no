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
 /** Static SSG "family" landings: end-of-content multiplex (issue #4485).
  *
  *  Shared by the build-plugin families that previously ran Auto Ads only —
  *  events, career, cost-of-living, comparisons, FAQ, pillar, exchange-rate,
  *  employer-profile and profession×canton — emitted once at the very bottom
  *  of the page content via `endOfContentMultiplexHtml()`
  *  (build-plugins/lib/adSlotHtml.ts). `autorelaxed` (multiplex) is the format
  *  the homepage / end-of-article placements proved earns far above display
  *  (in-page multiplex RPM €6.64 vs €0.20 display — see HOMEPAGE_MID_DISPLAY).
  *
  *  Slot id REUSES ARTICLE_END_MULTIPLEX ('5196931137') — an active autorelaxed
  *  end-of-content multiplex unit. These SSG family pages never co-render the
  *  blog end-of-article multiplex, so there is no same-page cannibalization
  *  (same cross-context reuse pattern as CALCULATOR_POST_RESULT /
  *  FT_DRIVEBY_ATF_DISPLAY). A dedicated `FT_SSG_END_MULTIPLEX` unit CANNOT be
  *  created from this automation (AdSense `adunits.create` returns 403 —
  *  console-only). Owner upgrade for isolated reporting: create a Multiplex
  *  unit named `FT_SSG_END_MULTIPLEX` in the AdSense console and swap the `slot`
  *  below — that single edit re-points every SSG family page. */
 SSG_END_MULTIPLEX: {
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

/* ────────────────────────────────────────────────────────────────────────────
 * Placeholder-height resolution — single source of truth for CLS reservation
 * ────────────────────────────────────────────────────────────────────────────
 *
 * `placeholderMinHeight` above was the declared source of truth for how much
 * layout space a slot reserves before it fills, but only the BUILD-TIME path
 * (`build-plugins/lib/adSlotHtml.ts`) ever read it. The runtime SPA path
 * (`components/shared/AdSenseBanner.tsx`) resolved the reserve from a
 * format-only heuristic (fluid/in-article → 220, autorelaxed → 400/600,
 * everything else → 280), and 42 of 49 `<AdSenseBanner>` call sites pass no
 * `minHeight` override — so for those slots the registry value was inert.
 *
 * Concretely that made the #4302 CLS fix a no-op on the SPA: this file raised
 * JOBLIST_INFEED_MOBILE/DESKTOP from 280 → 336 for exactly that campaign, but
 * `/cerca-lavoro-ticino/` kept reserving 280px per in-feed unit in production
 * (verified live: the in-feed wrapper computes `min-height: 280px`), and the
 * job list interleaves up to `JOBLIST_AD_MAX_PER_LIST` of them — every filled
 * unit pushing the rest of the list and the footer down. That is the field
 * CLS regression tracked in issue #4677.
 *
 * `resolveSlotPlaceholderMinHeight` closes the loop: the runtime component
 * reads the same registry entry the build-time emitter does, so the two paths
 * can no longer drift and a slot's reserve is edited in exactly one place.
 *
 * Two registry entries MAY share a triple when they are the same physical ad
 * unit reused in two placements (e.g. JOBLIST_INFEED_MOBILE and
 * JOBDETAIL_AUTH_GATE both key to `3205029282|auto|`). That is allowed and
 * intentional, but it makes their `placeholderMinHeight` values a single value
 * with two spellings: the resolver returns whichever entry is enumerated last,
 * so the two MUST stay numerically equal. `tests/adsense-placeholder-registry
 * .test.ts` turns red the moment they diverge — if you need genuinely different
 * reserves for two placements, give them different slot ids or formats rather
 * than editing one number.
 *
 * Keyed on the (slot, format, layout) TRIPLE, never the slot id alone: slot
 * ids are deliberately reused across placements (see the "Slot id REUSES …"
 * notes above), and `3205029282` is shared by JOBLIST_INFEED_MOBILE (336) and
 * JOBDETAIL_TOP_BANNER (100) — resolving by id alone would silently pick one
 * of the two. The triple is collision-free across the whole registry, pinned
 * by `tests/adsense-placeholder-registry.test.ts`.
 */

/** How close to the viewport an ad slot must come before it is allowed to spend
 *  an ad request — the single viewability lever shared by the two render paths.
 *
 *  An impression served for a unit the visitor never scrolls to is counted by
 *  Active View as a non-viewable impression: it earns ~nothing and drags the
 *  unit's measured viewability (hence its CPM) down for every OTHER placement
 *  of the same ad unit. Ad-unit 3205029282 is the worked example — 22.1%
 *  viewability across 92.7k mobile impressions/30d, against 62.0% on desktop
 *  where its only placement renders above the fold. Same unit, same creatives:
 *  the difference is entirely whether the request was spent on something the
 *  visitor could see.
 *
 *  ONE constant for both twins on purpose (AGENTS.md Non-Negotiable #6): the
 *  SPA (`components/shared/AdSenseBanner.tsx`) and the static-shell loader
 *  (`build-plugins/constants.ts` → `ADSENSE_LOADER_CONTENT`) implement the same
 *  policy in two languages, and a literal copied into both would drift.
 *
 *  Tuning note: this margin trades viewability against fill. Too small and a
 *  fast scroller passes the slot before AdSense returns a creative (the unit
 *  collapses, no impression at all); too large and it degenerates back into
 *  requesting units nobody reaches. 200px is the value both paths already used
 *  to gate the SCRIPT load, so adopting it for the per-slot request keeps the
 *  change to one variable — WHAT is deferred, not by how much. */
export const AD_SLOT_VIEWPORT_ROOT_MARGIN = '200px 0px';

/** Widest viewport (px) still treated as the registry's mobile/SSR floor for
 *  the multiplex desktop uplift below. Mirrors the `xl:` Tailwind breakpoint
 *  used by the `xl:min-h-[600px]` Suspense fallbacks. */
export const MULTIPLEX_DESKTOP_MIN_WIDTH = 1280;

/** Desktop multiplex reserve. `autorelaxed` renders ~380-450px on mobile but
 *  ~550-650px on desktop (wider grid → more ad rows), so the registry's
 *  mobile/SSR floor is lifted to this on wide viewports. */
export const MULTIPLEX_DESKTOP_MIN_HEIGHT = 600;

/**
 * How long a reserved ad box may stay unresolved before its space is given
 * back. An ad that has not reported `data-ad-status` by then is not "slow",
 * it is blocked — Privacy Sandbox / Attestation / ad blockers cut AdSense off
 * before it can answer `unfilled`, so the box would hold its reserve forever.
 *
 * 12s is the value measured for our own slots: most genuine fills land under
 * 2s, but Privacy Sandbox auctions can legitimately settle slower, and an 8s
 * cutoff false-collapsed late fills (depressing the measured fill rate). Both
 * consumers — `AdSenseBanner` for the slots we declare and `autoAdCollapse`
 * for the containers Google injects — must use the SAME budget: two different
 * timeouts would collapse two halves of the same page at two different moments.
 */
export const AD_FILL_TIMEOUT_MS = 12_000;

function slotReserveKey(
  adSlot: string | undefined,
  adFormat: string | undefined,
  adLayout?: string,
): string {
  return `${adSlot ?? ''}|${adFormat ?? ''}|${adLayout ?? ''}`;
}

/** Precomputed at module load — never rebuilt per call. A per-call rebuild
 *  would re-walk the registry on every ad render (the job list mounts up to
 *  `JOBLIST_AD_MAX_PER_LIST` units per page). */
const SLOT_RESERVE_BY_KEY: ReadonlyMap<string, number> = new Map(
  Object.values(AD_SLOTS)
    .filter((entry): entry is typeof entry & { placeholderMinHeight: number } =>
      typeof (entry as { placeholderMinHeight?: number }).placeholderMinHeight === 'number')
    .map((entry) => [
      slotReserveKey(
        (entry as { slot?: string }).slot,
        (entry as { format?: string }).format,
        (entry as { layout?: string }).layout,
      ),
      entry.placeholderMinHeight,
    ]),
);

/**
 * Registry-declared placeholder height for a slot, or `undefined` when the
 * (slot, format, layout) triple is not in the registry — the caller then falls
 * back to its own format heuristic.
 *
 * `viewportWidth` only affects `autorelaxed` (multiplex) units, which get the
 * documented desktop uplift. Pass `undefined` for SSR/build contexts to get
 * the mobile/SSR floor.
 */
export function resolveSlotPlaceholderMinHeight(
  adSlot: string | undefined,
  adFormat: string | undefined,
  adLayout?: string,
  viewportWidth?: number,
): number | undefined {
  const declared = SLOT_RESERVE_BY_KEY.get(slotReserveKey(adSlot, adFormat, adLayout));
  if (declared === undefined) return undefined;
  if (
    adFormat === 'autorelaxed' &&
    typeof viewportWidth === 'number' &&
    viewportWidth >= MULTIPLEX_DESKTOP_MIN_WIDTH
  ) {
    return Math.max(declared, MULTIPLEX_DESKTOP_MIN_HEIGHT);
  }
  return declared;
}
