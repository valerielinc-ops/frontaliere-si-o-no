/**
 * UI tests for `components/community/JobDetailAlertPrompt.tsx`.
 *
 * Verifies:
 *  - the four UI states (idle / submitting / success / error) and copy substitution.
 *  - the click-handlers wire to the right callbacks.
 *  - the close (✕) button counts as dismiss in idle/error states.
 *  - the success state auto-dismisses after the timeout.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, act, waitFor } from '@testing-library/react';
import JobDetailAlertPrompt from '@/components/community/JobDetailAlertPrompt';
import type { JobAlert } from '@/services/jobAlertService';

const baseAlert = (): JobAlert => ({
  id: 'alert-id',
  userId: 'user-1',
  email: 'foo@example.com',
  keywords: ['Sanità'],
  locations: [],
  contractTypes: [],
  sectors: [],
  frequency: 'weekly',
  locale: 'it',
  active: true,
  createdAt: new Date(),
  lastMatchedAt: null,
  matchCount: 0,
});

interface RenderOpts {
  subscribe?: () => Promise<JobAlert>;
}

function renderPrompt(opts: RenderOpts = {}) {
  const onClose = vi.fn();
  const onAccepted = vi.fn();
  const onDismissed = vi.fn();
  const onErrored = vi.fn();
  const onManage = vi.fn();
  const subscribe = opts.subscribe ?? (async () => baseAlert());
  render(
    <JobDetailAlertPrompt
      category="Sanità"
      userId="user-1"
      email="foo@example.com"
      locale="it"
      onClose={onClose}
      onAccepted={onAccepted}
      onDismissed={onDismissed}
      onErrored={onErrored}
      onManage={onManage}
      subscribe={subscribe}
    />,
  );
  return { onClose, onAccepted, onDismissed, onErrored, onManage };
}

describe('JobDetailAlertPrompt', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it('renders the idle state with substituted category copy', () => {
    renderPrompt();
    const dialog = screen.getByRole('dialog');
    expect(dialog).toBeTruthy();
    expect(dialog.textContent).toContain('Sanità');
    expect(screen.getByText(/Sì, attiva/)).toBeTruthy();
    expect(screen.getByText(/Non ora/)).toBeTruthy();
  });

  it('calls onDismissed and onClose when "Non ora" is clicked', () => {
    const { onDismissed, onClose } = renderPrompt();
    fireEvent.click(screen.getByText(/Non ora/));
    expect(onDismissed).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('treats the ✕ button as dismiss in idle state', () => {
    const { onDismissed, onClose } = renderPrompt();
    fireEvent.click(screen.getByLabelText(/Chiudi|Close/));
    expect(onDismissed).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('transitions to submitting then success when subscribe resolves', async () => {
    const { onAccepted } = renderPrompt({
      subscribe: async () => baseAlert(),
    });
    await act(async () => {
      fireEvent.click(screen.getByText(/Sì, attiva/));
    });
    expect(onAccepted).toHaveBeenCalledTimes(1);
    // success copy
    await waitFor(() => {
      expect(screen.getByText(/Alert attivato/)).toBeTruthy();
    });
    // manage link present
    expect(screen.getByText(/Gestisci alert/)).toBeTruthy();
  });

  it('transitions to error when subscribe rejects, and offers retry', async () => {
    const subscribe = vi
      .fn<() => Promise<JobAlert>>()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce(baseAlert());
    const { onAccepted, onErrored } = renderPrompt({ subscribe });

    await act(async () => {
      fireEvent.click(screen.getByText(/Sì, attiva/));
    });
    await waitFor(() => {
      expect(screen.getByText(/Errore/)).toBeTruthy();
    });
    expect(onErrored).toHaveBeenCalledTimes(1);

    // Click "Riprova" — should re-attempt subscribe and succeed.
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Riprova/ }));
    });
    await waitFor(() => {
      expect(onAccepted).toHaveBeenCalledTimes(1);
    });
    expect(subscribe).toHaveBeenCalledTimes(2);
  });

  it('auto-dismisses after the success state timeout', async () => {
    const setTimeoutSpy = vi.spyOn(window, 'setTimeout');
    const { onClose } = renderPrompt({ subscribe: async () => baseAlert() });
    await act(async () => {
      fireEvent.click(screen.getByText(/Sì, attiva/));
    });
    await waitFor(() => {
      expect(screen.getByText(/Alert attivato/)).toBeTruthy();
    });
    expect(onClose).not.toHaveBeenCalled();

    // The success-state effect schedules a 4 s setTimeout. Find it and run
    // its callback synchronously rather than waiting 4 s of real time.
    const successCall = setTimeoutSpy.mock.calls.find(([, delay]) => delay === 4000);
    expect(successCall).toBeTruthy();
    const cb = successCall![0] as () => void;
    act(() => cb());
    expect(onClose).toHaveBeenCalledTimes(1);

    setTimeoutSpy.mockRestore();
  });

  it('clicking "Gestisci alert" calls onManage and onClose', async () => {
    const { onManage, onClose } = renderPrompt({ subscribe: async () => baseAlert() });
    await act(async () => {
      fireEvent.click(screen.getByText(/Sì, attiva/));
    });
    await waitFor(() => {
      expect(screen.getByText(/Gestisci alert/)).toBeTruthy();
    });
    fireEvent.click(screen.getByText(/Gestisci alert/));
    expect(onManage).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('exposes accessible dialog metadata', () => {
    renderPrompt();
    const dialog = screen.getByRole('dialog');
    const labelledBy = dialog.getAttribute('aria-labelledby');
    expect(labelledBy).toBeTruthy();
    if (labelledBy) {
      const heading = document.getElementById(labelledBy);
      expect(heading).toBeTruthy();
      expect(heading?.tagName).toBe('H3');
    }
    expect(screen.getByLabelText(/Chiudi|Close/)).toBeTruthy();
  });
});
