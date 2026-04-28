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
