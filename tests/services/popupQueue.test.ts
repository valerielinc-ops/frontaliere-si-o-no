import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  getActiveSlotId,
  isActive,
  POPUP_PRIORITY,
  releaseSlot,
  requestSlot,
  subscribe,
} from '@/services/popupQueue';

const ACTIVE_SLOT = 'c3b-active';
const WAITING_SLOT = 'c3b-waiting';
const GUIDE_SLOT = 'c3b-guide-equal';
const COMPANY_SLOT = 'c3b-company-equal';
const LATER_GUIDE_SLOT = 'c3b-guide-equal-later';

describe('C3b — popup queue promotion timer', () => {
  afterEach(() => {
    releaseSlot(ACTIVE_SLOT);
    releaseSlot(WAITING_SLOT);
    releaseSlot(GUIDE_SLOT);
    releaseSlot(COMPANY_SLOT);
    releaseSlot(LATER_GUIDE_SLOT);
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('clears a pending promotion when the queued popup unmounts', () => {
    vi.useFakeTimers();
    const listener = vi.fn();
    const unsubscribe = subscribe(listener);

    try {
      expect(requestSlot(ACTIVE_SLOT, 100)).toBe(true);
      expect(requestSlot(WAITING_SLOT, 20)).toBe(false);

      releaseSlot(ACTIVE_SLOT);
      releaseSlot(WAITING_SLOT);

      const activeIdAfterUnmount = getActiveSlotId();
      const notificationsAfterUnmount = listener.mock.calls.length;
      vi.advanceTimersByTime(500);

      expect({
        activeIdAfterUnmount,
        timerNotifications: listener.mock.calls.length - notificationsAfterUnmount,
      }).toEqual({
        activeIdAfterUnmount: null,
        timerNotifications: 0,
      });
    } finally {
      unsubscribe();
    }
  });

  it('keeps equal-priority prompts FIFO through a pending release promotion', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-11T10:00:00.000Z'));

    expect(requestSlot(GUIDE_SLOT, POPUP_PRIORITY.GUIDE_BANNER)).toBe(true);
    vi.setSystemTime(new Date('2026-09-11T10:00:00.001Z'));
    expect(requestSlot(COMPANY_SLOT, POPUP_PRIORITY.COMPANY_FOLLOW_PROMPT)).toBe(false);

    // releaseSlot() removes the active guide and starts the 500 ms promotion
    // window. A later equal-priority request must not jump ahead of the queued
    // company follow prompt, and the pending timer must leave one active id.
    releaseSlot(GUIDE_SLOT);
    vi.setSystemTime(new Date('2026-09-11T10:00:00.002Z'));
    expect(requestSlot(LATER_GUIDE_SLOT, POPUP_PRIORITY.GUIDE_BANNER)).toBe(false);
    expect(getActiveSlotId()).toBe(GUIDE_SLOT);

    vi.advanceTimersByTime(500);

    expect(getActiveSlotId()).toBe(COMPANY_SLOT);
    expect([GUIDE_SLOT, COMPANY_SLOT, LATER_GUIDE_SLOT].filter(isActive)).toEqual([COMPANY_SLOT]);
  });

  it('keeps equal-priority FIFO after cancelling an empty promotion timer', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-11T10:01:00.000Z'));

    expect(requestSlot(ACTIVE_SLOT, 100)).toBe(true);
    expect(requestSlot(GUIDE_SLOT, POPUP_PRIORITY.GUIDE_BANNER)).toBe(false);
    expect(requestSlot(COMPANY_SLOT, POPUP_PRIORITY.COMPANY_FOLLOW_PROMPT)).toBe(false);

    // Emptying the queue while the release timer is pending calls
    // cancelPromotionTimer(); a later equal-priority pair must start a fresh
    // FIFO window instead of inheriting stale promotion state.
    releaseSlot(ACTIVE_SLOT);
    releaseSlot(GUIDE_SLOT);
    releaseSlot(COMPANY_SLOT);
    expect(getActiveSlotId()).toBe(null);

    vi.setSystemTime(new Date('2026-09-11T10:01:00.001Z'));
    expect(requestSlot(GUIDE_SLOT, POPUP_PRIORITY.GUIDE_BANNER)).toBe(true);
    vi.setSystemTime(new Date('2026-09-11T10:01:00.002Z'));
    expect(requestSlot(COMPANY_SLOT, POPUP_PRIORITY.COMPANY_FOLLOW_PROMPT)).toBe(false);

    releaseSlot(GUIDE_SLOT);
    vi.advanceTimersByTime(500);

    expect(getActiveSlotId()).toBe(COMPANY_SLOT);
  });
});
