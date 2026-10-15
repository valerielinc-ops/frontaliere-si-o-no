/**
 * Which `ins.adsbygoogle` is a site-placed slot. Shared by the per-page ad
 * diagnosis (services/adPageDiag.ts, whose inline twin is MANUAL_SLOT_JS in
 * build-plugins/shared/adPageDiagInline.ts) and the rewarded offer's ads
 * snapshots (services/adVisibilitySnapshot.ts). Kept dependency-free so the
 * lazy offer chunk does not pull the page-template tables.
 */

/** A site-placed AdSense slot: not the anchor, the vignette or an Auto ads insert. */
export function isManualSlot(el: Element): boolean {
  return (
    el.hasAttribute('data-ad-slot') &&
    !el.hasAttribute('data-anchor-status') &&
    !el.hasAttribute('data-vignette-loaded') &&
    !el.closest('.google-auto-placed')
  );
}
