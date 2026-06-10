/**
 * Tailwind positioning fragment that lifts a `fixed` bottom-anchored element
 * above the mobile bottom navigation bar.
 *
 * The mobile nav (App.tsx) is `fixed bottom-0 z-50 h-14 md:hidden` plus an
 * `env(safe-area-inset-bottom)` pad. A plain `bottom-4` leaves bottom-anchored
 * toasts/banners partially behind that bar on phones, hiding their CTA/dismiss
 * controls. This clears the 3.5rem (h-14) nav + safe-area + a 1rem gap on `<md`,
 * and falls back to `bottom-4` at `md+` where the nav is hidden.
 *
 * Single source of truth: the `3.5rem` mirrors the nav's `h-14`. If the nav
 * height changes, update it here once instead of in each toast/banner.
 *
 * Used by JobDetailAlertPrompt, JobAlertStickyBanner and the JobAlertForm toast.
 */
export const ABOVE_MOBILE_NAV_BOTTOM =
  'bottom-[calc(3.5rem+1rem+env(safe-area-inset-bottom,0px))] md:bottom-4';
