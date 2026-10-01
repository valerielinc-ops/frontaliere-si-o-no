import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  getActiveSlotId,
  isActive,
  markSlotShown,
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

describe('promotional frequency cap', () => {
  it('shares a 60 second gap without changing urgent queue ownership', async () => {
    const { canShowPromotionalPrompt, markPromotionalPromptShown } = await import('@/services/popupQueue');
    const storage = new Map<string, string>();
    vi.stubGlobal('sessionStorage', { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) });
    try {
      expect(canShowPromotionalPrompt(100_000)).toBe(true);
      markPromotionalPromptShown(100_000);
      expect(canShowPromotionalPrompt(159_999)).toBe(false);
      expect(requestSlot(COOKIE_SLOT, POPUP_PRIORITY.COOKIE_CONSENT)).toBe(true);
      expect(canShowPromotionalPrompt(160_000)).toBe(true);
    } finally { releaseSlot(COOKIE_SLOT); vi.unstubAllGlobals(); }
  });
});


let promptTest = 0;
describe('unsolicited prompts obey the queue frequency policy', () => {
  const promos = ['guide-banner', 'feature-survey', 'newsletter-popup', 'job-alert-sticky-banner'];
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2030-01-01T00:00:00Z').getTime() + 120_000 * ++promptTest);
    const storage = new Map<string, string>();
    vi.stubGlobal('sessionStorage', { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) });
  });
  afterEach(() => {
    [...promos, COOKIE_SLOT, CHATBOT_SLOT].forEach(releaseSlot);
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });
  it('a waiting request spends no cap; the actually shown guide delays the survey', async () => {
    const { canShowPromotionalPrompt } = await import('@/services/popupQueue');
    expect(requestSlot(COOKIE_SLOT, POPUP_PRIORITY.COOKIE_CONSENT)).toBe(true);
    expect(requestSlot('guide-banner', POPUP_PRIORITY.GUIDE_BANNER)).toBe(false);
    markSlotShown('guide-banner');
    expect(canShowPromotionalPrompt()).toBe(true);
    releaseSlot(COOKIE_SLOT);
    vi.advanceTimersByTime(500);
    expect(isActive('guide-banner')).toBe(true);
    markSlotShown('guide-banner');
    expect(requestSlot('feature-survey', POPUP_PRIORITY.NEWSLETTER)).toBe(false);
    releaseSlot('guide-banner');
    vi.advanceTimersByTime(59_999);
    expect(isActive('feature-survey')).toBe(false);
    vi.advanceTimersByTime(501);
    expect(isActive('feature-survey')).toBe(true);
  });
  it('a new or reprioritized promotion cannot preempt during the cap; consent and voluntary dialogs can', async () => {
    const { markPromotionalPromptShown } = await import('@/services/popupQueue');
    markPromotionalPromptShown();
    expect(requestSlot('newsletter-popup', POPUP_PRIORITY.NEWSLETTER)).toBe(false);
    expect(requestSlot('job-alert-sticky-banner', POPUP_PRIORITY.JOB_ALERT_STICKY)).toBe(false);
    expect(requestSlot('job-alert-sticky-banner', POPUP_PRIORITY.GUIDE_BANNER)).toBe(false);
    expect(requestSlot(COOKIE_SLOT, POPUP_PRIORITY.COOKIE_CONSENT)).toBe(true);
    expect(requestSlot(CHATBOT_SLOT, POPUP_PRIORITY.CHATBOT_PANEL)).toBe(true);
    vi.advanceTimersByTime(61_000);
    expect(isActive(CHATBOT_SLOT)).toBe(true);
    releaseSlot(CHATBOT_SLOT);
    releaseSlot(COOKIE_SLOT);
    vi.advanceTimersByTime(500);
    expect(isActive('job-alert-sticky-banner')).toBe(true);
  });
  it('does not let a remounted promotion inherit the released owner during its exit window', () => {
    requestSlot('guide-banner', POPUP_PRIORITY.GUIDE_BANNER);
    markSlotShown('guide-banner');
    requestSlot('feature-survey', POPUP_PRIORITY.NEWSLETTER);
    releaseSlot('guide-banner');
    expect(requestSlot('guide-banner', POPUP_PRIORITY.GUIDE_BANNER)).toBe(false);
    expect(isActive('guide-banner')).toBe(false);
    vi.advanceTimersByTime(500);
    expect(getActiveSlotId()).toBe(null);
  });
  it('does not promote an unmounted offer when the cooldown ends', async () => {
    const { markPromotionalPromptShown } = await import('@/services/popupQueue');
    markPromotionalPromptShown();
    requestSlot('feature-survey', POPUP_PRIORITY.NEWSLETTER);
    releaseSlot('feature-survey');
    vi.advanceTimersByTime(61_000);
    expect(getActiveSlotId()).toBe(null);
  });
});
