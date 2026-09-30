import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import JobDetailJobAlertButton from '@/components/community/JobDetailJobAlertButton';
import type { JobAlert, subscribeJobAlertForJob } from '@/services/jobAlertService';

vi.mock('@/services/i18n', () => ({
  useTranslation: () => ({
    t: (_key: string, fallback?: string) => fallback ?? _key,
    locale: 'it',
  }),
}));

type SubscribeFn = typeof subscribeJobAlertForJob;

const baseAlert = (): JobAlert => ({
  id: 'alert-id',
  userId: 'user-1',
  email: 'foo@example.com',
  keywords: ['job-1'],
  locations: [],
  contractTypes: [],
  sectors: [],
  cantonFilter: null,
  frequency: 'daily',
  locale: 'it',
  active: true,
  createdAt: new Date(),
  lastMatchedAt: null,
  matchCount: 0,
});

class FakeIO {
  static instances: FakeIO[] = [];
  readonly observed: Element[] = [];
  disconnected = false;

  constructor(private readonly callback: IntersectionObserverCallback) {
    FakeIO.instances.push(this);
  }

  observe(element: Element) {
    this.observed.push(element);
  }

  unobserve() {}

  disconnect() {
    this.disconnected = true;
  }

  takeRecords() {
    return [];
  }

  enter() {
    act(() => {
      this.callback(
        this.observed.map((target) => ({ isIntersecting: true, target })) as IntersectionObserverEntry[],
        this as unknown as IntersectionObserver,
      );
    });
  }
}

function renderButton({
  onImpression = vi.fn(),
  subscribe = vi.fn<SubscribeFn>(async () => baseAlert()),
}: {
  onImpression?: () => void;
  subscribe?: SubscribeFn;
} = {}) {
  render(
    <JobDetailJobAlertButton
      jobId="job-1"
      userId="user-1"
      email="foo@example.com"
      locale="it"
      onImpression={onImpression}
      subscribe={subscribe}
    />,
  );
  return { onImpression, subscribe };
}

describe('JobDetailJobAlertButton', () => {
  beforeEach(() => {
    FakeIO.instances = [];
    vi.stubGlobal('IntersectionObserver', FakeIO as unknown as typeof IntersectionObserver);
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('reports one impression when the direct CTA becomes visible', () => {
    const { onImpression } = renderButton();

    expect(onImpression).not.toHaveBeenCalled();
    FakeIO.instances[0].enter();
    FakeIO.instances[0].enter();

    expect(onImpression).toHaveBeenCalledTimes(1);
  });

  it('reports the impression before a click can create the alert', async () => {
    const subscribe = vi.fn<SubscribeFn>(async () => baseAlert());
    const { onImpression } = renderButton({ subscribe });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Avvisami per questo annuncio' }));
    });

    expect(onImpression).toHaveBeenCalledTimes(1);
    expect(subscribe).toHaveBeenCalledTimes(1);
  });
});
