// @vitest-environment jsdom
/**
 * GPT path of the rewarded application offer (no Offerwall held for the page
 * view). Since 2026-09-26 the "Candidati" click opens a neutral loading
 * screen that never mentions a video, so the GPT rewarded ad must not start
 * by itself: the visitor opts in explicitly once the slot is ready, a slot
 * that is not ready in time hands the click to the employer, and the reward
 * opens the application in a new tab: with no further click while the page
 * holds a click's activation, otherwise from one click (2026-09-29).
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

type Info = { requestId: number; detail?: string };

const mocks = vi.hoisted(() => ({
  props: null as Record<string, unknown> | null,
  trackAssistedApplicationEvent: vi.fn(),
  grantRewardedApplicationAccess: vi.fn(() => 1_900_000_000_000),
}));

vi.mock('@/components/shared/GptRewardedAd', () => ({
  default: (props: Record<string, unknown>) => {
    mocks.props = props;
    return <div data-testid="mock-google-rewarded" />;
  },
}));
vi.mock('@/services/rewardedWebAd', () => ({
  ASSISTED_APPLICATION_REWARDED_AD_UNIT_PATH: '/23355151813/rewarded-application-video',
  REWARDED_WEB_AD_FORMAT: 'rewarded_web',
  disposeRewardedWebAd: vi.fn(),
  isRewardedWebAdEligible: () => true,
}));
vi.mock('@/services/rewardedApplicationAccess', () => ({
  grantRewardedApplicationAccess: mocks.grantRewardedApplicationAccess,
  REWARDED_APPLICATION_ACCESS_TTL_HOURS: 1,
}));
vi.mock('@/services/assistedApplicationExperiment', () => ({
  trackAssistedApplicationEvent: mocks.trackAssistedApplicationEvent,
}));

import RewardedApplicationOffer, { GPT_OPT_IN_READY_TIMEOUT_MS } from '@/components/community/RewardedApplicationOffer';
import { RETURN_TO_TAB_SETTLE_MS } from '@/services/adVisibilitySnapshot';
import { HANDOFF_RECEIPT_MIN_AGE_MS } from '@/services/rewardedHandoffLedger';
import { setUserActivation } from '../../helpers/userActivation';
import { isActive, POPUP_PRIORITY, releaseSlot, requestSlot } from '@/services/popupQueue';
import { itReady } from '@/services/i18n';

const callProp = <T extends unknown[]>(name: string, ...args: T) => {
  act(() => {
    (mocks.props?.[name] as ((...callArgs: T) => void) | undefined)?.(...args);
  });
};
const tracked = (name: string) => mocks.trackAssistedApplicationEvent.mock.calls
  .filter(([eventName]) => eventName === name)
  .map(([, params]) => params);

const adContext = {
  variant: 'rewarded_ad',
  jobId: 'job-1',
  companyId: 'company-1',
  surface: 'job_detail_rewarded_inline',
  trigger: 'candidate_click',
  ad_unit: '/23355151813/rewarded-application-video',
  format: 'rewarded_web',
};

const defaultProps = {
  jobId: 'job-1',
  companyId: 'company-1',
  companyName: 'EOC',
  jobTitle: 'Fisioterapista diplomato',
  onContinue: vi.fn(),
  onUnavailable: vi.fn(),
};

beforeAll(async () => {
  await itReady;
});

beforeEach(() => {
  mocks.props = null;
  vi.clearAllMocks();
  // A reward inside a click's activation opens the employer at once; the
  // `handoff` card without one is covered in RewardedApplicationOffer.test.tsx.
  setUserActivation(true);
  // Every grant writes a receipt record: start each test from an empty ledger.
  window.localStorage.removeItem(HANDOFF_LEDGER_KEY);
});

afterEach(() => {
  cleanup();
  setUserActivation(null);
  vi.restoreAllMocks();
  document.body.style.overflow = '';
});

const HANDOFF_LEDGER_KEY = 'ft_rewarded_handoff_ledger_v1';
const SAFARI_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15';
const withUserAgent = (ua: string) => vi.spyOn(Object.getPrototypeOf(window.navigator), 'userAgent', 'get').mockReturnValue(ua);

describe('RewardedApplicationOffer — GPT path (no Offerwall held)', () => {
  it('portals the overlay above the application shell and locks page scrolling', () => {
    render(<RewardedApplicationOffer {...defaultProps} />);

    const overlay = screen.getByTestId('rewarded-application-offer');
    expect(overlay.parentElement).toBe(document.body);
    expect(overlay).toHaveClass('z-[1000]');
    expect(document.body.style.overflow).toBe('hidden');
  });

  it('shows a neutral loading screen while GPT loads, and never starts the video by itself', () => {
    render(<RewardedApplicationOffer {...defaultProps} />);

    const loading = screen.getByTestId('rewarded-application-loading');
    expect(loading).toHaveAttribute('role', 'status');
    expect(loading).toHaveTextContent('Apertura di «Fisioterapista diplomato»…');
    expect(loading.textContent).not.toMatch(/video|google|pubblicit/i);
    expect(document.activeElement).toBe(loading);
    // Mounted (the request runs) but hidden until the slot is ready.
    expect(screen.getByTestId('rewarded-application-opt-in')).toHaveClass('hidden');
    expect(mocks.props?.autoStart).toBeUndefined();
    expect(tracked('rewarded_application_offer_viewed')).toEqual([expect.objectContaining(adContext)]);
  });

  it('asks for an explicit opt-in only once the rewarded slot is ready', () => {
    const onDismiss = vi.fn();
    render(<RewardedApplicationOffer {...defaultProps} onDismiss={onDismiss} />);

    callProp('onReady', { requestId: 7 } satisfies Info);

    const card = screen.getByTestId('rewarded-application-opt-in');
    expect(card).not.toHaveClass('hidden');
    expect(card).toHaveAttribute('role', 'dialog');
    expect(card).toHaveTextContent('Guarda un breve video per candidarti a «Fisioterapista diplomato»');
    expect(screen.getByTestId('rewarded-application-opt-in-subtitle')).toHaveTextContent('Poi 1 ora di candidature senza video');
    expect(mocks.props?.label).toBe('Guarda il video');
    expect(screen.queryByTestId('rewarded-application-loading')).not.toBeInTheDocument();
    expect(document.activeElement).toBe(card);

    callProp('onOptIn', { requestId: 7 } satisfies Info);
    expect(tracked('rewarded_ad_opt_in')).toEqual([
      expect.objectContaining({ ...adContext, request_id: 7, ms_since_click: expect.any(Number) }),
    ]);

    // The only secondary action closes the card.
    fireEvent.click(screen.getByRole('button', { name: 'Chiudi' }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('hands off to the employer when the slot is not ready in time', () => {
    vi.useFakeTimers();
    try {
      const onUnavailable = vi.fn();
      render(<RewardedApplicationOffer {...defaultProps} onUnavailable={onUnavailable} />);

      act(() => {
        vi.advanceTimersByTime(GPT_OPT_IN_READY_TIMEOUT_MS - 1);
      });
      expect(onUnavailable).not.toHaveBeenCalled();

      act(() => {
        vi.advanceTimersByTime(1);
      });
      expect(onUnavailable).toHaveBeenCalledTimes(1);
      expect(onUnavailable).toHaveBeenCalledWith('gpt_ready_timeout');
      expect(tracked('rewarded_gpt_ready_timeout')).toEqual([
        expect.objectContaining({ ...adContext, timeout_ms: GPT_OPT_IN_READY_TIMEOUT_MS }),
      ]);
      expect(tracked('rewarded_ad_unavailable')).toEqual([
        expect.objectContaining({ ...adContext, reason: 'gpt_ready_timeout', handoff: 'direct_external' }),
      ]);

      // A slot that turns ready after the hand-off changes nothing.
      callProp('onReady', { requestId: 8 } satisfies Info);
      callProp('onUnavailable', 'no_fill', { requestId: 8 } satisfies Info);
      expect(screen.getByTestId('rewarded-application-opt-in')).toHaveClass('hidden');
      expect(onUnavailable).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps the opt-in card once the slot was ready in time', () => {
    vi.useFakeTimers();
    try {
      const onUnavailable = vi.fn();
      render(<RewardedApplicationOffer {...defaultProps} onUnavailable={onUnavailable} />);

      act(() => {
        vi.advanceTimersByTime(1_500);
      });
      callProp('onReady', { requestId: 7 } satisfies Info);
      act(() => {
        vi.advanceTimersByTime(GPT_OPT_IN_READY_TIMEOUT_MS * 3);
      });

      expect(onUnavailable).not.toHaveBeenCalled();
      expect(tracked('rewarded_gpt_ready_timeout')).toEqual([]);
      expect(screen.getByTestId('rewarded-application-opt-in')).not.toHaveClass('hidden');
    } finally {
      vi.useRealTimers();
    }
  });

  it('hands off directly to the employer on no_fill, with the reason tracked and no retry', () => {
    const onUnavailable = vi.fn();
    render(<RewardedApplicationOffer {...defaultProps} onUnavailable={onUnavailable} />);

    callProp('onUnavailable', 'no_fill', { requestId: 3, detail: 'slot_render_empty' } satisfies Info);

    expect(onUnavailable).toHaveBeenCalledTimes(1);
    expect(onUnavailable).toHaveBeenCalledWith('no_fill');
    expect(tracked('rewarded_ad_unavailable')).toEqual([
      expect.objectContaining({
        ...adContext,
        reason: 'no_fill',
        detail: 'slot_render_empty',
        handoff: 'direct_external',
        request_id: 3,
      }),
    ]);
    expect(screen.queryByRole('button', { name: 'Riprova' })).not.toBeInTheDocument();
    expect(mocks.grantRewardedApplicationAccess).not.toHaveBeenCalled();
  });

  it.each([
    ['ready_timeout', undefined],
    ['gpt_unavailable', 'gpt_not_loaded'],
    ['consent_denied', 'denied'],
    ['not_production', 'unsupported_host'],
    ['not_eligible', 'bot'],
    ['slot_init_error', 'slot_not_defined'],
    ['display_error', 'make_visible_threw'],
    ['slot_not_ready', undefined],
  ])('hands off directly on %s and keeps the reason distinguishable', (reason, detail) => {
    const onUnavailable = vi.fn();
    render(<RewardedApplicationOffer {...defaultProps} onUnavailable={onUnavailable} />);

    callProp('onUnavailable', reason, { requestId: 5, ...(detail ? { detail } : {}) } satisfies Info);

    expect(onUnavailable).toHaveBeenCalledWith(reason);
    const [event] = tracked('rewarded_ad_unavailable');
    expect(event).toEqual(expect.objectContaining({ reason, handoff: 'direct_external', request_id: 5 }));
    if (detail) expect(event).toEqual(expect.objectContaining({ detail }));
  });

  it('keeps the offer while the parent opens the employer directly, and shows the open card when the tab is blocked', async () => {
    // PR #10366 review: a direct hand-off (no ad, paid fallback off) opened in
    // a new tab the browser blocks must not lose the employer.
    let resolveOpened: (ok: boolean) => void = () => {};
    const onUnavailable = vi.fn(() => new Promise<boolean>((resolve) => { resolveOpened = resolve; }));
    const onContinue = vi.fn();
    render(<RewardedApplicationOffer {...defaultProps} onUnavailable={onUnavailable} onContinue={onContinue} />);

    callProp('onUnavailable', 'no_fill', { requestId: 5 } satisfies Info);
    callProp('onUnavailable', 'no_fill', { requestId: 5 } satisfies Info);

    expect(onUnavailable).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('rewarded-application-loading')).toHaveTextContent('Ti portiamo a «Fisioterapista diplomato»…');
    expect(screen.queryByTestId('rewarded-application-handoff')).not.toBeInTheDocument();

    await act(async () => {
      resolveOpened(false);
      await Promise.resolve();
    });

    const card = screen.getByTestId('rewarded-application-handoff');
    expect(card).toHaveTextContent('Apri «Fisioterapista diplomato»');
    expect(card).toHaveTextContent('L’offerta si apre in una nuova scheda e questa pagina resta aperta.');
    expect(card).not.toHaveTextContent('sbloccata');
    expect(tracked('rewarded_application_direct_unconfirmed')).toEqual([
      expect.objectContaining({ ...adContext, handoff_mode: 'direct_external', reason: 'no_fill' }),
    ]);
    expect(tracked('rewarded_application_handoff_shown')).toEqual([
      expect.objectContaining({ handoff_reason: 'tab_not_opened' }),
    ]);

    fireEvent.click(screen.getByTestId('rewarded-application-handoff-open'));
    expect(onContinue).toHaveBeenCalledTimes(1);
    expect(mocks.grantRewardedApplicationAccess).not.toHaveBeenCalled();
  });

  it('shows no open card when the parent confirms the direct hand-off tab', async () => {
    const onUnavailable = vi.fn(() => Promise.resolve(true));
    render(<RewardedApplicationOffer {...defaultProps} onUnavailable={onUnavailable} />);

    callProp('onUnavailable', 'no_fill', { requestId: 5 } satisfies Info);
    await act(async () => {
      await Promise.resolve();
    });

    expect(onUnavailable).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('rewarded-application-handoff')).not.toBeInTheDocument();
    expect(tracked('rewarded_application_direct_unconfirmed')).toEqual([]);
  });

  it('continues to the employer on the authoritative Google reward, with no further click inside a click activation', () => {
    const onContinue = vi.fn();
    render(<RewardedApplicationOffer {...defaultProps} onContinue={onContinue} />);
    callProp('onReady', { requestId: 9 } satisfies Info);

    callProp('onVideoCompleted', { requestId: 9 } satisfies Info);
    expect(mocks.grantRewardedApplicationAccess).not.toHaveBeenCalled();
    expect(onContinue).not.toHaveBeenCalled();

    callProp('onGranted', { requestId: 9 } satisfies Info);
    expect(mocks.grantRewardedApplicationAccess).toHaveBeenCalledTimes(1);
    expect(onContinue).toHaveBeenCalledTimes(1);
    expect(tracked('rewarded_ad_granted')).toEqual([expect.objectContaining({ ...adContext, request_id: 9 })]);
    expect(screen.getByTestId('rewarded-application-loading')).toHaveTextContent('Ti portiamo a «Fisioterapista diplomato»…');
    expect(screen.queryByRole('button')).not.toBeInTheDocument();

    // The close that follows the grant does not continue twice.
    callProp('onClosed', true, { requestId: 9 } satisfies Info);
    expect(onContinue).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['no click activation left', false],
    ['a browser without navigator.userActivation', null],
  ])('with %s, asks for one click that opens the employer in a new tab', (_label, activation) => {
    // A new tab opened without a click's activation is blocked by the browser:
    // the reward asks for that click instead of leaving the site in this tab.
    setUserActivation(activation);
    const onContinue = vi.fn();
    render(<RewardedApplicationOffer {...defaultProps} onContinue={onContinue} />);
    callProp('onReady', { requestId: 9 } satisfies Info);

    callProp('onGranted', { requestId: 9 } satisfies Info);
    expect(mocks.grantRewardedApplicationAccess).toHaveBeenCalledTimes(1);
    expect(onContinue).not.toHaveBeenCalled();
    expect(screen.queryByTestId('rewarded-application-loading')).not.toBeInTheDocument();
    const card = screen.getByTestId('rewarded-application-handoff');
    expect(card).toHaveTextContent('Candidatura a «Fisioterapista diplomato» sbloccata');
    expect(card).toHaveTextContent('L’offerta si apre in una nuova scheda e questa pagina resta aperta.');

    const open = screen.getByTestId('rewarded-application-handoff-open');
    expect(open).toHaveTextContent('Apri l’offerta');
    fireEvent.click(open);
    fireEvent.click(open);
    expect(onContinue).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('rewarded-application-loading')).toHaveTextContent('Ti portiamo a «Fisioterapista diplomato»…');

    callProp('onClosed', true, { requestId: 9 } satisfies Info);
    expect(onContinue).toHaveBeenCalledTimes(1);
  });

  it('lets the visitor close the click card after the reward, with the access kept', () => {
    setUserActivation(false);
    const onContinue = vi.fn();
    const onDismiss = vi.fn();
    render(<RewardedApplicationOffer {...defaultProps} onContinue={onContinue} onDismiss={onDismiss} />);
    callProp('onReady', { requestId: 9 } satisfies Info);
    callProp('onGranted', { requestId: 9 } satisfies Info);

    fireEvent.keyDown(document, { key: 'Escape' });

    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(onContinue).not.toHaveBeenCalled();
    expect(mocks.grantRewardedApplicationAccess).toHaveBeenCalledTimes(1);
  });

  it('tracks the automatic new tab, and keeps the redirect screen once the tab took the foreground', async () => {
    const onContinue = vi.fn(() => Promise.resolve(true));
    render(<RewardedApplicationOffer {...defaultProps} onContinue={onContinue} />);
    callProp('onReady', { requestId: 9 } satisfies Info);
    callProp('onGranted', { requestId: 9 } satisfies Info);
    await act(async () => {});

    expect(onContinue).toHaveBeenCalledTimes(1);
    expect(tracked('rewarded_application_handoff_auto')).toEqual([expect.objectContaining(adContext)]);
    expect(tracked('rewarded_application_handoff_unconfirmed')).toEqual([]);
    expect(screen.queryByTestId('rewarded-application-handoff')).not.toBeInTheDocument();
    expect(screen.getByTestId('rewarded-application-loading')).toHaveTextContent('Ti portiamo a «Fisioterapista diplomato»…');
  });

  it('brings the open card back when no new tab took the foreground despite the activation', async () => {
    // Safari may block window.open although navigator.userActivation.isActive
    // is true; with noopener the call returns null, so the parent reports it.
    const onContinue = vi.fn(() => Promise.resolve(false));
    render(<RewardedApplicationOffer {...defaultProps} onContinue={onContinue} />);
    callProp('onReady', { requestId: 9 } satisfies Info);
    callProp('onGranted', { requestId: 9 } satisfies Info);
    await act(async () => {});

    expect(onContinue).toHaveBeenCalledTimes(1);
    expect(tracked('rewarded_application_handoff_unconfirmed')).toEqual([
      expect.objectContaining({ ...adContext, handoff_mode: 'auto' }),
    ]);
    expect(tracked('rewarded_application_handoff_shown')).toEqual([
      expect.objectContaining({ ...adContext, handoff_reason: 'tab_not_opened' }),
    ]);
    const open = screen.getByTestId('rewarded-application-handoff-open');
    fireEvent.click(open);
    expect(onContinue).toHaveBeenCalledTimes(2);
    expect(tracked('rewarded_application_handoff_clicked')).toEqual([expect.objectContaining(adContext)]);
  });

  it('tracks the open card shown for lack of activation, and its click', () => {
    setUserActivation(false);
    const onContinue = vi.fn();
    render(<RewardedApplicationOffer {...defaultProps} onContinue={onContinue} />);
    callProp('onReady', { requestId: 9 } satisfies Info);
    callProp('onGranted', { requestId: 9 } satisfies Info);

    expect(tracked('rewarded_application_handoff_shown')).toEqual([
      expect.objectContaining({ ...adContext, handoff_reason: 'no_activation' }),
    ]);
    expect(tracked('rewarded_application_handoff_auto')).toEqual([]);
    fireEvent.click(screen.getByTestId('rewarded-application-handoff-open'));
    expect(onContinue).toHaveBeenCalledTimes(1);
    expect(tracked('rewarded_application_handoff_clicked')).toHaveLength(1);
  });

  it('snapshots the page ads at the click, and again when the visitor comes back from the employer tab', () => {
    const setVisibility = (state: DocumentVisibilityState) => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
      document.dispatchEvent(new Event('visibilitychange'));
    };
    vi.useFakeTimers();
    try {
      const onContinue = vi.fn();
      render(<RewardedApplicationOffer {...defaultProps} onContinue={onContinue} />);
      expect(tracked('rewarded_offer_ads_open')).toEqual([
        expect.objectContaining({ ...adContext, ads_total: 0, ads_visible: 0, anchor_visible: 0 }),
      ]);
      callProp('onReady', { requestId: 9 } satisfies Info);
      callProp('onGranted', { requestId: 9 } satisfies Info);
      expect(onContinue).toHaveBeenCalledTimes(1);
      expect(tracked('rewarded_offer_ads_return')).toEqual([]);

      // The employer's tab takes the foreground, then the visitor comes back.
      setVisibility('hidden');
      setVisibility('visible');
      act(() => {
        vi.advanceTimersByTime(RETURN_TO_TAB_SETTLE_MS);
      });
      expect(tracked('rewarded_offer_ads_return')).toEqual([
        expect.objectContaining({ ...adContext, ads_total: 0, ads_visible: 0, anchor_visible: 0 }),
      ]);
    } finally {
      vi.useRealTimers();
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
    }
  });

  it('on a WebKit browser, shows the open card at once instead of a popup Safari would block', () => {
    // Live 30-09: 2 of 3 automatic openings on Safari never took the
    // foreground although navigator.userActivation.isActive was true.
    withUserAgent(SAFARI_UA);
    const onContinue = vi.fn();
    render(<RewardedApplicationOffer {...defaultProps} onContinue={onContinue} />);
    callProp('onReady', { requestId: 9 } satisfies Info);
    callProp('onGranted', { requestId: 9 } satisfies Info);

    expect(onContinue).not.toHaveBeenCalled();
    expect(tracked('rewarded_application_handoff_auto')).toEqual([]);
    expect(tracked('rewarded_application_handoff_shown')).toEqual([
      expect.objectContaining({ ...adContext, handoff_reason: 'webkit_popup_policy' }),
    ]);
    fireEvent.click(screen.getByTestId('rewarded-application-handoff-open'));
    expect(onContinue).toHaveBeenCalledTimes(1);
  });

  it('sends the grant receipt later from the visible page: automatic hand-off, tab opened', async () => {
    vi.useFakeTimers();
    try {
      const onContinue = vi.fn(() => Promise.resolve(true));
      render(<RewardedApplicationOffer {...defaultProps} onContinue={onContinue} />);
      callProp('onReady', { requestId: 9 } satisfies Info);
      callProp('onGranted', { requestId: 9 } satisfies Info);
      await act(async () => {});
      expect(tracked('rewarded_receipt_auto_opened')).toEqual([]);

      act(() => {
        vi.advanceTimersByTime(HANDOFF_RECEIPT_MIN_AGE_MS + 500);
      });
      expect(tracked('rewarded_receipt_auto_opened')).toEqual([
        expect.objectContaining({ jobId: 'job-1', companyId: 'company-1', grant_path: 'gpt' }),
      ]);
      expect(window.localStorage.getItem(HANDOFF_LEDGER_KEY)).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('records the card click that opened the tab in the receipt', async () => {
    vi.useFakeTimers();
    try {
      setUserActivation(false);
      const onContinue = vi.fn(() => Promise.resolve(true));
      render(<RewardedApplicationOffer {...defaultProps} onContinue={onContinue} />);
      callProp('onReady', { requestId: 9 } satisfies Info);
      callProp('onGranted', { requestId: 9 } satisfies Info);
      fireEvent.click(screen.getByTestId('rewarded-application-handoff-open'));
      await act(async () => {});
      act(() => {
        vi.advanceTimersByTime(HANDOFF_RECEIPT_MIN_AGE_MS + 500);
      });
      expect(tracked('rewarded_receipt_card_opened')).toHaveLength(1);
      expect(tracked('rewarded_receipt_none')).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('receipts a blocked automatic opening whose card was never clicked', async () => {
    vi.useFakeTimers();
    try {
      const onContinue = vi.fn(() => Promise.resolve(false));
      render(<RewardedApplicationOffer {...defaultProps} onContinue={onContinue} />);
      callProp('onReady', { requestId: 9 } satisfies Info);
      callProp('onGranted', { requestId: 9 } satisfies Info);
      await act(async () => {});
      expect(screen.getByTestId('rewarded-application-handoff')).toBeInTheDocument();
      act(() => {
        vi.advanceTimersByTime(HANDOFF_RECEIPT_MIN_AGE_MS + 500);
      });
      expect(tracked('rewarded_receipt_blocked_left')).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('starts on the open card for an access already granted, with no ad and no offer view', () => {
    // A click resumed after the recovery reload whose access is still valid:
    // no activation survives the reload, so one click opens the new tab.
    const onContinue = vi.fn();
    render(<RewardedApplicationOffer {...defaultProps} onContinue={onContinue} resumed startInHandoff />);

    expect(screen.getByTestId('rewarded-application-handoff')).toHaveTextContent('Candidatura a «Fisioterapista diplomato» sbloccata');
    expect(screen.queryByTestId('mock-google-rewarded')).not.toBeInTheDocument();
    expect(mocks.props).toBeNull();
    expect(tracked('rewarded_application_offer_viewed')).toEqual([]);
    expect(tracked('rewarded_offer_ads_open')).toEqual([]);
    expect(tracked('rewarded_application_handoff_shown')).toEqual([
      expect.objectContaining({ handoff_reason: 'resume_entitlement', jobId: 'job-1' }),
    ]);
    expect(onContinue).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId('rewarded-application-handoff-open'));
    expect(onContinue).toHaveBeenCalledTimes(1);
    expect(mocks.grantRewardedApplicationAccess).not.toHaveBeenCalled();
  });

  it('offers a compact retry when the video is closed before the reward', () => {
    const onContinue = vi.fn();
    const onUnavailable = vi.fn();
    const onDismiss = vi.fn();
    render(
      <RewardedApplicationOffer
        {...defaultProps}
        onContinue={onContinue}
        onUnavailable={onUnavailable}
        onDismiss={onDismiss}
      />,
    );
    callProp('onReady', { requestId: 11 } satisfies Info);

    callProp('onClosed', false, { requestId: 11 } satisfies Info);

    expect(mocks.grantRewardedApplicationAccess).not.toHaveBeenCalled();
    expect(onContinue).not.toHaveBeenCalled();
    expect(onUnavailable).not.toHaveBeenCalled();
    expect(screen.getByTestId('rewarded-application-retry')).toBeInTheDocument();
    expect(tracked('rewarded_ad_unavailable')).toEqual([
      expect.objectContaining({ ...adContext, reason: 'video_closed_before_reward', handoff: 'none', request_id: 11 }),
    ]);

    // A retry is a new request behind the same loading screen, and again
    // waits for an explicit opt-in.
    fireEvent.click(screen.getByRole('button', { name: 'Riprova' }));
    expect(screen.getByTestId('rewarded-application-loading')).toHaveTextContent('Apertura di «Fisioterapista diplomato»…');
    expect(mocks.props?.retryToken).toBe(1);
    expect(mocks.props?.autoStart).toBeUndefined();

    callProp('onReady', { requestId: 12 } satisfies Info);
    callProp('onClosed', false, { requestId: 12 } satisfies Info);
    fireEvent.click(screen.getByRole('button', { name: 'Chiudi' }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('can be dismissed with Escape while nothing irrevocable is in flight', () => {
    const onDismiss = vi.fn();
    render(<RewardedApplicationOffer {...defaultProps} onDismiss={onDismiss} />);

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('ignores the second click of a double click on the backdrop, but honours a later one', () => {
    let clock = 1_000;
    vi.spyOn(performance, 'now').mockImplementation(() => clock);
    const onDismiss = vi.fn();
    render(<RewardedApplicationOffer {...defaultProps} onDismiss={onDismiss} />);
    const backdrop = screen.getByTestId('rewarded-application-offer');

    clock += 120;
    fireEvent.click(backdrop);
    expect(onDismiss).not.toHaveBeenCalled();

    clock += 1_000;
    fireEvent.click(backdrop);
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('holds the popup queue so the newsletter popup cannot hide the Google video', () => {
    vi.useFakeTimers();
    try {
      const { unmount } = render(<RewardedApplicationOffer {...defaultProps} />);

      expect(isActive('rewarded-application-offer')).toBe(true);
      expect(requestSlot('newsletter-popup', POPUP_PRIORITY.NEWSLETTER)).toBe(false);
      expect(isActive('newsletter-popup')).toBe(false);

      // Closing the offer releases the queue; the waiting popup is promoted
      // after the queue's exit window.
      unmount();
      act(() => {
        vi.advanceTimersByTime(500);
      });
      expect(isActive('rewarded-application-offer')).toBe(false);
      expect(isActive('newsletter-popup')).toBe(true);
    } finally {
      releaseSlot('newsletter-popup');
      act(() => {
        vi.runOnlyPendingTimers();
      });
      vi.useRealTimers();
    }
  });

  it('never ships a house, service or local video fallback', () => {
    render(<RewardedApplicationOffer {...defaultProps} />);
    expect(document.querySelector('video, source[src$=".mp4"]')).toBeNull();

    for (const file of [
      'components/community/RewardedApplicationOffer.tsx',
      'components/shared/GptRewardedAd.tsx',
      'services/rewardedWebAd.ts',
    ]) {
      const source = readFileSync(resolve(process.cwd(), file), 'utf8');
      expect(source, file).not.toMatch(/rewarded-frontaliere-house|\.mp4\b|<video\b/i);
    }
  });
});
