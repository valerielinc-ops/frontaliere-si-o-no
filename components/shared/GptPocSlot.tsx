/**
 * GptPocSlot — proof-of-concept Google Publisher Tag (GPT) display slot.
 *
 * WHY: the GAM Offerwall (with the in-house newsletter custom choice) requires
 * the site to be tagged with GPT. Today the site serves via AdSense Auto Ads
 * (adsbygoogle.js) + Funding Choices only. This PoC validates that GPT can
 * serve a slot on a NON-funnel page (blog articles), with AdSense filling unsold
 * inventory (the linked AdSense account already backfills GAM ad units), WHILE
 * AdSense Auto Ads keep serving untouched. See issue #2273.
 *
 * SAFETY: disabled by default (`GPT_POC_ENABLED = false`) → renders nothing, so
 * merging/deploying this file is a no-op for the live ad stack. To run the PoC,
 * flip the flag (and set a real ad unit path) and observe RPM / Auto Ads / CWV.
 * GPT (pubads) is independent of AdSense Auto Ads; this slot never touches
 * adsbygoogle.js. Lazy-loaded via IntersectionObserver (mirrors AdSenseBanner)
 * so it stays off the LCP critical path.
 */

import React, { useEffect, useRef, useState } from 'react';
import { isAdSenseProductionHost } from '@/components/shared/AdSenseBanner';
import { isLikelyBot } from '@/services/adAnalytics';
import { useKillSwitches } from '@/hooks/useKillSwitches';

// ── PoC switches ────────────────────────────────────────────
// PoC ACTIVATED (issue #2273): GPT now serves one display slot on blog articles
// to validate GPT serving + AdSense backfill while AdSense Auto Ads keep serving.
// Revert this to `false` (one-line, then deploy) if Auto Ads / RPM / CWV regress.
const GPT_POC_ENABLED = true;
// Full GAM ad unit path — the display ad unit created for this PoC in GAM
// Inventory (ad unit id 23356816306, sizes 300x250 + fluid, AdSense backfill on).
const GPT_POC_AD_UNIT_PATH = '/23355151813/gpt-poc-articoli';
// Match the sizes the GAM ad unit actually allows (300x250 + fluid/responsive).
const GPT_POC_SIZES = [[300, 250], 'fluid'];
const GPT_SCRIPT_SRC = 'https://securepubads.g.doubleclick.net/tag/js/gpt.js';

const IS_PROD = typeof window !== 'undefined' && isAdSenseProductionHost(window.location.hostname);
const SKIP_FOR_BOT = typeof window !== 'undefined' && isLikelyBot();

let gptScriptRequested = false;
let gptServicesEnabled = false;

// Minimal GPT access — @types/google-publisher-tag is not a dependency, so we
// reach googletag via an `any` view of window rather than a global type.
const gtag = (): any => {
  const w = window as any;
  // Ensure `cmd` exists even when `window.googletag` was already created by
  // another Google ad script WITHOUT a `cmd` queue — `|| { cmd: [] }` alone
  // returns that partial object as-is and `gt.cmd.push` then throws
  // "Cannot read properties of undefined (reading 'push')", so the slot never
  // defines/serves (observed live on article pages).
  const gt = w.googletag = w.googletag || {};
  gt.cmd = gt.cmd || [];
  return gt;
};

function ensureGptScript(): void {
  if (gptScriptRequested || typeof document === 'undefined') return;
  gptScriptRequested = true;
  gtag();
  if (document.querySelector(`script[src="${GPT_SCRIPT_SRC}"]`)) return;
  const s = document.createElement('script');
  s.src = GPT_SCRIPT_SRC;
  s.async = true;
  s.crossOrigin = 'anonymous';
  document.head.appendChild(s);
}

let slotSeq = 0;

const GptPocSlot: React.FC = () => {
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  // Stable, unique DOM id for this slot instance (GPT needs a real element id).
  const divIdRef = useRef<string>(`gpt-poc-slot-${++slotSeq}`);
  const [rendered, setRendered] = useState(false);
  // Runtime kill-switch (Firebase Remote Config KILL_GPT_POC_SLOT). Flip to
  // `true` in the RC console to stop serving the GPT slot within ~1 min — no
  // redeploy — if it regresses AdSense Auto Ads / RPM / CWV. Default-safe:
  // resolves `false` (slot shown) on RC failure.
  const { gptPocSlot: killed } = useKillSwitches();
  const active = GPT_POC_ENABLED && IS_PROD && !SKIP_FOR_BOT && !killed;

  useEffect(() => {
    if (!active) return;
    const divId = divIdRef.current;

    // Initialise the GPT framework EARLY (post-load idle, not on scroll): the GAM
    // Offerwall evaluates at page entry, so GPT must be present then or the wall
    // never shows. The ad slot itself stays lazy (IntersectionObserver below) to
    // protect CWV — only the lightweight gpt.js load + enableServices runs early.
    const initGptFramework = () => {
      ensureGptScript();
      const gt = gtag();
      gt.cmd.push(() => {
        try {
          if (!gptServicesEnabled) {
            gptServicesEnabled = true;
            // Modern GPT config API (pubads().enableSingleRequest() is deprecated).
            gt.setConfig({ singleRequest: true });
            gt.pubads().collapseEmptyDivs(true);
            gt.enableServices();
          }
        } catch { /* fail-soft */ }
      });
    };
    const ric: (cb: () => void) => void =
      (window as any).requestIdleCallback
        ? (cb) => (window as any).requestIdleCallback(cb, { timeout: 3000 })
        : (cb) => window.setTimeout(cb, 1200);
    ric(initGptFramework);

    const wrapper = wrapperRef.current;
    if (!wrapper || typeof IntersectionObserver === 'undefined') return;
    let defined = false;
    const defineAndDisplay = () => {
      if (defined) return;
      defined = true;
      ensureGptScript();
      const gt = gtag();
      gt.cmd.push(() => {
        try {
          const slot = gt
            .defineSlot(GPT_POC_AD_UNIT_PATH, GPT_POC_SIZES, divId)
            ?.addService(gt.pubads());
          if (!slot) return;
          gt.display(divId);
          setRendered(true);
        } catch {
          /* fail-soft: never let a PoC ad break the page */
        }
      });
    };

    const io = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          io.disconnect();
          defineAndDisplay();
          return;
        }
      }
    }, { rootMargin: '200px 0px' });
    io.observe(wrapper);
    return () => io.disconnect();
  }, [active]);

  if (!active) return null;

  return (
    <div
      ref={wrapperRef}
      aria-hidden={!rendered}
      // Reserve space to avoid CLS when the creative fills (mirrors
      // placeholderMinHeight in services/adsenseSlots.ts).
      style={{ minHeight: 250, contain: 'layout' }}
      className="mx-auto my-6 w-full max-w-[336px] text-center"
    >
      <div id={divIdRef.current} />
    </div>
  );
};

export default GptPocSlot;
