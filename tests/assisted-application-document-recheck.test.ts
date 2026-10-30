import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { createMemoryFirestore } from './helpers/memoryFirestore';
import { recheckStoredDocument } from '../functions/src/assistedApplicationDocumentRecheck.js';
import { DOCUMENT_CHECK_VERSION } from '../functions/src/lib/assistedApplicationDocumentCheckVersion.js';

const NOW = Date.now();
const ORDER = 'order_RECHECK123';
const BASE = `assisted_applications/${ORDER}`;
const FLOW = `${BASE}/automation/flow`;
const DRAFT = `${BASE}/ai_drafts/current`;
const KEY = `assisted-application-uploads/${ORDER}/degree.pdf`;
const BYTES = Buffer.from('%PDF-1.7 retained academic certificate fixture');
const HASH = createHash('sha256').update(BYTES).digest('hex');
const MD5 = createHash('md5').update(BYTES).digest('base64');
const CHECK = { verdict: 'match', matched: 'esame di laurea', version: DOCUMENT_CHECK_VERSION };
const claims = { kind: 'review', orderId: ORDER, round: 1, expiresAt: NOW + 86400000, consentBound: false };
let store: ReturnType<typeof createMemoryFirestore>;
let metadata: Record<string, any>;
let object: any;
let bucket: any;
let clock: number;
const args = (body = {}) => ({ db: store.db, bucket, claims, documentId: 'degree', fileId: 'degree.pdf', secret: 's'.repeat(40), now: () => clock, body });
const begin = () => recheckStoredDocument(args());
const complete = (descriptor: any, extra = {}) => recheckStoredDocument(args({ descriptor: descriptor.descriptor, sha256: HASH, clientCheck: CHECK, ...extra }));
const patch = (path: string, value: Record<string, unknown>) => {
  const parts = path.split('/');
  let ref = store.db;
  for (let n = 0; n < parts.length; n += 2) ref = ref.collection(parts[n]).doc(parts[n + 1]);
  return ref.set(value, { merge: true });
};

beforeEach(() => {
  clock = NOW;
  store = createMemoryFirestore({
    [BASE]: { paymentStatus: 'paid', consentVersion: 'assisted-application-v2', consentedAt: NOW, cvUploadedAt: NOW },
    [FLOW]: { state: 'candidate_review', round: 1, answers: { motivation: 'kept' }, documents: { degree: { files: [{ key: KEY, name: 'degree.pdf', detectedType: 'pdf', size: BYTES.length, uploadedAt: NOW, clientCheck: { verdict: 'mismatch', matched: '' } }] } } },
    [DRAFT]: { round: 1, status: 'ready', requiredDocuments: [{ id: 'degree', label: 'degree certificates', kind: 'diploma', keywords: ['degree certificates'], required: true }] },
  });
  metadata = { generation: '123', size: String(BYTES.length), md5Hash: MD5 };
  object = { getMetadata: vi.fn(async () => [{ ...metadata }]), download: vi.fn(async () => [BYTES]), getSignedUrl: vi.fn(async () => ['https://signed.example/degree.pdf?generation=123']) };
  bucket = { file: vi.fn(() => object) };
});

