import { describe, expect, it } from 'vitest';
import {
  EICAR_TEST_SIGNATURE,
  parseAssistedApplicationOrderId,
  scanBufferForThreats,
  isReadyForManualSubmission,
  scanAssistedApplicationCvUpload,
} from '../functions/src/assistedApplicationCvScanCore.js';

function createFakeDb(seed: Record<string, Record<string, unknown>> = {}) {
  const writes: Array<{ collection: string; docId: string; data: Record<string, unknown> }> = [];
  return {
    writes,
    collection(name: string) {
      return {
        doc(docId: string) {
          return {
            set: async (data: Record<string, unknown>) => {
              writes.push({ collection: name, docId, data });
              seed[docId] = { ...(seed[docId] || {}), ...data };
            },
            get: async () => ({
              exists: !!seed[docId],
              data: () => seed[docId],
            }),
          };
        },
      };
    },
  };
}

describe('parseAssistedApplicationOrderId', () => {
  it('extracts the orderId from an assisted-application-uploads path', () => {
    expect(parseAssistedApplicationOrderId('assisted-application-uploads/order123/cv.pdf')).toBe('order123');
  });

  it('returns null for unrelated paths', () => {
    expect(parseAssistedApplicationOrderId('cv-uploads/jobId/cv.pdf')).toBeNull();
    expect(parseAssistedApplicationOrderId('')).toBeNull();
  });
});

describe('scanBufferForThreats', () => {
  it('flags a buffer containing the EICAR test signature as infected', () => {
    expect(scanBufferForThreats(Buffer.from(`whatever\n${EICAR_TEST_SIGNATURE}\n`))).toBe('infected');
  });

  it('reports a clean buffer as clean', () => {
    expect(scanBufferForThreats(Buffer.from('%PDF-1.4 a perfectly ordinary CV'))).toBe('clean');
  });
});

describe('isReadyForManualSubmission', () => {
  it('is true only once cvScanStatus is clean', () => {
    expect(isReadyForManualSubmission({ cvScanStatus: 'clean' })).toBe(true);
    expect(isReadyForManualSubmission({ cvScanStatus: 'infected' })).toBe(false);
    expect(isReadyForManualSubmission({ cvScanStatus: 'pending' })).toBe(false);
    expect(isReadyForManualSubmission(null)).toBe(false);
  });
});

describe('scanAssistedApplicationCvUpload', () => {
  it('an EICAR-signed upload resolves to infected and keeps the order out of the admin queue', async () => {
    const db = createFakeDb();
    const filePath = 'assisted-application-uploads/order-infected/cv.txt';
    const result = await scanAssistedApplicationCvUpload(filePath, {
      db,
      readFile: async () => Buffer.from(EICAR_TEST_SIGNATURE),
    });

    expect(result).toMatchObject({ handled: true, orderId: 'order-infected', cvScanStatus: 'infected' });
    const orderDoc = await db.collection('assisted_applications').doc('order-infected').get();
    expect(orderDoc.data().cvScanStatus).toBe('infected');
    expect(isReadyForManualSubmission(orderDoc.data())).toBe(false);
  });

  it('a clean upload resolves to clean and surfaces the order as ready for the admin queue', async () => {
    const db = createFakeDb();
    const filePath = 'assisted-application-uploads/order-clean/cv.pdf';
    const result = await scanAssistedApplicationCvUpload(filePath, {
      db,
      readFile: async () => Buffer.from('a perfectly ordinary CV, no threats here'),
    });

    expect(result).toMatchObject({ handled: true, orderId: 'order-clean', cvScanStatus: 'clean' });
    const orderDoc = await db.collection('assisted_applications').doc('order-clean').get();
    expect(orderDoc.data().cvScanStatus).toBe('clean');
    expect(isReadyForManualSubmission(orderDoc.data())).toBe(true);
  });

  it('fails closed (infected) when reading the uploaded file throws', async () => {
    const db = createFakeDb();
    const result = await scanAssistedApplicationCvUpload('assisted-application-uploads/order-err/cv.pdf', {
      db,
      readFile: async () => {
        throw new Error('storage read failed');
      },
    });

    expect(result.cvScanStatus).toBe('infected');
  });

  it('does not write anything for a path outside assisted-application-uploads/**', async () => {
    const db = createFakeDb();
    const result = await scanAssistedApplicationCvUpload('cv-uploads/jobId/cv.pdf', { db });
    expect(result).toEqual({ handled: false, reason: 'unrecognized_path' });
    expect(db.writes).toHaveLength(0);
  });
});
