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

import { shouldSuppressManualInfeedAd } from './adExperiment.ts';

export { INFEED_AD_EXPERIMENT_ID, INFEED_AD_EXPERIMENT_RC_KILL_KEY, INFEED_AD_VARIANTS } from './adExperiment.ts';
export { INFEED_AD_TREATMENT_CANTONS as INFEED_AD_AB_TEST_SUPPRESSED_CANTONS } from './adExperiment.ts';

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
  *  Dedicated console unit `FT_SSG_END_MULTIPLEX` (`3285339503`) keeps the SSG
  *  family report separate from the blog end-of-article multiplex. */
 SSG_END_MULTIPLEX: {
 slot: '3285339503',
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
  *  Dedicated console unit `FT_JOBLIST_INLIST_DESKTOP_DISPLAY`
  *  (`4390537615`) keeps list viewability and RPM attributable to this surface. */
 JOBLIST_INFEED_DESKTOP: {
 slot: '4390537615',
 format: 'auto',
 fullWidthResponsive: true,
 placeholderMinHeight: 336,
 },
 /** Event listing: one responsive in-feed display unit after the first
  * value block. Dedicated console unit `FT_EVENTS_INFEED_DISPLAY`
  * (`2143648225`) keeps event-list reporting separate from job lists. */
 EVENTS_LIST_INFEED: {
 slot: '2143648225',
 format: 'auto',
 fullWidthResponsive: true,
 placeholderMinHeight: 336,
 },
 /** Job listing: mobile in-feed (responsive DISPLAY).
  *  Switched 2026-06-25 from the FEED native unit (6979586981, ~45% fill, RPM
  *  €0.11) to a responsive DISPLAY unit for the same fill/RPM reason as
  *  JOBLIST_INFEED_DESKTOP above. Dedicated console unit
  *  `FT_JOBLIST_INLIST_MOBILE_DISPLAY` (`7562575998`) keeps mobile list
  *  attribution separate from job-detail auth-gate traffic. */
 JOBLIST_INFEED_MOBILE: {
 slot: '7562575998',
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
  *  data area (health premiums, fuel daily, border wait, salary and profession
  *  landings — DRIVEBY_AD_SNIPPET).
  *
  *  Dedicated unit so the drive-by RPM lift can be measured in isolation
  *  instead of aggregated with the homepage placement (issue #1911 item 1).
  *  Console unit `FT_DRIVEBY_ATF_DISPLAY` is `7200533787`. The rendered
  *  format and reserve remain unchanged for this ID migration. */
 FT_DRIVEBY_ATF_DISPLAY: {
 slot: '7200533787',
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
  * Dedicated console unit `FT_JOBDETAIL_TOP_BANNER` (`9881792581`) keeps the
  * above-fold banner attributable separately from the auth gate. */
 JOBDETAIL_TOP_BANNER: {
 slot: '9881792581',
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
 slot: '6082893233',
 format: 'autorelaxed',
 fullWidthResponsive: false,
 placeholderMinHeight: 400,
 },
 /** JobBridge redirect page: end-of-gate multiplex after the direct link. */
 JOBBRIDGE_MULTIPLEX: {
 slot: '1952076530',
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

/** Canton keys (the `entry.key` / `initialFilterCanton` value — 2-letter code,
 *  or a URL-group key like `BASILEA` for merged half-cantons, see
 *  `data/canton-url-slugs.json`) where a manual in-feed slot would be
 *  suppressed while an active URL-surface experiment is running. The current
 *  set is intentionally empty: the TI treatment was rolled back after the
 *  2026-09-16 CLS regression, so every job-list surface keeps its fixed
 *  placeholder and AdSense Auto Ads remain enabled. Treatment membership is
 *  centralized in `services/adExperiment.ts`.
 */
/** True when an in-feed ad should be placed immediately after the card at this
 *  1-based position. Ad after card 3, 6, 9, … (every `JOBLIST_AD_EVERY_N`), up
 *  to `JOBLIST_AD_MAX_PER_LIST` ads per list (see cap rationale above).
 *
 *  `opts.canton`, when passed, opts this call site into the URL-surface
 *  comparison above. `adExperimentActive: false` is the treatment-only
 *  rollback and restores the original cadence on the treatment surfaces.
 *  Omitting `canton` (every existing caller that isn't the canton job-search
 *  listing) preserves the original cadence-only behaviour unchanged. */
export function shouldPlaceInfeedAd(
 position1Based: number,
 opts?: { canton?: string | null; adExperimentActive?: boolean } | number,
): boolean {
 // Array.prototype.filter passes its numeric index as the second argument.
 // Keep that established call shape type-safe while still accepting the
 // options object used by canton listing renderers.
 const adOptions = typeof opts === 'object' && opts !== null ? opts : undefined;
 if (shouldSuppressManualInfeedAd(adOptions?.canton, { active: adOptions?.adExperimentActive })) {
 return false;
 }
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
 * Registry entries use distinct console units for each placement context, so
 * reporting remains attributable and no two entries share a slot id. The
 * resolver remains keyed on the (slot, format, layout) triple as
 * defense-in-depth for future migrations; the registry test rejects both
 * triple collisions and slot-id aliases.
 */

/** How close to the viewport an ad slot must come before it is allowed to spend
 *  an ad request — the single viewability lever shared by the two render paths.
 *
 *  An impression served for a unit the visitor never scrolls to is counted by
 *  Active View as a non-viewable impression: it earns ~nothing and drags the
 *  unit's measured viewability (hence its CPM) down for every OTHER placement
 *  of the same ad unit. The registry keeps placement contexts on separate
 *  console units so this diagnosis remains attributable to the surface that
 *  requested the impression.
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

/** Response observation budget. Manual slots report waiting_response after
 * this deadline and keep watching for late fills; only explicit failures are
 * terminal. Auto-ad recovery retains its separate late-creative restoration. */
export const AD_FILL_TIMEOUT_MS = 12_000;

/**
 * Attribute on the `<AdSenseBanner>` wrapper carrying its lifecycle state
 * (`idle` | `waiting_width` | `loading` | `waiting_response` | `unfilled` | `filled` | `collapsed`). The SPA twin
 * of the static `data-ft-static-ad-collapsed` marker: the per-page diagnosis
 * (services/adPageDiag.ts and its inline twin in the AdSense loader) counts a
 * manual slot inside a `collapsed` wrapper as collapsed. Read-only telemetry
 * hook; no CSS keys on it.
 */
export const AD_BANNER_STATE_ATTR = 'data-ft-ad-state';

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
