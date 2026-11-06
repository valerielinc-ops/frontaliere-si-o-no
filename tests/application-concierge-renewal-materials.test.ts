import { describe, expect, it } from 'vitest';
import { inheritConciergeRenewalMaterials } from '../functions/src/applicationConciergeRenewalMaterials.js';
import { materialCopyFixture } from './helpers/conciergeMaterialCopyFixture.mjs';

function fixture() {
  const f = materialCopyFixture();
  const sourceKey = 'application-concierge-uploads/original/cv.pdf';
  const source = { userId: 'candidate', paymentStatus: 'paid', cvStorageKey: sourceKey, cvUploadedAt: new Date(f.now - 30 * 86400000),
    cvFileName: 'candidate-cv.pdf', consentVersion: 'application-concierge-v1', consentedAt: new Date(f.now - 30 * 86400000),
    applicantName: 'Candidate Example', applicantLocation: 'Como, Italia', applicantLocationCountry: 'IT' };
  const target = { userId: 'candidate', paymentStatus: 'paid', serviceStatus: 'active', expiresAt: new Date(f.now + 30 * 86400000),
    renewalOfServiceId: 'original', renewalConsentVersion: 'application-concierge-v1', renewalConsentedAt: new Date(f.now) };
  f.documents.set('application_concierge_services/original', f.clone(source));
  f.documents.set('application_concierge_services/renewal', f.clone(target));
  f.objects.set(sourceKey, { bytes: Buffer.from('%PDF-synthetic CV'), generation: '22', contentType: 'application/pdf', metadata: {} });
  return { ...f, target };
}

function copiedRenewalKeys(f: ReturnType<typeof fixture>) {
  return [...f.objects.keys()].filter(key => key.startsWith('application-concierge-uploads/renewal/'));
}

describe('renewal owns a separate CV with fresh consent', () => {
  it('copies once through the idempotent material-copy protocol and never overwrites a later user upload', async () => {
    const f = fixture();
    const result = await inheritConciergeRenewalMaterials({ db: f.db, bucket: f.bucket, serviceId: 'renewal', nowMs: f.now });
    expect(result.copied).toBe(true);
    const target = f.documents.get('application_concierge_services/renewal');
    expect(target.cvStorageKey).toMatch(/^application-concierge-uploads\/renewal\/renewal-.*\.pdf$/);
    expect(target.cvMaterialCopyWriteId).toBeTruthy();
    expect(target.consentVersion).toBe('application-concierge-v1');
    expect(target.applicantLocation).toBe('Como, Italia');
    expect(target.applicantLocationCountry).toBe('IT');
    expect(f.objects.has('application-concierge-uploads/original/cv.pdf')).toBe(true);
    const later = 'application-concierge-uploads/renewal/new-cv.pdf';
    f.documents.set('application_concierge_services/renewal', { ...target, cvStorageKey: later });
    expect((await inheritConciergeRenewalMaterials({ db: f.db, bucket: f.bucket, serviceId: 'renewal', nowMs: f.now })).copied).toBe(false);
    expect(f.documents.get('application_concierge_services/renewal').cvStorageKey).toBe(later);
  });

  it('recovers when GCS committed the renewal copy but the save acknowledgement was lost', async () => {
    const f = fixture();
    f.hooks.afterSave = () => { throw Object.assign(new Error('ack lost'), { code: 'ECONNRESET' }); };
    const result = await inheritConciergeRenewalMaterials({ db: f.db, bucket: f.bucket, serviceId: 'renewal', nowMs: f.now });
    expect(result.copied).toBe(true);
    const target = f.documents.get('application_concierge_services/renewal');
    expect(target.cvStorageKey).toBeTruthy();
    expect(f.writes.filter(key => key === target.cvStorageKey)).toHaveLength(1);
  });

  it('keeps a concurrent delivery pending and publishes only one renewal copy', async () => {
    const f = fixture();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    f.hooks.beforeSave = () => gate;
    const first = inheritConciergeRenewalMaterials({ db: f.db, bucket: f.bucket, serviceId: 'renewal', nowMs: f.now });
    await new Promise(resolve => setTimeout(resolve, 0));
    const second = await inheritConciergeRenewalMaterials({ db: f.db, bucket: f.bucket, serviceId: 'renewal', nowMs: f.now });
    expect(second).toMatchObject({ copied: false, pending: true });
    release();
    expect(await first).toEqual({ copied: true });
    expect(f.writes).toHaveLength(1);
    expect(f.objects.has(f.documents.get('application_concierge_services/renewal').cvStorageKey)).toBe(true);
  });

  it('does not copy another owner’s CV or copy without new consent', async () => {
    const f = fixture();
    f.documents.get('application_concierge_services/original').userId = 'different-candidate';
    expect((await inheritConciergeRenewalMaterials({ db: f.db, bucket: f.bucket, serviceId: 'renewal', nowMs: f.now })).copied).toBe(false);
    f.documents.get('application_concierge_services/original').userId = 'candidate';
    delete f.documents.get('application_concierge_services/renewal').renewalConsentVersion;
    expect((await inheritConciergeRenewalMaterials({ db: f.db, bucket: f.bucket, serviceId: 'renewal', nowMs: f.now })).copied).toBe(false);
    expect(copiedRenewalKeys(f)).toHaveLength(0);
  });

  it('a refund during copying cannot activate the copied materials', async () => {
    const f = fixture();
    f.hooks.afterSave = () => { f.documents.get('application_concierge_services/renewal').paymentStatus = 'refunded'; };
    expect((await inheritConciergeRenewalMaterials({ db: f.db, bucket: f.bucket, serviceId: 'renewal', nowMs: f.now })).copied).toBe(false);
    expect(f.documents.get('application_concierge_services/renewal').cvStorageKey).toBeUndefined();
    expect(copiedRenewalKeys(f)).toHaveLength(0);
  });

  it.each(['target_retention', 'target_expired', 'target_consent', 'source_retention', 'source_removed'])('discards a copy if privacy or eligibility changes during storage copying: %s', async change => {
    const f = fixture();
    f.hooks.afterSave = () => {
      const target = f.documents.get('application_concierge_services/renewal');
      const source = f.documents.get('application_concierge_services/original');
      if (change === 'target_retention') target.retentionPurgedAt = new Date(f.now);
      if (change === 'target_expired') target.expiresAt = new Date(f.now);
      if (change === 'target_consent') delete target.renewalConsentVersion;
      if (change === 'source_retention') source.retentionPurgedAt = new Date(f.now);
      if (change === 'source_removed') f.documents.delete('application_concierge_services/original');
    };
    expect((await inheritConciergeRenewalMaterials({ db: f.db, bucket: f.bucket, serviceId: 'renewal', nowMs: f.now })).copied).toBe(false);
    expect(f.documents.get('application_concierge_services/renewal').cvStorageKey).toBeUndefined();
    expect(copiedRenewalKeys(f)).toHaveLength(0);
  });
});
