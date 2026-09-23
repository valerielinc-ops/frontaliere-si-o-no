// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
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
    cmd: { push: vi.fn((callback: () => void) => callback()) },
    enums: { OutOfPageFormat: { REWARDED: 'rewarded' } },
    pubads: vi.fn(() => pubads),
    defineOutOfPageSlot: vi.fn(() => slot),
    display: vi.fn(),
    destroySlots: vi.fn(),
  };
  return {
    listeners,
    pubads,
    slot,
    tag,
    trackExperimentEvent: vi.fn(),
    makeRewardedVisible: vi.fn(() => true),
  };
});

vi.mock('@/components/shared/AdSenseBanner', () => ({
  isAdSenseProductionHost: () => true,
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
  isAdsConsentGranted: () => true,
  onAdsConsentChange: () => () => {},
}));

import GptRewardedAd, {
  ASSISTED_APPLICATION_REWARDED_AD_UNIT_PATH,
  REWARDED_READY_TIMEOUT_MS,
} from '@/components/shared/GptRewardedAd';
import { disposeRewardedWebAd, preloadRewardedWebAd } from '@/services/rewardedWebAd';

afterEach(() => {
  cleanup();
  disposeRewardedWebAd();
  vi.useRealTimers();
});

describe('GptRewardedAd', () => {
  beforeEach(() => {
    mocks.listeners.clear();
    vi.clearAllMocks();
  });

  it('uses the dedicated Ad Manager rewarded unit', () => {
    expect(ASSISTED_APPLICATION_REWARDED_AD_UNIT_PATH).toBe(
      '/23355151813/rewarded-application-video',
    );
  });

  it('shows the ad after opt-in and reports grant only through GPT lifecycle events', () => {
    const onGranted = vi.fn();
    const onClosed = vi.fn();
    const onOptIn = vi.fn();
    const onVideoCompleted = vi.fn();
    const readyEvent = { slot: mocks.slot, makeRewardedVisible: mocks.makeRewardedVisible };

    render(
      <GptRewardedAd
        label="Guarda il video"
        loadingLabel="Caricamento…"
        unavailableLabel="Non disponibile"
        onOptIn={onOptIn}
        onVideoCompleted={onVideoCompleted}
        onGranted={onGranted}
        onClosed={onClosed}
      />,
    );

    act(() => {
      mocks.listeners.get('rewardedSlotReady')?.(readyEvent);
    });
    fireEvent.click(screen.getByTestId('assisted-application-offer-rewarded'));

    expect(onOptIn).toHaveBeenCalledTimes(1);
    expect(mocks.makeRewardedVisible).toHaveBeenCalledTimes(1);
    expect(onGranted).not.toHaveBeenCalled();

    act(() => {
      mocks.listeners.get('rewardedSlotVideoCompleted')?.({ slot: mocks.slot });
      mocks.listeners.get('rewardedSlotGranted')?.({ slot: mocks.slot });
      mocks.listeners.get('rewardedSlotClosed')?.({ slot: mocks.slot });
    });

    expect(onVideoCompleted).toHaveBeenCalledTimes(1);
    expect(onGranted).toHaveBeenCalledTimes(1);
    expect(onClosed).toHaveBeenCalledWith(true);
    expect(mocks.trackExperimentEvent).toHaveBeenCalledWith('rewarded_web_granted', expect.any(Object));
  });

  it('reuses a slot that was preloaded before the offer dialog mounted', () => {
    preloadRewardedWebAd();
    const readyEvent = { slot: mocks.slot, makeRewardedVisible: mocks.makeRewardedVisible };

    act(() => {
      mocks.listeners.get('rewardedSlotReady')?.(readyEvent);
    });

    render(
      <GptRewardedAd
        label="Guarda il video"
        loadingLabel="Caricamento…"
        unavailableLabel="Non disponibile"
        onGranted={vi.fn()}
      />,
    );

    expect(screen.getByTestId('assisted-application-offer-rewarded')).toBeInTheDocument();
    expect(mocks.tag.defineOutOfPageSlot).toHaveBeenCalledTimes(1);
    expect(mocks.tag.display).toHaveBeenCalledTimes(1);
  });

  it('opens a ready preloaded slot without a second CTA click when auto-start is enabled', () => {
    preloadRewardedWebAd();
    const onOptIn = vi.fn();
    const readyEvent = { slot: mocks.slot, makeRewardedVisible: mocks.makeRewardedVisible };

    act(() => {
      mocks.listeners.get('rewardedSlotReady')?.(readyEvent);
    });

    render(
      <GptRewardedAd
        label="Guarda il video"
        loadingLabel="Caricamento…"
        showingLabel="Video in riproduzione…"
        unavailableLabel="Non disponibile"
        autoStart
        onOptIn={onOptIn}
        onGranted={vi.fn()}
      />,
    );

    expect(onOptIn).toHaveBeenCalledTimes(1);
    expect(mocks.makeRewardedVisible).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('assisted-application-offer-rewarded')).not.toBeInTheDocument();
  });

  it('reports a GPT show refusal as unavailable instead of leaving the request showing', () => {
    preloadRewardedWebAd();
    const onUnavailable = vi.fn();
    const readyEvent = { slot: mocks.slot, makeRewardedVisible: mocks.makeRewardedVisible };

    act(() => {
      mocks.listeners.get('rewardedSlotReady')?.(readyEvent);
      mocks.makeRewardedVisible.mockReturnValueOnce(false);
    });

    render(
      <GptRewardedAd
        label="Guarda il video"
        loadingLabel="Caricamento…"
        unavailableLabel="Non disponibile"
        autoStart
        onGranted={vi.fn()}
        onUnavailable={onUnavailable}
      />,
    );

    expect(onUnavailable).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('Caricamento…')).not.toBeInTheDocument();
    expect(screen.getByText('Non disponibile')).toBeInTheDocument();
  });

  it('does not leave the caller loading forever when GPT never makes the slot ready', () => {
    vi.useFakeTimers();
    const onUnavailable = vi.fn();

    render(
      <GptRewardedAd
        label="Guarda il video"
        loadingLabel="Caricamento…"
        unavailableLabel="Non disponibile"
        onGranted={vi.fn()}
        onUnavailable={onUnavailable}
      />,
    );

    act(() => {
      vi.advanceTimersByTime(REWARDED_READY_TIMEOUT_MS);
    });

    expect(onUnavailable).toHaveBeenCalledTimes(1);
  });
});
