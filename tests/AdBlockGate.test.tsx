/**
 * AdBlockGate coverage (#3654, part 1/2 of #2961).
 *
 * Verifies: bot skip, control-bucket skip (no detection ever runs), the gate
 * rendering with no dismiss affordance for the test bucket when a blocker is
 * detected, the recheck flow closing the gate on "disabled", the subscribe
 * CTA closing the gate + navigating, the suppression on the subscribe page
 * itself, and the "abandoned" outcome firing on tab hide.
 *
 * #3655 owner refinement: newsletter subscribers and job-alert subscribers
 * are hard-excluded from the gate exactly like bots — no bucket resolution,
 * no detection, ever — verified via the raw localStorage flags.
 */

import React from 'react';
import { render, screen, act, waitFor, fireEvent } from '@testing-library/react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import AdBlockGate from '@/components/community/AdBlockGate';
import { Analytics } from '@/services/analytics';
import { registerSuperProperty } from '@/services/posthog';
import { isLikelyBot } from '@/services/botPatterns';
import { resolveAdBlockAbBucket } from '@/services/adBlockAbTest';
import { detectAdBlock } from '@/services/adBlockDetection';

vi.mock('@/services/i18n', () => ({
  useTranslation: () => ({ t: (key: string) => key, locale: 'it' as const }),
}));

vi.mock('@/services/analytics', () => ({
  Analytics: {
    trackUIInteraction: vi.fn(),
  },
}));

vi.mock('@/services/posthog', () => ({
  registerSuperProperty: vi.fn(),
}));

vi.mock('@/services/botPatterns', () => ({
  isLikelyBot: vi.fn(() => false),
}));

vi.mock('@/services/adBlockAbTest', () => ({
  resolveAdBlockAbBucket: vi.fn(() => 'test'),
}));

vi.mock('@/services/adBlockDetection', () => ({
  detectAdBlock: vi.fn(() => Promise.resolve(false)),
}));

const navigateToMock = vi.fn();
let mockActiveTab = 'calculator';

vi.mock('@/services/NavigationContext', () => ({
  useNavigationOptional: () => ({
    activeTab: mockActiveTab,
    navigateTo: navigateToMock,
  }),
}));

const isLikelyBotMock = vi.mocked(isLikelyBot);
const resolveBucketMock = vi.mocked(resolveAdBlockAbBucket);
const detectAdBlockMock = vi.mocked(detectAdBlock);
const trackUIInteractionMock = vi.mocked(Analytics.trackUIInteraction);
const registerSuperPropertyMock = vi.mocked(registerSuperProperty);

