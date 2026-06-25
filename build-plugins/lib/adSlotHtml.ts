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
 * In-feed ad for static job/employer lists.
 *
 * Static HTML has no per-request device detection, so unlike the SPA (which
 * picks the mobile vs desktop slot via the `isMobile` flag) we emit a SINGLE
 * responsive DISPLAY `<ins>` (`format:auto` + `data-full-width-responsive`) per
 * in-feed point. AdSense serves a device-appropriate creative from the same
 * responsive unit, so "format by device" still holds without a dual-`<ins>`
 * show/hide pair — which would be unsafe here: the static loader
 * (`ADSENSE_LOADER_CONTENT`) pushes once per `<ins>` in DOM order, and
 * `adsbygoogle.push({})` is not slot-bound, so emitting a hidden off-device
 * `<ins>` would consume a push and desync the trailing slots (e.g. the
 * end-of-list multiplex). One `<ins>` per point keeps push↔slot aligned.
 *
 * Uses JOBLIST_INFEED_DESKTOP (the higher-fill ~92% responsive display unit);
 * being responsive it adapts down to mobile widths too.
 *
 * `spanFull` makes the ad item span every column of a multi-column grid so the
 * ad keeps full width instead of squeezing into a single ~1/N-width cell.
 */
function infeedAdInnerHtml(): string {
  return adSlotHtml('JOBLIST_INFEED_DESKTOP');
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
