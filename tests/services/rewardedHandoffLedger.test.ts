// @vitest-environment jsdom
/**
 * rewardedHandoffLedger: every rewarded grant gets one receipt, sent later
 * from a visible page, whose event name says what happened after the grant
 * (live check 30-09: only 18 hand-off events for 33 grants).
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ track: vi.fn() }));
vi.mock('@/services/assistedApplicationExperiment', () => ({
  trackAssistedApplicationEvent: mocks.track,
}));

import {
  flushHandoffReceipts,
  HANDOFF_RECEIPT_EVENTS,
  HANDOFF_RECEIPT_MIN_AGE_MS,
  markHandoffOpened,
  markHandoffRoute,
  receiptEventName,
  recordHandoffGrant,
  scheduleHandoffReceiptFlush,
} from '@/services/rewardedHandoffLedger';

// The service is mocked above, so its name list is read from the source.
const experimentSource = readFileSync(resolve(process.cwd(), 'services/assistedApplicationExperiment.ts'), 'utf8');

const KEY = 'ft_rewarded_handoff_ledger_v1';
const setVisibility = (state: DocumentVisibilityState) => {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
  document.dispatchEvent(new Event('visibilitychange'));
};
const sent = () => mocks.track.mock.calls.map(([name, params]) => ({ name, params }));
const grant = (now: number) => recordHandoffGrant({ jobId: 'job-1', companyId: 'company-1', path: 'offerwall' }, now);

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_900_000_000_000);
  mocks.track.mockReset();
  window.localStorage.removeItem(KEY);
  setVisibility('visible');
});

afterEach(() => {
  vi.useRealTimers();
  setVisibility('visible');
});

describe('receiptEventName', () => {
  it.each([
    [{ route: 'auto', opened: 1 }, 'rewarded_receipt_auto_opened'],
    [{ route: 'auto', opened: 0 }, 'rewarded_receipt_auto_left'],
    [{ route: 'card', opened: 1 }, 'rewarded_receipt_card_opened'],
    [{ route: 'card', opened: 0 }, 'rewarded_receipt_card_left'],
    [{ route: 'blocked', opened: 1 }, 'rewarded_receipt_blocked_opened'],
    [{ route: 'blocked', opened: 0 }, 'rewarded_receipt_blocked_left'],
    [{ route: 'none', opened: 0 }, 'rewarded_receipt_none'],
  ] as const)('%o → %s', (entry, name) => {
    expect(receiptEventName(entry)).toBe(name);
  });
});

describe('ledger', () => {
  it('sends one receipt per grant once it is due, then forgets it', () => {
    const id = grant(Date.now());
    markHandoffRoute(id, 'auto');
    markHandoffOpened(id);
    expect(flushHandoffReceipts()).toBe(0);

    vi.advanceTimersByTime(HANDOFF_RECEIPT_MIN_AGE_MS);
    expect(flushHandoffReceipts()).toBe(1);
    expect(sent()).toEqual([{
      name: 'rewarded_receipt_auto_opened',
      params: expect.objectContaining({ jobId: 'job-1', companyId: 'company-1', grant_path: 'offerwall', ms_since_grant: HANDOFF_RECEIPT_MIN_AGE_MS }),
    }]);
    expect(window.localStorage.getItem(KEY)).toBeNull();
    expect(flushHandoffReceipts()).toBe(0);
  });

  it('reports a grant that never reached a hand-off as none', () => {
    grant(Date.now());
    vi.advanceTimersByTime(HANDOFF_RECEIPT_MIN_AGE_MS);
    flushHandoffReceipts();
    expect(sent().map((s) => s.name)).toEqual(['rewarded_receipt_none']);
  });

  it('keeps blocked over the card that follows it, and records the click', () => {
    const id = grant(Date.now());
    markHandoffRoute(id, 'auto');
    markHandoffRoute(id, 'blocked');
    markHandoffRoute(id, 'card');
    markHandoffOpened(id);
    vi.advanceTimersByTime(HANDOFF_RECEIPT_MIN_AGE_MS);
    flushHandoffReceipts();
    expect(sent().map((s) => s.name)).toEqual(['rewarded_receipt_blocked_opened']);
  });

  it('never sends from a hidden page: the receipt waits for the return', () => {
    grant(Date.now());
    vi.advanceTimersByTime(HANDOFF_RECEIPT_MIN_AGE_MS);
    setVisibility('hidden');
    expect(flushHandoffReceipts()).toBe(0);
    expect(window.localStorage.getItem(KEY)).not.toBeNull();
    setVisibility('visible');
    expect(flushHandoffReceipts()).toBe(1);
  });

  it('schedules the send after the grant, or on the first return to the tab', () => {
    const id = grant(Date.now());
    markHandoffRoute(id, 'auto');
    scheduleHandoffReceiptFlush();
    // The employer's tab took the foreground before the receipt was due.
    setVisibility('hidden');
    vi.advanceTimersByTime(HANDOFF_RECEIPT_MIN_AGE_MS + 500);
    expect(sent()).toEqual([]);
    setVisibility('visible');
    expect(sent().map((s) => s.name)).toEqual(['rewarded_receipt_auto_left']);
  });

  it('works without storage: no id, no throw, no receipt', () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    const id = grant(Date.now());
    expect(id).toBeNull();
    expect(() => markHandoffRoute(id, 'auto')).not.toThrow();
    vi.advanceTimersByTime(HANDOFF_RECEIPT_MIN_AGE_MS);
    expect(flushHandoffReceipts()).toBe(0);
    setItem.mockRestore();
  });

  it('only uses event names registered for the assisted-application funnel', () => {
    for (const name of HANDOFF_RECEIPT_EVENTS) expect(experimentSource).toContain(`'${name}',`);
    expect(experimentSource).toContain("'rewarded_application_direct_unconfirmed',");
  });
});
