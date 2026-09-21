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
    makeRewardedVisible: vi.fn(),
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

import GptRewardedAd from '@/components/shared/GptRewardedAd';

afterEach(() => cleanup());

describe('GptRewardedAd', () => {
  beforeEach(() => {
    mocks.listeners.clear();
    vi.clearAllMocks();
  });

  it('shows the ad after opt-in and reports grant only through GPT lifecycle events', () => {
    const onGranted = vi.fn();
    const onClosed = vi.fn();
    const onOptIn = vi.fn();
    const readyEvent = { slot: mocks.slot, makeRewardedVisible: mocks.makeRewardedVisible };

    render(
      <GptRewardedAd
        label="Guarda il video"
        loadingLabel="Caricamento…"
        unavailableLabel="Non disponibile"
        onOptIn={onOptIn}
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
      mocks.listeners.get('rewardedSlotGranted')?.({ slot: mocks.slot });
      mocks.listeners.get('rewardedSlotClosed')?.({ slot: mocks.slot });
    });

    expect(onGranted).toHaveBeenCalledTimes(1);
    expect(onClosed).toHaveBeenCalledWith(true);
    expect(mocks.trackExperimentEvent).toHaveBeenCalledWith('rewarded_web_granted', expect.any(Object));
  });
});
