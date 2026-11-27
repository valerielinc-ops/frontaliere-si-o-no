/** Reads, for one order and round, whether an ambiguous send of the round is still unresolved (lib/applicationExistsReconciliation.js). */
import { ASSISTED_APPLICATIONS_COLLECTION, ASSISTED_APPLICATION_AUDIT_SUBCOLLECTION } from './assistedApplicationConstants.js';
import { ambiguousSendOpen } from './lib/applicationExistsReconciliation.js';

export async function readAmbiguousSendOpen(db, orderId, round) {
  const orderRef = db.collection(ASSISTED_APPLICATIONS_COLLECTION).doc(String(orderId));
  const wanted = Number(round) || 1;
  const [runner, audit] = await Promise.all([
    orderRef.collection('automation_events').where('type', '==', 'submit_failed').where('round', '==', wanted).get(),
    orderRef.collection(ASSISTED_APPLICATION_AUDIT_SUBCOLLECTION).where('round', '==', wanted).get(),
  ]);
  return ambiguousSendOpen({
    round: wanted,
    runnerEvents: runner.docs.map((doc) => doc.data() || {}),
    proofs: audit.docs.map((doc) => doc.data() || {}),
  });
}
