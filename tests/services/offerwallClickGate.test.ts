// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  FC_OFFERWALL_ENTITLEMENT_COOKIE,
  OFFERWALL_APPEAR_TIMEOUT_MS,
  OFFERWALL_ENTITLEMENT_GRACE_MS,
  OFFERWALL_SLOW_MS,
  OFFERWALL_STALL_REPORT_MS,
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
    window.__ftOfferwallGate = { state: 'off_board' };
    expect(offerwallGateStatus()).toBe('off_board');
    expect(isOfferwallHeld(), 'an off-board page never holds an Offerwall').toBe(false);
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

  it('reports not_held when the visit started off the job board', async () => {
    window.__ftOfferwallGate = { state: 'off_board' };
    await expect(releaseHeldOfferwall()).resolves.toEqual({ outcome: 'not_shown', reason: 'not_held' });
    expect(window.__ftOfferwallGate?.state).toBe('off_board');
  });

  it('reports release_refused when the gate was already released', async () => {
    window.__ftOfferwallGate = { state: 'held', release: () => false };
    await expect(releaseHeldOfferwall()).resolves.toEqual({ outcome: 'not_shown', reason: 'release_refused' });
  });

  it('reports appear_timeout when no Offerwall renders in time', async () => {
    holdOfferwall();
    const onShown = vi.fn();
    const pending = releaseHeldOfferwall({ onShown });
    expect(window.__ftOfferwallGate?.state).toBe('released');
    await vi.advanceTimersByTimeAsync(OFFERWALL_APPEAR_TIMEOUT_MS + 400);
    await expect(pending).resolves.toEqual({ outcome: 'not_shown', reason: 'appear_timeout' });
    expect(onShown).not.toHaveBeenCalled();
  });

  it('completes as soon as Google writes a new entitlement, while the thank-you screen is still up', async () => {
    // Live E4 (25-09): FCOEC ~100 ms after the ad's close, root removed ~3.1 s later.
    holdOfferwall(() => {
      setTimeout(() => {
        mountRoot('fc-message-root');
      }, 600);
    });
    const onShown = vi.fn();
    const onClosed = vi.fn();
    const pending = releaseHeldOfferwall({ onShown, onClosed });

    await vi.advanceTimersByTimeAsync(1000);
    expect(onShown).toHaveBeenCalledWith(expect.objectContaining({ root: 'fc-message-root' }));

    setEntitlement('granted-1');
    await vi.advanceTimersByTimeAsync(200);
    const result = await pending;
    expect(result).toMatchObject({
      outcome: 'completed',
      signal: 'entitlement',
      closedMs: null,
      root: 'fc-message-root',
    });
    expect(onClosed).not.toHaveBeenCalled();
    // The root is still on screen: completion did not wait for it.
    expect(document.querySelector('.fc-message-root')).not.toBeNull();
  });

  it('ignores an entitlement left by an earlier grant, and completes only when it changes', async () => {
    setEntitlement('earlier-visit');
    holdOfferwall(() => {
      mountRoot('fc-message-root');
    });
    let settled = false;
    const pending = releaseHeldOfferwall().then((result) => {
      settled = true;
      return result;
    });
    await vi.advanceTimersByTimeAsync(3000);
    expect(settled, 'the pre-existing cookie is not a new grant').toBe(false);

    setEntitlement('granted-now');
    await vi.advanceTimersByTimeAsync(200);
    await expect(pending).resolves.toMatchObject({ outcome: 'completed', signal: 'entitlement' });
  });

  it('waits after the close for an entitlement written late', async () => {
    let root: HTMLDivElement | null = null;
    holdOfferwall(() => {
      root = mountRoot('fc-offerwall-root');
    });
    const onClosed = vi.fn();
    const pending = releaseHeldOfferwall({ onClosed });
    await vi.advanceTimersByTimeAsync(400);
    root!.style.display = 'none';
    await vi.advanceTimersByTimeAsync(OFFERWALL_ENTITLEMENT_GRACE_MS - 2000);
    expect(onClosed).toHaveBeenCalledTimes(1);
    setEntitlement('granted-2');
    await vi.advanceTimersByTimeAsync(400);
    await expect(pending).resolves.toMatchObject({ outcome: 'completed', signal: 'root_closed' });
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

  it('reports a stall once and keeps following the Offerwall until it closes', async () => {
    let root: HTMLDivElement | null = null;
    holdOfferwall(() => {
      root = mountRoot('fc-message-root');
    });
    const onStalled = vi.fn();
    let settled = false;
    const pending = releaseHeldOfferwall({ onStalled }).then((result) => {
      settled = true;
      return result;
    });

    await vi.advanceTimersByTimeAsync(OFFERWALL_STALL_REPORT_MS + 1000);
    expect(onStalled).toHaveBeenCalledTimes(1);
    expect(onStalled).toHaveBeenCalledWith(expect.objectContaining({ root: 'fc-message-root' }));
    expect(settled, 'time on screen is not an outcome').toBe(false);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(onStalled).toHaveBeenCalledTimes(1);

    root!.remove();
    await vi.advanceTimersByTimeAsync(OFFERWALL_ENTITLEMENT_GRACE_MS + 400);
    await expect(pending).resolves.toMatchObject({ outcome: 'closed_without_reward' });
  });

  it('still grants a reward Google confirms after a stall', async () => {
    let root: HTMLDivElement | null = null;
    holdOfferwall(() => {
      root = mountRoot('fc-message-root');
    });
    const pending = releaseHeldOfferwall();
    await vi.advanceTimersByTimeAsync(OFFERWALL_STALL_REPORT_MS + 800);
    setEntitlement('granted-late');
    root!.remove();
    await vi.advanceTimersByTimeAsync(400);
    await expect(pending).resolves.toMatchObject({ outcome: 'completed', signal: 'root_closed' });
  });

  describe('late Offerwall (GPT fallback support)', () => {
    it('reports a slow Offerwall once, before the appear timeout, without resolving', async () => {
      holdOfferwall();
      const onSlow = vi.fn();
      let settled = false;
      const pending = releaseHeldOfferwall({ onSlow }).then((result) => {
        settled = true;
        return result;
      });

      await vi.advanceTimersByTimeAsync(OFFERWALL_SLOW_MS - 200);
      expect(onSlow).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(400);
      expect(onSlow).toHaveBeenCalledTimes(1);
      expect(onSlow.mock.calls[0][0].elapsedMs).toBeGreaterThanOrEqual(OFFERWALL_SLOW_MS);
      expect(settled).toBe(false);

      await vi.advanceTimersByTimeAsync(OFFERWALL_APPEAR_TIMEOUT_MS);
      expect(onSlow).toHaveBeenCalledTimes(1);
      await expect(pending).resolves.toEqual({ outcome: 'not_shown', reason: 'appear_timeout' });
    });

    it('does not report slow when the Offerwall renders in time', async () => {
      holdOfferwall(() => {
        setTimeout(() => {
          mountRoot('fc-message-root');
        }, 1000);
      });
      const onSlow = vi.fn();
      const onShown = vi.fn();
      void releaseHeldOfferwall({ onSlow, onShown });
      await vi.advanceTimersByTimeAsync(OFFERWALL_APPEAR_TIMEOUT_MS + 400);
      expect(onShown).toHaveBeenCalledTimes(1);
      expect(onSlow).not.toHaveBeenCalled();
    });

    it('resolves appear_timeout when onAppearTimeout does not ask to keep watching', async () => {
      holdOfferwall();
      const onAppearTimeout = vi.fn(() => 'resolve' as const);
      const pending = releaseHeldOfferwall({ onAppearTimeout });
      await vi.advanceTimersByTimeAsync(OFFERWALL_APPEAR_TIMEOUT_MS + 400);
      expect(onAppearTimeout).toHaveBeenCalledTimes(1);
      await expect(pending).resolves.toEqual({ outcome: 'not_shown', reason: 'appear_timeout' });
    });

    it('keeps following a late Offerwall after the timeout, through to its reward', async () => {
      holdOfferwall(() => {
        setTimeout(() => {
          mountRoot('fc-message-root');
        }, OFFERWALL_APPEAR_TIMEOUT_MS + 3000);
      });
      const onAppearTimeout = vi.fn(() => 'keep_watching' as const);
      const onShown = vi.fn();
      let settled = false;
      const pending = releaseHeldOfferwall({ onAppearTimeout, onShown }).then((result) => {
        settled = true;
        return result;
      });

      await vi.advanceTimersByTimeAsync(OFFERWALL_APPEAR_TIMEOUT_MS + 400);
      expect(onAppearTimeout).toHaveBeenCalledTimes(1);
      expect(settled, 'kept watching after the timeout').toBe(false);

      await vi.advanceTimersByTimeAsync(3000);
      expect(onShown).toHaveBeenCalledWith(expect.objectContaining({ root: 'fc-message-root' }));
      expect(onAppearTimeout).toHaveBeenCalledTimes(1);

      setEntitlement('granted-late-render');
      await vi.advanceTimersByTimeAsync(400);
      await expect(pending).resolves.toMatchObject({ outcome: 'completed', signal: 'entitlement' });
    });

    it('stops watching on abort, and a later Offerwall is no longer reported', async () => {
      holdOfferwall();
      const controller = new AbortController();
      const onShown = vi.fn();
      const pending = releaseHeldOfferwall({
        signal: controller.signal,
        onShown,
        onAppearTimeout: () => 'keep_watching',
      });
      await vi.advanceTimersByTimeAsync(OFFERWALL_APPEAR_TIMEOUT_MS + 1000);
      controller.abort();
      await expect(pending).resolves.toEqual({ outcome: 'not_shown', reason: 'aborted' });

      mountRoot('fc-message-root');
      await vi.advanceTimersByTimeAsync(2000);
      expect(onShown).not.toHaveBeenCalled();
    });

    it('does not release at all when the signal is already aborted', async () => {
      holdOfferwall();
      const controller = new AbortController();
      controller.abort();
      await expect(releaseHeldOfferwall({ signal: controller.signal }))
        .resolves.toEqual({ outcome: 'not_shown', reason: 'aborted' });
      expect(window.__ftOfferwallGate?.state).toBe('held');
    });
  });
});
