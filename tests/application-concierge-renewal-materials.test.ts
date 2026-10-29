import { describe, expect, it } from 'vitest';
import { inheritConciergeRenewalMaterials } from '../functions/src/applicationConciergeRenewalMaterials.js';

function fixture() {
  const now = Date.now();
  const documents = new Map<string, any>([
    ['renewal', { userId: 'candidate', paymentStatus: 'paid', serviceStatus: 'active', expiresAt: new Date(now + 30 * 86400000), renewalOfServiceId: 'original', renewalConsentVersion: 'application-concierge-v1', renewalConsentedAt: new Date(now) }],
    ['original', { userId: 'candidate', cvStorageKey: 'application-concierge-uploads/original/cv.pdf', consentVersion: 'application-concierge-v1', consentedAt: new Date(now - 30 * 86400000), applicantName: 'Candidate Example' }],
  ]);
  const files = new Set(['application-concierge-uploads/original/cv.pdf']);
  const deleted: string[] = [];
  let onCopy = () => {};
  let queue = Promise.resolve();
  const ref = (id: string): any => ({ get: async () => ({ data: () => documents.get(id) }), set: async (data: any) => documents.set(id, { ...documents.get(id), ...data }) });
  const tx = { get: (r: any) => r.get(), set: (r: any, data: any) => r.set(data) };
  const db: any = { collection: () => ({ doc: ref }), runTransaction: (callback: any) => { const next = queue.then(() => callback(tx)); queue = next.then(() => undefined, () => undefined); return next; } };
  const file = (key: string): any => ({ key, copy: async (target: any) => { files.add(target.key); onCopy(); }, delete: async () => { deleted.push(key); files.delete(key); } });
  return { now, documents, files, deleted, db, bucket: { file }, setOnCopy: (fn: () => void) => { onCopy = fn; } };
}

describe('renewal owns a separate CV with fresh consent', () => {
  it('copies once and never overwrites a later user upload', async () => {
    const f = fixture();
    const result = await inheritConciergeRenewalMaterials({ ...f, serviceId: 'renewal', nowMs: f.now });
    expect(result.copied).toBe(true);
    const target = f.documents.get('renewal');
    expect(target.cvStorageKey).toMatch(/^application-concierge-uploads\/renewal\/renewal-.*\.pdf$/);
    expect(target.consentVersion).toBe('application-concierge-v1');
    expect(f.files.has('application-concierge-uploads/original/cv.pdf')).toBe(true);
    const later = 'application-concierge-uploads/renewal/new-cv.pdf';
    f.documents.set('renewal', { ...target, cvStorageKey: later });
    expect((await inheritConciergeRenewalMaterials({ ...f, serviceId: 'renewal', nowMs: f.now })).copied).toBe(false);
    expect(f.documents.get('renewal').cvStorageKey).toBe(later);
  });
  it('two deliveries retain the winner copy and delete only the unused unique copy', async () => {
    const f = fixture();
    const results = await Promise.all([inheritConciergeRenewalMaterials({ ...f, serviceId: 'renewal', nowMs: f.now }), inheritConciergeRenewalMaterials({ ...f, serviceId: 'renewal', nowMs: f.now })]);
    expect(results.filter(result => result.copied)).toHaveLength(1);
    expect(f.deleted).toHaveLength(1);
    expect(f.files.has(f.documents.get('renewal').cvStorageKey)).toBe(true);
    expect(f.deleted).not.toContain(f.documents.get('renewal').cvStorageKey);
  });
  it('does not copy another owner’s CV or copy without new consent', async () => {
    const f = fixture();
    f.documents.get('original').userId = 'different-candidate';
    expect((await inheritConciergeRenewalMaterials({ ...f, serviceId: 'renewal', nowMs: f.now })).copied).toBe(false);
    f.documents.get('original').userId = 'candidate';
    delete f.documents.get('renewal').renewalConsentVersion;
    expect((await inheritConciergeRenewalMaterials({ ...f, serviceId: 'renewal', nowMs: f.now })).copied).toBe(false);
    expect(f.files.size).toBe(1);
  });
  it('a refund during copying cannot activate the copied materials', async () => {
    const f = fixture();
    f.setOnCopy(() => { f.documents.get('renewal').paymentStatus = 'refunded'; });
    expect((await inheritConciergeRenewalMaterials({ ...f, serviceId: 'renewal', nowMs: f.now })).copied).toBe(false);
    expect(f.documents.get('renewal').cvStorageKey).toBeUndefined();
    expect(f.files.size).toBe(1);
  });
});
