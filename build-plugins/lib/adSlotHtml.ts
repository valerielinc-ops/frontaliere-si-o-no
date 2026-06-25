/**
 * Shared AdSense `<ins>` markup generator for build-plugin static HTML pages.
 *
 * Mirrors the runtime `<AdSenseBanner>` React component but emits raw HTML
 * for static SEO pages (F2 health-premiums, F5 weekly-employers, F6 fuel-daily).
 * The original pattern lives in `build-plugins/salaryHubContent.ts` — keep this
 * helper byte-for-byte compatible so the rendered HTML and AdSense slot
 * configuration stay consistent across plugins.
 *
 * Why a shared module: avoids drift between plugin copies and centralises the
 * attribute order so the regression test (`tests/regression/seo-static-ad-slots.test.ts`)
 * can reliably assert one `<ins class="adsbygoogle">` per render function.
 */
import { AD_CLIENT, AD_SLOTS } from '../../services/adsenseSlots';

export type AdSlotKey = keyof typeof AD_SLOTS;

export function adSlotHtml(slotKey: AdSlotKey): string {
  const cfg = AD_SLOTS[slotKey];
  const attrs = [
    `class="adsbygoogle"`,
    `style="display:block;min-height:${cfg.placeholderMinHeight}px"`,
    `data-ad-client="${AD_CLIENT}"`,
    `data-ad-slot="${cfg.slot}"`,
    `data-ad-format="${cfg.format}"`,
  ];
  if ('layout' in cfg && cfg.layout) attrs.push(`data-ad-layout="${cfg.layout}"`);
  if ('layoutKey' in cfg && cfg.layoutKey) attrs.push(`data-ad-layout-key="${cfg.layoutKey}"`);
  if (cfg.fullWidthResponsive) attrs.push(`data-full-width-responsive="true"`);
  return `<ins ${attrs.join(' ')}></ins>`;
}

/**
 * Device-split in-feed ad as a list `<li>` for static job/employer lists.
 *
 * Mirrors the SPA `JobBoard` between-card ad (which picks the mobile vs desktop
 * in-feed slot via the `isMobile` JS flag): since static HTML has no per-request
 * device detection, we emit BOTH the mobile and desktop in-feed `<ins>` wrapped
 * in Tailwind show/hide (`block sm:hidden` / `hidden sm:block`) so the
 * device-appropriate format renders. The static AdSense loader
 * (`ADSENSE_LOADER_CONTENT`) only `push()`es a visible `<ins>` (it skips the
 * collapsed `display:none` device variant), so no wasted ad request fires.
 *
 * `spanFull` makes the ad item span every column of a multi-column grid so the
 * ad keeps full width instead of squeezing into a single ~1/3-width cell.
 */
function infeedAdInnerHtml(): string {
  // `md` cutoff (≥768px = desktop) mirrors the SPA JobBoard's
  // `isMobile = max-width:767px` so the same device picks the same slot.
  const mobile = `<div class="block md:hidden">${adSlotHtml('JOBLIST_INFEED_MOBILE')}</div>`;
  const desktop = `<div class="hidden md:block">${adSlotHtml('JOBLIST_INFEED_DESKTOP')}</div>`;
  return mobile + desktop;
}

/** In-feed ad as a list `<li>` — for `<ul role="list">` job/employer lists. */
export function infeedAdListItemHtml(opts?: { spanFull?: boolean }): string {
  const span = opts?.spanFull ? ' sm:col-span-2 lg:col-span-3' : '';
  return `<li class="ft-infeed-ad my-3${span}" role="presentation">${infeedAdInnerHtml()}</li>`;
}

/** In-feed ad as a `<div>` block — for grids whose direct children are cards
 *  (e.g. the canton `data-listing-grid` of `<article>`s, not a `<ul>`/`<li>`).
 *  Spans every grid column so the ad keeps full width. */
export function infeedAdGridBlockHtml(): string {
  return `<div class="ft-infeed-ad my-3 sm:col-span-2 lg:col-span-3" role="presentation">${infeedAdInnerHtml()}</div>`;
}
