// @vitest-environment jsdom

import { afterEach, describe, expect, it } from 'vitest';

import { hasVisibleBottomOverlay } from '../components/shared/visibleBottomOverlay';

function setRect(element: HTMLElement, rect: Partial<DOMRect>) {
  Object.defineProperty(element, 'getBoundingClientRect', {
    configurable: true,
    value: () => ({
      top: 100,
      right: 300,
      bottom: 200,
      left: 100,
      width: 200,
      height: 100,
      ...rect,
    }),
  });
}

afterEach(() => {
  document.body.replaceChildren();
});

describe('job-search floating button overlay guard', () => {
  it('detects a visible bottom overlay', () => {
    const overlay = document.createElement('div');
    overlay.dataset.bottomOverlay = 'communications-consent';
    setRect(overlay, { top: 640, bottom: 740, width: 390, height: 100 });
    document.body.append(overlay);

    expect(hasVisibleBottomOverlay()).toBe(true);
  });

  it('detects a visible modal dialog', () => {
    const modal = document.createElement('div');
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    setRect(modal, { top: 120, bottom: 600, width: 360, height: 480 });
    document.body.append(modal);

    expect(hasVisibleBottomOverlay()).toBe(true);
  });

  it('ignores hidden and off-screen overlays', () => {
    const hidden = document.createElement('div');
    hidden.dataset.bottomOverlay = 'hidden';
    hidden.style.display = 'none';
    setRect(hidden, { top: 640, bottom: 740, width: 390, height: 100 });

    const offScreen = document.createElement('div');
    offScreen.dataset.bottomOverlay = 'off-screen';
    setRect(offScreen, { top: window.innerHeight + 1, bottom: window.innerHeight + 101 });
    document.body.append(hidden, offScreen);

    expect(hasVisibleBottomOverlay()).toBe(false);
  });
});
