// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
 NAV_OVERLAY_GAP_PX,
 NAV_OVERLAY_SHIFT_ATTR,
 findCoveringOverlay,
 installNavOverlayGuard,
 navOverlayShift,
} from '@/services/navOverlayGuard';

type Box = { top: number; left: number; width: number; height: number };

function setViewport(width: number, height: number): void {
 Object.defineProperty(window, 'innerWidth', { configurable: true, value: width });
 Object.defineProperty(window, 'innerHeight', { configurable: true, value: height });
}

/** Stubs layout: the box moves with the element's `translate` like a browser would. */
function setBox(element: HTMLElement, box: Box): void {
 Object.defineProperty(element, 'getBoundingClientRect', {
 configurable: true,
 value: () => {
 const shift = Number.parseFloat((element.style.getPropertyValue('translate') || '0 0').split(' ')[1] || '0') || 0;
 const top = box.top + shift;
 return { top, bottom: top + box.height, left: box.left, right: box.left + box.width, width: box.width, height: box.height, x: box.left, y: top, toJSON: () => ({}) };
 },
 });
}

function markReact(element: HTMLElement): void {
 (element as unknown as Record<string, unknown>)['__reactFiber$test'] = {};
}

function mountNav(): HTMLElement {
 const root = document.createElement('div');
 root.id = 'root';
 const nav = document.createElement('nav');
 markReact(nav);
 const button = document.createElement('button');
 markReact(button);
 nav.appendChild(button);
 root.appendChild(nav);
 document.body.appendChild(root);
 setBox(nav, { top: 0, left: 0, width: 1540, height: 81 });
 return nav;
}

function mountChip(box: Box): { host: HTMLElement; chip: HTMLElement } {
 const host = document.createElement('div');
 host.style.position = 'fixed';
 const chip = document.createElement('span');
 host.appendChild(chip);
 document.body.appendChild(host);
 setBox(host, box);
 setBox(chip, box);
 return { host, chip };
}

/** Routes elementFromPoint to whichever stubbed box is on top at (x, y). */
function stubHitTesting(layers: HTMLElement[]): void {
 Object.defineProperty(document, 'elementFromPoint', {
 configurable: true,
 value: (x: number, y: number) => {
 for (const element of layers) {
 const r = element.getBoundingClientRect();
 if (x >= r.left && x < r.right && y >= r.top && y < r.bottom) return element;
 }
 return null;
 },
 });
}

async function flushFrames(): Promise<void> {
 await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
 await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
}

describe('navOverlayShift', () => {
 it('moves a box that overlaps the nav band just below it', () => {
 expect(navOverlayShift(14, 48, 0, 81)).toBe(81 + NAV_OVERLAY_GAP_PX - 14);
 });

 it('leaves a box below the nav where it is', () => {
 expect(navOverlayShift(566, 48, 0, 81)).toBe(0);
 });
});

describe('findCoveringOverlay', () => {
 afterEach(() => {
 document.body.innerHTML = '';
 });

 it('returns the outermost fixed box a third party injected', () => {
 setViewport(1540, 900);
 const { host, chip } = mountChip({ top: 14, left: 1017, width: 505, height: 48 });
 expect(findCoveringOverlay(chip, 1540, 900)).toBe(host);
 });

 it('ignores our own React-rendered UI', () => {
 setViewport(1540, 900);
 const { host, chip } = mountChip({ top: 14, left: 1017, width: 505, height: 48 });
 markReact(host);
 markReact(chip);
 expect(findCoveringOverlay(chip, 1540, 900)).toBeNull();
 });

 it('leaves full-viewport layers (consent, vignette) alone', () => {
 setViewport(1540, 900);
 const { chip } = mountChip({ top: 0, left: 0, width: 1540, height: 900 });
 expect(findCoveringOverlay(chip, 1540, 900)).toBeNull();
 });

 it('leaves a viewport-wide but short panel alone, including its positioned children', () => {
 setViewport(1540, 1000);
 const { host, chip } = mountChip({ top: 0, left: 0, width: 1540, height: 300 });
 chip.style.position = 'absolute';
 setBox(chip, { top: 20, left: 1400, width: 120, height: 40 });
 expect(findCoveringOverlay(host, 1540, 1000)).toBeNull();
 expect(findCoveringOverlay(chip, 1540, 1000)).toBeNull();
 });

 it('looks inside a click-through viewport-wide layer for the chip it hosts', () => {
 setViewport(1540, 900);
 const { host, chip } = mountChip({ top: 0, left: 0, width: 1540, height: 900 });
 host.style.pointerEvents = 'none';
 chip.style.position = 'fixed';
 setBox(chip, { top: 14, left: 1017, width: 505, height: 48 });
 expect(findCoveringOverlay(chip, 1540, 900)).toBe(chip);
 });
});

