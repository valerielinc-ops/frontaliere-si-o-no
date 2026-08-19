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
import { detectAdBlockDetailed } from '@/services/adBlockDetection';

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

// The gate reads the rich signal now: Funding Choices reports not just whether
// ads are blocked but whether the visitor already allowlisted the site, and an
// allowlisted visitor must never be gated again — they did the thing we asked.
const CLEAN = { blocked: false, adsAllowed: false, source: 'funding_choices' as const, status: null };
const BLOCKED = { blocked: true, adsAllowed: false, source: 'funding_choices' as const, status: null };
const ALLOWLISTED = { blocked: true, adsAllowed: true, source: 'funding_choices' as const, status: null };

vi.mock('@/services/adBlockDetection', () => ({
  detectAdBlockDetailed: vi.fn(() => Promise.resolve({ blocked: false, adsAllowed: false, source: 'funding_choices', status: null })),
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
const detectAdBlockMock = vi.mocked(detectAdBlockDetailed);
const trackUIInteractionMock = vi.mocked(Analytics.trackUIInteraction);
const registerSuperPropertyMock = vi.mocked(registerSuperProperty);

// JSDOM marks `window.location` read-only; replace it with a writable stub
// so we can spy on .reload(), same pattern as ChunkLoadErrorBoundary.test.tsx.
const originalLocation = window.location;
let reloadSpy: ReturnType<typeof vi.fn>;

describe('AdBlockGate', () => {
  beforeEach(() => {
    isLikelyBotMock.mockReturnValue(false);
    resolveBucketMock.mockReturnValue('test');
    detectAdBlockMock.mockResolvedValue(CLEAN);
    mockActiveTab = 'calculator';
    navigateToMock.mockClear();
    localStorage.clear();
    sessionStorage.clear();
    reloadSpy = vi.fn();
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { ...originalLocation, reload: reloadSpy },
      writable: true,
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    sessionStorage.clear();
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: originalLocation,
      writable: true,
    });
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
    detectAdBlockMock.mockResolvedValue(BLOCKED);
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
    detectAdBlockMock.mockResolvedValue(CLEAN);
    render(<AdBlockGate />);
    await act(async () => {});
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('closes the gate and logs "disabled" when recheck no longer finds a blocker', async () => {
    detectAdBlockMock.mockResolvedValueOnce(BLOCKED);
    render(<AdBlockGate />);
    await screen.findByRole('dialog');

    detectAdBlockMock.mockResolvedValueOnce(CLEAN);
    fireEvent.click(screen.getByRole('button', { name: /ricontrolla/i }));

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(trackUIInteractionMock).toHaveBeenCalledWith('adblock_gate', 'modal', 'outcome', 'disabled');
  });

  it('offers a reload button when recheck still finds a blocker, and reload triggers window.location.reload()', async () => {
    detectAdBlockMock.mockResolvedValue(BLOCKED);
    render(<AdBlockGate />);
    await screen.findByRole('dialog');

    expect(screen.queryByRole('button', { name: /ricarica/i })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /ricontrolla/i }));
    await screen.findByRole('button', { name: /ricarica/i });

    // Gate stays open — a still-blocked recheck is not an outcome by itself.
    expect(screen.getByRole('dialog')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /ricarica/i }));
    expect(reloadSpy).toHaveBeenCalledTimes(1);
  });

  it('closes the gate, logs subscribe_clicked, and navigates to the subscribe page on CTA click', async () => {
    detectAdBlockMock.mockResolvedValue(BLOCKED);
    render(<AdBlockGate />);
    await screen.findByRole('dialog');

    fireEvent.click(screen.getByRole('button', { name: /abbonamento/i }));

    expect(trackUIInteractionMock).toHaveBeenCalledWith('adblock_gate', 'modal', 'outcome', 'subscribe_clicked');
    expect(navigateToMock).toHaveBeenCalledWith('subscribe');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('never opens while already on the subscribe placeholder page', async () => {
    mockActiveTab = 'subscribe';
    detectAdBlockMock.mockResolvedValue(BLOCKED);
    render(<AdBlockGate />);
    await act(async () => {});
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  // Hiding the tab is how a visitor reaches the browser's extension menu, i.e.
  // the one action this gate exists to ask for. Reading it as abandonment did
  // not merely mislabel it: logOutcome is one-shot, so it also sealed the
  // outcome and dropped the 'disabled' that followed. GA4 over
  // 2026-07-27..08-18 showed outcome=disabled at 0 while the in-page
  // popup_adblock_disable counter recorded 4.
  it('records a hidden tab as context, never as an abandoned outcome', async () => {
    detectAdBlockMock.mockResolvedValue(BLOCKED);
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
      expect(trackUIInteractionMock).toHaveBeenCalledWith('adblock_gate', 'modal', 'tab_hidden', 'while_open');
    });
    expect(trackUIInteractionMock).not.toHaveBeenCalledWith('adblock_gate', 'modal', 'outcome', 'abandoned');
  });

  it('logs "abandoned" when the page actually unloads with the gate untouched', async () => {
    detectAdBlockMock.mockResolvedValue(BLOCKED);
    render(<AdBlockGate />);
    await screen.findByRole('dialog');

    await waitFor(() => {
      act(() => {
        window.dispatchEvent(new Event('pagehide'));
      });
      expect(trackUIInteractionMock).toHaveBeenCalledWith('adblock_gate', 'modal', 'outcome', 'abandoned');
    });
  });

  it('does not call the gate\'s own reload an abandonment', async () => {
    detectAdBlockMock.mockResolvedValue(BLOCKED);
    render(<AdBlockGate />);
    await screen.findByRole('dialog');

    // A still-blocked recheck is what surfaces the reload button.
    fireEvent.click(screen.getByRole('button', { name: /ricontrolla/i }));
    await screen.findByRole('button', { name: /ricarica/i });
    fireEvent.click(screen.getByRole('button', { name: /ricarica/i }));

    // The reload unloads the page on purpose; that unload is not a departure.
    act(() => { window.dispatchEvent(new Event('pagehide')); });
    expect(trackUIInteractionMock).not.toHaveBeenCalledWith('adblock_gate', 'modal', 'outcome', 'abandoned');
    expect(sessionStorage.getItem('ft_adblock_reload_pending')).toEqual(expect.any(String));
  });

  // The reload is the only path on which a paused blocker actually stops
  // reporting itself, because cosmetic filter rules injected into the previous
  // document survive the pause. Before this marker, that path's outcome lived
  // in a document that no longer existed when the answer arrived.
  it('reports "disabled" when the visitor comes back from the gate reload clean', async () => {
    sessionStorage.setItem('ft_adblock_reload_pending', String(Date.now()));
    detectAdBlockMock.mockResolvedValue(CLEAN);
    render(<AdBlockGate />);
    await act(async () => {});

    expect(trackUIInteractionMock).toHaveBeenCalledWith('adblock_gate', 'modal', 'outcome', 'disabled', 'after_reload');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(sessionStorage.getItem('ft_adblock_reload_pending')).toBeNull();
  });

  it('reports "reload_still_blocked" when the blocker survived the reload', async () => {
    sessionStorage.setItem('ft_adblock_reload_pending', String(Date.now()));
    detectAdBlockMock.mockResolvedValue(BLOCKED);
    render(<AdBlockGate />);
    await screen.findByRole('dialog');

    expect(trackUIInteractionMock).toHaveBeenCalledWith('adblock_gate', 'modal', 'outcome', 'reload_still_blocked', 'after_reload');
  });

  it('ignores a stale reload marker from an earlier visit', async () => {
    sessionStorage.setItem('ft_adblock_reload_pending', String(Date.now() - 6 * 60 * 1000));
    detectAdBlockMock.mockResolvedValue(CLEAN);
    render(<AdBlockGate />);
    await act(async () => {});

    expect(trackUIInteractionMock).not.toHaveBeenCalledWith(
      'adblock_gate', 'modal', 'outcome', 'disabled', 'after_reload',
    );
  });

  it('never resolves a bucket or runs detection for newsletter subscribers (#3655)', async () => {
    localStorage.setItem('newsletter_subscribed', 'true');
    detectAdBlockMock.mockResolvedValue(BLOCKED);
    render(<AdBlockGate />);
    await act(async () => {});
    expect(resolveBucketMock).not.toHaveBeenCalled();
    expect(detectAdBlockMock).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('never resolves a bucket or runs detection for job-alert subscribers (#3655)', async () => {
    localStorage.setItem('job_alert_subscribed', 'true');
    detectAdBlockMock.mockResolvedValue(BLOCKED);
    render(<AdBlockGate />);
    await act(async () => {});
    expect(resolveBucketMock).not.toHaveBeenCalled();
    expect(detectAdBlockMock).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('still shows the gate for a non-subscribed, non-job-alert visitor in the test bucket (regression guard)', async () => {
    resolveBucketMock.mockReturnValue('test');
    detectAdBlockMock.mockResolvedValue(BLOCKED);
    render(<AdBlockGate />);
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toBeInTheDocument();
    expect(resolveBucketMock).toHaveBeenCalled();
  });

  // Google's own recovery message has been live on this site since 2026-06-16,
  // three weeks before this gate existed, so a visitor may well have
  // allowlisted us through that one. Gating them again would punish exactly
  // the action both walls were asking for.
  it('never gates a visitor who has already allowlisted the site', async () => {
    detectAdBlockMock.mockResolvedValue(ALLOWLISTED);
    render(<AdBlockGate />);
    await act(async () => {});
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('reports the allowlisting as a disabled outcome when it happened during the reload', async () => {
    sessionStorage.setItem('ft_adblock_reload_pending', String(Date.now()));
    detectAdBlockMock.mockResolvedValue(ALLOWLISTED);
    render(<AdBlockGate />);
    await act(async () => {});
    expect(trackUIInteractionMock).toHaveBeenCalledWith('adblock_gate', 'modal', 'outcome', 'disabled', 'allowlisted');
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
