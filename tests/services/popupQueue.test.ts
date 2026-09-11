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
const COOKIE_SLOT = 'c3b-cookie-consent';
const CHATBOT_SLOT = 'c3b-chatbot-panel';

describe('C3b — popup queue promotion timer', () => {
  afterEach(() => {
    releaseSlot(ACTIVE_SLOT);
    releaseSlot(WAITING_SLOT);
    releaseSlot(GUIDE_SLOT);
    releaseSlot(COMPANY_SLOT);
    releaseSlot(LATER_GUIDE_SLOT);
    releaseSlot(COOKIE_SLOT);
    releaseSlot(CHATBOT_SLOT);
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

  it('uses the released popup priority while its promotion window is pending', () => {
    vi.useFakeTimers();

    expect(requestSlot(GUIDE_SLOT, POPUP_PRIORITY.GUIDE_BANNER)).toBe(true);
    expect(requestSlot(COMPANY_SLOT, POPUP_PRIORITY.COMPANY_FOLLOW_PROMPT)).toBe(false);
    releaseSlot(GUIDE_SLOT);

    expect(requestSlot(COOKIE_SLOT, POPUP_PRIORITY.COOKIE_CONSENT)).toBe(true);
    releaseSlot(COOKIE_SLOT);
    expect(getActiveSlotId()).toBe(COOKIE_SLOT);

    expect(requestSlot(CHATBOT_SLOT, POPUP_PRIORITY.CHATBOT_PANEL)).toBe(true);
    expect(getActiveSlotId()).toBe(CHATBOT_SLOT);
    vi.advanceTimersByTime(500);
    expect(getActiveSlotId()).toBe(CHATBOT_SLOT);
  });

  it('re-arbitrates a reprioritized active entry with one notification', () => {
    vi.useFakeTimers();
    const listener = vi.fn();
    const unsubscribe = subscribe(listener);

    try {
      expect(requestSlot(ACTIVE_SLOT, 100)).toBe(true);
      expect(requestSlot(WAITING_SLOT, 80)).toBe(false);
      expect(requestSlot(ACTIVE_SLOT, 70)).toBe(false);

      expect(getActiveSlotId()).toBe(WAITING_SLOT);
      expect(listener).toHaveBeenCalledTimes(2);
      vi.advanceTimersByTime(500);
      expect(listener).toHaveBeenCalledTimes(2);
    } finally {
      unsubscribe();
    }
  });

  it('re-arbitrates a released owner that changes priority during the promotion window', () => {
    vi.useFakeTimers();
    const listener = vi.fn();
    const unsubscribe = subscribe(listener);

    try {
      expect(requestSlot(ACTIVE_SLOT, 100)).toBe(true);
      expect(requestSlot(WAITING_SLOT, 80)).toBe(false);
      releaseSlot(ACTIVE_SLOT);
      expect(getActiveSlotId()).toBe(ACTIVE_SLOT);

      expect(requestSlot(ACTIVE_SLOT, 70)).toBe(false);
      expect(getActiveSlotId()).toBe(WAITING_SLOT);
      expect(listener).toHaveBeenCalledTimes(2);
      vi.advanceTimersByTime(500);
      expect(listener).toHaveBeenCalledTimes(2);
    } finally {
      unsubscribe();
    }
  });
});
