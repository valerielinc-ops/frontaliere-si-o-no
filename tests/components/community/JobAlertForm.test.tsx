/**
 * UI tests for `components/community/JobAlertForm.tsx` — focused on the
 * new canton geo-filter selector added for the Cathedral CH-wide expansion
 * (docs/CATHEDRAL-STATUS.md #12).
 *
 * Strategy: drive the canton multi-select via DOM events and inspect the
 * resulting UI state (chip aria-pressed flags, summary chip rendering,
 * picker-open visibility). The end-to-end "createAlert receives the right
 * cantonFilter shape" assertion is exercised by the service-level tests
 * in `tests/services/jobAlertService.cantonFilter.test.ts` — that layer is
 * the one that owns the Firestore-payload contract.
 *
 * The form's `handleCreate` dynamic-imports `@/services/jobAlertService`
 * which makes mocking the createAlert side of the funnel fragile in jsdom;
 * the chosen split keeps the UI tests deterministic and the persistence
 * contract directly tested at the service surface.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, within, waitFor, act } from '@testing-library/react';
import JobAlertForm from '@/components/community/JobAlertForm';
const ALERT_CTA_SURFACES = ['inline_card'];

const { createAlertMock, getUserAlertsMock } = vi.hoisted(() => ({
  createAlertMock: vi.fn(async () => ({ id: 'x' })),
  getUserAlertsMock: vi.fn(async () => []),
}));

// Mock the service so the form can dynamic-import it without trying to talk
// to a real Firestore (the canton tests don't assert on this — see the
// service-level tests for the payload contract; the funnel tests below do,
// which works because the form shares ONE import promise across its callers).
vi.mock('@/services/jobAlertService', () => ({
  createAlert: createAlertMock,
  getUserAlerts: getUserAlertsMock,
  deleteAlert: vi.fn(async () => undefined),
  updateAlert: vi.fn(async () => undefined),
}));

const { analyticsMock } = vi.hoisted(() => ({
  analyticsMock: {
    trackJobAlertCtaClick: vi.fn(),
    trackJobAlertCtaShown: vi.fn(),
    trackJobAlertCreated: vi.fn(),
    trackJobAlertDeleted: vi.fn(),
  },
}));
vi.mock('@/services/analytics', () => ({ Analytics: analyticsMock }));

vi.mock('@/services/profileFirestore', () => ({
  loadEnrichmentProfileFields: vi.fn(async () => ({})),
}));

const authUser = { uid: 'user-1', email: 'foo@example.com' };

function expandForm() {
  const triggerButton = screen.getAllByRole('button')[0];
  fireEvent.click(triggerButton);
  // 2026-05-19 form-simplification: advanced filters (locations / contracts
  // / sectors / cantons / frequency) live behind a "Filtri avanzati" toggle
  // by default. Most tests inspect those fields, so reveal them eagerly.
  const advancedToggle = document.querySelector<HTMLButtonElement>(
    'button[aria-controls="job-alert-advanced"]',
  );
  if (advancedToggle) fireEvent.click(advancedToggle);
}

function getCantonPickerToggle(): HTMLButtonElement {
  const btn = document.querySelector<HTMLButtonElement>(
    'button[aria-controls="job-alert-canton-list"]',
  );
  if (!btn) throw new Error('Canton picker toggle not found');
  return btn;
}

function openCantonPicker() {
  fireEvent.click(getCantonPickerToggle());
}

function getCantonChip(label: RegExp | string): HTMLButtonElement {
  // Canton chips live inside the picker container and carry aria-pressed.
  const list = document.getElementById('job-alert-canton-list');
  if (!list) throw new Error('Canton picker list not rendered (open it first?)');
  const buttons = Array.from(list.querySelectorAll<HTMLButtonElement>('button[aria-pressed]'));
  const matcher = typeof label === 'string' ? new RegExp(label, 'i') : label;
  const chip = buttons.find((b) => matcher.test(b.textContent ?? ''));
  if (!chip) throw new Error(`Canton chip matching ${label} not found`);
  return chip;
}

function getFieldset(): HTMLFieldSetElement {
  // The canton fieldset is the one whose id-anchored toggle controls
  // job-alert-canton-list. Climb to the enclosing <fieldset>.
  const toggle = getCantonPickerToggle();
  const fs = toggle.closest('fieldset');
  if (!fs) throw new Error('Canton fieldset not found');
  return fs as HTMLFieldSetElement;
}

beforeEach(() => {
  // nothing to set up beyond the per-file mocks
});

afterEach(() => {
  cleanup();
});

describe('JobAlertForm — canton geo filter', () => {
  it('shows the canton fieldset with the "all cantons" default summary', () => {
    render(<JobAlertForm authUser={authUser} />);
    expandForm();

    const fieldset = getFieldset();
    // The picker is collapsed by default — no list rendered.
    expect(document.getElementById('job-alert-canton-list')).toBeNull();
    // Summary label reflects the all-cantons default.
    // Match the short status pill, not the longer hint copy (case-sensitive
    // anchor for the start of the summary span text).
    expect(within(fieldset).getByText(/^Tutti i cantoni$/)).toBeTruthy();
    // Toggle button advertises a closed picker.
    expect(getCantonPickerToggle().getAttribute('aria-expanded')).toBe('false');
  });

  it('opens the picker and lists all 26 cantons', () => {
    render(<JobAlertForm authUser={authUser} />);
    expandForm();
    openCantonPicker();

    const list = document.getElementById('job-alert-canton-list');
    expect(list).not.toBeNull();
    const chips = list!.querySelectorAll('button[aria-pressed]');
    expect(chips.length).toBe(26);
    expect(getCantonPickerToggle().getAttribute('aria-expanded')).toBe('true');
  });

  it('selects a single canton (TI) and reflects it via aria-pressed + summary chip', () => {
    render(<JobAlertForm authUser={authUser} />);
    expandForm();
    openCantonPicker();

    const ti = getCantonChip(/Ticino/);
    expect(ti.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(ti);
    expect(ti.getAttribute('aria-pressed')).toBe('true');

    // Collapse the picker — the chip summary should render outside the list.
    openCantonPicker(); // toggles closed
    expect(document.getElementById('job-alert-canton-list')).toBeNull();
    const fieldset = getFieldset();
    const summary = within(fieldset).getByLabelText(/Cantoni selezionati/i);
    expect(within(summary as HTMLElement).getByText(/Ticino/)).toBeTruthy();
  });

  it('supports multi-canton selection (TI + GE) — both flagged + visible in the summary', () => {
    render(<JobAlertForm authUser={authUser} />);
    expandForm();
    openCantonPicker();

    fireEvent.click(getCantonChip(/Ticino/));
    fireEvent.click(getCantonChip(/Ginevra/));
    expect(getCantonChip(/Ticino/).getAttribute('aria-pressed')).toBe('true');
    expect(getCantonChip(/Ginevra/).getAttribute('aria-pressed')).toBe('true');

    // Numeric summary updates with the count.
    const fieldset = getFieldset();
    expect(within(fieldset).getByText(/Selezionati: 2/i)).toBeTruthy();

    openCantonPicker(); // collapse
    const summary = within(fieldset).getByLabelText(/Cantoni selezionati/i);
    expect(within(summary as HTMLElement).getByText(/Ticino/)).toBeTruthy();
    expect(within(summary as HTMLElement).getByText(/Ginevra/)).toBeTruthy();
  });

  it('toggles a canton off when its chip is clicked twice', () => {
    render(<JobAlertForm authUser={authUser} />);
    expandForm();
    openCantonPicker();

    const ti = getCantonChip(/Ticino/);
    fireEvent.click(ti);
    expect(ti.getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(ti);
    expect(ti.getAttribute('aria-pressed')).toBe('false');

    const fieldset = getFieldset();
    // Match the short status pill, not the longer hint copy (case-sensitive
    // anchor for the start of the summary span text).
    expect(within(fieldset).getByText(/^Tutti i cantoni$/)).toBeTruthy();
  });

  it('clears the entire selection via the "Reimposta" button', () => {
    render(<JobAlertForm authUser={authUser} />);
    expandForm();
    openCantonPicker();

    fireEvent.click(getCantonChip(/Ticino/));
    fireEvent.click(getCantonChip(/Ginevra/));

    // The reset button is the only secondary button in the fieldset that
    // is neither the picker toggle (aria-controls) nor a canton chip
    // (aria-pressed). We pin it by location to remain robust to t() returning
    // raw translation keys when locale chunks haven't loaded.
    const fieldset = getFieldset();
    const resetBtn = Array.from(fieldset.querySelectorAll('button')).find(
      (b) => !b.hasAttribute('aria-controls') && !b.hasAttribute('aria-pressed'),
    ) as HTMLButtonElement | undefined;
    expect(resetBtn).toBeTruthy();
    fireEvent.click(resetBtn!);

    expect(getCantonChip(/Ticino/).getAttribute('aria-pressed')).toBe('false');
    expect(getCantonChip(/Ginevra/).getAttribute('aria-pressed')).toBe('false');
    // Match the short status pill, not the longer hint copy (case-sensitive
    // anchor for the start of the summary span text).
    expect(within(fieldset).getByText(/^Tutti i cantoni$/)).toBeTruthy();
  });

  it('removes a canton from the summary via the chip × button', () => {
    render(<JobAlertForm authUser={authUser} />);
    expandForm();
    openCantonPicker();
    fireEvent.click(getCantonChip(/Ticino/));
    fireEvent.click(getCantonChip(/Ginevra/));
    openCantonPicker(); // collapse to show summary

    const fieldset = getFieldset();
    const summary = within(fieldset).getByLabelText(/Cantoni selezionati/i) as HTMLElement;
    // Find the × button whose aria-label mentions Ginevra.
    const removeGinevra = Array.from(summary.querySelectorAll('button')).find((b) =>
      /Ginevra/i.test(b.getAttribute('aria-label') ?? ''),
    );
    expect(removeGinevra).toBeTruthy();
    fireEvent.click(removeGinevra!);

    // Summary now only has Ticino.
    const updatedSummary = within(fieldset).getByLabelText(/Cantoni selezionati/i) as HTMLElement;
    expect(within(updatedSummary).getByText(/Ticino/)).toBeTruthy();
    expect(within(updatedSummary).queryByText(/Ginevra/)).toBeNull();
  });
});

describe('JobAlertForm — initialCantonCode prefill (issue #4298)', () => {
  it('pre-selects the canton passed via initialCantonCode', () => {
    render(<JobAlertForm authUser={authUser} initialCantonCode="TI" />);
    expandForm();
    openCantonPicker();

    expect(getCantonChip(/Ticino/).getAttribute('aria-pressed')).toBe('true');
  });

  it('ignores an invalid/unknown initialCantonCode (falls back to "all cantons")', () => {
    render(<JobAlertForm authUser={authUser} initialCantonCode="XX" />);
    expandForm();

    const fieldset = getFieldset();
    expect(within(fieldset).getByText(/^Tutti i cantoni$/)).toBeTruthy();
  });

  it('never overwrites a canton the user already cleared by hand', () => {
    const { rerender } = render(<JobAlertForm authUser={authUser} initialCantonCode="TI" />);
    expandForm();
    openCantonPicker();
    expect(getCantonChip(/Ticino/).getAttribute('aria-pressed')).toBe('true');

    fireEvent.click(getCantonChip(/Ticino/)); // user clears it by hand
    expect(getCantonChip(/Ticino/).getAttribute('aria-pressed')).toBe('false');

    // A later prop change (e.g. searchQuery-driven re-render) must not
    // re-seed the canton the user just cleared.
    rerender(<JobAlertForm authUser={authUser} initialKeyword="Sviluppo" initialCantonCode="TI" />);
    expect(getCantonChip(/Ticino/).getAttribute('aria-pressed')).toBe('false');
  });
});

// ── alert_funnel: guest submit, post-auth replay, inline impression chain ──

const PENDING_KEY = 'pending_job_alert';

/** Controllable IntersectionObserver stand-in (same shape as the #5039 pin). */
class FakeIO {
  static instances: FakeIO[] = [];
  callback: IntersectionObserverCallback;
  observed: Element[] = [];
  constructor(cb: IntersectionObserverCallback) {
    this.callback = cb;
    FakeIO.instances.push(this);
  }
  observe(el: Element) { this.observed.push(el); }
  unobserve() { /* noop */ }
  disconnect() { /* noop */ }
  takeRecords() { return []; }
  enter() {
    act(() => {
      this.callback(
        this.observed.map((target) => ({ isIntersecting: true, target })) as unknown as IntersectionObserverEntry[],
        this as unknown as IntersectionObserver,
      );
    });
  }
}

