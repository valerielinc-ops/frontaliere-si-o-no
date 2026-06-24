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
// Fallback reserve used only until we've measured the real top Auto Ad once.
const RESERVE_PX = 250;

// Adaptive reserve: the top in-page Auto Ad renders a variable height, so a
// fixed 250px guess can mismatch the real ad — when the placeholder (250) is
// swapped for a shorter served ad, content jumps. We remember the ad's actual
// rendered height (per tab session) and reserve exactly that next time, so the
// placeholder == the ad == no shift. Converges after the first served
// impression; bounded to a sane banner range so a stray 0/huge measurement
// can't poison the reserve.
const RESERVE_STORE_KEY = 'ft_autoad_top_h';
const RESERVE_MIN_PX = 60;
const RESERVE_MAX_PX = 400;

function readReserve(): number {
  try {
    const v = Number(sessionStorage.getItem(RESERVE_STORE_KEY));
    if (Number.isFinite(v) && v >= RESERVE_MIN_PX && v <= RESERVE_MAX_PX) return v;
  } catch { /* sessionStorage blocked — fall through to default */ }
  return RESERVE_PX;
}

function writeReserve(px: number): void {
  const h = Math.round(px);
  if (!(h >= RESERVE_MIN_PX && h <= RESERVE_MAX_PX)) return;
  try { sessionStorage.setItem(RESERVE_STORE_KEY, String(h)); } catch { /* ignore */ }
}

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
      if (adIsCollapsed(ad)) {
        // Ad absent / unfilled → hold the placeholder at the adaptive reserve
        // (last measured real height, or the 250px fallback) so <main> sits at
        // its post-ad position from first paint.
        reserve.style.minHeight = `${readReserve()}px`;
      } else if (ad) {
        // Ad is occupying space → record its REAL rendered height so the next
        // load reserves exactly this (placeholder == ad == no swap shift), then
        // collapse the placeholder since the ad now provides the height.
        writeReserve(ad.getBoundingClientRect().height);
        reserve.style.minHeight = '0px';
      }
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
  // Seed the first-paint reserve from the remembered height (client-only here,
  // past the SSR/bot guards) so the placeholder already matches the ad before
  // the effect runs — no 250→real shrink on mount. Overrides the CSS floor.
  return (
    <div
      ref={ref}
      className="autoad-top-reserve"
      style={{ minHeight: `${readReserve()}px` }}
      aria-hidden="true"
    />
  );
}
