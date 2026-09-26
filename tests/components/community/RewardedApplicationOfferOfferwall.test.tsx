// @vitest-environment jsdom
/**
 * Click-only AdSense Offerwall inside the rewarded application offer: when
 * Funding Choices holds an Offerwall for the page view, the "Candidati" click
 * releases it before any GPT request. Google's reward continues to the
 * application with no further click; a released Offerwall that does not show
 * hands off to the employer without a second ad; the GPT path runs only when
 * nothing was released.
 */
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type ReleaseOptions = {
  onShown?: (info: { shownMs: number; root: string }) => void;
  onClosed?: (info: { shownMs: number; closedMs: number; root: string }) => void;
  onStalled?: (info: { shownMs: number; root: string }) => void;
};
type ReleaseResult =
  | { outcome: 'completed'; shownMs: number; closedMs: number; completedMs: number; root: string }
  | { outcome: 'closed_without_reward'; shownMs: number; closedMs: number; root: string }
  | { outcome: 'not_shown'; reason: string };

const mocks = vi.hoisted(() => ({
  status: 'absent' as 'held' | 'released' | 'suppressed' | 'off_board' | 'absent',
  releaseOptions: null as ReleaseOptions | null,
  resolveRelease: null as ((result: ReleaseResult) => void) | null,
  releaseHeldOfferwall: vi.fn(),
  trackAssistedApplicationEvent: vi.fn(),
  grantRewardedApplicationAccess: vi.fn(() => 1_900_000_000_000),
}));

vi.mock('@/components/shared/GptRewardedAd', () => ({
  default: () => <div data-testid="mock-google-rewarded" />,
}));
vi.mock('@/services/rewardedWebAd', () => ({
  ASSISTED_APPLICATION_REWARDED_AD_UNIT_PATH: '/23355151813/rewarded-application-video',
  REWARDED_WEB_AD_FORMAT: 'rewarded_web',
}));
vi.mock('@/services/rewardedApplicationAccess', () => ({
  grantRewardedApplicationAccess: mocks.grantRewardedApplicationAccess,
}));
vi.mock('@/services/assistedApplicationExperiment', () => ({
  trackAssistedApplicationEvent: mocks.trackAssistedApplicationEvent,
}));
vi.mock('@/services/offerwallClickGate', () => ({
  offerwallGateStatus: () => mocks.status,
  releaseHeldOfferwall: mocks.releaseHeldOfferwall,
}));

import RewardedApplicationOffer from '@/components/community/RewardedApplicationOffer';

const tracked = (name: string) => mocks.trackAssistedApplicationEvent.mock.calls
  .filter(([eventName]) => eventName === name)
  .map(([, params]) => params);

const props = {
  jobId: 'job-1',
  companyId: 'company-1',
  companyName: 'EOC',
  jobTitle: 'Fisioterapista diplomato',
  onContinue: vi.fn(),
  onUnavailable: vi.fn(),
};

const offerwallContext = {
  variant: 'rewarded_ad',
  jobId: 'job-1',
  companyId: 'company-1',
  surface: 'job_detail_rewarded_inline',
  trigger: 'candidate_click',
  ad_unit: 'adsense_offerwall',
  format: 'offerwall',
  provider: 'adsense_offerwall',
};

const settle = async (result: ReleaseResult) => {
  await act(async () => {
    mocks.resolveRelease?.(result);
  });
};

const showOfferwall = (shownMs = 800) => {
  act(() => {
    mocks.releaseOptions?.onShown?.({ shownMs, root: 'fc-message-root' });
  });
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.status = 'absent';
  mocks.releaseOptions = null;
  mocks.resolveRelease = null;
  mocks.releaseHeldOfferwall.mockImplementation((options: ReleaseOptions) => {
    mocks.releaseOptions = options;
    return new Promise<ReleaseResult>((resolve) => {
      mocks.resolveRelease = resolve;
    });
  });
});

afterEach(() => {
  cleanup();
  document.body.style.overflow = '';
});

