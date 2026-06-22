import { useEffect, useRef } from 'react';
import { isLikelyBot } from '@/services/botPatterns';

/**
 * Reserves layout space for the top in-page Google Auto Ad.
 *
 * On the homepage Google Auto Ads inject a `.google-auto-placed` ad as a flow
 * sibling immediately above `<main>`, which pushes all content down ~250-298px
 * once the ad script runs (well after first paint). Measured live this was the
 * dominant Cumulative Layout Shift: 0.25 mobile / 0.19 desktop.
 *
 * Pure space reservation (no ad added/removed — AGENTS.md §7): this renders a
 * placeholder of the same min-height the injected ad container takes (250px,
 * matching `.google-auto-placed { min-height: 250px }` in index.css) so the gap
 * above `<main>` exists from first paint, and then keeps the *total* gap height
 * (ad + placeholder) constant by mirroring the ad's effective height:
 *
 *   - ad absent (not injected yet, or ad-blocked) → placeholder holds 250px
 *   - ad present and occupying space (loading/filled) → placeholder collapses
 *     to 0 (the ad now provides the height)
 *   - ad present but COLLAPSED by AdSense (unfilled / empty — index.css drops it
 *     to min-height:0) → placeholder re-expands to 250px so `<main>` does not
 *     jump back up
 *
 * A pure-CSS `:has()` collapse cannot express the third case ("ad exists AND is
 * not unfilled") because `:has()` may not be nested, so the unfilled ad would
 * collapse to 0 while the placeholder stayed collapsed → `<main>` shifts up 250px
 * (observed live). A MutationObserver mirrors the exact signals index.css uses to
 * collapse the ad (`:empty` / `ins[data-ad-status="unfilled"]`); it fires before
 * paint, so the ad-collapse and the placeholder-expand land in the same frame and
 * `<main>` never moves either way.
 *
 * Rendered only where the auto ad actually injects — production AdSense host and
 * non-bot clients — so dev/preview/bot loads never show an empty reserved band.
 * (Production-host set mirrors `isAdSenseProductionHost` in AdSenseBanner.tsx;
 * kept inline to avoid pulling that lazy ad chunk into the main bundle.)
 */
const ADSENSE_PRODUCTION_HOSTS = new Set(['frontaliereticino.ch']);
const RESERVE_PX = 250;

/** True when the column-child auto-ad is NOT occupying layout space — i.e. it is
 *  absent, empty, or AdSense has flagged it unfilled (mirrors the collapse
 *  conditions on `.google-auto-placed` in index.css). */
function adIsCollapsed(ad: Element | null | undefined): boolean {
  if (!ad) return true;
  if (ad.childElementCount === 0) return true;
  return !!ad.querySelector('ins[data-ad-status="unfilled"]');
}

export default function TopAutoAdReserve() {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const reserve = ref.current;
    const col = reserve?.closest('.app-shell-col');
    if (!reserve || !col) return;

    let adObserver: MutationObserver | null = null;
    const sync = () => {
      const children = Array.from(col.children) as Element[];
      const ad = children.find((c) =>
        c.classList.contains('google-auto-placed'),
      );
      // Once the ad exists, also watch its subtree for fill-status changes.
      if (ad && !adObserver) {
        adObserver = new MutationObserver(sync);
        adObserver.observe(ad, {
          attributes: true,
          childList: true,
          subtree: true,
          attributeFilter: ['data-ad-status'],
        });
      }
      reserve.style.minHeight = adIsCollapsed(ad) ? `${RESERVE_PX}px` : '0px';
    };

    const colObserver = new MutationObserver(sync);
    colObserver.observe(col, { childList: true });
    sync();

    return () => {
      colObserver.disconnect();
      adObserver?.disconnect();
    };
  }, []);

  if (typeof window === 'undefined') return null;
  if (!ADSENSE_PRODUCTION_HOSTS.has(window.location.hostname)) return null;
  if (isLikelyBot()) return null;
  return <div ref={ref} className="autoad-top-reserve" aria-hidden="true" />;
}
