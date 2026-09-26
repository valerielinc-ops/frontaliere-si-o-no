// @vitest-environment jsdom
/**
 * GPT path of the rewarded application offer (no Offerwall held for the page
 * view). Since 2026-09-26 the "Candidati" click opens a neutral loading
 * screen that never mentions a video, so the GPT rewarded ad must not start
 * by itself: the visitor opts in explicitly once the slot is ready, a slot
 * that is not ready in time hands the click to the employer, and the reward
 * continues to the application with no further click.
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
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  document.body.style.overflow = '';
});

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

  it('continues to the employer on the authoritative Google reward, with no further click', () => {
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
