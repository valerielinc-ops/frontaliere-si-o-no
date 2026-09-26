// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest';

const firestore = vi.hoisted(() => {
  const docs: Record<string, Record<string, unknown>> = {};
  const writes: Array<{ path: string; data: Record<string, unknown> }> = [];
  return {
    docs,
    writes,
    getFirestore: vi.fn(() => ({ __db: true })),
    doc: vi.fn((_db: unknown, ...segments: string[]) => ({ path: segments.join('/') })),
    getDoc: vi.fn(async (ref: { path: string }) => ({
      exists: () => Object.hasOwn(docs, ref.path),
      data: () => docs[ref.path],
    })),
    setDoc: vi.fn(async (ref: { path: string }, data: Record<string, unknown>) => {
      writes.push({ path: ref.path, data });
      docs[ref.path] = { ...(docs[ref.path] || {}), ...data };
    }),
  };
});

vi.mock('firebase/firestore', () => ({
  getFirestore: firestore.getFirestore,
  doc: firestore.doc,
  getDoc: firestore.getDoc,
  setDoc: firestore.setDoc,
}));

vi.mock('@/services/firebase', () => ({ app: { __testApp: true } }));

import { recordApplicationIntent } from '@/services/applicationIntent';

const email = 'applicant@example.test';
const profilePath = `newsletter_subscribers/${email}/private/personalization`;

beforeEach(() => {
  localStorage.clear();
  for (const key of Object.keys(firestore.docs)) delete firestore.docs[key];
  firestore.writes.length = 0;
  firestore.getDoc.mockClear();
  firestore.setDoc.mockClear();
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true })));
});

describe('authenticated application-intent persistence', () => {
  it('writes the bounded profile before the recording promise resolves', async () => {
    const recorded = await recordApplicationIntent({
      job: { id: 'job-1', slug: 'software-engineer-lugano', companyKey: 'acme' },
      origin: '/cerca-lavoro',
      surface: 'job_board_apply',
      consentText: 'Consenso test',
      authEmail: email,
      authUser: { uid: 'uid-test', getIdToken: async () => 'test-token' },
    });

    expect(recorded).toBe(true);
    expect(firestore.getDoc).toHaveBeenCalledOnce();
    expect(firestore.writes).toHaveLength(1);
    expect(firestore.writes[0].path).toBe(profilePath);
    expect(firestore.writes[0].data.applicationIntent).toEqual({
      intents: [expect.objectContaining({
        jobKey: 'acme:software-engineer-lugano',
        application_status: 'redirect_only',
      })],
    });
    expect(Object.keys((firestore.writes[0].data.applicationIntent as { intents: Array<Record<string, unknown>> }).intents[0]).sort())
      .toEqual(['application_status', 'jobKey', 'retentionUntil', 'timestamp']);
  });

  it('hydrates remote opt-out before recording or writing a ranking key', async () => {
    firestore.docs[profilePath] = {
      applicationIntent: { optedOut: true, intents: [] },
    };

    const recorded = await recordApplicationIntent({
      job: { id: 'job-1', slug: 'software-engineer-lugano', companyKey: 'acme' },
      origin: '/cerca-lavoro',
      surface: 'job_board_apply',
      consentText: 'Consenso test',
      authEmail: email,
      authUser: { uid: 'uid-test', getIdToken: async () => 'test-token' },
    });

    expect(recorded).toBe(false);
    expect(firestore.writes).toHaveLength(0);
    expect(JSON.parse(localStorage.getItem('frontaliere_job_personalization') || '{}')
      .applicationIntent).toEqual({ optedOut: true, intents: [] });
  });

  it('keeps valid older signals when expired trailing entries fill the stored tail', async () => {
    const now = Date.now();
    const retained = {
      jobKey: 'acme:still-valid',
      application_status: 'redirect_only',
      timestamp: now - 1_000,
      retentionUntil: now - 1_000 + 90 * 24 * 60 * 60 * 1000,
    };
    firestore.docs[profilePath] = {
      applicationIntent: {
        optedOut: false,
        intents: [retained, ...Array.from({ length: 100 }, (_, index) => ({
          jobKey: `acme:expired-${index}`,
          application_status: 'redirect_only',
          timestamp: now - 91 * 24 * 60 * 60 * 1000,
          retentionUntil: now - 24 * 60 * 60 * 1000,
        }))],
      },
    };

    await recordApplicationIntent({
      job: { id: 'job-1', slug: 'software-engineer-lugano', companyKey: 'acme' },
      origin: '/cerca-lavoro',
      surface: 'job_board_apply',
      consentText: 'Consenso test',
      authEmail: email,
      authUser: { uid: 'uid-test', getIdToken: async () => 'test-token' },
    });

    const intents = (firestore.writes[0].data.applicationIntent as {
      intents: Array<{ jobKey: string }>;
    }).intents;
    expect(intents.map((intent) => intent.jobKey).sort()).toEqual([
      'acme:software-engineer-lugano',
      'acme:still-valid',
    ]);
  });

  it('fails closed when the authenticated profile cannot be hydrated', async () => {
    firestore.getDoc.mockRejectedValueOnce(new Error('offline'));

    const recorded = await recordApplicationIntent({
      job: { id: 'job-1', slug: 'software-engineer-lugano', companyKey: 'acme' },
      origin: '/cerca-lavoro',
      surface: 'job_board_apply',
      consentText: 'Consenso test',
      authEmail: email,
      authUser: { uid: 'uid-test', getIdToken: async () => 'test-token' },
    });

    expect(recorded).toBe(false);
    expect(firestore.writes).toHaveLength(0);
    expect(JSON.parse(localStorage.getItem('frontaliere_job_personalization') || '{}')
      .applicationIntent).toBeUndefined();
  });

  it('fails closed when an authenticated user has no email for the opt-out lookup', async () => {
    const recorded = await recordApplicationIntent({
      job: { id: 'job-1', slug: 'software-engineer-lugano', companyKey: 'acme' },
      origin: '/cerca-lavoro',
      surface: 'job_board_apply',
      consentText: 'Consenso test',
      authUser: { uid: 'uid-without-email', getIdToken: async () => 'test-token' },
    });

    expect(recorded).toBe(false);
    expect(firestore.getDoc).not.toHaveBeenCalled();
    expect(firestore.writes).toHaveLength(0);
    expect(JSON.parse(localStorage.getItem('frontaliere_job_personalization') || '{}')
      .applicationIntent).toBeUndefined();
  });
});
