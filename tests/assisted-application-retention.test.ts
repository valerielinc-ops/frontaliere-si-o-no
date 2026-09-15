import { describe, expect, it, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const DAY = 86400000;
const NOW = 1_800_000_000_000;
const functionsIndexSource = readFileSync(resolve('functions/index.js'), 'utf8');
let orders: Record<string, Record<string, unknown>> = {};

const deleteFileMock = vi.fn(async () => {});

function docRef(id: string) {
  return {
    id,
    async set(data: Record<string, unknown>, options?: { merge?: boolean }) {
      orders[id] = options?.merge ? { ...(orders[id] || {}), ...data } : data;
    },
  };
}

const firestore = Object.assign(
  () => ({
    collection: () => ({
      where: () => ({
        limit: () => ({
          async get() {
            const docs = Object.keys(orders).map((id) => ({
              id,
              data: () => orders[id],
              ref: docRef(id),
            }));
            return { docs, empty: docs.length === 0 };
          },
        }),
      }),
    }),
  }),
  {
    Timestamp: { fromMillis: (millis: number) => ({ millis }) },
    FieldValue: { serverTimestamp: () => '__server_timestamp__' },
  },
);

vi.mock('firebase-admin', () => ({
  default: {
    firestore,
    storage: () => ({
      bucket: () => ({
        file: (path: string) => ({
          delete: (options: { ignoreNotFound: boolean }) => deleteFileMock(path, options),
        }),
      }),
    }),
  },
}));

async function load() {
  return import('../functions/src/assistedApplicationRetention.js');
}

beforeEach(() => {
  orders = {
    submitted_old: {
      submissionStatus: 'ready_for_manual_submission',
      submittedAt: { toMillis: () => NOW - 91 * DAY },
      cvStorageKey: 'assisted-application-uploads/submitted_old/cv.pdf',
      coverLetterStorageKey: 'assisted-application-uploads/submitted_old/letter.docx',
    },
    refunded_old: {
      paymentStatus: 'refunded',
      refundedAt: { toMillis: () => NOW - 100 * DAY },
      cvStorageKey: 'assisted-application-uploads/refunded_old/cv.docx',
    },
    talent_pool: {
      submissionStatus: 'ready_for_manual_submission',
      submittedAt: { toMillis: () => NOW - 120 * DAY },
      talentPoolConsent: true,
      cvStorageKey: 'assisted-application-uploads/talent_pool/cv.pdf',
    },
    recent: {
      submissionStatus: 'ready_for_manual_submission',
      submittedAt: { toMillis: () => NOW - 5 * DAY },
      cvStorageKey: 'assisted-application-uploads/recent/cv.pdf',
    },
    pending: {
      paymentStatus: 'pending',
      cvStorageKey: 'assisted-application-uploads/pending/cv.pdf',
    },
    abandoned_old: {
      paymentStatus: 'paid',
      submissionStatus: 'awaiting_upload',
      cvUploadedAt: { toMillis: () => NOW - 91 * DAY },
      cvStorageKey: 'assisted-application-uploads/abandoned_old/cv.pdf',
    },
    unsafe_reference: {
      paymentStatus: 'refunded',
      refundedAt: { toMillis: () => NOW - 100 * DAY },
      cvStorageKey: 'cv-uploads/other-job/other.pdf',
    },
    unsafe_nested: {
      paymentStatus: 'refunded',
      refundedAt: { toMillis: () => NOW - 100 * DAY },
      cvStorageKey: 'assisted-application-uploads/unsafe_nested/../other.pdf',
    },
  };
  vi.clearAllMocks();
});

describe('purgeExpiredAssistedApplicationFiles', () => {
  it('is wired to a daily Cloud Scheduler function', () => {
    expect(functionsIndexSource).toContain("export const purgeAssistedApplicationFiles = onSchedule(");
    expect(functionsIndexSource).toContain("schedule: 'every 24 hours'");
    expect(functionsIndexSource).toContain('purgeExpiredAssistedApplicationFiles()');
  });

  it('deletes expired CV/cover-letter objects and clears their references', async () => {
    const { purgeExpiredAssistedApplicationFiles } = await load();

    const result = await purgeExpiredAssistedApplicationFiles(90, NOW);

    expect(result.purged).toBe(3);
    expect(deleteFileMock).toHaveBeenCalledTimes(4);
    expect(deleteFileMock).toHaveBeenCalledWith(
      'assisted-application-uploads/submitted_old/cv.pdf',
      { ignoreNotFound: true },
    );
    expect(deleteFileMock).toHaveBeenCalledWith(
      'assisted-application-uploads/refunded_old/cv.docx',
      { ignoreNotFound: true },
    );
    expect(orders.submitted_old.cvStorageKey).toBeNull();
    expect(orders.submitted_old.coverLetterStorageKey).toBeNull();
    expect(orders.submitted_old.retentionPurgedAt).toBe('__server_timestamp__');
    expect(orders.refunded_old.cvStorageKey).toBeNull();
    expect(orders.abandoned_old.cvStorageKey).toBeNull();
    expect(orders.abandoned_old.cvUploadedAt).toBeNull();
    expect(deleteFileMock).toHaveBeenCalledWith(
      'assisted-application-uploads/abandoned_old/cv.pdf',
      { ignoreNotFound: true },
    );
  });

  it('preserves talent-pool consent and never deletes a path outside the assisted namespace', async () => {
    const { purgeExpiredAssistedApplicationFiles } = await load();

    await purgeExpiredAssistedApplicationFiles(90, NOW);

    expect(orders.talent_pool.cvStorageKey).toBe('assisted-application-uploads/talent_pool/cv.pdf');
    expect(orders.unsafe_reference.cvStorageKey).toBe('cv-uploads/other-job/other.pdf');
    expect(orders.unsafe_nested.cvStorageKey).toBe('assisted-application-uploads/unsafe_nested/../other.pdf');
    expect(deleteFileMock).not.toHaveBeenCalledWith(
      'assisted-application-uploads/talent_pool/cv.pdf',
      { ignoreNotFound: true },
    );
    expect(deleteFileMock).not.toHaveBeenCalledWith(
      'cv-uploads/other-job/other.pdf',
      { ignoreNotFound: true },
    );
    expect(deleteFileMock).not.toHaveBeenCalledWith(
      'assisted-application-uploads/unsafe_nested/../other.pdf',
      { ignoreNotFound: true },
    );
  });
});
