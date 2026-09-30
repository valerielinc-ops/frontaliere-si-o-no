import { afterEach, describe, expect, it } from 'vitest';
import { consumeJobAlertOpen, requestJobAlertOpen } from '@/services/jobAlertOpenSignal';

describe('job-alert cross-view handoff', () => {
  afterEach(() => {
    consumeJobAlertOpen();
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
});
