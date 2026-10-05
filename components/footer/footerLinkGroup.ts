/**
 * Layout of one footer link group (the «Progetto» / «Servizi» / «Guide»
 * sections in the App footer).
 *
 * The links are `text-xs` (16px line box) and wrap onto several rows. With a
 * 4px row gap the safe clickable circle of each link overlaps the link below
 * it, so Lighthouse `target-size` (WCAG 2.5.8, 24x24 CSS px) fails on every
 * page that renders the footer: that is what pushed `/prezzi-diesel/` under
 * the 0.9 accessibility budget after the footer was regrouped. Each direct
 * link child therefore gets a 24px minimum height (`min-h-6`), which satisfies
 * the criterion by size regardless of how the row wraps.
 *
 * Shared by every group so a new section cannot reintroduce the short target;
 * `tests/footer-link-target-size.test.ts` holds the invariant.
 */
export const FOOTER_LINK_GROUP_CLASS =
  'flex flex-wrap items-center justify-start gap-x-3 gap-y-1 [&>span]:hidden [&>a]:min-h-6';
