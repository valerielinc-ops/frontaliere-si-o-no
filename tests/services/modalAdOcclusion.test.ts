// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GOOGLE_ANCHOR_TAB_ALLOWANCE_PX, observeGoogleAdEdgeInsets, observeGoogleAdOverlays } from '@/services/modalAdOcclusion';
import { APPLICATION_OFFER_AD_INSET_VAR, APPLICATION_OFFER_CARD_ROOM } from '@/components/community/useApplicationOfferAdClearance';
const cleanups: Array<() => void> = [];
afterEach(() => { cleanups.splice(0).forEach((f) => f()); document.body.innerHTML = ''; });
function ad(fixed: boolean) {
 const el = document.createElement('ins');
 el.className = fixed ? 'adsbygoogle adsbygoogle-noablate' : 'google-auto-placed';
 el.style.position = fixed ? 'fixed' : 'static';
 el.style.display = 'block';
 el.getBoundingClientRect = () => ({ top: 650, bottom: 750, width: 390, height: 100, left: 0, right: 390 } as DOMRect);
 el.innerHTML = '<div><iframe id="aswift_1"></iframe></div>';
 document.body.append(el); return el;
}
describe('promotions yield to Google overlays without suppressing ads', () => {
 it('detects anchors and leaves exact inline styles untouched', () => {
  const el = ad(true); const before = el.getAttribute('style'); const notify = vi.fn();
  const stop = observeGoogleAdOverlays(notify); cleanups.push(stop);
  expect(notify).toHaveBeenLastCalledWith(true);
  expect(el.getAttribute('style')).toBe(before);
  stop(); expect(el.getAttribute('style')).toBe(before);
 });
 it('does not block on in-page ads or on closed overlays', async () => {
  const el = ad(false); const notify = vi.fn(); cleanups.push(observeGoogleAdOverlays(notify));
  expect(notify).toHaveBeenLastCalledWith(false);
  el.style.position = 'fixed'; await Promise.resolve(); expect(notify).toHaveBeenLastCalledWith(true);
  el.style.display = 'none'; await Promise.resolve(); expect(notify).toHaveBeenLastCalledWith(false);
 });
 it('measures the edge an anchor takes, past its collapse tab, without touching the ad', async () => {
  // jsdom viewport: 768 px high. A bottom anchor 118 px high.
  const el = ad(true); el.getBoundingClientRect = () => ({ top: 650, bottom: 768, width: 728, height: 118, left: 0, right: 728 } as DOMRect);
  const before = el.getAttribute('style'); const notify = vi.fn();
  cleanups.push(observeGoogleAdEdgeInsets(notify));
  expect(notify).toHaveBeenLastCalledWith({ top: 0, bottom: 118 + GOOGLE_ANCHOR_TAB_ALLOWANCE_PX });
  expect(el.getAttribute('style')).toBe(before);
  // Collapsed or closed: no inset; an unchanged scan reports nothing.
  el.style.display = 'none'; await Promise.resolve(); expect(notify).toHaveBeenLastCalledWith({ top: 0, bottom: 0 });
  const calls = notify.mock.calls.length; el.setAttribute('data-anchor-status', 'dismissed'); await Promise.resolve();
  expect(notify.mock.calls.length).toBe(calls);
 });
 it('measures a top anchor, and ignores vignettes and fixed ads off the edges', () => {
  const top = ad(true); top.getBoundingClientRect = () => ({ top: 0, bottom: 60, width: 390, height: 60, left: 0, right: 390 } as DOMRect);
  const vignette = ad(true); vignette.getBoundingClientRect = () => ({ top: 0, bottom: 768, width: 1024, height: 768, left: 0, right: 1024 } as DOMRect);
  const floating = ad(true); floating.getBoundingClientRect = () => ({ top: 300, bottom: 400, width: 300, height: 100, left: 0, right: 300 } as DOMRect);
  const inPage = ad(false); inPage.getBoundingClientRect = () => ({ top: 700, bottom: 768, width: 300, height: 68, left: 0, right: 300 } as DOMRect);
  const notify = vi.fn(); cleanups.push(observeGoogleAdEdgeInsets(notify));
  expect(notify).toHaveBeenLastCalledWith({ top: 60 + GOOGLE_ANCHOR_TAB_ALLOWANCE_PX, bottom: 0 });
 });
 it('keeps the application offer dialogs clear of the anchor', () => {
  const hook = readFileSync(resolve(process.cwd(), 'components/community/useApplicationOfferAdClearance.ts'), 'utf8');
  expect(hook).toContain('observeGoogleAdEdgeInsets(setInsets)');
  // Every card gets the reduced max height and scrolls, so a long one never runs under the anchor.
  for (const [file, cards] of [['AssistedApplicationOffer.tsx', 1], ['RewardedApplicationOffer.tsx', 3]] as const) {
   const src = readFileSync(resolve(process.cwd(), 'components/community', file), 'utf8');
   expect(src, file).toContain('useApplicationOfferAdClearance()');
   expect(src, file).toContain('style={adClearance.overlayStyle}');
   expect(src.split('style={adClearance.cardStyle}').length - 1, file).toBe(cards);
   expect(src.split('role="dialog"').length - 1, `${file}: one clearance per dialog card`).toBe(cards);
  }
  const rewarded = readFileSync(resolve(process.cwd(), 'components/community/RewardedApplicationOffer.tsx'), 'utf8');
  expect(rewarded).toMatch(/const cardClass = '[^']*overflow-y-auto/);
  // The cards subtract the anchor's height through a custom property, so the breakpoint caps
  // stay in the classes: an inline max-height capped phones at 42rem too (live 2026-10-07).
  expect(APPLICATION_OFFER_CARD_ROOM).toContain(`var(${APPLICATION_OFFER_AD_INSET_VAR},0px)`);
  expect(hook).toContain('[APPLICATION_OFFER_AD_INSET_VAR]:');
  expect(hook).not.toContain('maxHeight');
  expect(rewarded).toContain(`const cardClass = 'max-h-[${APPLICATION_OFFER_CARD_ROOM}] `);
  const assisted = readFileSync(resolve(process.cwd(), 'components/community/AssistedApplicationOffer.tsx'), 'utf8');
  expect(assisted).toContain(` max-h-[${APPLICATION_OFFER_CARD_ROOM}] `);
  expect(assisted).toContain(` sm:max-h-[min(90dvh,42rem,${APPLICATION_OFFER_CARD_ROOM})] `);
 });
 it('keeps Auto Ads selectors out of modal suppression CSS and JS', () => {
  const css = readFileSync(resolve(process.cwd(), 'index.css'), 'utf8');
  const popup = readFileSync(resolve(process.cwd(), 'components/community/NewsletterPopup.tsx'), 'utf8');
  expect(css).not.toMatch(/body\.modal-open\s+(?:ins|iframe|\[|\.google-auto-placed)/);
  expect(popup).not.toContain('suppressGoogleAdOverlays');
  expect(popup).toContain('observeGoogleAdOverlays(setGoogleOverlayActive)');
 });
});
