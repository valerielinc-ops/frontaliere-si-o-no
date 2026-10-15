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
 * This is a real CSS class defined in `index.css` (`.above-mobile-nav`), NOT a
 * Tailwind arbitrary-value utility. An earlier attempt put
 * `bottom-[calc(...)] md:bottom-4` in this const, but the production Tailwind
 * source scan did not pick up class literals living only in this shared `.ts`
 * file, so the utility was never generated and the toast dropped to its in-flow
 * position off-screen. A class defined in the entry stylesheet always ships, so
 * referencing it by name here is scan-proof. The actual offsets (4.5rem mobile,
 * 1rem at md+) live in index.css.
 *
 * ONE CALLER, DELIBERATELY. Four prompts used to import this directly and
 * assemble the rest of the position themselves, which is how four of them ended
 * up on byte-identical coordinates with no coordination. The offset now belongs
 * to `components/shared/BottomPromptShell.tsx`, which owns the whole class list
 * AND the popupQueue claim that keeps two prompts off the same pixels. The only
 * other importer is the JobAlertForm success toast, a transient z-50 status
 * message that deliberately does not queue — see the exemption list in
 * `tests/bottom-prompt-slot.test.tsx`, which fails if a third one appears.
 */
export const ABOVE_MOBILE_NAV_BOTTOM = 'above-mobile-nav';
