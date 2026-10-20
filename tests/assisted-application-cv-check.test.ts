import { describe, expect, it, vi } from 'vitest';

vi.mock('firebase-admin', () => ({ default: {} }));

const {
  checkAssistedApplicationCv,
  detectCvFileType,
  isAssistedApplicationCvKey,
} = await import('../functions/src/assistedApplicationCvCheck.js');

function fakeDb() {
  const writes: Record<string, any> = {};
  return {
    writes,
    collection: (name: string) => ({
      doc: (id: string) => ({
        async set(data: any) { writes[`${name}/${id}`] = data; },
      }),
    }),
  };
}

function fakeBucket(bytes: number[] | null) {
  return {
    file: (key: string) => ({
      key,
      async download() {
        if (!bytes) throw Object.assign(new Error('No such object'), { code: 404 });
        return [Buffer.from(bytes)];
      },
    }),
  };
}

describe('assisted application CV type check', () => {
  it('recognises PDF, legacy Word and DOCX by their first bytes', () => {
    expect(detectCvFileType(Buffer.from('%PDF-1.7'))).toBe('pdf');
    expect(detectCvFileType(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]))).toBe('doc');
    expect(detectCvFileType(Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00]))).toBe('docx');
    expect(detectCvFileType(Buffer.from('MZ\x90\x00'))).toBeNull();
    expect(detectCvFileType(Buffer.from([]))).toBeNull();
  });

  it('only accepts references inside the order folder', () => {
    expect(isAssistedApplicationCvKey('o1', 'assisted-application-uploads/o1/1-cv.pdf')).toBe(true);
    expect(isAssistedApplicationCvKey('o1', 'assisted-application-uploads/o2/1-cv.pdf')).toBe(false);
    expect(isAssistedApplicationCvKey('o1', 'assisted-application-uploads/o1/../o2/cv.pdf')).toBe(false);
  });

  it('records the verdict for the exact key on the order', async () => {
    const db = fakeDb();
    const ok = await checkAssistedApplicationCv({
      orderId: 'o1', key: 'assisted-application-uploads/o1/1-cv.pdf', db, bucket: fakeBucket([0x25, 0x50, 0x44, 0x46, 0x2d]),
    });
    expect(ok).toMatchObject({ verdict: 'ok', detectedType: 'pdf', key: 'assisted-application-uploads/o1/1-cv.pdf' });
    expect(db.writes['assisted_applications/o1'].cvFileCheck.verdict).toBe('ok');

    const renamed = await checkAssistedApplicationCv({
      orderId: 'o1', key: 'assisted-application-uploads/o1/2-cv.pdf', db, bucket: fakeBucket([0x4d, 0x5a]),
    });
    expect(renamed.verdict).toBe('type_mismatch');

    const missing = await checkAssistedApplicationCv({
      orderId: 'o1', key: 'assisted-application-uploads/o1/3-cv.pdf', db, bucket: fakeBucket(null),
    });
    expect(missing.verdict).toBe('missing');

    const outside = await checkAssistedApplicationCv({
      orderId: 'o1', key: 'cv-uploads/job/cv.pdf', db, bucket: fakeBucket([0x25]),
    });
    expect(outside.verdict).toBe('invalid_key');
  });
});
