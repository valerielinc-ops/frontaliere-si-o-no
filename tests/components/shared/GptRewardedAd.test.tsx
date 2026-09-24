// @vitest-environment jsdom

import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const listeners = new Map<string, (event: unknown) => void>();
  const pubads = {
    addEventListener: vi.fn((name: string, handler: (event: unknown) => void) => listeners.set(name, handler)),
    removeEventListener: vi.fn((name: string) => listeners.delete(name)),
  };
  const slot = {
    addService: vi.fn(),
  };
  const tag = {
    apiReady: true as boolean | undefined,
    cmd: { push: vi.fn((callback: () => void) => callback()) },
    enums: { OutOfPageFormat: { REWARDED: 'rewarded' } },
    pubads: vi.fn(() => pubads),
    defineOutOfPageSlot: vi.fn((): unknown => slot),
    display: vi.fn(),
    destroySlots: vi.fn(),
  };
  return {
    listeners,
    pubads,
    slot,
    tag,
    env: {
      productionHost: true,
      consent: 'granted' as 'granted' | 'denied' | null,
    },
    trackExperimentEvent: vi.fn(),
    makeRewardedVisible: vi.fn((): unknown => undefined),
  };
});

vi.mock('@/components/shared/AdSenseBanner', () => ({
  isAdSenseProductionHost: () => mocks.env.productionHost,
}));
vi.mock('@/components/shared/GptAdSlot', () => ({
  GPT_ENABLED: true,
  getGptTag: () => mocks.tag,
  initGptFramework: vi.fn(),
}));
vi.mock('@/services/botPatterns', () => ({ isLikelyBot: () => false }));
vi.mock('@/services/analytics', () => ({
  Analytics: { trackExperimentEvent: mocks.trackExperimentEvent },
}));
vi.mock('@/services/adsConsent', () => ({
  getAdsConsent: () => mocks.env.consent,
  isAdsConsentGranted: () => mocks.env.consent === 'granted',
  onAdsConsentChange: () => () => {},
}));

import GptRewardedAd, {
  ASSISTED_APPLICATION_REWARDED_AD_UNIT_PATH,
  REWARDED_READY_TIMEOUT_MS,
} from '@/components/shared/GptRewardedAd';
import {
  disposeRewardedWebAd,
  preloadRewardedWebAd,
  resetRewardedWebAdForTests,
} from '@/services/rewardedWebAd';

type Props = Partial<Parameters<typeof GptRewardedAd>[0]>;

function renderAd(props: Props = {}) {
  return render(
    <GptRewardedAd
      label="Guarda il video"
      loadingLabel="Caricamento…"
      showingLabel="Video in riproduzione…"
      unavailableLabel="Non disponibile"
      onGranted={vi.fn()}
      {...props}
    />,
  );
}

const readyEvent = () => ({ slot: mocks.slot, makeRewardedVisible: mocks.makeRewardedVisible });
const fire = (name: string, event: unknown) => {
  act(() => {
    mocks.listeners.get(name)?.(event);
  });
};
const trackedEvents = (name: string) => mocks.trackExperimentEvent.mock.calls
  .filter(([eventName]) => eventName === name)
  .map(([, params]) => params);

afterEach(() => {
  cleanup();
  disposeRewardedWebAd();
  resetRewardedWebAdForTests();
  vi.useRealTimers();
});

