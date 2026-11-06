/** Revalidate legacy portal metadata; the ordinary automation clock owns every subsequent transition. */
import { randomUUID } from 'node:crypto';
import { getRemoteConfig } from 'firebase-admin/remote-config';
import { isInvokedDirectly } from '../lib/is-invoked-directly.mjs';
import { getFirestoreDb } from '../lib/firestore-admin.mjs';
import { AUTOMATION_FLAG_KEY, parseAutomationFlag } from '../../functions/src/assistedApplicationAutomationFlag.js';
import { loadRunnerAnswerContext } from '../../functions/src/assistedApplicationAnswerEvidence.js';
import { readOnlyPortalContracts } from './lib/portal/read-only-contracts.mjs';
import { PORTAL_CONTRACT_RECONCILIATION_VERSION as VERSION, legacyPortalContractEligible,
  portalContractContextHash, portalContractEpisode, portalContractSourceUrl,
  portalContractQuestionKey, revalidatedPortalQuestions } from './lib/portal/question-contract-reconciliation.mjs';

const RECEIPT = 'portalQuestionContractRecovery';
const RETRY_MS = [5 * 60_000, 30 * 60_000];
const plainObject = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
const stateHash = (context, answerEvidenceFingerprint = '') => portalContractContextHash({ ...context,
  answerEvidenceFingerprint,
  submission: { ...context.submission, [RECEIPT]: undefined } });

async function readContext(ref, read = item => item.get()) {
  const [order, flow, draft, submission, execution] = await Promise.all([read(ref), read(ref.collection('automation').doc('flow')),
    read(ref.collection('ai_drafts').doc('current')), read(ref.collection('automation').doc('submission')),
    read(ref.collection('automation').doc('execution'))]);
  return { order: order.data(), flow: flow.data(), draft: draft.data(), submission: submission.data() || {}, execution: execution.data() || {} };
}

async function contextWithVerifiedAnswers(db, orderId, context, nowMs, getDocument) {
  const rawFlow = context.flow || {};
  const { flow, answerEvidence } = await loadRunnerAnswerContext({ db, orderId, order: context.order || {}, flow: context.flow || {},
    draft: context.draft || {}, nowMs, getDocument });
  const answerEvidenceFingerprint = portalContractContextHash((answerEvidence || [])
    .map(record => String(record?.id || record?.key || '').trim()).filter(Boolean).sort());
  // Keep the marker out of Firestore: it only tells the reconciliation policy
  // that this is a freshly loaded, untrusted legacy projection.
  return { ...context, flow: { ...flow, __answerContextLoaded: true,
    __legacyAnswers: plainObject(rawFlow.answers), __legacyQuestionAnswers: plainObject(rawFlow.questionAnswers),
    __answerEvidenceFingerprint: answerEvidenceFingerprint } };
}