describe('AdBlockGate', () => {
  beforeEach(() => {
    isLikelyBotMock.mockReturnValue(false);
    resolveBucketMock.mockReturnValue('test');
    detectAdBlockMock.mockResolvedValue(false);
    mockActiveTab = 'calculator';
    navigateToMock.mockClear();
    localStorage.clear();
  });

  afterEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
  });

  it('never resolves a bucket or runs detection for bots', async () => {
    isLikelyBotMock.mockReturnValue(true);
    render(<AdBlockGate />);
    await act(async () => {});
    expect(resolveBucketMock).not.toHaveBeenCalled();
    expect(detectAdBlockMock).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('reports the bucket assignment for the control arm but never runs detection', async () => {
    resolveBucketMock.mockReturnValue('control');
    render(<AdBlockGate />);
    await act(async () => {});
    expect(registerSuperPropertyMock).toHaveBeenCalledWith('adblock_ab_bucket', 'control');
    expect(trackUIInteractionMock).toHaveBeenCalledWith('adblock_gate', 'ab_test', 'bucket_assigned', 'control');
    expect(detectAdBlockMock).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('shows the gate for the test bucket when a blocker is detected, with no dismiss button', async () => {
    resolveBucketMock.mockReturnValue('test');
    detectAdBlockMock.mockResolvedValue(true);
    render(<AdBlockGate />);

    const dialog = await screen.findByRole('dialog');
    expect(dialog).toBeInTheDocument();
    expect(trackUIInteractionMock).toHaveBeenCalledWith('adblock_gate', 'modal', 'show', 'detected');

    // Exactly the two forward paths, no close/dismiss affordance of any kind.
    const buttons = screen.getAllByRole('button');
    const buttonLabels = buttons.map((b) => b.textContent || '');
    expect(buttonLabels.some((l) => /ricontrolla/i.test(l))).toBe(true);
    expect(buttonLabels.some((l) => /abbonamento/i.test(l))).toBe(true);
    expect(screen.queryByLabelText(/close|chiudi|dismiss/i)).toBeNull();
  });

  it('does not show the gate for the test bucket when no blocker is detected', async () => {
    resolveBucketMock.mockReturnValue('test');
    detectAdBlockMock.mockResolvedValue(false);
    render(<AdBlockGate />);
    await act(async () => {});
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('closes the gate and logs "disabled" when recheck no longer finds a blocker', async () => {
    detectAdBlockMock.mockResolvedValueOnce(true);
    render(<AdBlockGate />);
    await screen.findByRole('dialog');

    detectAdBlockMock.mockResolvedValueOnce(false);
    fireEvent.click(screen.getByRole('button', { name: /ricontrolla/i }));

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(trackUIInteractionMock).toHaveBeenCalledWith('adblock_gate', 'modal', 'outcome', 'disabled');
  });

  it('closes the gate, logs subscribe_clicked, and navigates to the subscribe page on CTA click', async () => {
    detectAdBlockMock.mockResolvedValue(true);
    render(<AdBlockGate />);
    await screen.findByRole('dialog');

    fireEvent.click(screen.getByRole('button', { name: /abbonamento/i }));

    expect(trackUIInteractionMock).toHaveBeenCalledWith('adblock_gate', 'modal', 'outcome', 'subscribe_clicked');
    expect(navigateToMock).toHaveBeenCalledWith('subscribe');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('never opens while already on the subscribe placeholder page', async () => {
    mockActiveTab = 'subscribe';
    detectAdBlockMock.mockResolvedValue(true);
    render(<AdBlockGate />);
    await act(async () => {});
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('logs an "abandoned" outcome if the tab is hidden while the gate is open', async () => {
    detectAdBlockMock.mockResolvedValue(true);
    render(<AdBlockGate />);
    await screen.findByRole('dialog');

    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });

    // The listener attaches in an effect keyed on `open`, committed only
    // after the dialog's own state update flushes — a passive effect whose
    // exact timing relative to `findByRole` resolving is a React-scheduler
    // implementation detail, not a guarantee (flaked in CI: #4287). Retry
    // the dispatch inside `waitFor` so the assertion doesn't depend on
    // catching the listener on the very first attempt.
    await waitFor(() => {
      act(() => {
        document.dispatchEvent(new Event('visibilitychange'));
      });
      expect(trackUIInteractionMock).toHaveBeenCalledWith('adblock_gate', 'modal', 'outcome', 'abandoned');
    });
  });

  it('never resolves a bucket or runs detection for newsletter subscribers (#3655)', async () => {
    localStorage.setItem('newsletter_subscribed', 'true');
    detectAdBlockMock.mockResolvedValue(true);
    render(<AdBlockGate />);
    await act(async () => {});
    expect(resolveBucketMock).not.toHaveBeenCalled();
    expect(detectAdBlockMock).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('never resolves a bucket or runs detection for job-alert subscribers (#3655)', async () => {
    localStorage.setItem('job_alert_subscribed', 'true');
    detectAdBlockMock.mockResolvedValue(true);
    render(<AdBlockGate />);
    await act(async () => {});
    expect(resolveBucketMock).not.toHaveBeenCalled();
    expect(detectAdBlockMock).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('still shows the gate for a non-subscribed, non-job-alert visitor in the test bucket (regression guard)', async () => {
    resolveBucketMock.mockReturnValue('test');
    detectAdBlockMock.mockResolvedValue(true);
    render(<AdBlockGate />);
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toBeInTheDocument();
    expect(resolveBucketMock).toHaveBeenCalled();
  });
});