describe('GptRewardedAd', () => {
  beforeEach(() => {
    mocks.listeners.clear();
    vi.clearAllMocks();
    mocks.env.productionHost = true;
    mocks.env.consent = 'granted';
    mocks.tag.apiReady = true;
    mocks.tag.cmd.push.mockImplementation((callback: () => void) => callback());
    mocks.tag.defineOutOfPageSlot.mockImplementation(() => mocks.slot);
    mocks.makeRewardedVisible.mockImplementation(() => undefined);
  });

  it('uses the dedicated Ad Manager rewarded unit', () => {
    expect(ASSISTED_APPLICATION_REWARDED_AD_UNIT_PATH).toBe(
      '/23355151813/rewarded-application-video',
    );
  });

  it('starts one Google rewarded request when mounted by the click, with listeners wired before display()', () => {
    renderAd({ autoStart: true });

    expect(mocks.tag.defineOutOfPageSlot).toHaveBeenCalledTimes(1);
    expect(mocks.tag.defineOutOfPageSlot).toHaveBeenCalledWith(ASSISTED_APPLICATION_REWARDED_AD_UNIT_PATH, 'rewarded');
    expect(mocks.tag.display).toHaveBeenCalledTimes(1);
    const readyListenerOrder = mocks.pubads.addEventListener.mock.invocationCallOrder[
      mocks.pubads.addEventListener.mock.calls.findIndex(([name]) => name === 'rewardedSlotReady')
    ];
    const grantedListenerOrder = mocks.pubads.addEventListener.mock.invocationCallOrder[
      mocks.pubads.addEventListener.mock.calls.findIndex(([name]) => name === 'rewardedSlotGranted')
    ];
    expect(readyListenerOrder).toBeLessThan(mocks.tag.display.mock.invocationCallOrder[0]);
    expect(grantedListenerOrder).toBeLessThan(mocks.tag.display.mock.invocationCallOrder[0]);
    expect(trackedEvents('rewarded_web_request')).toEqual([
      expect.objectContaining({
        slot: ASSISTED_APPLICATION_REWARDED_AD_UNIT_PATH,
        format: 'rewarded_web',
        trigger: 'candidate_click',
        request_id: expect.any(Number),
      }),
    ]);
  });

  it('makes the video visible on rewardedSlotReady without a second click and grants only on rewardedSlotGranted', () => {
    const onGranted = vi.fn();
    const onClosed = vi.fn();
    const onOptIn = vi.fn();
    const onVideoCompleted = vi.fn();
    renderAd({ autoStart: true, onOptIn, onVideoCompleted, onGranted, onClosed });

    expect(mocks.makeRewardedVisible).not.toHaveBeenCalled();
    fire('slotRenderEnded', { slot: mocks.slot, isEmpty: false });
    fire('rewardedSlotReady', readyEvent());

    expect(onOptIn).toHaveBeenCalledTimes(1);
    expect(onOptIn).toHaveBeenCalledWith({ requestId: expect.any(Number) });
    expect(mocks.makeRewardedVisible).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('assisted-application-offer-rewarded')).not.toBeInTheDocument();
    expect(screen.getByText('Video in riproduzione…')).toBeInTheDocument();
    expect(onGranted).not.toHaveBeenCalled();

    fire('rewardedSlotVideoCompleted', { slot: mocks.slot });
    expect(onVideoCompleted).toHaveBeenCalledTimes(1);
    expect(onGranted).not.toHaveBeenCalled();

    fire('rewardedSlotGranted', { slot: mocks.slot });
    fire('rewardedSlotClosed', { slot: mocks.slot });

    expect(onGranted).toHaveBeenCalledTimes(1);
    expect(onClosed).toHaveBeenCalledWith(true, { requestId: expect.any(Number) });
    expect(trackedEvents('rewarded_web_started')).toHaveLength(1);
    expect(trackedEvents('rewarded_web_granted')).toHaveLength(1);
  });

  it('does not grant when the visitor closes the video before the reward', () => {
    const onGranted = vi.fn();
    const onClosed = vi.fn();
    renderAd({ autoStart: true, onGranted, onClosed });

    fire('rewardedSlotReady', readyEvent());
    fire('rewardedSlotClosed', { slot: mocks.slot });

    expect(onGranted).not.toHaveBeenCalled();
    expect(onClosed).toHaveBeenCalledWith(false, { requestId: expect.any(Number) });
    expect(trackedEvents('rewarded_web_closed')).toEqual([
      expect.objectContaining({ reason: 'video_closed_before_reward' }),
    ]);
  });

  it('reuses a preloaded request that is still pending instead of starting a second one', () => {
    const preloadId = preloadRewardedWebAd();
    const onOptIn = vi.fn();
    renderAd({ autoStart: true, onOptIn });

    fire('rewardedSlotReady', readyEvent());

    expect(mocks.tag.defineOutOfPageSlot).toHaveBeenCalledTimes(1);
    expect(onOptIn).toHaveBeenCalledWith({ requestId: preloadId });
    expect(mocks.makeRewardedVisible).toHaveBeenCalledTimes(1);
  });

  it('opens a preloaded ready slot immediately when the offer mounts', () => {
    preloadRewardedWebAd();
    fire('rewardedSlotReady', readyEvent());

    renderAd({ autoStart: true });

    expect(mocks.tag.defineOutOfPageSlot).toHaveBeenCalledTimes(1);
    expect(mocks.makeRewardedVisible).toHaveBeenCalledTimes(1);
  });

  it('keeps the explicit button only for callers without autoStart', () => {
    preloadRewardedWebAd();
    fire('rewardedSlotReady', readyEvent());

    renderAd();

    expect(screen.getByTestId('assisted-application-offer-rewarded')).toBeInTheDocument();
    expect(mocks.makeRewardedVisible).not.toHaveBeenCalled();
  });

  it('starts a fresh auction for the click when an earlier preload already ended with no fill', () => {
    const preloadId = preloadRewardedWebAd();
    fire('slotRenderEnded', { slot: mocks.slot, isEmpty: true });
    const onUnavailable = vi.fn();

    renderAd({ autoStart: true, onUnavailable });

    expect(mocks.tag.defineOutOfPageSlot).toHaveBeenCalledTimes(2);
    expect(onUnavailable).not.toHaveBeenCalled();
    expect(screen.getByText('Caricamento…')).toBeInTheDocument();

    fire('rewardedSlotReady', readyEvent());
    expect(mocks.makeRewardedVisible).toHaveBeenCalledTimes(1);
    const clickRequest = trackedEvents('rewarded_web_request').at(-1);
    expect(clickRequest).toEqual(expect.objectContaining({ trigger: 'candidate_click' }));
    expect(clickRequest?.request_id).not.toBe(preloadId);
  });

  it('reports an empty Google response as no_fill and never retries it automatically', () => {
    const onUnavailable = vi.fn();
    const { rerender } = renderAd({ autoStart: true, onUnavailable });

    fire('slotRenderEnded', { slot: mocks.slot, isEmpty: true });

    expect(onUnavailable).toHaveBeenCalledTimes(1);
    expect(onUnavailable).toHaveBeenCalledWith('no_fill', {
      requestId: expect.any(Number),
      detail: 'slot_render_empty',
    });
    expect(trackedEvents('rewarded_web_unavailable')).toEqual([
      expect.objectContaining({ reason: 'no_fill', detail: 'slot_render_empty', request_id: expect.any(Number) }),
    ]);

    rerender(
      <GptRewardedAd
        label="Guarda il video"
        loadingLabel="Caricamento…"
        unavailableLabel="Non disponibile"
        autoStart
        onGranted={vi.fn()}
        onUnavailable={onUnavailable}
      />,
    );

    expect(mocks.tag.defineOutOfPageSlot).toHaveBeenCalledTimes(1);
    expect(mocks.makeRewardedVisible).not.toHaveBeenCalled();
    expect(onUnavailable).toHaveBeenCalledTimes(1);
  });

  it('reports ready_timeout when Google never answers the request', () => {
    vi.useFakeTimers();
    const onUnavailable = vi.fn();
    renderAd({ autoStart: true, onUnavailable });

    act(() => {
      vi.advanceTimersByTime(REWARDED_READY_TIMEOUT_MS);
    });

    expect(onUnavailable).toHaveBeenCalledWith('ready_timeout', { requestId: expect.any(Number) });
    expect(mocks.makeRewardedVisible).not.toHaveBeenCalled();
  });

  it('reports gpt_unavailable when GPT never loads, then fails fast on the next click', () => {
    vi.useFakeTimers();
    mocks.tag.apiReady = undefined;
    mocks.tag.cmd.push.mockImplementation(() => undefined);
    const firstOnUnavailable = vi.fn();
    const first = renderAd({ autoStart: true, onUnavailable: firstOnUnavailable });

    act(() => {
      vi.advanceTimersByTime(REWARDED_READY_TIMEOUT_MS);
    });
    expect(firstOnUnavailable).toHaveBeenCalledWith('gpt_unavailable', {
      requestId: expect.any(Number),
      detail: 'gpt_not_loaded',
    });
    first.unmount();

    const secondOnUnavailable = vi.fn();
    renderAd({ autoStart: true, onUnavailable: secondOnUnavailable });

    expect(secondOnUnavailable).toHaveBeenCalledWith('gpt_unavailable', {
      requestId: expect.any(Number),
      detail: 'gpt_not_loaded',
    });
  });

  it('reports consent_denied without sending a Google request', () => {
    mocks.env.consent = 'denied';
    const onUnavailable = vi.fn();
    renderAd({ autoStart: true, onUnavailable });

    expect(onUnavailable).toHaveBeenCalledWith('consent_denied', { requestId: 0, detail: 'denied' });
    expect(mocks.tag.defineOutOfPageSlot).not.toHaveBeenCalled();
  });

  it('reports not_production outside the production host without sending a request', () => {
    mocks.env.productionHost = false;
    const onUnavailable = vi.fn();
    renderAd({ autoStart: true, onUnavailable });

    expect(onUnavailable).toHaveBeenCalledWith('not_production', { requestId: 0, detail: 'unsupported_host' });
    expect(mocks.tag.defineOutOfPageSlot).not.toHaveBeenCalled();
  });

  it('reports slot_init_error when GPT refuses to define the rewarded slot', () => {
    mocks.tag.defineOutOfPageSlot.mockImplementation(() => null);
    const onUnavailable = vi.fn();
    renderAd({ autoStart: true, onUnavailable });

    expect(onUnavailable).toHaveBeenCalledWith('slot_init_error', {
      requestId: expect.any(Number),
      detail: 'slot_not_defined',
    });
    expect(mocks.tag.display).not.toHaveBeenCalled();
  });

  it('reports display_error when a ready ad cannot be made visible', () => {
    mocks.makeRewardedVisible.mockImplementation(() => {
      throw new Error('overlay failed');
    });
    const onUnavailable = vi.fn();
    renderAd({ autoStart: true, onUnavailable });

    fire('rewardedSlotReady', readyEvent());

    expect(onUnavailable).toHaveBeenCalledTimes(1);
    expect(onUnavailable).toHaveBeenCalledWith('display_error', {
      requestId: expect.any(Number),
      detail: 'make_visible_threw',
    });
    expect(screen.queryByText('Video in riproduzione…')).not.toBeInTheDocument();
  });
});
