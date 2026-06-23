/**
 * Full-height left/right side-rail ad gutters shared by the two static-page
 * emitters that produce staticOverlay SEO landings:
 *   - build-plugins/htmlTemplate.ts (buildSimplePage / seoContentOutsideRoot)
 *   - build-plugins/staticPagesPlugin.ts (hubChromeSplit editorial landings)
 *
 * The static `<main>` becomes the centre column of a 3-col grid that only
 * materialises at the `xlw` (≥1400px) tier — below that the page stays a single,
 * unchanged column. The two `<aside>` elements are PORTAL TARGETS: App.tsx mounts
 * `<ArticleRailAdStack>` into `#rail-left-root` / `#rail-right-root` on
 * staticOverlay pages (same portal mechanism as `#footer-root`), so the GPT
 * half-page rail units + Remote Config kill-switch match the article/job rails.
 * Reserved 300px columns mean zero CLS.
 *
 * Extracted into ONE module so the markup (grid classes, aside ids) can't drift
 * between the two emitters — the regression tests/static-seo-rail-ads contract
 * (xlw:grid-cols-[300px_minmax(0,1fr)_300px] + both portal ids) holds by
 * construction.
 */
export interface RailGutters {
  /** Opening grid wrapper + left aside. Place immediately BEFORE `<main>`. */
  open: string;
  /** Right aside + closing grid wrapper. Place immediately AFTER `</main>`. */
  close: string;
}

const RAIL_GUTTERS: RailGutters = {
  open: ` <div class="ft-rail-grid xlw:grid xlw:grid-cols-[300px_minmax(0,1fr)_300px] xlw:gap-4 xlw:mx-auto xlw:max-w-[1768px]">
 <aside id="rail-left-root" class="ft-rail-aside hidden xlw:flex xlw:flex-col" aria-hidden="true"></aside>`,
  close: `
 <aside id="rail-right-root" class="ft-rail-aside hidden xlw:flex xlw:flex-col" aria-hidden="true"></aside>
 </div>`,
};

const EMPTY_GUTTERS: RailGutters = { open: '', close: '' };

/**
 * Returns the rail gutter markup, or empty strings when rails are suppressed.
 *
 * @param enabled emit the gutters only when rails should render. Drive-by /
 *   no-ad pages (`disableAutoAds`) opt out by passing `false`; mirrors the
 *   `seoContentOutsideRoot && !disableAutoAds` gate in htmlTemplate.ts.
 */
export function railGutters(enabled: boolean): RailGutters {
  return enabled ? RAIL_GUTTERS : EMPTY_GUTTERS;
}
