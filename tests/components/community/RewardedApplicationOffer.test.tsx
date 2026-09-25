// @vitest-environment jsdom

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
}));
vi.mock('@/services/rewardedApplicationAccess', () => ({
  grantRewardedApplicationAccess: mocks.grantRewardedApplicationAccess,
}));
vi.mock('@/services/assistedApplicationExperiment', () => ({
  trackAssistedApplicationEvent: mocks.trackAssistedApplicationEvent,
}));

import RewardedApplicationOffer from '@/components/community/RewardedApplicationOffer';
import { isActive, POPUP_PRIORITY, releaseSlot, requestSlot } from '@/services/popupQueue';

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

beforeEach(() => {
  mocks.props = null;
  vi.clearAllMocks();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  document.body.style.overflow = '';
});

describe('RewardedApplicationOffer', () => {
  it('portals the dialog above the application shell and locks page scrolling', () => {
    render(<RewardedApplicationOffer {...defaultProps} />);

    const dialog = screen.getByRole('dialog');
    expect(dialog.parentElement?.parentElement).toBe(document.body);
    expect(dialog.parentElement).toHaveClass('z-[1000]');
    expect(document.body.style.overflow).toBe('hidden');
  });

  it('can be dismissed with the close control or Escape', () => {
    const onDismiss = vi.fn();
    render(<RewardedApplicationOffer {...defaultProps} onDismiss={onDismiss} />);

    fireEvent.click(screen.getByTestId('rewarded-application-offer-close'));
    fireEvent.keyDown(document, { key: 'Escape' });

    expect(onDismiss).toHaveBeenCalledTimes(2);
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

  it('starts the Google video automatically from the Candidati click, without a second button', () => {
    render(<RewardedApplicationOffer {...defaultProps} />);

    expect(mocks.props?.autoStart).toBe(true);
    expect(screen.getByRole('dialog')).toHaveTextContent('parte da solo appena è pronto');
    expect(tracked('rewarded_application_offer_viewed')).toEqual([expect.objectContaining(adContext)]);

    callProp('onOptIn', { requestId: 7 } satisfies Info);
    expect(tracked('rewarded_ad_opt_in')).toEqual([
      expect.objectContaining({ ...adContext, request_id: 7, ms_since_click: expect.any(Number) }),
    ]);
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
    expect(screen.queryByRole('button', { name: 'Riprova con il video' })).not.toBeInTheDocument();
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

  it('unlocks only after the authoritative Google reward signal and waits for an explicit continue', () => {
    const onContinue = vi.fn();
    render(<RewardedApplicationOffer {...defaultProps} onContinue={onContinue} />);

    callProp('onVideoCompleted', { requestId: 9 } satisfies Info);
    expect(screen.queryByRole('button', { name: 'Apri la candidatura sul sito dell’azienda' })).not.toBeInTheDocument();
    expect(mocks.grantRewardedApplicationAccess).not.toHaveBeenCalled();

    callProp('onGranted', { requestId: 9 } satisfies Info);
    expect(screen.getByRole('button', { name: 'Apri la candidatura sul sito dell’azienda' })).toBeInTheDocument();
    expect(mocks.grantRewardedApplicationAccess).toHaveBeenCalledTimes(1);
    expect(tracked('rewarded_ad_granted')).toEqual([expect.objectContaining({ ...adContext, request_id: 9 })]);
    expect(onContinue).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Apri la candidatura sul sito dell’azienda' }));
    expect(onContinue).toHaveBeenCalledTimes(1);
  });

  it('keeps the application locked when the video is closed before the reward', () => {
    const onContinue = vi.fn();
    const onUnavailable = vi.fn();
    render(<RewardedApplicationOffer {...defaultProps} onContinue={onContinue} onUnavailable={onUnavailable} />);

    callProp('onClosed', false, { requestId: 11 } satisfies Info);

    expect(mocks.grantRewardedApplicationAccess).not.toHaveBeenCalled();
    expect(onContinue).not.toHaveBeenCalled();
    expect(onUnavailable).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'Apri la candidatura sul sito dell’azienda' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Riprova con il video' })).toBeInTheDocument();
    expect(tracked('rewarded_ad_unavailable')).toEqual([
      expect.objectContaining({ ...adContext, reason: 'video_closed_before_reward', handoff: 'none', request_id: 11 }),
    ]);
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
