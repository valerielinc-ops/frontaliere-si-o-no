// @vitest-environment jsdom
/**
 * Offerwall recovery inside the rewarded application offer
 * (services/offerwallRecovery.ts), for the clicks the gate cannot serve as
 * they arrive (measured 27-28/09):
 * - consent given on the same page view (`suppressed`), a second attempt
 *   (`released`), a stale `off_board`: one reload that resumes the click;
 * - a refused consent is a decision: Google serves the Offerwall with Limited
 *   Ads; with no decision yet the visitor is asked for the consent choice, or
 *   goes on without the video;
 * - Funding Choices still loading: the click waits briefly for the gate.
 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

type ReleaseResult = { outcome: 'not_shown'; reason: string };

const mocks = vi.hoisted(() => ({
  status: 'absent' as 'held' | 'released' | 'suppressed' | 'off_board' | 'absent',
  releaseHeldOfferwall: vi.fn(),
  trackAssistedApplicationEvent: vi.fn(),
}));

vi.mock('@/components/shared/GptRewardedAd', () => ({
  default: () => <div data-testid="mock-google-rewarded" />,
}));
vi.mock('@/services/rewardedWebAd', () => ({
  ASSISTED_APPLICATION_REWARDED_AD_UNIT_PATH: '/23355151813/rewarded-application-video',
  REWARDED_WEB_AD_FORMAT: 'rewarded_web',
  disposeRewardedWebAd: vi.fn(),
  isRewardedWebAdEligible: () => true,
}));
vi.mock('@/services/rewardedApplicationAccess', () => ({
  grantRewardedApplicationAccess: vi.fn(() => 1_900_000_000_000),
  REWARDED_APPLICATION_ACCESS_TTL_HOURS: 1,
}));
vi.mock('@/services/assistedApplicationExperiment', () => ({
  trackAssistedApplicationEvent: mocks.trackAssistedApplicationEvent,
}));
vi.mock('@/services/offerwallClickGate', () => ({
  offerwallGateStatus: () => mocks.status,
  releaseHeldOfferwall: mocks.releaseHeldOfferwall,
}));

import RewardedApplicationOffer from '@/components/community/RewardedApplicationOffer';
import { setAdsConsent } from '@/services/adsConsent';
import { takeOfferwallResume } from '@/services/offerwallRecovery';
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
});

const consent = (value: 'granted' | 'denied' | null) => {
  if (value === null) window.localStorage.removeItem('frontaliere_ads_consent');
  else window.localStorage.setItem('frontaliere_ads_consent', value);
};

type Gfc = { callbackQueue?: unknown[]; showRevocationMessage?: () => void };

beforeAll(async () => {
  await itReady;
});

beforeEach(() => {
  vi.clearAllMocks();
  window.localStorage.clear();
  window.sessionStorage.clear();
  mocks.status = 'absent';
  mocks.releaseHeldOfferwall.mockImplementation(() => new Promise<ReleaseResult>(() => {}));
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  document.body.style.overflow = '';
  document.head.querySelectorAll('script[data-test-fc]').forEach((el) => el.remove());
  delete (window as unknown as { googlefc?: Gfc }).googlefc;
  delete (window as unknown as { __ftFcConsentBridge?: unknown }).__ftFcConsentBridge;
});

describe('RewardedApplicationOffer — reload that resumes the click', () => {
  it.each([
    ['suppressed', 'no_consent_decision'],
    ['released', 'already_released'],
    ['off_board', 'off_board_page'],
  ] as const)('reloads once for a %s gate with consent, behind the loading screen', (status, reason) => {
    mocks.status = status;
    consent('granted');
    const p = props();
    render(<RewardedApplicationOffer {...p} />);

    expect(p.onReload).toHaveBeenCalledTimes(1);
    // The resumed click gets the reason: the event before the reload does not reach GA4.
    expect(takeOfferwallResume('job-1')).toEqual({ reason, gate_status: status, consent_state: 'granted' });
    expect(screen.getByTestId('rewarded-application-loading')).toHaveTextContent('Apertura di «Fisioterapista diplomato»…');
    expect(screen.queryByTestId('mock-google-rewarded')).not.toBeInTheDocument();
    expect(mocks.releaseHeldOfferwall).not.toHaveBeenCalled();
    expect(tracked('rewarded_offerwall_reload')).toEqual([
      expect.objectContaining({ reason, gate_status: status, consent_state: 'granted' }),
    ]);
    expect(tracked('rewarded_offerwall_not_shown')).toEqual([]);
    expect(p.onUnavailable).not.toHaveBeenCalled();
  });

  it('never reloads a resumed click again: the GPT path runs, and says why', () => {
    mocks.status = 'suppressed';
    consent('granted');
    const p = props();
    render(<RewardedApplicationOffer {...p} resumed />);

    expect(p.onReload).not.toHaveBeenCalled();
    expect(screen.getByTestId('mock-google-rewarded')).toBeInTheDocument();
    expect(tracked('rewarded_offerwall_not_shown')).toEqual([
      expect.objectContaining({ reason: 'no_consent_decision', trigger: 'offerwall_resume', consent_state: 'granted' }),
    ]);
  });

  it('takes the GPT path when the resume marker cannot be stored', () => {
    mocks.status = 'released';
    consent('granted');
    const real = window.sessionStorage;
    const throwing = {
      getItem: () => null,
      setItem: () => {
        throw new DOMException('quota', 'QuotaExceededError');
      },
      removeItem: () => {},
      clear: () => {},
      key: () => null,
      length: 0,
    } as unknown as Storage;
    Object.defineProperty(window, 'sessionStorage', { value: throwing, configurable: true });
    const p = props();
    try {
      render(<RewardedApplicationOffer {...p} />);
    } finally {
      Object.defineProperty(window, 'sessionStorage', { value: real, configurable: true });
    }

    expect(p.onReload).not.toHaveBeenCalled();
    expect(screen.getByTestId('mock-google-rewarded')).toBeInTheDocument();
    expect(tracked('rewarded_offerwall_not_shown')).toEqual([
      expect.objectContaining({ reason: 'already_released' }),
    ]);
  });
});

describe('RewardedApplicationOffer — consent choice', () => {
  it('releases the Offerwall after a refused consent: Google serves it with Limited Ads', () => {
    mocks.status = 'held';
    consent('denied');
    render(<RewardedApplicationOffer {...props()} />);

    expect(mocks.releaseHeldOfferwall).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('rewarded-application-consent')).not.toBeInTheDocument();
    expect(tracked('rewarded_offerwall_released')).toEqual([
      expect.objectContaining({ gate_status: 'held', consent_state: 'denied' }),
    ]);
  });

  it('reloads for a consent refused on this page view, like a grant', () => {
    mocks.status = 'suppressed';
    consent('denied');
    const p = props();
    render(<RewardedApplicationOffer {...p} />);

    expect(p.onReload).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('rewarded-application-consent')).not.toBeInTheDocument();
  });

  it('asks for the consent choice when the visitor has not answered yet', () => {
    mocks.status = 'suppressed';
    consent(null);
    const p = props();
    render(<RewardedApplicationOffer {...p} />);

    expect(p.onReload).not.toHaveBeenCalled();
    expect(mocks.releaseHeldOfferwall).not.toHaveBeenCalled();
    const card = screen.getByTestId('rewarded-application-consent');
    expect(card).toHaveAttribute('role', 'dialog');
    expect(card).toHaveTextContent('Per candidarti a «Fisioterapista diplomato» con il video manca la tua scelta sul consenso');
    expect(document.activeElement).toBe(card);
    expect(screen.queryByTestId('rewarded-application-loading')).not.toBeInTheDocument();
    expect(tracked('rewarded_offerwall_not_shown')).toEqual([
      expect.objectContaining({ reason: 'no_consent_decision', gate_status: 'suppressed', consent_state: 'none' }),
    ]);
  });

  it('opens the Funding Choices consent message from the card', () => {
    mocks.status = 'suppressed';
    consent(null);
    const showRevocationMessage = vi.fn();
    (window as unknown as { googlefc?: Gfc }).googlefc = { callbackQueue: [], showRevocationMessage };
    render(<RewardedApplicationOffer {...props()} />);

    fireEvent.click(screen.getByTestId('rewarded-application-consent-review'));

    expect(showRevocationMessage).toHaveBeenCalledTimes(1);
    expect(tracked('rewarded_offerwall_consent_reopened')).toHaveLength(1);
  });

  it.each(['granted', 'denied'] as const)('releases the Offerwall held since the load once the answer is %s', (answer) => {
    mocks.status = 'held';
    consent(null);
    render(<RewardedApplicationOffer {...props()} />);
    expect(screen.getByTestId('rewarded-application-consent')).toBeInTheDocument();

    act(() => {
      setAdsConsent(answer);
    });

    expect(mocks.releaseHeldOfferwall).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('rewarded-application-consent')).not.toBeInTheDocument();
    expect(tracked('rewarded_offerwall_consent_decided')).toEqual([
      expect.objectContaining({ gate_status: 'held', consent_state: answer }),
    ]);
    // Reported once, when the card opened.
    expect(tracked('rewarded_offerwall_not_shown')).toHaveLength(1);
  });

  it('reloads after the answer when nothing was held for the page view', () => {
    mocks.status = 'suppressed';
    consent(null);
    const p = props();
    render(<RewardedApplicationOffer {...p} />);

    act(() => {
      setAdsConsent('granted');
    });

    expect(p.onReload).toHaveBeenCalledTimes(1);
    expect(takeOfferwallResume('job-1')).toEqual({
      reason: 'no_consent_decision',
      gate_status: 'suppressed',
      consent_state: 'granted',
    });
  });

  it('ignores a change that leaves no decision', () => {
    mocks.status = 'held';
    consent(null);
    render(<RewardedApplicationOffer {...props()} />);

    act(() => {
      window.dispatchEvent(new CustomEvent('frontaliere:ads-consent'));
    });

    expect(screen.getByTestId('rewarded-application-consent')).toBeInTheDocument();
    expect(mocks.releaseHeldOfferwall).not.toHaveBeenCalled();
  });

  it('goes on to the employer without the video', () => {
    mocks.status = 'suppressed';
    consent(null);
    const p = props();
    render(<RewardedApplicationOffer {...p} />);

    fireEvent.click(screen.getByTestId('rewarded-application-consent-continue'));

    expect(p.onUnavailable).toHaveBeenCalledWith('ad_consent_missing');
    expect(tracked('rewarded_offerwall_consent_declined')).toHaveLength(1);
  });

  it('never asks for consent when Funding Choices never reached the gate', () => {
    mocks.status = 'absent';
    consent(null);
    render(<RewardedApplicationOffer {...props()} />);

    expect(screen.queryByTestId('rewarded-application-consent')).not.toBeInTheDocument();
    expect(screen.getByTestId('mock-google-rewarded')).toBeInTheDocument();
  });
});

describe('RewardedApplicationOffer — Funding Choices still loading', () => {
  const addFundingChoicesScript = () => {
    const script = document.createElement('script');
    script.setAttribute('data-test-fc', '');
    script.src = 'https://fundingchoicesmessages.google.com/i/pub-8628054934855353?ers=1';
    document.head.appendChild(script);
  };

  it('waits for the gate, then releases the Offerwall it holds', async () => {
    vi.useFakeTimers();
    addFundingChoicesScript();
    consent('granted');
    render(<RewardedApplicationOffer {...props()} />);

    expect(screen.getByTestId('rewarded-application-loading')).toBeInTheDocument();
    expect(screen.queryByTestId('mock-google-rewarded')).not.toBeInTheDocument();
    expect(mocks.releaseHeldOfferwall).not.toHaveBeenCalled();

    mocks.status = 'held';
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });

    expect(mocks.releaseHeldOfferwall).toHaveBeenCalledTimes(1);
    expect(tracked('rewarded_offerwall_not_shown')).toEqual([]);
  });

  it('waits for a Funding Choices loader that is only scheduled, then asks for the consent choice', async () => {
    // A first click before the idle loader injects Funding Choices: the CMP
    // bridge is there, the script is not yet (review of #10230).
    vi.useFakeTimers();
    (window as unknown as { __ftFcConsentBridge?: number }).__ftFcConsentBridge = 1;
    consent(null);
    render(<RewardedApplicationOffer {...props()} />);

    expect(screen.getByTestId('rewarded-application-loading')).toBeInTheDocument();
    expect(screen.queryByTestId('mock-google-rewarded')).not.toBeInTheDocument();

    mocks.status = 'suppressed';
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4500);
    });

    expect(screen.getByTestId('rewarded-application-consent')).toBeInTheDocument();
    expect(screen.queryByTestId('mock-google-rewarded')).not.toBeInTheDocument();
  });

  it('takes the GPT path when the gate is still not reached after the wait', async () => {
    vi.useFakeTimers();
    addFundingChoicesScript();
    consent('granted');
    render(<RewardedApplicationOffer {...props()} />);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(3100);
    });

    expect(screen.getByTestId('mock-google-rewarded')).toBeInTheDocument();
    expect(tracked('rewarded_offerwall_not_shown')).toEqual([
      expect.objectContaining({ reason: 'not_held', gate_status: 'absent' }),
    ]);
  });

  it('waits for the gate after the resume reload even before the script is seen', async () => {
    vi.useFakeTimers();
    consent('granted');
    render(<RewardedApplicationOffer {...props()} resumed />);

    expect(screen.queryByTestId('mock-google-rewarded')).not.toBeInTheDocument();
    mocks.status = 'held';
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });

    expect(mocks.releaseHeldOfferwall).toHaveBeenCalledTimes(1);
    expect(tracked('rewarded_offerwall_released')).toEqual([
      expect.objectContaining({ trigger: 'offerwall_resume' }),
    ]);
  });
});
