/**
 * How many of the page's ads are still on screen, for the rewarded
 * application offer's snapshots (RewardedApplicationOffer).
 *
 * The owner saw the page's ads disappear behind the offer's loader after the
 * "Candidati" click, before Google's Offerwall appeared (2026-09-30). Nothing
 * in the site's code hides them on that path, so the snapshots measure it
 * instead of guessing: one at the click, one after the Offerwall is on screen,
 * one when the visitor comes back to the tab after the employer's page opened.
 * `ads_total - ads_visible` is the number of rendered ads that are hidden at
 * that moment; the three GA4 metrics are registered by
 * scripts/setup-ga4-ad-page-diag-definitions.mjs.
 *
 * An ad counts once it has a creative: a filled manual slot, an Auto ads
 * container with a creative, the displayed Auto ads anchor, a GPT (GAM) slot
 * iframe (the rewarded video's own slot excluded). The vignette is left out:
 * it is hidden by design until Google triggers it.
 */

import { isManualSlot } from './adSlotKinds';

export interface AdVisibility {
  ads_total: number;
  ads_visible: number;
  anchor_visible: 0 | 1;
}

/** Rendered: no `display: none` up the tree, not invisible, not zero-sized. */
function isRendered(el: Element, doc: Document): boolean {
  const view = doc.defaultView;
  if (!view || !el.isConnected) return false;
  for (let node: Element | null = el; node && node !== doc.documentElement; node = node.parentElement) {
    const style = view.getComputedStyle(node);
    if (style.display === 'none' || style.opacity === '0') return false;
    if (node === el && style.visibility === 'hidden') return false;
  }
  const rect = el.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

export function collectAdVisibility(doc: Document = document): AdVisibility {
  const ads: Element[] = [];
  doc.querySelectorAll('ins.adsbygoogle[data-ad-status="filled"]').forEach((el) => {
    if (isManualSlot(el)) ads.push(el);
  });
  doc.querySelectorAll('.google-auto-placed').forEach((el) => {
    if (el.querySelector('iframe, ins[data-ad-status="filled"]')) ads.push(el);
  });
  const anchor = doc.querySelector('ins[data-anchor-status="displayed"]');
  if (anchor) ads.push(anchor);
  doc.querySelectorAll('iframe[id^="google_ads_iframe_"]').forEach((el) => {
    if (!/rewarded/i.test(el.id)) ads.push(el);
  });
  let visible = 0;
  for (const el of ads) if (isRendered(el, doc)) visible++;
  return {
    ads_total: ads.length,
    ads_visible: visible,
    anchor_visible: anchor && isRendered(anchor, doc) ? 1 : 0,
  };
}

/** How long a hand-off waits for the visitor to come back to the tab. */
export const RETURN_TO_TAB_MAX_WAIT_MS = 30 * 60 * 1000;
/** Lets Google finish what it does on the return (the vignette trigger). */
export const RETURN_TO_TAB_SETTLE_MS = 2000;

let disarmPrevious: (() => void) | null = null;

/**
 * Calls `onReturn` once, `settleMs` after the page comes back to the
 * foreground following a hide (the employer's tab took it, then the visitor
 * came back). Only one watch is armed at a time; it gives up after
 * `maxWaitMs`. Returns the disarm function.
 */
export function watchReturnToTab(
  onReturn: () => void,
  { maxWaitMs = RETURN_TO_TAB_MAX_WAIT_MS, settleMs = RETURN_TO_TAB_SETTLE_MS }: { maxWaitMs?: number; settleMs?: number } = {},
): () => void {
  disarmPrevious?.();
  if (typeof document === 'undefined' || typeof window === 'undefined') return () => {};
  let wasHidden = document.visibilityState === 'hidden';
  let settleTimer: ReturnType<typeof setTimeout> | null = null;
  const onVisibility = () => {
    if (document.visibilityState === 'hidden') {
      wasHidden = true;
      return;
    }
    if (!wasHidden || settleTimer) return;
    document.removeEventListener('visibilitychange', onVisibility);
    settleTimer = setTimeout(() => {
      disarm();
      onReturn();
    }, settleMs);
  };
  const giveUp = setTimeout(() => disarm(), maxWaitMs);
  function disarm() {
    clearTimeout(giveUp);
    if (settleTimer) clearTimeout(settleTimer);
    document.removeEventListener('visibilitychange', onVisibility);
    if (disarmPrevious === disarm) disarmPrevious = null;
  }
  document.addEventListener('visibilitychange', onVisibility);
  disarmPrevious = disarm;
  return disarm;
}
