/** Adapted local-only quick bait from IAB AdBlockDetection 1.0 (BSD-3).
 * Upstream: InteractiveAdvertisingBureau/AdBlockDetection/adblockDetector.js.
 * No remote lists, eval, tracking pixels or requests before CMP consent.
 * A plain control node distinguishes hidden documents/layout from filtering.
 * Copyright (c) 2017 IAB. License: docs/licenses/iab-adblock-detection.txt.
 */
export function probeIabAdBlock(): Promise<'blocked' | 'clear' | 'unknown'> {
  return new Promise((resolve) => {
    if (!document.body || document.visibilityState === 'hidden') { resolve('unknown'); return; }
    const bait = document.createElement('div');
    const control = document.createElement('div');
    bait.className = 'pub_300x250 pub_300x250m pub_728x90 text-ad textAd text_ad text_ads text-ads text-ad-links adsbox';
    const style = 'position:absolute;left:-10000px;top:-1000px;width:1px;height:1px;pointer-events:none;';
    for (const el of [bait, control]) { el.style.cssText = style; el.setAttribute('aria-hidden', 'true'); document.body.appendChild(el); }
    let count = 0;
    const visible = (el: HTMLElement) => { const css = getComputedStyle(el); const box = el.getBoundingClientRect(); return el.isConnected && box.width > 0 && box.height > 0 && css.display !== 'none' && css.visibility !== 'hidden'; };
    const finish = (result: 'blocked' | 'clear' | 'unknown') => { bait.remove(); control.remove(); resolve(result); };
    const check = () => {
      try {
        if (document.visibilityState === 'hidden' || !visible(control)) { finish('unknown'); return; }
        if (!visible(bait)) { finish('blocked'); return; }
        if (++count >= 6) { finish('clear'); return; }
        setTimeout(check, 150);
      } catch { finish('unknown'); }
    };
    setTimeout(check, 150);
  });
}
