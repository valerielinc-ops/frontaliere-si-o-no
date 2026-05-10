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
import { render, screen, fireEvent, cleanup, within } from '@testing-library/react';
import JobAlertForm from '@/components/community/JobAlertForm';

// Mock the service so the form can dynamic-import it without trying to talk
// to a real Firestore (we don't assert on this — see the service-level tests
// for the payload contract).
vi.mock('@/services/jobAlertService', () => ({
  createAlert: vi.fn(async () => ({ id: 'x' })),
  getUserAlerts: vi.fn(async () => []),
  deleteAlert: vi.fn(async () => undefined),
  updateAlert: vi.fn(async () => undefined),
}));

vi.mock('@/services/analytics', () => ({
  Analytics: {
    trackJobAlertCtaClick: vi.fn(),
    trackJobAlertCreated: vi.fn(),
    trackJobAlertDeleted: vi.fn(),
  },
}));

const authUser = { uid: 'user-1', email: 'foo@example.com' };

function expandForm() {
  const triggerButton = screen.getAllByRole('button')[0];
  fireEvent.click(triggerButton);
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
