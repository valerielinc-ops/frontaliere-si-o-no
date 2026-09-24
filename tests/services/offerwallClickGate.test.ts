// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  OFFERWALL_APPEAR_TIMEOUT_MS,
  isOfferwallHeld,
  releaseHeldOfferwall,
} from '@/services/offerwallClickGate';

function holdOfferwall(onRelease: () => void = () => {}): void {
  window.__ftOfferwallGate = {
    state: 'held',
    release() {
      if (window.__ftOfferwallGate?.state !== 'held') return false;
      window.__ftOfferwallGate.state = 'released';
      onRelease();
      return true;
    },
  };
}

function mountRoot(className: string): HTMLDivElement {
  const el = document.createElement('div');
  el.className = className;
  document.body.appendChild(el);
  return el;
}

describe('offerwallClickGate', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    delete window.__ftOfferwallGate;
    document.body.innerHTML = '';
  });

  it('reports not_held when Funding Choices never held an Offerwall on this page', async () => {
    expect(isOfferwallHeld()).toBe(false);
    await expect(releaseHeldOfferwall()).resolves.toEqual({ outcome: 'not_shown', reason: 'not_held' });
  });

  it('reports release_refused when the gate was already released', async () => {
    window.__ftOfferwallGate = { state: 'held', release: () => false };
    await expect(releaseHeldOfferwall()).resolves.toEqual({ outcome: 'not_shown', reason: 'release_refused' });
  });

  it('hands over to the GPT path when no Offerwall renders in time', async () => {
    holdOfferwall();
    const onShown = vi.fn();
    const pending = releaseHeldOfferwall({ onShown });
    expect(window.__ftOfferwallGate?.state).toBe('released');
    await vi.advanceTimersByTimeAsync(OFFERWALL_APPEAR_TIMEOUT_MS + 400);
    await expect(pending).resolves.toEqual({ outcome: 'not_shown', reason: 'appear_timeout' });
    expect(onShown).not.toHaveBeenCalled();
  });

  it('follows the Offerwall root from release to completion', async () => {
    let root: HTMLDivElement | null = null;
    holdOfferwall(() => {
      setTimeout(() => {
        root = mountRoot('fc-monetization-root');
      }, 600);
    });
    const onShown = vi.fn();
    const pending = releaseHeldOfferwall({ onShown });

    await vi.advanceTimersByTimeAsync(1000);
    expect(onShown).toHaveBeenCalledWith(expect.objectContaining({ root: 'fc-monetization-root' }));

    root!.remove();
    await vi.advanceTimersByTimeAsync(400);
    await expect(pending).resolves.toMatchObject({ outcome: 'completed', root: 'fc-monetization-root' });
  });

  it('treats a root hidden in place as completed', async () => {
    let root: HTMLDivElement | null = null;
    holdOfferwall(() => {
      root = mountRoot('fc-offerwall-root');
    });
    const pending = releaseHeldOfferwall();
    await vi.advanceTimersByTimeAsync(400);
    root!.style.display = 'none';
    await vi.advanceTimersByTimeAsync(400);
    await expect(pending).resolves.toMatchObject({ outcome: 'completed' });
  });

  it('never mistakes the consent message already on screen for the Offerwall', async () => {
    mountRoot('fc-consent-root');
    holdOfferwall();
    const onShown = vi.fn();
    const pending = releaseHeldOfferwall({ onShown });
    await vi.advanceTimersByTimeAsync(OFFERWALL_APPEAR_TIMEOUT_MS + 400);
    await expect(pending).resolves.toEqual({ outcome: 'not_shown', reason: 'appear_timeout' });
    expect(onShown).not.toHaveBeenCalled();
  });

  it('stops waiting once the completion bound is reached', async () => {
    holdOfferwall(() => {
      mountRoot('fc-monetization-root');
    });
    const pending = releaseHeldOfferwall({ completionTimeoutMs: 5000 });
    await vi.advanceTimersByTimeAsync(6000);
    await expect(pending).resolves.toMatchObject({ outcome: 'timed_out', root: 'fc-monetization-root' });
  });
});
