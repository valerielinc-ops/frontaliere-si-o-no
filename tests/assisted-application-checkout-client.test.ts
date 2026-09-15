import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createAssistedApplicationCheckout } from '../services/assistedApplicationCheckout';

const fetchMock = vi.fn(async () => ({
  ok: true,
  json: async () => ({
    ok: true,
    url: 'https://checkout.stripe.com/cs_assisted_client',
    orderId: 'order-client-1',
  }),
}));

const input = {
  jobId: 'job-client-1',
  companyId: 'company-client',
  jobUrl: 'https://jobs.example.test/jobs/job-client-1',
  companyName: 'ACME SA',
  jobTitle: 'Software Developer',
  experimentVariant: 'assisted_application' as const,
  successUrl: 'https://frontaliereticino.ch/lavoro/job-client-1',
  cancelUrl: 'https://frontaliereticino.ch/lavoro/job-client-1',
};

function requestBodyAt(index: number) {
  const init = fetchMock.mock.calls[index]?.[1] as RequestInit;
  return JSON.parse(String(init?.body || '{}')) as { requestKey?: string };
}

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockClear();
});

describe('assisted application checkout client idempotency', () => {
  it('persists one request key per user and job across retries', async () => {
    const user = { uid: 'user-client-1', getIdToken: vi.fn(async () => 'good-token') };

    await createAssistedApplicationCheckout(input, user);
    await createAssistedApplicationCheckout(input, user);

    const firstKey = requestBodyAt(0).requestKey;
    expect(firstKey).toMatch(/^[A-Za-z0-9_-]{16,128}$/);
    expect(requestBodyAt(1).requestKey).toBe(firstKey);
  });

  it('keeps request keys distinct for different authenticated users', async () => {
    await createAssistedApplicationCheckout(input, {
      uid: 'user-client-2',
      getIdToken: vi.fn(async () => 'good-token'),
    });
    await createAssistedApplicationCheckout(input, {
      uid: 'user-client-3',
      getIdToken: vi.fn(async () => 'good-token'),
    });

    expect(requestBodyAt(0).requestKey).not.toBe(requestBodyAt(1).requestKey);
  });

  it('keeps the request key stable when locale and return path change', async () => {
    const user = { uid: 'user-client-locale', getIdToken: vi.fn(async () => 'good-token') };

    await createAssistedApplicationCheckout(input, user);
    await createAssistedApplicationCheckout({
      ...input,
      jobTitle: 'Sviluppatore software',
      successUrl: 'https://frontaliereticino.ch/it/lavoro/job-client-1',
      cancelUrl: 'https://frontaliereticino.ch/it/lavoro/job-client-1',
    }, user);

    expect(requestBodyAt(1).requestKey).toBe(requestBodyAt(0).requestKey);
  });
});
