import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  consumeJobAlertOpen,
  openJobAlertForm,
  requestJobAlertOpen,
} from '@/services/jobAlertOpenSignal';
import type { PendingJobAlertOrigin } from '@/services/pendingJobAlert';

const FORM_HANDOFF_ORIGINS = [
  'inline_card',
  'job_detail_button',
  'job_board_filters',
  'end_card',
  'sticky_banner',
  'saved_jobs_nudge',
] as const satisfies readonly PendingJobAlertOrigin[];

describe('job-alert cross-view handoff', () => {
  afterEach(() => {
    consumeJobAlertOpen();
    vi.unstubAllGlobals();
  });

  it('preserves a detail-receipt origin for the form mounted after navigation', () => {
    requestJobAlertOpen('Tecnologia', 'job_detail_button');

    expect(consumeJobAlertOpen()).toEqual({
      keyword: 'Tecnologia',
      origin: 'job_detail_button',
    });
  });

  it('keeps the legacy inline handoff shape when no origin is supplied', () => {
    requestJobAlertOpen('Tecnologia');

    expect(consumeJobAlertOpen()).toEqual({ keyword: 'Tecnologia' });
  });

  it.each(FORM_HANDOFF_ORIGINS)('broadcasts and queues the %s origin through one helper', (origin) => {
    // This file is intentionally a node test: SSG and other non-browser
    // consumers import the helper too. The helper must queue without touching
    // browser globals.
    expect(() => openJobAlertForm('Tecnologia', origin)).not.toThrow();
    expect(consumeJobAlertOpen()).toEqual({ keyword: 'Tecnologia', origin });

    const events: Event[] = [];
    const listener = (event: Event) => events.push(event);
    const eventTarget = new EventTarget();
    vi.stubGlobal('window', eventTarget);
    eventTarget.addEventListener('openJobAlert', listener);

    try {
      openJobAlertForm('Tecnologia', origin);

      expect(consumeJobAlertOpen()).toEqual({ keyword: 'Tecnologia', origin });
      expect(events).toHaveLength(1);
      expect((events[0] as CustomEvent<{ keyword?: string; origin?: PendingJobAlertOrigin }>).detail)
        .toEqual({ keyword: 'Tecnologia', origin });
    } finally {
      eventTarget.removeEventListener('openJobAlert', listener);
    }
  });
});
