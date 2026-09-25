// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  FC_OFFERWALL_ENTITLEMENT_COOKIE,
  OFFERWALL_APPEAR_TIMEOUT_MS,
  OFFERWALL_ENTITLEMENT_GRACE_MS,
  isOfferwallHeld,
  offerwallGateStatus,
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

function setEntitlement(value: string): void {
  document.cookie = `${FC_OFFERWALL_ENTITLEMENT_COOKIE}=${value}; path=/`;
}

describe('offerwallClickGate', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    delete window.__ftOfferwallGate;
    document.body.innerHTML = '';
    document.cookie = `${FC_OFFERWALL_ENTITLEMENT_COOKIE}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/`;
  });

  it('reports the gate status the click finds', () => {
    expect(offerwallGateStatus()).toBe('absent');
    window.__ftOfferwallGate = { state: 'suppressed' };
    expect(offerwallGateStatus()).toBe('suppressed');
    window.__ftOfferwallGate = { state: 'released' };
    expect(offerwallGateStatus()).toBe('released');
    window.__ftOfferwallGate = { state: 'held' };
    expect(offerwallGateStatus(), 'held without a release function is unusable').toBe('absent');
    holdOfferwall();
    expect(offerwallGateStatus()).toBe('held');
    expect(isOfferwallHeld()).toBe(true);
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

  it('completes when the root closes after Google granted the reward', async () => {
    let root: HTMLDivElement | null = null;
    holdOfferwall(() => {
      setTimeout(() => {
        root = mountRoot('fc-message-root');
      }, 600);
    });
    const onShown = vi.fn();
    const pending = releaseHeldOfferwall({ onShown });

    await vi.advanceTimersByTimeAsync(1000);
    expect(onShown).toHaveBeenCalledWith(expect.objectContaining({ root: 'fc-message-root' }));

    // Live order: entitlement cookie on the thank-you screen, root removed ~3 s later.
    setEntitlement('granted-1');
    await vi.advanceTimersByTimeAsync(3000);
    root!.remove();
    await vi.advanceTimersByTimeAsync(400);
    await expect(pending).resolves.toMatchObject({ outcome: 'completed', root: 'fc-message-root' });
  });

  it('waits a short grace for an entitlement set right after the close', async () => {
    let root: HTMLDivElement | null = null;
    holdOfferwall(() => {
      root = mountRoot('fc-offerwall-root');
    });
    const pending = releaseHeldOfferwall();
    await vi.advanceTimersByTimeAsync(400);
    root!.style.display = 'none';
    await vi.advanceTimersByTimeAsync(OFFERWALL_ENTITLEMENT_GRACE_MS / 2);
    setEntitlement('granted-2');
    await vi.advanceTimersByTimeAsync(400);
    await expect(pending).resolves.toMatchObject({ outcome: 'completed' });
  });

  it('reports closed_without_reward when no entitlement follows the close', async () => {
    let root: HTMLDivElement | null = null;
    holdOfferwall(() => {
      root = mountRoot('fc-message-root');
    });
    const pending = releaseHeldOfferwall();
    await vi.advanceTimersByTimeAsync(400);
    root!.remove();
    await vi.advanceTimersByTimeAsync(OFFERWALL_ENTITLEMENT_GRACE_MS + 400);
    await expect(pending).resolves.toMatchObject({ outcome: 'closed_without_reward', root: 'fc-message-root' });
  });

  it('does not count an entitlement that predates the release', async () => {
    setEntitlement('earlier-visit');
    let root: HTMLDivElement | null = null;
    holdOfferwall(() => {
      root = mountRoot('fc-message-root');
    });
    const pending = releaseHeldOfferwall();
    await vi.advanceTimersByTimeAsync(400);
    root!.remove();
    await vi.advanceTimersByTimeAsync(OFFERWALL_ENTITLEMENT_GRACE_MS + 400);
    await expect(pending).resolves.toMatchObject({ outcome: 'closed_without_reward' });
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
      mountRoot('fc-message-root');
    });
    const pending = releaseHeldOfferwall({ completionTimeoutMs: 5000 });
    await vi.advanceTimersByTimeAsync(6000);
    await expect(pending).resolves.toMatchObject({ outcome: 'timed_out', root: 'fc-message-root' });
  });
});
