/** Queue certainly unsent technical holds once per published portal-engine version. */
import { isInvokedDirectly } from '../lib/is-invoked-directly.mjs';
import { getFirestoreDb } from '../lib/firestore-admin.mjs';
import { currentPortalCodeVersion } from './lib/portal-code-version.mjs';
import { evaluateRedFlags, roundWasSent } from '../../functions/src/assistedApplicationFlow.js';
import { AUTOMATION_FLAG_KEY, parseAutomationFlag } from '../../functions/src/assistedApplicationAutomationFlag.js';
import { getRemoteConfig } from 'firebase-admin/remote-config';
import { portalCodeVersion, portalRecoveryDefinitelyUnsent } from '../../functions/src/assistedApplicationPortalRecoveryPolicy.js';

export async function reconcilePortalCode({ db, version, apply = false, nowMs = Date.now(), isEnabled = null }) {
  if (!portalCodeVersion(version)) throw new Error('invalid_portal_code_version');
  if (!isEnabled) {
    // The script's Admin SDK owns the app initialized by getFirestoreDb.
    // A Functions SDK installed beside it has a separate app registry.
    const template = await getRemoteConfig().getTemplate();
    const flag = parseAutomationFlag(template.parameters?.[AUTOMATION_FLAG_KEY]?.defaultValue?.value);
    isEnabled = id => flag.all || flag.orders.has(id);
  }
  const summary = { scanned: 0, eligible: 0, queued: 0, apply };
  let cursor;
  do {
    let query = db.collection('assisted_applications').where('automationState', '==', 'owner_takeover').orderBy('__name__').limit(100);
    if (cursor) query = query.startAfter(cursor);
    const page = await query.get();
    for (const doc of page.docs) {
      summary.scanned++;
      if (!(await isEnabled(doc.id))) continue;
      const eligible = await db.runTransaction(async transaction => {
        const flowRef = doc.ref.collection('automation').doc('flow');
        const submissionRef = doc.ref.collection('automation').doc('submission');
        const [orderDoc, flowDoc, draftDoc, submissionDoc] = await Promise.all([
          transaction.get(doc.ref), transaction.get(flowRef), transaction.get(doc.ref.collection('ai_drafts').doc('current')),
          transaction.get(submissionRef),
        ]);
        const order = orderDoc.data(); const flow = flowDoc.data(); const draft = draftDoc.data();
        if (!portalRecoveryDefinitelyUnsent({ order, flow, draft, submission: submissionDoc.data(), version })
          || !roundWasSent(flow) || flow.postingExpiredAt) return false;
        const flags = evaluateRedFlags(draft, flow.answers || {}, flow.documents || {}, flow.questionAnswers);
        if (flags.owner.length || flags.candidate.length || flags.documents.length) return false;
        const receipt = submissionDoc.data()?.portalCodeRecovery;
        if (receipt?.version === version && Number(receipt.round) === Number(flow.round || 1)) return false;
        if (apply) {
          const heldBy = flow.heldBy[0] === 'portal:captcha_provider_unavailable' ? flow.heldBy : ['portal:portal_needs_candidate'];
          transaction.set(flowRef, { heldBy, portalAutoRetryAt: nowMs, portalAutoRetryCount: 0,
            portalRecoveryVersion: version, updatedAt: nowMs }, { merge: true });
          transaction.set(doc.ref, { automationDueAt: nowMs, automationUpdatedAt: new Date(nowMs) }, { merge: true });
          transaction.set(submissionRef, { portalCodeRecovery: { version, round: Number(flow.round) || 1, queuedAt: nowMs } }, { merge: true });
          transaction.set(doc.ref.collection('events').doc(), { type: 'portal_code_recovery_scheduled', actor: 'system', at: nowMs, version });
        }
        return true;
      });
      if (eligible) { summary.eligible++; if (apply) summary.queued++; }
    }
    cursor = page.docs.length === 100 ? page.docs.at(-1) : null;
  } while (cursor);
  return summary;
}

if (isInvokedDirectly(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.some(arg => !['--apply', '--dry-run'].includes(arg)) || (args.includes('--apply') && args.includes('--dry-run'))) {
    throw new Error('Usage: reconcile-portal-code.mjs [--dry-run | --apply]');
  }
  console.log(JSON.stringify(await reconcilePortalCode({ db: await getFirestoreDb(), version: currentPortalCodeVersion(), apply: args.includes('--apply') })));
}
