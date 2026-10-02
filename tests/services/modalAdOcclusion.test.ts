// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { observeGoogleAdOverlays } from '@/services/modalAdOcclusion';
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
 it('keeps Auto Ads selectors out of modal suppression CSS and JS', () => {
  const css = readFileSync(resolve(process.cwd(), 'index.css'), 'utf8');
  const popup = readFileSync(resolve(process.cwd(), 'components/community/NewsletterPopup.tsx'), 'utf8');
  expect(css).not.toMatch(/body\.modal-open\s+(?:ins|iframe|\[|\.google-auto-placed)/);
  expect(popup).not.toContain('suppressGoogleAdOverlays');
  expect(popup).toContain('observeGoogleAdOverlays(setGoogleOverlayActive)');
 });
});
