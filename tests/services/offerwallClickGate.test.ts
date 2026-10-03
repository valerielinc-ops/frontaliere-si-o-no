// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  FC_OFFERWALL_ENTITLEMENT_COOKIE,
  OFFERWALL_APPEAR_TIMEOUT_MS,
  OFFERWALL_ENTITLEMENT_GRACE_MS,
  OFFERWALL_REVEAL_GRACE_MS,
  OFFERWALL_SLOW_MS,
  OFFERWALL_STAGE_STYLE_ID,
  OFFERWALL_STALL_REPORT_MS,
  isOfferwallHeld,
  isOfferwallStaged,
  offerwallGateStatus,
  releaseHeldOfferwall,
  revealStagedOfferwall,
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
    window.history.replaceState({}, '', '/');
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

  it('clears a stale off-board state after SPA entry into the job board', () => {
    window.history.replaceState({}, '', '/cerca-lavoro-ticino/azienda-esempio/offerta/');
    window.__ftOfferwallGate = { state: 'off_board' };

    expect(offerwallGateStatus()).toBe('absent');
    expect(window.__ftOfferwallGate?.state).toBe('idle');
    expect(isOfferwallHeld()).toBe(false);
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

  describe('staged release behind the paid choice', () => {
    afterEach(() => {
      revealStagedOfferwall();
    });

    it('releases the Offerwall hidden, reports it ready, and never times out while hidden', async () => {
      holdOfferwall(() => {
        setTimeout(() => {
          mountRoot('fc-message-root');
        }, 1800);
      });
      const onStaged = vi.fn();
      const onShown = vi.fn();
      const onSlow = vi.fn();
      const onAppearTimeout = vi.fn();
      let settled = false;
      void releaseHeldOfferwall({ staged: true, onStaged, onShown, onSlow, onAppearTimeout }).then(() => {
        settled = true;
      });

      expect(isOfferwallStaged()).toBe(true);
      expect(window.__ftOfferwallGate?.state).toBe('released');
      await vi.advanceTimersByTimeAsync(2000);
      expect(onStaged).toHaveBeenCalledTimes(1);
      expect(onStaged).toHaveBeenCalledWith({ elapsedMs: expect.any(Number), root: 'fc-message-root' });
      expect(onStaged.mock.calls[0][0].elapsedMs).toBeGreaterThanOrEqual(1800);
      // The style keeps the root off screen: nothing is reported as shown.
      expect(window.getComputedStyle(document.querySelector('.fc-message-root') as Element).display).toBe('none');
      expect(onShown).not.toHaveBeenCalled();

      // The visitor reads the paid choice for longer than every timeout.
      await vi.advanceTimersByTimeAsync(OFFERWALL_APPEAR_TIMEOUT_MS * 3);
      expect(onSlow).not.toHaveBeenCalled();
      expect(onAppearTimeout).not.toHaveBeenCalled();
      expect(settled).toBe(false);
      expect(onStaged).toHaveBeenCalledTimes(1);
    });

    it('shows the staged Offerwall at once when it is revealed, timing it from the reveal', async () => {
      holdOfferwall(() => {
        setTimeout(() => {
          mountRoot('fc-message-root');
        }, 1500);
      });
      const onShown = vi.fn();
      const pending = releaseHeldOfferwall({ staged: true, onShown });
      await vi.advanceTimersByTimeAsync(20_000);

      revealStagedOfferwall();
      expect(isOfferwallStaged()).toBe(false);
      await vi.advanceTimersByTimeAsync(400);
      expect(onShown).toHaveBeenCalledTimes(1);
      expect(onShown.mock.calls[0][0]).toEqual({ shownMs: expect.any(Number), root: 'fc-message-root' });
      expect(onShown.mock.calls[0][0].shownMs).toBeLessThan(1000);

      setEntitlement('granted-staged');
      await vi.advanceTimersByTimeAsync(200);
      await expect(pending).resolves.toMatchObject({ outcome: 'completed', signal: 'entitlement' });
    });

    it('keeps the consent message usable while the Offerwall is staged', async () => {
      holdOfferwall();
      const consentRoot = mountRoot('fc-consent-root');
      void releaseHeldOfferwall({ staged: true });
      expect(document.getElementById(OFFERWALL_STAGE_STYLE_ID)).not.toBeNull();
      expect(window.getComputedStyle(consentRoot).display).not.toBe('none');
    });

    it('gives a staged Offerwall not yet rendered the rest of its appear timeout after the reveal', async () => {
      holdOfferwall();
      const onAppearTimeout = vi.fn();
      const pending = releaseHeldOfferwall({ staged: true, onAppearTimeout });
      await vi.advanceTimersByTimeAsync(2000);

      revealStagedOfferwall();
      await vi.advanceTimersByTimeAsync(OFFERWALL_APPEAR_TIMEOUT_MS - 2000 - 600);
      expect(onAppearTimeout).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1000);
      await expect(pending).resolves.toEqual({ outcome: 'not_shown', reason: 'appear_timeout' });
    });

    it('gives a reveal after the appear timeout a short grace, not a new full wait', async () => {
      holdOfferwall();
      const onAppearTimeout = vi.fn();
      const pending = releaseHeldOfferwall({ staged: true, onAppearTimeout });
      await vi.advanceTimersByTimeAsync(OFFERWALL_APPEAR_TIMEOUT_MS + 5000);

      revealStagedOfferwall();
      await vi.advanceTimersByTimeAsync(OFFERWALL_REVEAL_GRACE_MS - 400);
      expect(onAppearTimeout).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(800);
      await expect(pending).resolves.toEqual({ outcome: 'not_shown', reason: 'appear_timeout' });
    });

    it('takes the stage down when the release is refused', async () => {
      window.__ftOfferwallGate = { state: 'held', release: () => false };
      await expect(releaseHeldOfferwall({ staged: true }))
        .resolves.toEqual({ outcome: 'not_shown', reason: 'release_refused' });
      expect(isOfferwallStaged()).toBe(false);
    });

    it('keeps a staged Offerwall hidden when the watch is aborted (the choice was closed)', async () => {
      holdOfferwall(() => {
        mountRoot('fc-message-root');
      });
      const controller = new AbortController();
      const pending = releaseHeldOfferwall({ staged: true, signal: controller.signal });
      await vi.advanceTimersByTimeAsync(400);
      controller.abort();
      await expect(pending).resolves.toEqual({ outcome: 'not_shown', reason: 'aborted' });
      expect(isOfferwallStaged()).toBe(true);
      expect(window.getComputedStyle(document.querySelector('.fc-message-root') as Element).display).toBe('none');
    });
  });
});
