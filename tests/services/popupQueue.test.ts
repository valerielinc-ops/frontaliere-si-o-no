import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  getActiveSlotId,
  releaseSlot,
  requestSlot,
  subscribe,
} from '@/services/popupQueue';

const ACTIVE_SLOT = 'c3b-active';
const WAITING_SLOT = 'c3b-waiting';

describe('C3b — popup queue promotion timer', () => {
  afterEach(() => {
    releaseSlot(ACTIVE_SLOT);
    releaseSlot(WAITING_SLOT);
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
});
