import { describe, expect, it } from 'vitest';
import { inheritConciergeRenewalMaterials } from '../functions/src/applicationConciergeRenewalMaterials.js';
import { materialCopyFixture } from './helpers/conciergeMaterialCopyFixture.mjs';

function fixture() {
  const f = materialCopyFixture(), now = f.now, prefix = 'application_concierge_services/';
  f.documents.clear();
  f.documents.set(prefix + 'renewal', { userId: 'candidate', paymentStatus: 'paid', serviceStatus: 'active', expiresAt: new Date(now + 30 * 86400000), renewalOfServiceId: 'original', renewalConsentVersion: 'application-concierge-v1', renewalConsentedAt: new Date(now) });
  f.documents.set(prefix + 'original', { userId: 'candidate', paymentStatus: 'paid', serviceStatus: 'expired', expiresAt: new Date(now - 1),
    cvStorageKey: 'application-concierge-uploads/original/cv.pdf', consentVersion: 'application-concierge-v1', consentedAt: new Date(now - 30 * 86400000), applicantName: 'Candidate Example' });
  f.objects.set('application-concierge-uploads/original/cv.pdf', f.objects.get(f.sourceKey)!);
  f.objects.delete(f.sourceKey);
  return { ...f, documents: { get: (id: string) => f.documents.get(prefix + id), set: (id: string, data: any) => f.documents.set(prefix + id, data),
    delete: (id: string) => f.documents.delete(prefix + id) }, files: f.objects,
    setOnCopy(fn: () => void) { f.hooks.afterSave = fn; } };
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
  it('two deliveries share one uploader and never delete the published CV', async () => {
    const f = fixture();
    const results = await Promise.all([inheritConciergeRenewalMaterials({ ...f, serviceId: 'renewal', nowMs: f.now }), inheritConciergeRenewalMaterials({ ...f, serviceId: 'renewal', nowMs: f.now })]);
    expect(results.filter(result => result.copied)).toHaveLength(1);
    expect(f.deleted).toHaveLength(0);
    expect(f.files.size).toBe(2);
    expect(f.files.has(f.documents.get('renewal').cvStorageKey)).toBe(true);
    expect(f.deleted).not.toContain(f.documents.get('renewal').cvStorageKey);
  });
  it('preserves the renewed CV after a committed publication loses its ACK', async () => {
    const f = fixture(); let lost = false;
    f.hooks.afterCommit = async () => {
      if (!lost && f.documents.get('renewal').cvStorageKey) { lost = true; throw new Error('commit_ack_lost'); }
    };
    expect((await inheritConciergeRenewalMaterials({ ...f, serviceId: 'renewal', nowMs: f.now })).copied).toBe(true);
    expect(f.files.has(f.documents.get('renewal').cvStorageKey)).toBe(true);
    expect(f.deleted).toHaveLength(0);
    expect((await inheritConciergeRenewalMaterials({ ...f, serviceId: 'renewal', nowMs: f.now })).copied).toBe(false);
    expect(f.files.size).toBe(2);
  });
  it('a concurrent user upload wins and only the unpublished copy is cleaned', async () => {
    const f = fixture(), later = 'application-concierge-uploads/renewal/user-cv.pdf';
    f.setOnCopy(() => {
      f.files.set(later, { bytes: Buffer.from('user CV'), generation: '888', contentType: 'application/pdf', metadata: {} });
      f.documents.get('renewal').cvStorageKey = later;
    });
    expect((await inheritConciergeRenewalMaterials({ ...f, serviceId: 'renewal', nowMs: f.now })).copied).toBe(false);
    expect(f.documents.get('renewal').cvStorageKey).toBe(later);
    expect(f.files.has(later)).toBe(true);
    expect(f.deleted).toHaveLength(1);
    expect(f.deleted).not.toContain(later);
    expect(f.files.size).toBe(2);
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
  it.each(['target_retention', 'target_expired', 'target_consent', 'source_retention', 'source_removed'])('discards a copy if privacy or eligibility changes during storage copying: %s', async change => {
    const f = fixture();
    f.setOnCopy(() => {
      if (change === 'target_retention') f.documents.get('renewal').retentionPurgedAt = new Date(f.now);
      if (change === 'target_expired') f.documents.get('renewal').expiresAt = new Date(f.now);
      if (change === 'target_consent') delete f.documents.get('renewal').renewalConsentVersion;
      if (change === 'source_retention') f.documents.get('original').retentionPurgedAt = new Date(f.now);
      if (change === 'source_removed') f.documents.delete('original');
    });
    expect((await inheritConciergeRenewalMaterials({ ...f, serviceId: 'renewal', nowMs: f.now })).copied).toBe(false);
    expect(f.documents.get('renewal').cvStorageKey).toBeUndefined();
    expect(f.deleted).toHaveLength(1);
    expect(f.files.size).toBe(1);
  });
});
