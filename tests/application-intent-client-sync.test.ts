// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const writes = vi.hoisted(() => [] as Array<{
  ref: { path: string };
  data: Record<string, any>;
}>);

vi.mock('firebase/firestore', () => ({
  getFirestore: vi.fn(() => ({ id: 'test-firestore' })),
  doc: vi.fn((_db: unknown, ...segments: string[]) => ({ path: segments.join('/') })),
  setDoc: vi.fn(async (ref: { path: string }, data: Record<string, any>) => {
    writes.push({ ref, data });
  }),
}));

vi.mock('@/services/firebase', () => ({
  app: { id: 'test-app' },
}));

import { recordApplicationIntent } from '@/services/applicationIntent';

const input = {
  job: {
    id: 'job-1',
    slug: 'software-engineer-lugano',
    companyKey: 'acme',
    title: 'Software Engineer',
  },
  origin: '/cerca-lavoro-ticino/',
  surface: 'job_board_apply',
  consentText: 'consent',
};

describe('authenticated application-intent client sync', () => {
  beforeEach(() => {
    localStorage.clear();
    writes.length = 0;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('writes the personalization document before the redirect telemetry request', async () => {
    const order: string[] = [];
    const setDocMock = (await import('firebase/firestore')).setDoc;
    vi.mocked(setDocMock).mockImplementation(async (ref: any, data: any) => {
      order.push('firestore');
      writes.push({ ref, data });
    });
    const getIdToken = vi.fn(async () => {
      order.push('token');
      return 'firebase-token';
    });
    const fetchMock = vi.fn(async () => {
      order.push('endpoint');
      return { ok: true };
    });
    vi.stubGlobal('fetch', fetchMock);

    await recordApplicationIntent({
      ...input,
      authUser: { uid: 'uid-1', email: 'reader@example.test', getIdToken },
    });

    expect(writes).toHaveLength(1);
    expect(writes[0].ref.path).toBe('newsletter_subscribers/reader@example.test/private/personalization');
    expect(writes[0].data.applicationIntent.intents[0].jobKey).toBe('acme:software-engineer-lugano');
    expect(order).toEqual(['firestore', 'token', 'endpoint']);
    expect(fetchMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ keepalive: true }));
  });

  it('keeps anonymous clicks on the local-only path', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true })));

    await recordApplicationIntent(input);

    expect(writes).toHaveLength(0);
  });
});
