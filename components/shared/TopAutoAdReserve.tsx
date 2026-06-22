import { isLikelyBot } from '@/services/botPatterns';

/**
 * Reserves layout space for the top in-page Google Auto Ad.
 *
 * On the homepage Google Auto Ads inject a `.google-auto-placed` ad as a flow
 * sibling immediately above `<main>`, which pushes all content down ~250-298px
 * once the ad script runs (well after first paint). Measured live this was the
 * dominant Cumulative Layout Shift: 0.19 desktop / 0.25 mobile.
 *
 * Pure space reservation (no ad added/removed — AGENTS.md §7): this renders a
 * placeholder of the same min-height the injected ad container takes (250px,
 * matching `.google-auto-placed { min-height: 250px }` in index.css) so the gap
 * above `<main>` exists from first paint. The CSS rule
 * `.app-shell-col:has(> .google-auto-placed) > .autoad-top-reserve` then
 * collapses this placeholder to 0 in the same style/layout pass the ad lands,
 * keeping the gap height constant so `<main>` never moves. Robust to whichever
 * order Google injects relative to this node, since total gap = ad + placeholder
 * stays constant either way.
 *
 * Rendered only where the auto ad actually injects — production AdSense host and
 * non-bot clients — so dev/preview/bot loads never show an empty reserved band.
 * (Production-host set mirrors `isAdSenseProductionHost` in AdSenseBanner.tsx;
 * kept inline to avoid pulling that lazy ad chunk into the main bundle.)
 */
const ADSENSE_PRODUCTION_HOSTS = new Set(['frontaliereticino.ch']);

export default function TopAutoAdReserve() {
  if (typeof window === 'undefined') return null;
  if (!ADSENSE_PRODUCTION_HOSTS.has(window.location.hostname)) return null;
  if (isLikelyBot()) return null;
  return <div className="autoad-top-reserve" aria-hidden="true" />;
}
