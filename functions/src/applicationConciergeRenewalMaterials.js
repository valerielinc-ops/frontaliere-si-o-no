/** A renewal owns its own CV copy so retention of an older service cannot break it. */
import { randomUUID } from 'node:crypto';
import { FieldValue } from 'firebase-admin/firestore';
import { getStorage } from 'firebase-admin/storage';
import { ASSISTED_APPLICATION_STORAGE_BUCKET } from './assistedApplicationCvCheck.js';
import { APPLICATION_CONCIERGE_SERVICES_COLLECTION } from './applicationConciergeConstants.js';

export async function inheritConciergeRenewalMaterials({ db, serviceId, bucket = null }) {
  const ref = db.collection(APPLICATION_CONCIERGE_SERVICES_COLLECTION).doc(serviceId);
  const target = (await ref.get()).data();
  if (target?.paymentStatus !== 'paid' || !target.renewalOfServiceId || target.cvStorageKey) return { copied: false };
  const source = (await db.collection(APPLICATION_CONCIERGE_SERVICES_COLLECTION).doc(target.renewalOfServiceId).get()).data();
  if (!source?.cvStorageKey || source.userId !== target.userId || !source.consentVersion || !source.consentedAt) return { copied: false };
  const storage = bucket || getStorage().bucket(ASSISTED_APPLICATION_STORAGE_BUCKET);
  const extension = /\.(pdf|docx|doc)$/i.exec(source.cvStorageKey)?.[1]?.toLowerCase() || 'pdf';
  const key = `application-concierge-uploads/${serviceId}/renewal-${randomUUID()}.${extension}`;
  await storage.file(source.cvStorageKey).copy(storage.file(key));
  const copied = await db.runTransaction(async tx => {
    const current = (await tx.get(ref)).data();
    if (current?.paymentStatus !== 'paid' || current.cvStorageKey || current.userId !== source.userId) return false;
    tx.set(ref, { cvStorageKey: key, cvUploadedAt: FieldValue.serverTimestamp(), cvFileName: source.cvFileName || null,
      applicantName: source.applicantName || null, applicantEmail: source.applicantEmail || source.customerEmail || null,
      applicantPhone: source.applicantPhone || null, applicantLocation: source.applicantLocation || null,
      consentVersion: source.consentVersion, consentedAt: current.renewalConsentedAt || FieldValue.serverTimestamp(),
      renewalMaterialsCopiedAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() }, { merge: true });
    return true;
  });
  if (!copied) await storage.file(key).delete({ ignoreNotFound: true });
  return { copied };
}