describe('RewardedApplicationOffer — click-only Offerwall', () => {
  it('runs the GPT path untouched when no Offerwall is held, and says why', () => {
    render(<RewardedApplicationOffer {...props} />);

    expect(screen.getByTestId('mock-google-rewarded')).toBeInTheDocument();
    expect(mocks.releaseHeldOfferwall).not.toHaveBeenCalled();
    expect(tracked('rewarded_offerwall_released')).toEqual([]);
    expect(tracked('rewarded_offerwall_not_shown')).toEqual([
      expect.objectContaining({ ...offerwallContext, reason: 'not_held' }),
    ]);
  });

  it.each([
    ['suppressed', 'no_consent_decision'],
    ['off_board', 'off_board_page'],
    ['released', 'already_released'],
  ] as const)('reports a %s gate as %s before the GPT path', (status, reason) => {
    mocks.status = status;
    render(<RewardedApplicationOffer {...props} />);

    expect(screen.getByTestId('mock-google-rewarded')).toBeInTheDocument();
    expect(mocks.releaseHeldOfferwall).not.toHaveBeenCalled();
    expect(tracked('rewarded_offerwall_not_shown')).toEqual([
      expect.objectContaining({ ...offerwallContext, reason }),
    ]);
  });

  it('releases the held Offerwall on the click, before any GPT request', () => {
    mocks.status = 'held';
    render(<RewardedApplicationOffer {...props} />);

    expect(mocks.releaseHeldOfferwall).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('mock-google-rewarded')).not.toBeInTheDocument();
    expect(screen.getByTestId('rewarded-application-offerwall-pending')).toHaveTextContent('Stiamo preparando il video…');
    expect(tracked('rewarded_offerwall_released')).toEqual([expect.objectContaining(offerwallContext)]);
  });

  it('after Google’s reward continues to the application once, with no further click', async () => {
    mocks.status = 'held';
    render(<RewardedApplicationOffer {...props} />);

    showOfferwall(800);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(tracked('rewarded_offerwall_shown')).toEqual([
      expect.objectContaining({ ...offerwallContext, shown_ms: 800, fc_root: 'fc-message-root' }),
    ]);

    act(() => {
      mocks.releaseOptions?.onClosed?.({ shownMs: 800, closedMs: 31_000, root: 'fc-message-root' });
    });
    expect(screen.getByTestId('rewarded-application-offerwall-verifying')).toBeInTheDocument();
    expect(props.onContinue).not.toHaveBeenCalled();

    await settle({ outcome: 'completed', shownMs: 800, closedMs: 31_000, completedMs: 31_200, root: 'fc-message-root' });

    expect(props.onContinue).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('rewarded-application-offerwall-done')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Apri la candidatura sul sito dell’azienda' })).not.toBeInTheDocument();
    expect(screen.queryByTestId('mock-google-rewarded')).not.toBeInTheDocument();
    expect(mocks.grantRewardedApplicationAccess).toHaveBeenCalledTimes(1);
    expect(tracked('rewarded_offerwall_completed')).toEqual([
      expect.objectContaining({ ...offerwallContext, shown_ms: 800, closed_ms: 31_000, completed_ms: 31_200 }),
    ]);
    expect(tracked('rewarded_application_access_granted')).toEqual([
      expect.objectContaining({ ...offerwallContext, access_expires_at: 1_900_000_000_000, access_ttl_hours: 12 }),
    ]);
    // The GPT reward event stays reserved to rewardedSlotGranted.
    expect(tracked('rewarded_ad_granted')).toEqual([]);
    expect(props.onUnavailable).not.toHaveBeenCalled();
  });

  it('hands off to the employer, with no GPT request, when a released Offerwall does not show', async () => {
    mocks.status = 'held';
    render(<RewardedApplicationOffer {...props} />);

    await settle({ outcome: 'not_shown', reason: 'appear_timeout' });

    expect(tracked('rewarded_offerwall_not_shown')).toEqual([
      expect.objectContaining({ ...offerwallContext, reason: 'appear_timeout' }),
    ]);
    expect(props.onUnavailable).toHaveBeenCalledTimes(1);
    expect(props.onUnavailable).toHaveBeenCalledWith('offerwall_not_shown');
    expect(screen.queryByTestId('mock-google-rewarded')).not.toBeInTheDocument();
    expect(mocks.grantRewardedApplicationAccess).not.toHaveBeenCalled();
    expect(props.onContinue).not.toHaveBeenCalled();
  });

  it('runs the GPT request when the release itself was refused (nothing released)', async () => {
    mocks.status = 'held';
    render(<RewardedApplicationOffer {...props} />);

    await settle({ outcome: 'not_shown', reason: 'release_refused' });

    expect(screen.getByTestId('mock-google-rewarded')).toBeInTheDocument();
    expect(tracked('rewarded_offerwall_not_shown')).toEqual([
      expect.objectContaining({ ...offerwallContext, reason: 'release_refused' }),
    ]);
    expect(props.onUnavailable).not.toHaveBeenCalled();
  });

  it('reports a stall without unlocking, then recovers when the Offerwall finally closes', async () => {
    mocks.status = 'held';
    render(<RewardedApplicationOffer {...props} />);
    showOfferwall(500);

    act(() => {
      mocks.releaseOptions?.onStalled?.({ shownMs: 500, root: 'fc-message-root' });
    });
    expect(tracked('rewarded_offerwall_timed_out')).toEqual([
      expect.objectContaining({ ...offerwallContext, shown_ms: 500, fc_root: 'fc-message-root' }),
    ]);
    expect(mocks.grantRewardedApplicationAccess).not.toHaveBeenCalled();
    // Google's dialog is still up: this one stays out of its way.
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    act(() => {
      mocks.releaseOptions?.onClosed?.({ shownMs: 500, closedMs: 601_000, root: 'fc-message-root' });
    });
    expect(screen.getByRole('dialog')).toBeInTheDocument();

    await settle({ outcome: 'closed_without_reward', shownMs: 500, closedMs: 601_000, root: 'fc-message-root' });
    expect(props.onUnavailable).toHaveBeenCalledWith('offerwall_closed_without_reward');
    expect(mocks.grantRewardedApplicationAccess).not.toHaveBeenCalled();
    expect(props.onContinue).not.toHaveBeenCalled();
  });

  it('hands the visitor to the employer when the Offerwall closes without a reward', async () => {
    mocks.status = 'held';
    render(<RewardedApplicationOffer {...props} />);
    showOfferwall(700);

    await settle({ outcome: 'closed_without_reward', shownMs: 700, closedMs: 9_000, root: 'fc-message-root' });

    expect(tracked('rewarded_offerwall_closed_without_reward')).toEqual([
      expect.objectContaining({ ...offerwallContext, shown_ms: 700, closed_ms: 9_000, fc_root: 'fc-message-root' }),
    ]);
    expect(props.onUnavailable).toHaveBeenCalledTimes(1);
    expect(props.onUnavailable).toHaveBeenCalledWith('offerwall_closed_without_reward');
    expect(mocks.grantRewardedApplicationAccess).not.toHaveBeenCalled();
    expect(tracked('rewarded_offerwall_completed')).toEqual([]);
    // No second ad after the Offerwall.
    expect(screen.queryByTestId('mock-google-rewarded')).not.toBeInTheDocument();
  });
});
