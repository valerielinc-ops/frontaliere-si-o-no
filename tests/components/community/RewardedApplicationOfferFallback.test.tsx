// @vitest-environment jsdom
/**
 * GPT rewarded fallback of a released AdSense Offerwall that does not appear
 * (the AdSense experiment's per-visitor "no message" holdout, a slow Funding
 * Choices). The slot is prepared, hidden, once the Offerwall is late; at the
 * appear timeout a ready slot becomes the explicit opt-in card (never an
 * automatic video), a slot that is not ready gets GPT_OPT_IN_READY_TIMEOUT_MS
 * more before the direct employer hand-off, and an Offerwall that still
 * appears before the video starts takes over again.
 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

type Decision = 'keep_watching' | 'resolve' | void;
type ReleaseOptions = {
  onShown?: (info: { shownMs: number; root: string }) => void;
  onClosed?: (info: { shownMs: number; closedMs: number; root: string }) => void;
  onStalled?: (info: { shownMs: number; root: string }) => void;
  onSlow?: (info: { elapsedMs: number }) => void;
  onAppearTimeout?: (info: { elapsedMs: number }) => Decision;
  signal?: AbortSignal;
};
type ReleaseResult =
  | {
    outcome: 'completed';
    signal: 'entitlement' | 'root_closed';
    shownMs: number;
    closedMs: number | null;
    completedMs: number;
    root: string;
  }
  | { outcome: 'closed_without_reward'; shownMs: number; closedMs: number; root: string }
  | { outcome: 'not_shown'; reason: string };
type Info = { requestId: number; detail?: string };

const mocks = vi.hoisted(() => ({
  releaseOptions: null as ReleaseOptions | null,
  resolveRelease: null as ((result: ReleaseResult) => void) | null,
  releaseHeldOfferwall: vi.fn(),
  trackAssistedApplicationEvent: vi.fn(),
  grantRewardedApplicationAccess: vi.fn(() => 1_900_000_000_000),
  disposeRewardedWebAd: vi.fn(),
  eligible: true,
  resolveOnAbort: true,
  gptProps: null as Record<string, unknown> | null,
}));

vi.mock('@/components/shared/GptRewardedAd', () => ({
  default: (props: Record<string, unknown>) => {
    mocks.gptProps = props;
    return <div data-testid="mock-google-rewarded" />;
  },
}));
vi.mock('@/services/rewardedWebAd', () => ({
  ASSISTED_APPLICATION_REWARDED_AD_UNIT_PATH: '/23355151813/rewarded-application-video',
  REWARDED_WEB_AD_FORMAT: 'rewarded_web',
  disposeRewardedWebAd: mocks.disposeRewardedWebAd,
  isRewardedWebAdEligible: () => mocks.eligible,
}));
vi.mock('@/services/rewardedApplicationAccess', () => ({
  grantRewardedApplicationAccess: mocks.grantRewardedApplicationAccess,
  REWARDED_APPLICATION_ACCESS_TTL_HOURS: 1,
}));
vi.mock('@/services/assistedApplicationExperiment', () => ({
  trackAssistedApplicationEvent: mocks.trackAssistedApplicationEvent,
}));
vi.mock('@/services/offerwallClickGate', () => ({
  offerwallGateStatus: () => 'held',
  releaseHeldOfferwall: mocks.releaseHeldOfferwall,
}));

import RewardedApplicationOffer, { GPT_OPT_IN_READY_TIMEOUT_MS } from '@/components/community/RewardedApplicationOffer';
import { itReady } from '@/services/i18n';

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
  onDismiss: vi.fn(),
};

const adContext = {
  variant: 'rewarded_ad',
  jobId: 'job-1',
  companyId: 'company-1',
  surface: 'job_detail_rewarded_inline',
  trigger: 'candidate_click',
  ad_unit: '/23355151813/rewarded-application-video',
  format: 'rewarded_web',
};

const slow = () => {
  act(() => {
    mocks.releaseOptions?.onSlow?.({ elapsedMs: 2_600 });
  });
};
const appearTimeout = (): Decision => {
  let decision: Decision;
  act(() => {
    decision = mocks.releaseOptions?.onAppearTimeout?.({ elapsedMs: 5_000 });
  });
  return decision;
};
const callGpt = <T extends unknown[]>(name: string, ...args: T) => {
  act(() => {
    (mocks.gptProps?.[name] as ((...callArgs: T) => void) | undefined)?.(...args);
  });
};
const showOfferwall = (shownMs: number) => {
  act(() => {
    mocks.releaseOptions?.onShown?.({ shownMs, root: 'fc-message-root' });
  });
};
const settle = async (result: ReleaseResult) => {
  await act(async () => {
    mocks.resolveRelease?.(result);
  });
};
const flush = async () => {
  await act(async () => {});
};

beforeAll(async () => {
  await itReady;
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.eligible = true;
  mocks.resolveOnAbort = true;
  mocks.gptProps = null;
  mocks.releaseOptions = null;
  mocks.resolveRelease = null;
  mocks.releaseHeldOfferwall.mockImplementation((options: ReleaseOptions) => {
    mocks.releaseOptions = options;
    return new Promise<ReleaseResult>((resolve) => {
      mocks.resolveRelease = resolve;
      options.signal?.addEventListener('abort', () => {
        if (mocks.resolveOnAbort) resolve({ outcome: 'not_shown', reason: 'aborted' });
      });
    });
  });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  document.body.style.overflow = '';
});

describe('RewardedApplicationOffer — GPT fallback of a late Offerwall', () => {
  it('prepares the GPT slot hidden while the Offerwall is late, behind the same neutral loader', () => {
    render(<RewardedApplicationOffer {...props} />);
    expect(screen.queryByTestId('mock-google-rewarded')).not.toBeInTheDocument();

    slow();

    expect(screen.getByTestId('mock-google-rewarded')).toBeInTheDocument();
    expect(screen.getByTestId('rewarded-application-opt-in')).toHaveClass('hidden');
    const loading = screen.getByTestId('rewarded-application-loading');
    expect(loading).toHaveTextContent('Apertura di «Fisioterapista diplomato»…');
    expect(loading.textContent).not.toMatch(/video|google|pubblicit/i);
    expect(tracked('rewarded_offerwall_gpt_fallback_started')).toEqual([
      expect.objectContaining({ ...adContext, offerwall_wait_ms: 2_600 }),
    ]);
    // The release keeps waiting for Google: nothing is handed off yet.
    expect(props.onUnavailable).not.toHaveBeenCalled();
  });

  it('offers a ready slot as an explicit opt-in at the appear timeout, and continues on the GPT reward', async () => {
    render(<RewardedApplicationOffer {...props} />);
    slow();
    callGpt('onReady', { requestId: 21 } satisfies Info);
    // Ready before the timeout: still hidden, the Offerwall may yet appear.
    expect(screen.getByTestId('rewarded-application-opt-in')).toHaveClass('hidden');

    expect(appearTimeout()).toBe('keep_watching');

    const card = screen.getByTestId('rewarded-application-opt-in');
    expect(card).not.toHaveClass('hidden');
    expect(card).toHaveTextContent('Guarda un breve video per candidarti a «Fisioterapista diplomato»');
    expect(screen.getByTestId('rewarded-application-opt-in-subtitle')).toHaveTextContent('Poi 1 ora di candidature senza video');
    expect(mocks.gptProps?.label).toBe('Guarda il video');
    expect(mocks.gptProps?.autoStart).toBeUndefined();
    expect(tracked('rewarded_offerwall_not_shown')).toEqual([
      expect.objectContaining({ reason: 'appear_timeout', provider: 'adsense_offerwall' }),
    ]);
    expect(tracked('rewarded_offerwall_gpt_fallback_shown')).toEqual([expect.objectContaining(adContext)]);

    const signal = mocks.releaseOptions?.signal;
    expect(signal?.aborted).toBe(false);
    callGpt('onOptIn', { requestId: 21 } satisfies Info);
    // The visitor chose the GPT video: the late-Offerwall watch ends.
    expect(signal?.aborted).toBe(true);
    await flush();

    callGpt('onGranted', { requestId: 21 } satisfies Info);
    expect(mocks.grantRewardedApplicationAccess).toHaveBeenCalledTimes(1);
    expect(props.onContinue).toHaveBeenCalledTimes(1);
    expect(props.onUnavailable).not.toHaveBeenCalled();
    expect(mocks.disposeRewardedWebAd).not.toHaveBeenCalled();
    expect(tracked('rewarded_offerwall_gpt_fallback_granted')).toEqual([
      expect.objectContaining({ ...adContext, request_id: 21 }),
    ]);
    expect(tracked('rewarded_application_access_granted')).toEqual([
      expect.objectContaining({ ...adContext, access_ttl_hours: 1 }),
    ]);
    expect(screen.getByTestId('rewarded-application-loading')).toHaveTextContent('Ti portiamo a «Fisioterapista diplomato»…');
  });

  it('waits GPT_OPT_IN_READY_TIMEOUT_MS more for a slot not ready at the timeout, then hands off directly', () => {
    vi.useFakeTimers();
    render(<RewardedApplicationOffer {...props} />);
    slow();

    expect(appearTimeout()).toBe('keep_watching');
    expect(screen.getByTestId('rewarded-application-loading')).toHaveTextContent('Apertura di «Fisioterapista diplomato»…');
    expect(screen.getByTestId('rewarded-application-opt-in')).toHaveClass('hidden');
    // The released Offerwall may still render: the neutral loader is not dismissible.
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(props.onDismiss).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(GPT_OPT_IN_READY_TIMEOUT_MS - 1);
    });
    expect(props.onUnavailable).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(1);
    });

    expect(props.onUnavailable).toHaveBeenCalledTimes(1);
    expect(props.onUnavailable).toHaveBeenCalledWith('gpt_ready_timeout');
    expect(mocks.releaseOptions?.signal?.aborted).toBe(true);
    expect(mocks.disposeRewardedWebAd).toHaveBeenCalledTimes(1);
    expect(tracked('rewarded_offerwall_gpt_fallback_aborted')).toEqual([
      expect.objectContaining({ ...adContext, reason: 'gpt_unavailable', gpt_reason: 'gpt_ready_timeout' }),
    ]);
    expect(tracked('rewarded_offerwall_gpt_fallback_shown')).toEqual([]);
    expect(mocks.grantRewardedApplicationAccess).not.toHaveBeenCalled();
  });

  it('shows the opt-in card when the slot turns ready during the extra wait', () => {
    vi.useFakeTimers();
    render(<RewardedApplicationOffer {...props} />);
    slow();
    appearTimeout();
    act(() => {
      vi.advanceTimersByTime(1_500);
    });

    callGpt('onReady', { requestId: 22 } satisfies Info);

    expect(screen.getByTestId('rewarded-application-opt-in')).not.toHaveClass('hidden');
    expect(tracked('rewarded_offerwall_gpt_fallback_shown')).toHaveLength(1);
    act(() => {
      vi.advanceTimersByTime(GPT_OPT_IN_READY_TIMEOUT_MS * 2);
    });
    expect(props.onUnavailable).not.toHaveBeenCalled();
  });

  it('lets a late Offerwall take over an opt-in card whose video has not started', async () => {
    render(<RewardedApplicationOffer {...props} />);
    slow();
    callGpt('onReady', { requestId: 23 } satisfies Info);
    appearTimeout();
    expect(screen.getByTestId('rewarded-application-opt-in')).not.toHaveClass('hidden');

    showOfferwall(6_400);

    expect(mocks.disposeRewardedWebAd).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('rewarded-application-offer')).not.toBeInTheDocument();
    expect(tracked('rewarded_offerwall_gpt_fallback_aborted')).toEqual([
      expect.objectContaining({ ...adContext, reason: 'offerwall_shown_late', offerwall_shown_ms: 6_400 }),
    ]);
    expect(tracked('rewarded_offerwall_shown')).toHaveLength(1);

    // Late callbacks of the torn-down slot change nothing.
    callGpt('onGranted', { requestId: 23 } satisfies Info);
    callGpt('onUnavailable', 'no_fill', { requestId: 23 } satisfies Info);
    expect(mocks.grantRewardedApplicationAccess).not.toHaveBeenCalled();
    expect(props.onUnavailable).not.toHaveBeenCalled();

    await settle({
      outcome: 'completed',
      signal: 'entitlement',
      shownMs: 6_400,
      closedMs: null,
      completedMs: 38_000,
      root: 'fc-message-root',
    });
    expect(props.onContinue).toHaveBeenCalledTimes(1);
    expect(mocks.grantRewardedApplicationAccess).toHaveBeenCalledTimes(1);
    expect(tracked('rewarded_offerwall_completed')).toHaveLength(1);
    expect(tracked('rewarded_offerwall_gpt_fallback_granted')).toEqual([]);
  });

  it('keeps the GPT flow authoritative once its video started, even if a late Offerwall is reported', () => {
    render(<RewardedApplicationOffer {...props} />);
    slow();
    callGpt('onReady', { requestId: 26 } satisfies Info);
    appearTimeout();
    callGpt('onOptIn', { requestId: 26 } satisfies Info);

    // Reports already queued before the watch ended (or no AbortController):
    // the late Offerwall appears and closes while the GPT video plays.
    showOfferwall(7_200);
    act(() => {
      mocks.releaseOptions?.onClosed?.({ shownMs: 7_200, closedMs: 9_000, root: 'fc-message-root' });
    });
    act(() => {
      mocks.releaseOptions?.onStalled?.({ shownMs: 7_200, root: 'fc-message-root' });
    });
    expect(screen.queryByTestId('rewarded-application-loading')).not.toBeInTheDocument();
    expect(tracked('rewarded_offerwall_timed_out')).toEqual([]);

    expect(screen.getByTestId('rewarded-application-offer')).toBeInTheDocument();
    expect(screen.getByTestId('mock-google-rewarded')).toBeInTheDocument();
    expect(mocks.disposeRewardedWebAd).not.toHaveBeenCalled();
    expect(tracked('rewarded_offerwall_shown')).toEqual([]);
    expect(tracked('rewarded_offerwall_gpt_fallback_aborted')).toEqual([]);

    callGpt('onGranted', { requestId: 26 } satisfies Info);
    expect(props.onContinue).toHaveBeenCalledTimes(1);
    expect(tracked('rewarded_offerwall_gpt_fallback_granted')).toHaveLength(1);
  });

  it('ignores every late Offerwall outcome once the GPT video started', async () => {
    // As on a browser without AbortController: the observer is not stopped.
    mocks.resolveOnAbort = false;
    render(<RewardedApplicationOffer {...props} />);
    slow();
    callGpt('onReady', { requestId: 27 } satisfies Info);
    appearTimeout();
    callGpt('onOptIn', { requestId: 27 } satisfies Info);

    // Only reachable when the watch could not be aborted: the outcome still
    // arrives, and must neither hand off nor grant on the Offerwall path.
    await settle({ outcome: 'closed_without_reward', shownMs: 7_000, closedMs: 9_000, root: 'fc-message-root' });
    expect(props.onUnavailable).not.toHaveBeenCalled();
    expect(tracked('rewarded_offerwall_closed_without_reward')).toEqual([]);
    expect(screen.getByTestId('mock-google-rewarded')).toBeInTheDocument();

    // The GPT video closed without its reward: the GPT retry card, not an Offerwall hand-off.
    callGpt('onClosed', false, { requestId: 27 } satisfies Info);
    expect(screen.getByTestId('rewarded-application-retry')).toBeInTheDocument();
  });

  it('destroys a prepared slot when the Offerwall appears before the timeout', () => {
    render(<RewardedApplicationOffer {...props} />);
    slow();
    expect(screen.getByTestId('mock-google-rewarded')).toBeInTheDocument();

    showOfferwall(3_100);

    expect(mocks.disposeRewardedWebAd).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('mock-google-rewarded')).not.toBeInTheDocument();
    expect(tracked('rewarded_offerwall_gpt_fallback_aborted')).toEqual([
      expect.objectContaining({ reason: 'offerwall_shown', offerwall_shown_ms: 3_100 }),
    ]);
  });

  it('starts no fallback for a visitor outside rewarded eligibility, and hands off at the timeout', async () => {
    mocks.eligible = false;
    render(<RewardedApplicationOffer {...props} />);
    slow();

    expect(screen.queryByTestId('mock-google-rewarded')).not.toBeInTheDocument();
    expect(tracked('rewarded_offerwall_gpt_fallback_started')).toEqual([]);
    expect(appearTimeout()).toBe('resolve');

    await settle({ outcome: 'not_shown', reason: 'appear_timeout' });
    expect(props.onUnavailable).toHaveBeenCalledWith('offerwall_not_shown');
    expect(tracked('rewarded_offerwall_not_shown')).toHaveLength(1);
  });

  it('drops a fallback whose slot fails early and keeps waiting for the Offerwall', async () => {
    render(<RewardedApplicationOffer {...props} />);
    slow();

    callGpt('onUnavailable', 'no_fill', { requestId: 24, detail: 'slot_render_empty' } satisfies Info);

    expect(props.onUnavailable).not.toHaveBeenCalled();
    expect(screen.queryByTestId('mock-google-rewarded')).not.toBeInTheDocument();
    expect(tracked('rewarded_offerwall_gpt_fallback_aborted')).toEqual([
      expect.objectContaining({ reason: 'gpt_unavailable', gpt_reason: 'no_fill', detail: 'slot_render_empty' }),
    ]);
    expect(appearTimeout()).toBe('resolve');

    await settle({ outcome: 'not_shown', reason: 'appear_timeout' });
    expect(props.onUnavailable).toHaveBeenCalledTimes(1);
    expect(props.onUnavailable).toHaveBeenCalledWith('offerwall_not_shown');
    expect(tracked('rewarded_offerwall_not_shown')).toHaveLength(1);
  });

  it('ends the late-Offerwall watch when the offer closes', () => {
    render(<RewardedApplicationOffer {...props} />);
    slow();
    callGpt('onReady', { requestId: 25 } satisfies Info);
    appearTimeout();
    const signal = mocks.releaseOptions?.signal;

    fireEvent.click(screen.getByRole('button', { name: 'Chiudi' }));
    expect(props.onDismiss).toHaveBeenCalledTimes(1);
    cleanup();

    expect(signal?.aborted).toBe(true);
  });
});
