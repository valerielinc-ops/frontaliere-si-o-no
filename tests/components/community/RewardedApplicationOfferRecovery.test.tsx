// @vitest-environment jsdom
/**
 * Offerwall recovery inside the rewarded application offer
 * (services/offerwallRecovery.ts), for the clicks the gate cannot serve as
 * they arrive (measured 27-28/09):
 * - consent given on the same page view (`suppressed`), a second attempt
 *   (`released`), a stale `off_board`: one reload that resumes the click;
 * - a refused consent is a decision: Google serves the Offerwall with Limited
 *   Ads; with no decision yet Google's consent message opens at once (owner
 *   decision 2026-10-03), and a message that never shows or closes
 *   unanswered goes on without the video;
 * - Funding Choices still loading: the click waits briefly for the gate.
 */
import { act, cleanup, render, screen } from '@testing-library/react';
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
  parkedOfferwallRoot: () => null,
  OFFERWALL_STAGED_APPEAR_TIMEOUT_MS: 6000,
}));

import RewardedApplicationOffer, {
  CONSENT_DECISION_GRACE_MS,
  CONSENT_MESSAGE_APPEAR_MS,
} from '@/components/community/RewardedApplicationOffer';
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

/** Funding Choices can show its consent message right away. */
const fundingChoicesReady = () => {
  const showRevocationMessage = vi.fn();
  (window as unknown as { googlefc?: Gfc }).googlefc = { callbackQueue: [], showRevocationMessage };
  return showRevocationMessage;
};

/** Google's consent message on screen, as Funding Choices mounts it. */
const mountConsentMessage = () => {
  const root = document.createElement('div');
  root.className = 'fc-consent-root';
  document.body.appendChild(root);
  return root;
};

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
  document.body.querySelectorAll('.fc-consent-root').forEach((el) => el.remove());
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

  it('opens the Google consent message at once when the visitor has not answered yet', () => {
    mocks.status = 'suppressed';
    consent(null);
    const showRevocationMessage = fundingChoicesReady();
    const p = props();
    render(<RewardedApplicationOffer {...p} />);

    expect(showRevocationMessage).toHaveBeenCalledTimes(1);
    // No card of ours before it: the neutral loading screen stays under it.
    expect(screen.queryByTestId('rewarded-application-consent')).not.toBeInTheDocument();
    expect(screen.getByTestId('rewarded-application-loading')).toBeInTheDocument();
    expect(p.onReload).not.toHaveBeenCalled();
    expect(mocks.releaseHeldOfferwall).not.toHaveBeenCalled();
    expect(tracked('rewarded_offerwall_consent_reopened')).toHaveLength(1);
    expect(tracked('rewarded_offerwall_not_shown')).toEqual([
      expect.objectContaining({ reason: 'no_consent_decision', gate_status: 'suppressed', consent_state: 'none' }),
    ]);
  });

  it.each(['granted', 'denied'] as const)('releases the Offerwall held since the load once the answer is %s', (answer) => {
    mocks.status = 'held';
    consent(null);
    fundingChoicesReady();
    render(<RewardedApplicationOffer {...props()} />);
    expect(mocks.releaseHeldOfferwall).not.toHaveBeenCalled();

    act(() => {
      setAdsConsent(answer);
    });

    expect(mocks.releaseHeldOfferwall).toHaveBeenCalledTimes(1);
    expect(tracked('rewarded_offerwall_consent_decided')).toEqual([
      expect.objectContaining({ gate_status: 'held', consent_state: answer }),
    ]);
    // Reported once, when the message opened.
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
    fundingChoicesReady();
    mountConsentMessage();
    const p = props();
    render(<RewardedApplicationOffer {...p} />);

    act(() => {
      window.dispatchEvent(new CustomEvent('frontaliere:ads-consent'));
    });

    expect(mocks.releaseHeldOfferwall).not.toHaveBeenCalled();
    expect(p.onUnavailable).not.toHaveBeenCalled();
  });

  it('goes on without the video when the consent message never comes on screen', async () => {
    vi.useFakeTimers();
    mocks.status = 'suppressed';
    consent(null);
    fundingChoicesReady();
    const p = props();
    render(<RewardedApplicationOffer {...p} />);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(CONSENT_MESSAGE_APPEAR_MS - 400);
    });
    expect(p.onUnavailable).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(800);
    });

    expect(p.onUnavailable).toHaveBeenCalledWith('ad_consent_missing');
    expect(tracked('rewarded_offerwall_consent_declined')).toEqual([
      expect.objectContaining({ reason: 'message_not_shown' }),
    ]);
  });

  it('waits while the consent message is on screen, then goes on without the video if it closes unanswered', async () => {
    vi.useFakeTimers();
    mocks.status = 'suppressed';
    consent(null);
    fundingChoicesReady();
    const message = mountConsentMessage();
    const p = props();
    render(<RewardedApplicationOffer {...p} />);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(p.onUnavailable).not.toHaveBeenCalled();

    message.remove();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(CONSENT_DECISION_GRACE_MS - 400);
    });
    expect(p.onUnavailable).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(800);
    });

    expect(p.onUnavailable).toHaveBeenCalledWith('ad_consent_missing');
    expect(tracked('rewarded_offerwall_consent_declined')).toEqual([
      expect.objectContaining({ reason: 'message_closed' }),
    ]);
  });

  it('takes the answer that arrives just after the message closes', async () => {
    vi.useFakeTimers();
    mocks.status = 'held';
    consent(null);
    fundingChoicesReady();
    const message = mountConsentMessage();
    const p = props();
    render(<RewardedApplicationOffer {...p} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });

    message.remove();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(600);
    });
    act(() => {
      setAdsConsent('granted');
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(CONSENT_DECISION_GRACE_MS * 2);
    });

    expect(mocks.releaseHeldOfferwall).toHaveBeenCalledTimes(1);
    expect(p.onUnavailable).not.toHaveBeenCalled();
    expect(tracked('rewarded_offerwall_consent_declined')).toEqual([]);
  });

  it('never asks for consent when Funding Choices never reached the gate', () => {
    mocks.status = 'absent';
    consent(null);
    render(<RewardedApplicationOffer {...props()} />);

    expect(tracked('rewarded_offerwall_consent_reopened')).toEqual([]);
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

  it('waits for a Funding Choices loader that is only scheduled, then opens the consent message', async () => {
    // A first click before the idle loader injects Funding Choices: the CMP
    // bridge is there, the script is not yet (review of #10230).
    vi.useFakeTimers();
    (window as unknown as { __ftFcConsentBridge?: number }).__ftFcConsentBridge = 1;
    consent(null);
    render(<RewardedApplicationOffer {...props()} />);

    expect(screen.getByTestId('rewarded-application-loading')).toBeInTheDocument();
    expect(screen.queryByTestId('mock-google-rewarded')).not.toBeInTheDocument();

    expect(tracked('rewarded_offerwall_consent_reopened')).toEqual([]);

    mocks.status = 'suppressed';
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4500);
    });

    expect(tracked('rewarded_offerwall_consent_reopened')).toHaveLength(1);
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