function typeKeywordAndSubmit(value: string) {
  fireEvent.change(document.getElementById('job-alert-keyword') as HTMLInputElement, { target: { value } });
  const submit = Array.from(document.querySelectorAll<HTMLButtonElement>('#job-alert-form button')).find(
    (b) => !b.hasAttribute('aria-controls') && !b.hasAttribute('aria-pressed'),
  );
  if (!submit) throw new Error('submit button not found');
  fireEvent.click(submit);
}

function ctaActions(): string[] {
  return analyticsMock.trackJobAlertCtaClick.mock.calls.map((c) => `${c[0]}:${c[1]}`);
}

describe('JobAlertForm — guest submit persists the intent or says it cannot (issue 9575)', () => {
  beforeEach(() => {
    localStorage.clear();
    Object.values(analyticsMock).forEach((m) => m.mockClear());
    createAlertMock.mockClear();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('stores the intent with its CTA origin, then hands off to sign-in', async () => {
    const onRequireAuth = vi.fn();
    render(<JobAlertForm authUser={null} onRequireAuth={onRequireAuth} />);
    fireEvent.click(screen.getAllByRole('button')[0]);
    typeKeywordAndSubmit('infermiere');

    expect(onRequireAuth).toHaveBeenCalledTimes(1);
    const stored = JSON.parse(localStorage.getItem(PENDING_KEY) || 'null');
    expect(stored.value.origin).toBe('inline_card');
    expect(stored.value.config.keywords).toEqual(['infermiere']);
    expect(screen.queryByTestId('job-alert-pending-storage-failed')).toBeNull();
    await waitFor(() => expect(ctaActions()).toContain('inline_card:accept'));
    expect(ctaActions()).not.toContain('inline_card:error');
  });

  it('does NOT start the auth round-trip when the intent cannot be stored — it surfaces the failure instead', async () => {
    vi.spyOn(window.localStorage, 'setItem').mockImplementation(() => {
      throw new DOMException('QuotaExceededError', 'QuotaExceededError');
    });
    const onRequireAuth = vi.fn();
    render(<JobAlertForm authUser={null} onRequireAuth={onRequireAuth} />);
    fireEvent.click(screen.getAllByRole('button')[0]);
    typeKeywordAndSubmit('infermiere');

    // Pre-fix: onRequireAuth fired anyway and the replay found nothing.
    expect(onRequireAuth).not.toHaveBeenCalled();
    const notice = screen.getByTestId('job-alert-pending-storage-failed');
    expect(notice.getAttribute('role')).toBe('alert');
    // The typed criteria stay on screen for the manual retry after sign-in.
    expect((document.getElementById('job-alert-keyword') as HTMLInputElement).value).toBe('infermiere');
    await waitFor(() => expect(ctaActions()).toEqual(expect.arrayContaining(['inline_card:accept', 'inline_card:error'])));

    // Signing in stays possible, as an explicit choice without a promised replay.
    fireEvent.click(within(notice).getByRole('button'));
    expect(onRequireAuth).toHaveBeenCalledTimes(1);
  });

  it('an empty guest submit neither stores an intent nor sends the user to sign-in', () => {
    const onRequireAuth = vi.fn();
    render(<JobAlertForm authUser={null} onRequireAuth={onRequireAuth} />);
    fireEvent.click(screen.getAllByRole('button')[0]);
    typeKeywordAndSubmit('   ');
    expect(onRequireAuth).not.toHaveBeenCalled();
    expect(localStorage.getItem(PENDING_KEY)).toBeNull();
  });
});

describe('JobAlertForm — post-auth replay keeps the qualifying CTA origin (issue 9576)', () => {
  beforeEach(async () => {
    localStorage.clear();
    Object.values(analyticsMock).forEach((m) => m.mockClear());
    createAlertMock.mockClear();
  });

  it('attributes the replayed job_alert_created to inline_card, with the auth hop as a separate field', async () => {
    // Written by the guest submit above, read back after sign-in.
    const onRequireAuth = vi.fn();
    const { unmount } = render(<JobAlertForm authUser={null} onRequireAuth={onRequireAuth} />);
    fireEvent.click(screen.getAllByRole('button')[0]);
    typeKeywordAndSubmit('infermiere');
    expect(onRequireAuth).toHaveBeenCalledTimes(1);
    unmount();

    render(<JobAlertForm authUser={authUser} />);
    await waitFor(() => expect(createAlertMock).toHaveBeenCalledTimes(1));
    expect(createAlertMock).toHaveBeenCalledWith(
      'user-1',
      'foo@example.com',
      expect.objectContaining({ keywords: ['infermiere'] }),
    );
    await waitFor(() => expect(analyticsMock.trackJobAlertCreated).toHaveBeenCalledTimes(1));
    const created = analyticsMock.trackJobAlertCreated.mock.calls[0][0];
    expect(created).toMatchObject({ surface: 'inline_card', authPath: 'post_auth_replay' });
    // The surface is one the goal's allowlist counts on BOTH sides of the ratio.
    expect(ALERT_CTA_SURFACES).toContain(created.surface);
    await waitFor(() => expect(ctaActions()).toContain('inline_card:success'));
    expect(localStorage.getItem(PENDING_KEY)).toBeNull();
  });

  it('a legacy intent without origin stays on the diagnostic post_auth_auto surface', async () => {
    localStorage.setItem(
      PENDING_KEY,
      JSON.stringify({
        value: { keywords: ['cuoco'], locations: [], contractTypes: [], sectors: [], cantonFilter: null, frequency: 'daily', locale: 'it' },
        savedAt: Date.now(),
      }),
    );
    render(<JobAlertForm authUser={authUser} />);
    await waitFor(() => expect(analyticsMock.trackJobAlertCreated).toHaveBeenCalledTimes(1));
    const created = analyticsMock.trackJobAlertCreated.mock.calls[0][0];
    expect(created).toMatchObject({ surface: 'post_auth_auto', authPath: 'post_auth_replay' });
    expect(ALERT_CTA_SURFACES).not.toContain(created.surface);
  });

  it('a direct signed-in create reports authPath direct and the accept→success chain', async () => {
    render(<JobAlertForm authUser={authUser} />);
    fireEvent.click(screen.getAllByRole('button')[0]);
    typeKeywordAndSubmit('contabile');
    await waitFor(() => expect(analyticsMock.trackJobAlertCreated).toHaveBeenCalledTimes(1));
    expect(analyticsMock.trackJobAlertCreated.mock.calls[0][0]).toMatchObject({ surface: 'inline_card', authPath: 'direct' });
    await waitFor(() => expect(ctaActions()).toEqual(['inline_card:open', 'inline_card:accept', 'inline_card:success']));
  });

  it('a failed signed-in create reports accept→error', async () => {
    createAlertMock.mockRejectedValueOnce(new Error('quota'));
    render(<JobAlertForm authUser={authUser} />);
    fireEvent.click(screen.getAllByRole('button')[0]);
    typeKeywordAndSubmit('contabile');
    await waitFor(() => expect(ctaActions()).toEqual(['inline_card:open', 'inline_card:accept', 'inline_card:error']));
    expect(analyticsMock.trackJobAlertCreated).not.toHaveBeenCalled();
  });
});

describe('JobAlertForm — inline_card impression fires once, on visibility (issue 9577)', () => {
  beforeEach(() => {
    FakeIO.instances = [];
    vi.stubGlobal('IntersectionObserver', FakeIO as unknown as typeof IntersectionObserver);
    Object.values(analyticsMock).forEach((m) => m.mockClear());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('is not emitted on mount nor on the two-search auto-expand, only when the card is seen', async () => {
    vi.useFakeTimers();
    const { rerender } = render(<JobAlertForm authUser={null} initialKeyword="infermiere" />);
    act(() => { vi.advanceTimersByTime(900); });
    rerender(<JobAlertForm authUser={null} initialKeyword="cuoco" />);
    act(() => { vi.advanceTimersByTime(900); });
    vi.useRealTimers();
    // Auto-expand happened…
    expect(document.getElementById('job-alert-form')).not.toBeNull();
    await new Promise((r) => setTimeout(r, 20));
    // …but pre-fix it was the ONLY place an inline_card impression came from.
    expect(analyticsMock.trackJobAlertCtaShown).not.toHaveBeenCalled();

    const io = FakeIO.instances.at(-1)!;
    io.enter();
    io.enter();
    await waitFor(() => expect(analyticsMock.trackJobAlertCtaShown).toHaveBeenCalledTimes(1));
    expect(analyticsMock.trackJobAlertCtaShown).toHaveBeenCalledWith('inline_card', 'cuoco');
  });

  it('waits for a signed-in user\'s alerts before arming the impression', async () => {
    render(<JobAlertForm authUser={authUser} />);
    await waitFor(() => expect(FakeIO.instances.length).toBeGreaterThan(0));
    FakeIO.instances.at(-1)!.enter();
    await waitFor(() => expect(analyticsMock.trackJobAlertCtaShown).toHaveBeenCalledTimes(1));
    expect(analyticsMock.trackJobAlertCtaShown.mock.calls[0][0]).toBe('inline_card');
  });
});
