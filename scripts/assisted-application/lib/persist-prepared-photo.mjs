import { photoFileAccepted, requiredDocumentsFor } from '../../../functions/src/assistedApplicationExtraDocuments.js';

/** Persist an extracted portrait only while its source CV and submission round are still current. */
export async function persistPreparedPhoto({
  db,
  orderRef,
  documentId,
  file,
  round,
  sourceCvKey,
  draft,
  flow,
}) {
  if (typeof sourceCvKey !== 'string' || !sourceCvKey) return false;

  return db.runTransaction(async (transaction) => {
    const flowRef = orderRef.collection('automation').doc('flow');
    const orderSnapshot = await transaction.get(orderRef);
    const flowSnapshot = await transaction.get(flowRef);
    const currentOrder = orderSnapshot.data() || {};
    const current = flowSnapshot.data() || {};
    if (currentOrder.cvStorageKey !== sourceCvKey
      || current.state !== 'submitting' || (Number(current.round) || 1) !== Number(round)) return false;

    const existing = current.documents?.[documentId] || {};
    const files = Array.isArray(existing.files) ? existing.files : [];
    const document = requiredDocumentsFor(draft, flow).find((item) => item.id === documentId);
    if (document && files.some((item) => photoFileAccepted(document, item))) return false;
    if (!files.some((item) => item?.key === file.key)) {
      transaction.set(flowRef, {
        documents: { [documentId]: { ...existing, files: [...files, file] } },
      }, { merge: true });
    }
    return true;
  });
}
