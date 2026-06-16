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
  w.googletag = w.googletag || { cmd: [] };
  return w.googletag;
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

  useEffect(() => {
    if (!GPT_POC_ENABLED || !IS_PROD || SKIP_FOR_BOT) return;
    const wrapper = wrapperRef.current;
    if (!wrapper || typeof IntersectionObserver === 'undefined') return;

    const divId = divIdRef.current;
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
          if (!gptServicesEnabled) {
            gptServicesEnabled = true;
            gt.pubads().enableSingleRequest();
            gt.pubads().collapseEmptyDivs(true);
            gt.enableServices();
          }
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
  }, []);

  if (!GPT_POC_ENABLED || !IS_PROD || SKIP_FOR_BOT) return null;

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
