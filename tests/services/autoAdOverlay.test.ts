// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
 MAX_AUTO_AD_OVERLAY_CLEARANCE_PX,
 measureAutoAdOverlayClearance,
 subscribeToAutoAdOverlay,
} from '@/services/autoAdOverlay';

function setViewport(width: number, height: number): void {
 Object.defineProperty(window, 'innerWidth', { configurable: true, value: width });
 Object.defineProperty(window, 'innerHeight', { configurable: true, value: height });
}

function addAutoAd(
 position: 'fixed' | 'static',
 rect: { top: number; bottom: number; width: number; height: number },
): HTMLDivElement {
 const element = document.createElement('div');
 element.className = 'google-auto-placed';
 element.style.position = position;
 Object.defineProperty(element, 'getBoundingClientRect', {
 configurable: true,
 value: () => ({ ...rect, left: 0, right: rect.width, x: 0, y: rect.top, toJSON: () => ({}) }),
 });
 document.body.appendChild(element);
 return element;
}

describe('autoAdOverlay', () => {
 afterEach(() => {
 document.body.innerHTML = '';
 });

 it('returns zero for in-flow Auto Ads', () => {
 setViewport(390, 800);
 addAutoAd('static', { top: 550, bottom: 800, width: 390, height: 250 });

 expect(measureAutoAdOverlayClearance()).toBe(0);
 });

 it('returns the visible height of a fixed bottom anchor', () => {
 setViewport(390, 800);
 addAutoAd('fixed', { top: 740, bottom: 800, width: 390, height: 60 });

 expect(measureAutoAdOverlayClearance()).toBe(60);
 });

 it('caps unusually tall overlays so a prompt stays usable', () => {
 setViewport(390, 800);
 addAutoAd('fixed', { top: 500, bottom: 800, width: 390, height: 300 });

 expect(measureAutoAdOverlayClearance()).toBe(MAX_AUTO_AD_OVERLAY_CLEARANCE_PX);
 });

 it('ignores fixed elements that are too narrow to be an anchor', () => {
 setViewport(390, 800);
 addAutoAd('fixed', { top: 740, bottom: 800, width: 180, height: 60 });

 expect(measureAutoAdOverlayClearance()).toBe(0);
 });

 it('refreshes when an existing candidate becomes a fixed bottom anchor', async () => {
 setViewport(390, 800);
 const element = addAutoAd('static', { top: 740, bottom: 800, width: 390, height: 60 });
 const requestAnimationFrame = vi
 .spyOn(window, 'requestAnimationFrame')
 .mockImplementation((callback) => {
  return window.setTimeout(() => callback(0), 0);
 });
 const listener = vi.fn();
 const unsubscribe = subscribeToAutoAdOverlay(listener);

 await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
 expect(listener).toHaveBeenLastCalledWith(0);
 Object.defineProperty(element, 'getBoundingClientRect', {
  configurable: true,
  value: () => ({
  top: 740,
  bottom: 800,
  width: 390,
  height: 60,
  left: 0,
  right: 390,
  x: 0,
  y: 740,
  toJSON: () => ({}),
  }),
 });
 element.style.position = 'fixed';

 await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
 await new Promise<void>((resolve) => window.setTimeout(resolve, 0));

 expect(listener).toHaveBeenLastCalledWith(60);
 expect(requestAnimationFrame).toHaveBeenCalled();
 unsubscribe();
 });
});