describe('installNavOverlayGuard', () => {
 beforeEach(() => {
 vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => window.setTimeout(() => callback(0), 0));
 vi.spyOn(window, 'cancelAnimationFrame').mockImplementation((id) => window.clearTimeout(id));
 });

 afterEach(() => {
 vi.restoreAllMocks();
 document.body.innerHTML = '';
 });

 it('moves a chip that covers the nav below it without hiding it, and restores it on teardown', async () => {
 setViewport(1540, 900);
 const nav = mountNav();
 const { host } = mountChip({ top: 14, left: 1017, width: 505, height: 48 });
 stubHitTesting([host, nav]);

 const teardown = installNavOverlayGuard(nav);
 await flushFrames();

 const expected = 81 + NAV_OVERLAY_GAP_PX - 14;
 expect(host.style.getPropertyValue('translate')).toBe(`0 ${expected}px`);
 expect(host.getAttribute(NAV_OVERLAY_SHIFT_ATTR)).toBe(String(expected));
 expect(host.getBoundingClientRect().top).toBe(81 + NAV_OVERLAY_GAP_PX);
 expect(host.style.display).toBe('');
 expect(host.style.visibility).toBe('');
 expect(host.isConnected).toBe(true);

 teardown();
 expect(host.style.getPropertyValue('translate')).toBe('');
 expect(host.hasAttribute(NAV_OVERLAY_SHIFT_ATTR)).toBe(false);
 });

 it('drops the offset once the overlay moves away from the nav on its own', async () => {
 setViewport(1540, 900);
 const nav = mountNav();
 const { host } = mountChip({ top: 14, left: 1017, width: 505, height: 48 });
 stubHitTesting([host, nav]);

 const teardown = installNavOverlayGuard(nav);
 await flushFrames();
 expect(host.hasAttribute(NAV_OVERLAY_SHIFT_ATTR)).toBe(true);

 // Google re-anchors the chip at the bottom of the viewport.
 setBox(host, { top: 790, left: 1017, width: 505, height: 48 });
 window.dispatchEvent(new Event('scroll'));
 await flushFrames();

 expect(host.style.getPropertyValue('translate')).toBe('');
 expect(host.hasAttribute(NAV_OVERLAY_SHIFT_ATTR)).toBe(false);
 teardown();
 });

 it('re-measures a moved overlay on the next frame when CSS moves it without any event', async () => {
 setViewport(1540, 900);
 const nav = mountNav();
 const { host } = mountChip({ top: 14, left: 1017, width: 505, height: 48 });
 stubHitTesting([host, nav]);

 const teardown = installNavOverlayGuard(nav);
 await flushFrames();
 expect(host.getAttribute(NAV_OVERLAY_SHIFT_ATTR)).toBe(String(81 + NAV_OVERLAY_GAP_PX - 14));

 // A CSS transition drops the chip's own top from 14px to 30px: no mutation,
 // scroll or resize is dispatched.
 setBox(host, { top: 30, left: 1017, width: 505, height: 48 });
 await flushFrames();

 expect(host.getAttribute(NAV_OVERLAY_SHIFT_ATTR)).toBe(String(81 + NAV_OVERLAY_GAP_PX - 30));
 expect(host.getBoundingClientRect().top).toBeGreaterThanOrEqual(81);
 teardown();
 });

 it('does not move a viewport-wide short panel that covers the nav', async () => {
 setViewport(1540, 1000);
 const nav = mountNav();
 const { host } = mountChip({ top: 0, left: 0, width: 1540, height: 300 });
 stubHitTesting([host, nav]);

 const teardown = installNavOverlayGuard(nav);
 await flushFrames();

 expect(host.hasAttribute(NAV_OVERLAY_SHIFT_ATTR)).toBe(false);
 expect(host.style.getPropertyValue('translate')).toBe('');
 teardown();
 });

 it('does nothing when only the nav is on the nav band', async () => {
 setViewport(1540, 900);
 const nav = mountNav();
 const { host } = mountChip({ top: 790, left: 1017, width: 505, height: 48 });
 stubHitTesting([host, nav]);

 const teardown = installNavOverlayGuard(nav);
 await flushFrames();

 expect(host.style.getPropertyValue('translate')).toBe('');
 teardown();
 });
});
