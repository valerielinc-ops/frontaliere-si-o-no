// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
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

 it.each([250, 300])('reserves the full visible %ipx anchor without overlapping its creative', (height) => {
 setViewport(390, 800);
 addAutoAd('fixed', { top: 800 - height, bottom: 800, width: 390, height });

 expect(measureAutoAdOverlayClearance()).toBe(height);
 });

 it('reserves only the visible part of an anchor extending below the viewport', () => {
 setViewport(390, 800);
 addAutoAd('fixed', { top: 740, bottom: 990, width: 390, height: 250 });

 expect(measureAutoAdOverlayClearance()).toBe(60);
 });

 it.each(['display: none', 'visibility: hidden', 'visibility: collapse', 'opacity: 0'])('ignores hidden anchor styles: %s', (hiddenStyle) => {
 setViewport(390, 800);
 const element = addAutoAd('fixed', { top: 550, bottom: 800, width: 390, height: 250 });
 element.style.cssText = `position: fixed; ${hiddenStyle}`;

 expect(measureAutoAdOverlayClearance()).toBe(0);
 });

 it('ignores an anchor inside a transparent ancestor', () => {
 setViewport(390, 800);
 const element = addAutoAd('fixed', { top: 550, bottom: 800, width: 390, height: 250 });
 const wrapper = document.createElement('div');
 wrapper.style.opacity = '0';
 document.body.appendChild(wrapper);
 wrapper.appendChild(element);

 expect(measureAutoAdOverlayClearance()).toBe(0);
 });

 it.each([
 { top: 0, bottom: 250, width: 390, height: 250 },
 { top: 0, bottom: 800, width: 390, height: 800 },
 { top: -40, bottom: 800, width: 390, height: 840 },
 ])('ignores top anchors and fullscreen vignettes: %o', (rect) => {
 setViewport(390, 800);
 addAutoAd('fixed', rect);

 expect(measureAutoAdOverlayClearance()).toBe(0);
 });

 it('ignores a fixed anchor translated outside the viewport horizontally', () => {
 setViewport(390, 800);
 const element = addAutoAd('fixed', { top: 550, bottom: 800, width: 390, height: 250 });
 vi.spyOn(element, 'getBoundingClientRect').mockReturnValue({
 top: 550, bottom: 800, width: 390, height: 250, left: 390, right: 780,
 x: 390, y: 550, toJSON: () => ({}),
 });

 expect(measureAutoAdOverlayClearance()).toBe(0);
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