describe('retained document browser recheck protocol', () => {
  it('binds short-lived downloads to exact bytes, generation, document context and server version', async () => {
    const descriptor = await begin();
    expect(descriptor).toMatchObject({ state: 'ready', size: BYTES.length, sha256: HASH, generation: '123', version: DOCUMENT_CHECK_VERSION });
    expect(bucket.file).toHaveBeenCalledWith(KEY, { generation: '123' });
    expect(object.getSignedUrl).toHaveBeenCalledWith(expect.objectContaining({ expires: NOW + 120000, queryParams: { generation: '123' } }));
    const before = store.read(FLOW);
    const result = await complete(descriptor, { extractedText: 'must not be stored', clientCheck: { ...CHECK, extractedText: 'not stored' } });
    expect(result).toEqual({ state: 'checked', clientCheck: CHECK });
    const current = store.read(FLOW);
    expect({ ...current, documents: before.documents }).toEqual(before);
    expect(current.documents.degree.files[0]).toMatchObject({ clientCheck: CHECK, documentCheckProof: { version: DOCUMENT_CHECK_VERSION, generation: '123', sha256: HASH, md5Hash: MD5 } });
    expect(JSON.stringify(current)).not.toContain('extractedText');
    expect(JSON.stringify(current)).not.toContain('signed.example');
    object.download.mockClear();
    expect(await begin()).toEqual({ state: 'unchanged', clientCheck: CHECK });
    expect(object.download).not.toHaveBeenCalled();
    expect(await complete(descriptor)).toEqual({ state: 'checked', clientCheck: CHECK });
  });

  it.each(['png', 'jpg', 'doc'])('preserves unsupported %s checks and never issues a download', async detectedType => {
    const flow = store.read(FLOW);
    flow.documents.degree.files[0].detectedType = detectedType;
    await patch(FLOW, flow);
    expect(await begin()).toEqual({ state: 'unsupported' });
    expect(bucket.file).not.toHaveBeenCalled();
    expect(store.read(FLOW)).toEqual(flow);
  });

  it.each([
    { retentionPurgedAt: NOW }, { withdrawnAt: NOW }, { consentVersion: 'unknown' }, { consentedAt: null },
    { paymentStatus: 'refunded' }, { cvUploadedAt: NOW - 91 * 86400000 }, { cvUploadedAt: null },
  ])('refuses files without current mandate and retention: %j', async orderPatch => {
    await patch(BASE, orderPatch);
    await expect(begin()).rejects.toMatchObject({ status: 403 });
    expect(bucket.file).not.toHaveBeenCalled();
  });

  it('refuses other orders, stale rounds and requests outside requested document files', async () => {
    await expect(recheckStoredDocument({ ...args(), claims: { ...claims, orderId: 'order_OTHER123' } })).rejects.toMatchObject({ status: 403 });
    await patch(FLOW, { round: 2 });
    await expect(begin()).rejects.toMatchObject({ code: 'stale_link' });
    await patch(FLOW, { round: 1 });
    await expect(recheckStoredDocument({ ...args(), fileId: 'other.pdf' })).rejects.toMatchObject({ code: 'invalid_file' });
    const flow = store.read(FLOW); flow.documents.degree.files[0].key = 'assisted-application-uploads/other/degree.pdf'; await patch(FLOW, flow);
    await expect(begin()).rejects.toMatchObject({ code: 'invalid_file' });
  });

  it.each(['generation', 'context', 'file', 'round', 'consent', 'retention'])('fences completion after a %s change', async change => {
    const descriptor = await begin();
    if (change === 'generation') metadata.generation = '124';
    if (change === 'context') await patch(DRAFT, { requiredDocuments: [{ id: 'degree', label: 'Work reference', kind: 'reference', keywords: [] }] });
    if (change === 'file') { const flow = store.read(FLOW); flow.documents.degree.files = []; await patch(FLOW, flow); }
    if (change === 'round') await patch(FLOW, { round: 2 });
    if (change === 'consent') await patch(BASE, { consentedAt: null });
    if (change === 'retention') await patch(BASE, { retentionPurgedAt: NOW });
    const before = store.read(FLOW);
    await expect(complete(descriptor)).rejects.toBeDefined();
    expect(store.read(FLOW)).toEqual(before);
  });

  it('rechecks mandate and retention after storage read and inside the final transaction', async () => {
    object.download.mockImplementationOnce(async () => { await patch(BASE, { consentedAt: null }); return [BYTES]; });
    await expect(begin()).rejects.toMatchObject({ status: 403 });
    await patch(BASE, { consentedAt: NOW });
    const descriptor = await begin();
    const original = store.db.runTransaction;
    store.db.runTransaction = async (fn: any) => { await patch(BASE, { retentionPurgedAt: NOW }); return original(fn); };
    await expect(complete(descriptor)).rejects.toMatchObject({ status: 403 });
    expect(store.read(FLOW).documents.degree.files[0].clientCheck.verdict).toBe('mismatch');
  });

  it('rejects altered, expired, wrong-version or wrong-hash results', async () => {
    const descriptor = await begin();
    await expect(complete({ descriptor: descriptor.descriptor + 'x' })).rejects.toMatchObject({ code: 'invalid_check' });
    await expect(complete(descriptor, { sha256: '0'.repeat(64) })).rejects.toMatchObject({ code: 'invalid_check' });
    await expect(complete(descriptor, { clientCheck: { ...CHECK, version: DOCUMENT_CHECK_VERSION + 1 } })).rejects.toMatchObject({ code: 'invalid_check' });
    clock += 120001;
    await expect(complete(descriptor)).rejects.toMatchObject({ code: 'check_expired' });
    expect(store.read(FLOW).documents.degree.files[0].clientCheck.verdict).toBe('mismatch');
  });

  it('refuses changed storage bytes, generations and excessive size before returning a descriptor', async () => {
    object.download.mockResolvedValueOnce([BYTES.subarray(0, 4)]);
    await expect(begin()).rejects.toMatchObject({ code: 'file_changed' });
    object.download.mockImplementationOnce(async () => { metadata.generation = '124'; return [BYTES]; });
    await expect(begin()).rejects.toMatchObject({ code: 'file_changed' });
    metadata.size = String(11 * 1024 * 1024);
    await expect(begin()).rejects.toMatchObject({ code: 'invalid_file' });
  });
});
