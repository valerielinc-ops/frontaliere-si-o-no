/** A renewal owns its own CV copy so retention of an older service cannot break it. */
import { FieldValue } from 'firebase-admin/firestore';
import { getStorage } from 'firebase-admin/storage';
import { ASSISTED_APPLICATION_STORAGE_BUCKET } from './assistedApplicationCvCheck.js';
import { APPLICATION_CONCIERGE_SERVICES_COLLECTION, serviceIsActive } from './applicationConciergeConstants.js';
import { conciergeMaterialCopy } from './applicationConciergeMaterialCopy.js';

export async function inheritConciergeRenewalMaterials({ db, serviceId, bucket = null, nowMs = Date.now() }) {
  const operationStartedAt = Date.now();
  const ref = db.collection(APPLICATION_CONCIERGE_SERVICES_COLLECTION).doc(serviceId);
  const target = (await ref.get()).data();
  if (!serviceIsActive(target, nowMs) || !target.renewalOfServiceId || target.cvStorageKey || target.renewalMaterialsCopiedAt || target.retentionPurgedAt || !target.renewalConsentVersion) return { copied: false };
  const source = (await db.collection(APPLICATION_CONCIERGE_SERVICES_COLLECTION).doc(target.renewalOfServiceId).get()).data();
  if (!String(source?.cvStorageKey || '').startsWith(`application-concierge-uploads/${target.renewalOfServiceId}/`) || source.userId !== target.userId || source.retentionPurgedAt || !source.consentVersion || !source.consentedAt) return { copied: false };
  const storage = bucket || getStorage().bucket(ASSISTED_APPLICATION_STORAGE_BUCKET);
  const copy = conciergeMaterialCopy({ db, bucket: storage, serviceId, sourceServiceId: target.renewalOfServiceId,
    targetId: serviceId, uid: target.userId, source, purpose: 'renewal', now: () => Math.max(nowMs, Date.now()), operationStartedAt });
  let uploaded;
  try { uploaded = await copy.save(); }
  catch (error) { if (error?.code === 'material_copy_in_progress') return { copied: false, pending: true }; throw error; }
  if (!uploaded) return { copied: false };
  const copied = await copy.publish((tx, { service: current, source: currentSource, key, writeId }) => {
    tx.set(ref, { cvStorageKey: key, cvUploadedAt: FieldValue.serverTimestamp(), cvFileName: currentSource.cvFileName || null,
      cvMaterialCopyWriteId: writeId,
      applicantName: currentSource.applicantName || null, applicantEmail: currentSource.applicantEmail || currentSource.customerEmail || null,
      applicantPhone: currentSource.applicantPhone || null, applicantLocation: currentSource.applicantLocation || null,
      consentVersion: current.renewalConsentVersion, consentedAt: current.renewalConsentedAt || FieldValue.serverTimestamp(),
      renewalMaterialsCopiedAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() }, { merge: true });
  });
  if (!copied) await copy.abandon();
  return { copied };
}
