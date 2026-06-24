/**
 * DesktopTopBanner — dedicated desktop top-of-page GPT/GAM leaderboard.
 *
 * Replaces our reliance on Google's variable-height in-page Auto Ad at the top
 * of the tool pages. That Auto Ad (`.google-auto-placed`) rendered inside an
 * aspect-ratio box much taller than the real creative, leaving a ~120px blank
 * band above the fold (the reported "gap in alto"). A deliberate unit lets us
 * pin the exact height instead.
 *
 * Serves `/23355151813/desktop-top-banner` (970x90 / 728x90 — a single 90px
 * creative height, NO fluid) via GptAdSlot with a 90px reserve, so the slot
 * reserves exactly the creative height: zero blank band AND zero CLS. Unfilled
 * impressions collapse to `display:none` (GptAdSlot), so the slot never leaves
 * white space when there is no demand.
 *
 * GPT (pubads) is independent of `adsbygoogle.js`, so AdSense Auto Ads keep
 * serving untouched (AGENTS §7) — this is additive, not a suppression. Runtime
 * kill-switch: Firebase Remote Config `KILL_DESKTOP_TOP_BANNER` (~1 min, no
 * redeploy; default-safe = shown).
 *
 * CSS-gated to >=lg (1024px): the unit only allows desktop leaderboards
 * (728-970 wide), so below that the container can't fit a creative and the slot
 * stays hidden (mobile/​tablet keep their own Auto Ads).
 */
import GptAdSlot, { type GptSize } from '@/components/shared/GptAdSlot';
import { useKillSwitches } from '@/hooks/useKillSwitches';

const TOP_BANNER_UNIT_PATH = '/23355151813/desktop-top-banner';
// Uniform 90px-tall leaderboards only — a single creative height means the
// 90px reserve below matches the fill exactly (no over-reserve gap, no shift).
const TOP_BANNER_SIZES: GptSize[] = [[970, 90], [728, 90]];

export default function DesktopTopBanner() {
  const { desktopTopBanner: killed } = useKillSwitches();
  return (
    <GptAdSlot
      adUnitPath={TOP_BANNER_UNIT_PATH}
      sizes={TOP_BANNER_SIZES}
      killed={killed}
      minHeight={90}
      // CLS-safe: keep the 90px reserve even when unfilled. This slot sits ABOVE
      // THE FOLD (above the H1); collapsing it on no-fill would yank the H1 and
      // all content below upward and register a Cumulative Layout Shift (the
      // "header jumps up after load" report). A stable 90px footprint is worth
      // more than recovering a thin band when there's no demand.
      collapseOnEmpty={false}
      // Desktop-only leaderboard, centred, full content width. `hidden` below lg
      // so mobile/tablet render nothing (no reserve, no band).
      className="hidden lg:block w-full text-center mb-4"
    />
  );
}
