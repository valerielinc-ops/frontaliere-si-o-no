// @vitest-environment jsdom
/**
 * The paid application first, the Offerwall prepared hidden behind it (owner
 * decision 2026-10-03): with `paidChoice`, a click whose Offerwall is held
 * shows the paid choice while the Offerwall is released off screen; the free
 * path reveals it, and a failure after that goes to the employer without a
 * second paid offer.
 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

type ReleaseResult = { outcome: string; reason?: string };
type ReleaseOptions = {
  staged?: boolean;
  onStaged?: (info: { elapsedMs: number; root: string }) => void;
  onShown?: (info: { shownMs: number; root: string }) => void;
};

const mocks = vi.hoisted(() => ({
  status: 'held' as 'held' | 'released' | 'suppressed' | 'off_board' | 'absent',
  releaseHeldOfferwall: vi.fn(),
  revealStagedOfferwall: vi.fn(),
  trackAssistedApplicationEvent: vi.fn(),
}));

vi.mock('@/components/shared/GptRewardedAd', () => ({
  default: () => <div data-testid="mock-google-rewarded" />,
}));
vi.mock('@/services/rewardedWebAd', () => ({
  ASSISTED_APPLICATION_REWARDED_AD_UNIT_PATH: '/23355151813/rewarded-application-video',
  REWARDED_WEB_AD_FORMAT: 'rewarded_web',
  disposeRewardedWebAd: vi.fn(),
  isRewardedWebAdEligible: () => false,
}));
vi.mock('@/services/rewardedApplicationAccess', () => ({
  grantRewardedApplicationAccess: vi.fn(() => 1_900_000_000_000),
  REWARDED_APPLICATION_ACCESS_TTL_HOURS: 1,
}));
vi.mock('@/services/assistedApplicationExperiment', () => ({
  ASSISTED_APPLICATION_PRICE_EUR_CENTS: 99,
  trackAssistedApplicationEvent: mocks.trackAssistedApplicationEvent,
}));
vi.mock('@/services/offerwallClickGate', () => ({
  offerwallGateStatus: () => mocks.status,
  releaseHeldOfferwall: mocks.releaseHeldOfferwall,
  revealStagedOfferwall: mocks.revealStagedOfferwall,
}));

import RewardedApplicationOffer from '@/components/community/RewardedApplicationOffer';
import { setAdsConsent } from '@/services/adsConsent';
import { itReady } from '@/services/i18n';

const tracked = (name: string) => mocks.trackAssistedApplicationEvent.mock.calls
  .filter(([eventName]) => eventName === name)
  .map(([, params]) => params);

const props = () => ({
  jobId: 'job-1',
  companyId: 'company-1',
  companyName: 'EOC',
  jobTitle: 'Fisioterapista diplomato',
  onContinue: vi.fn(),
  onUnavailable: vi.fn(),
  onDismiss: vi.fn(),
  onReload: vi.fn(),
  paidChoice: { onChoosePaid: vi.fn() },
});

let settleRelease: (result: ReleaseResult) => void = () => {};
const releaseOptions = (): ReleaseOptions => mocks.releaseHeldOfferwall.mock.calls[0][0] as ReleaseOptions;

beforeAll(async () => {
  await itReady;
});

beforeEach(() => {
  vi.clearAllMocks();
  window.localStorage.clear();
  window.sessionStorage.clear();
  window.localStorage.setItem('frontaliere_ads_consent', 'granted');
  mocks.status = 'held';
  mocks.releaseHeldOfferwall.mockImplementation(() => new Promise<ReleaseResult>((resolve) => {
    settleRelease = resolve;
  }));
});

afterEach(() => {
  cleanup();
  document.body.style.overflow = '';
  delete (window as unknown as { googlefc?: unknown }).googlefc;
});

describe('RewardedApplicationOffer — paid choice first', () => {
  it('shows the paid choice and releases the Offerwall hidden behind it', () => {
    render(<RewardedApplicationOffer {...props()} />);

    expect(screen.getByTestId('assisted-application-offer')).toBeInTheDocument();
    expect(screen.getByTestId('assisted-application-offer-external'))
      .toHaveTextContent('Candidati da solo, gratis con un breve video');
    expect(screen.queryByTestId('rewarded-application-loading')).not.toBeInTheDocument();
    expect(mocks.releaseHeldOfferwall).toHaveBeenCalledTimes(1);
    expect(releaseOptions().staged).toBe(true);
    expect(mocks.revealStagedOfferwall).not.toHaveBeenCalled();
    expect(tracked('assisted_application_offer_viewed')).toEqual([
      expect.objectContaining({ variant: 'rewarded_ad', jobId: 'job-1', trigger: 'offerwall_first' }),
    ]);
    expect(tracked('rewarded_offerwall_released')).toHaveLength(1);
  });

  it('reports the hidden Offerwall once it is ready', () => {
    render(<RewardedApplicationOffer {...props()} />);

    act(() => {
      releaseOptions().onStaged?.({ elapsedMs: 1900, root: 'fc-message-root' });
    });

    expect(tracked('rewarded_offerwall_staged')).toEqual([
      expect.objectContaining({ shown_ms: 1900, fc_root: 'fc-message-root', gate_status: 'held' }),
    ]);
    // Still the choice: nothing comes on screen before the visitor asks.
    expect(screen.getByTestId('assisted-application-offer')).toBeInTheDocument();
  });

  it('reveals the ready Offerwall on the free path and steps out of its way', () => {
    render(<RewardedApplicationOffer {...props()} />);
    act(() => {
      releaseOptions().onStaged?.({ elapsedMs: 1900, root: 'fc-message-root' });
    });

    fireEvent.click(screen.getByTestId('assisted-application-offer-external'));

    expect(mocks.revealStagedOfferwall).toHaveBeenCalledTimes(1);
    expect(tracked('assisted_application_choose_external')).toEqual([
      expect.objectContaining({ reason: 'offerwall_ready', gate_status: 'held' }),
    ]);
    expect(screen.queryByTestId('assisted-application-offer')).not.toBeInTheDocument();
    // Until Google's dialog is on screen the neutral loading line stays.
    expect(screen.getByTestId('rewarded-application-loading')).toBeInTheDocument();

    act(() => {
      releaseOptions().onShown?.({ shownMs: 120, root: 'fc-message-root' });
    });
    expect(screen.queryByTestId('rewarded-application-offer')).not.toBeInTheDocument();
    expect(tracked('rewarded_offerwall_shown')).toEqual([expect.objectContaining({ shown_ms: 120 })]);
  });

  it('reveals an Offerwall still rendering, and says so', () => {
    render(<RewardedApplicationOffer {...props()} />);

    fireEvent.click(screen.getByTestId('assisted-application-offer-external'));

    expect(mocks.revealStagedOfferwall).toHaveBeenCalledTimes(1);
    expect(tracked('assisted_application_choose_external')).toEqual([
      expect.objectContaining({ reason: 'offerwall_pending' }),
    ]);
  });

  it('goes to the employer without a second paid offer when the Offerwall then fails', async () => {
    const p = props();
    render(<RewardedApplicationOffer {...p} />);
    fireEvent.click(screen.getByTestId('assisted-application-offer-external'));

    await act(async () => {
      settleRelease({ outcome: 'not_shown', reason: 'appear_timeout' });
    });

    expect(p.onUnavailable).toHaveBeenCalledWith('offerwall_not_shown', { paidOfferShown: true });
  });

  it('starts the checkout from the paid button, leaving the Offerwall hidden', () => {
    const p = props();
    render(<RewardedApplicationOffer {...p} />);

    fireEvent.click(screen.getByTestId('assisted-application-offer-paid'));

    expect(p.paidChoice.onChoosePaid).toHaveBeenCalledTimes(1);
    expect(mocks.revealStagedOfferwall).not.toHaveBeenCalled();
  });

  it('shows the checkout state the parent passes', () => {
    const p = props();
    const { rerender } = render(<RewardedApplicationOffer {...p} />);

    rerender(<RewardedApplicationOffer {...p} paidChoice={{ ...p.paidChoice, paidLoading: true, error: 'Pagamento non disponibile' }} />);

    expect(screen.getByTestId('assisted-application-offer-paid')).toBeDisabled();
    expect(screen.getByRole('alert')).toHaveTextContent('Pagamento non disponibile');
  });

  it('closes from its X and from Escape, never revealing the Offerwall', () => {
    const p = props();
    render(<RewardedApplicationOffer {...p} />);

    fireEvent.click(screen.getByTestId('assisted-application-offer-close'));
    expect(p.onDismiss).toHaveBeenCalledTimes(1);

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(p.onDismiss).toHaveBeenCalledTimes(2);
    expect(mocks.revealStagedOfferwall).not.toHaveBeenCalled();
  });

  it('keeps one body scroll lock, restored when the offer closes', () => {
    document.body.style.overflow = 'auto';
    const { unmount } = render(<RewardedApplicationOffer {...props()} />);
    expect(document.body.style.overflow).toBe('hidden');

    unmount();
    expect(document.body.style.overflow).toBe('auto');
  });

  it('keeps the choice up when the hidden release did not happen, and goes on without the Offerwall', async () => {
    const p = props();
    render(<RewardedApplicationOffer {...p} />);

    await act(async () => {
      settleRelease({ outcome: 'not_shown', reason: 'release_refused' });
    });
    expect(screen.getByTestId('assisted-application-offer')).toBeInTheDocument();
    expect(tracked('rewarded_offerwall_not_shown')).toEqual([
      expect.objectContaining({ reason: 'release_refused' }),
    ]);

    fireEvent.click(screen.getByTestId('assisted-application-offer-external'));

    expect(mocks.revealStagedOfferwall).not.toHaveBeenCalled();
    expect(tracked('assisted_application_choose_external')).toEqual([
      expect.objectContaining({ reason: 'offerwall_unavailable' }),
    ]);
    // The GPT path, which reports itself unavailable while the video is off;
    // that report then carries `paidOfferShown` (previous test).
    expect(screen.getByTestId('mock-google-rewarded')).toBeInTheDocument();
  });

  it('opens the consent message first, then the paid choice once the answer lets the Offerwall through', () => {
    window.localStorage.removeItem('frontaliere_ads_consent');
    const showRevocationMessage = vi.fn();
    (window as unknown as { googlefc?: unknown }).googlefc = { callbackQueue: [], showRevocationMessage };
    render(<RewardedApplicationOffer {...props()} />);

    expect(showRevocationMessage).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('assisted-application-offer')).not.toBeInTheDocument();
    expect(mocks.releaseHeldOfferwall).not.toHaveBeenCalled();

    act(() => {
      setAdsConsent('granted');
    });

    expect(screen.getByTestId('assisted-application-offer')).toBeInTheDocument();
    expect(releaseOptions().staged).toBe(true);
  });

  it('releases the Offerwall on screen at once without a paid choice, as before', () => {
    const { paidChoice: _paidChoice, ...withoutChoice } = props();
    render(<RewardedApplicationOffer {...withoutChoice} />);

    expect(screen.queryByTestId('assisted-application-offer')).not.toBeInTheDocument();
    expect(releaseOptions().staged).toBe(false);
  });

  it('never shows the paid choice when nothing is held for the click', () => {
    mocks.status = 'released';
    const p = props();
    render(<RewardedApplicationOffer {...p} />);

    expect(screen.queryByTestId('assisted-application-offer')).not.toBeInTheDocument();
    expect(p.onReload).toHaveBeenCalledTimes(1);
  });
});