export async function reconcilePortalQuestions({ db, apply = false, now = Date.now, isEnabled = null,
  probe = readOnlyPortalContracts, maxProbes = 6, scanLimit = 60, timeBudgetMs = 180_000 } = {}) {
  const startedAt = now();
  maxProbes = Number.isFinite(maxProbes) ? Math.min(6, Math.max(0, Math.floor(maxProbes))) : 6;
  scanLimit = Number.isFinite(scanLimit) ? Math.min(60, Math.max(1, Math.floor(scanLimit))) : 60;
  timeBudgetMs = Number.isFinite(timeBudgetMs) ? Math.min(180_000, Math.max(1, timeBudgetMs)) : 180_000;
  const summary = { scanned: 0, probed: 0, changed: 0, queued: 0, unknown: 0, alreadyChecked: 0, raced: 0, apply };
  if (!isEnabled) {
    const template = await getRemoteConfig().getTemplate();
    const flag = parseAutomationFlag(template.parameters?.[AUTOMATION_FLAG_KEY]?.defaultValue?.value);
    isEnabled = id => flag.all || flag.orders.has(id);
  }
  const cursorRef = db.collection('assisted_application_maintenance').doc('native-contract-v1');
  const owner = randomUUID();
  let cursor;
  if (apply) {
    const lease = await db.runTransaction(async tx => {
      const current = (await tx.get(cursorRef)).data() || {};
      if (Number(current.leaseUntil) > now()) return null;
      tx.set(cursorRef, { owner, leaseUntil: now() + timeBudgetMs + 30_000 }, { merge: true });
      return current;
    });
    if (!lease) return { ...summary, busy: true };
    cursor = lease.cursor || null;
  } else cursor = (await cursorRef.get()).data()?.cursor || null;
  let lastId = cursor;
  try {
    let query = db.collection('assisted_applications').where('automationState', 'in', ['needs_candidate_action', 'owner_takeover']).orderBy('__name__');
    if (cursor) query = query.startAfter(cursor);
    const page = await query.limit(scanLimit).get();
    for (const doc of page.docs) {
      if (summary.probed >= maxProbes || now() - startedAt >= timeBudgetMs) break;
      summary.scanned++;
      lastId = doc.id;
      if (!(await isEnabled(doc.id))) continue;
      const initialRaw = await readContext(doc.ref);
      const initial = await contextWithVerifiedAnswers(db, doc.id, initialRaw, now(), ref => ref.get());
      if (!legacyPortalContractEligible(initial, now())) continue;
      const contextHash = stateHash(initialRaw, initial.flow?.__answerEvidenceFingerprint);
      const episode = portalContractEpisode(initialRaw);
      const prior = initialRaw.submission[RECEIPT];
      const sameClass = prior?.version === VERSION && prior?.episode === episode;
      if (sameClass && (Number(prior.attempts) >= 3 || prior.contextHash === contextHash
        && (prior.outcome !== 'transient' || Number(prior.nextAttemptAt) > now()))) {
        summary.alreadyChecked++;
        continue;
      }
      summary.probed++;
      const proof = await probe({ applyUrl: portalContractSourceUrl(initial.draft), channelType: initial.draft.channel?.type,
        job: { company: initial.order.companyName || '', title: initial.draft.job?.title || initial.order.jobTitle || '' }, now });
      const outcome = await db.runTransaction(async tx => {
        if (apply) {
          const lease = (await tx.get(cursorRef)).data();
          if (lease?.owner !== owner || Number(lease.leaseUntil) <= now()) return 'raced';
        }
        const currentRaw = await readContext(doc.ref, ref => tx.get(ref));
        const current = await contextWithVerifiedAnswers(db, doc.id, currentRaw, now(), ref => tx.get(ref));
        if (!legacyPortalContractEligible(current, now())
          || stateHash(currentRaw, current.flow?.__answerEvidenceFingerprint) !== contextHash) return 'raced';
        const patch = revalidatedPortalQuestions(current, proof, now(), {
          previouslyRelaxed: sameClass ? prior.relaxedQuestionKeys || [] : [],
        });
        const attempts = sameClass ? Number(prior.attempts || 0) + 1 : 1;
        const transient = !proof.complete && String(proof.reason || '').startsWith('transient_');
        const stamp = now();
        const nextDraft = patch.changed ? { ...currentRaw.draft, questions: patch.questions } : currentRaw.draft;
        const nextOrder = patch.changed && patch.queue ? { ...currentRaw.order, automationDueAt: stamp } : currentRaw.order;
        const relaxed = patch.changed ? patch.questions.filter(question => patch.updated.includes(question.id)
          && question.required === false).map(portalContractQuestionKey) : [];
        const receipt = { version: VERSION, episode, attempts, checkedAt: stamp, round: Number(currentRaw.flow.round),
          contextHash: stateHash({ ...currentRaw, order: nextOrder, draft: nextDraft }, current.flow?.__answerEvidenceFingerprint),
          outcome: patch.changed ? 'reconciled' : transient ? 'transient' : 'unknown',
          reason: proof.complete ? patch.reason || 'native_contract_observed' : proof.reason || patch.reason,
          proof: { observedAt: proof.observedAt || stamp, complete: Boolean(proof.complete), stable: Boolean(proof.stable),
            deniedRequests: proof.deniedRequests || [],
            readOnlyProtocol: proof.readOnlyProtocol || null, publicAssetProof: proof.publicAssetProof || null, guestSessionProof: proof.guestSessionProof || null },
          sourceUrl: portalContractSourceUrl(currentRaw.draft),
          relaxedQuestionKeys: [...new Set([...(sameClass ? prior.relaxedQuestionKeys || [] : []), ...relaxed])],
          nextAttemptAt: transient && attempts < 3 ? stamp + RETRY_MS[attempts - 1] : null };
        if (apply) {
          if (patch.changed) tx.set(doc.ref.collection('ai_drafts').doc('current'), { questions: patch.questions }, { merge: true });
          if (patch.changed && patch.queue) tx.set(doc.ref, { automationDueAt: stamp }, { merge: true });
          tx.set(doc.ref.collection('automation').doc('submission'), { [RECEIPT]: receipt }, { merge: true });
        }
        return patch.changed ? patch.queue ? 'queued' : 'changed' : 'unknown';
      });
      if (outcome === 'queued') { summary.changed++; summary.queued++; }
      else if (Object.hasOwn(summary, outcome)) summary[outcome]++;
    }
    if (!page.docs.length || (page.docs.length < scanLimit && lastId === page.docs.at(-1)?.id)) lastId = null;
    return summary;
  } finally {
    if (apply) await db.runTransaction(async tx => {
      const current = (await tx.get(cursorRef)).data();
      if (current?.owner === owner) tx.set(cursorRef, { cursor: lastId, leaseUntil: 0, owner: null }, { merge: true });
    });
  }
}

if (isInvokedDirectly(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.some(arg => !['--apply', '--dry-run'].includes(arg)) || args.includes('--apply') && args.includes('--dry-run')) {
    throw new Error('Usage: reconcile-portal-questions.mjs [--dry-run | --apply]');
  }
  try {
    console.log(JSON.stringify(await reconcilePortalQuestions({ db: await getFirestoreDb(), apply: args.includes('--apply') })));
  } catch {
    console.error('portal_contract_reconciliation_failed');
    process.exitCode = 1;
  }
}
