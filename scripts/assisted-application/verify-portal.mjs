/** Read-only portal inspection through the normal executor, with a round-bound one-use request. */
import { createHash, randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import { isInvokedDirectly } from '../lib/is-invoked-directly.mjs';
import { getFirestoreDb } from '../lib/firestore-admin.mjs';
import { ASSISTED_APPLICATION_ORDER_ID_RE, hasAssistedApplicationConsent } from '../../functions/src/assistedApplicationConstants.js';
import { ASSISTED_APPLICATION_STORAGE_BUCKET } from '../../functions/src/assistedApplicationCvCheck.js';
import { retentionPurgeDueAt, talentPoolConsentActive } from '../../functions/src/assistedApplicationRetention.js';
import { roundWasSent } from '../../functions/src/assistedApplicationFlow.js';
import { currentPortalCodeVersion } from './lib/portal-code-version.mjs';
import { portalAccountStore } from './lib/portal/account.mjs';
import { verificationTarget, verifyPortalApplication } from './lib/portal/verify.mjs';
import { decryptJson, maskValues, personalValuesOf, runKeyFrom, storeEvidence } from './lib/secure-run.mjs';

export function verificationBinding({ flow, submission }) {
  return createHash('sha256').update(JSON.stringify({ round: flow?.round || 1, dispatch: flow?.dispatch || null,
    claim: submission?.[`r${Number(flow?.round) || 1}`] || null })).digest('hex');
}

export function verificationEligible({ order, flow, draft, submission, round, nowMs = Date.now() }) {
  const claim = submission?.[`r${round}`];
  const retentionDue = retentionPurgeDueAt(order);
  return hasAssistedApplicationConsent(order) && (talentPoolConsentActive(order) || (retentionDue !== null && retentionDue > nowMs))
    && order?.paymentStatus === 'paid' && !order.withdrawnAt && !order.retentionPurgedAt && !submission?.withdrawnAt
    && !['submitted', 'withdrawn', 'refunded'].includes(order.submissionStatus)
    && !['pending', 'succeeded', 'refunded'].includes(order.refundStatus)
    && roundWasSent(flow, round) && flow?.state === 'owner_takeover' && Number(flow.round) === round && !flow.postingExpiredAt
    && flow.heldBy?.length === 1 && ['portal_ambiguous', 'portal_antibot_ambiguous'].includes(flow.heldBy[0])
    && draft?.status === 'ready' && Number(draft.round) === round && !draft.sent
    && claim?.state === 'sending' && claim.channel === 'portal' && Number(claim.clickedAt) > 0;
}

async function readContext(transaction, ref) {
  const paths = [ref, ref.collection('automation').doc('flow'), ref.collection('ai_drafts').doc('current'),
    ref.collection('automation').doc('submission'), ref.collection('automation').doc('portal_verification')];
  const docs = await Promise.all(paths.map(path => transaction.get(path)));
  return Object.fromEntries(['order', 'flow', 'draft', 'submission', 'verification'].map((key, index) => [key, docs[index].data()]));
}

export async function requestPortalVerification({ db, orderId, round, version, nowMs = Date.now(), nonce = randomUUID() }) {
  if (!/^[a-f0-9]{64}$/.test(version) || !/^[a-z0-9-]{16,80}$/i.test(nonce)) throw new Error('invalid_verification_request');
  const ref = db.collection('assisted_applications').doc(orderId);
  return db.runTransaction(async transaction => {
    const state = await readContext(transaction, ref);
    if (!verificationEligible({ ...state, round, nowMs })) return { requested: false, reason: 'ineligible' };
    const binding = verificationBinding(state);
    const previous = state.verification;
    const same = previous?.version === version && previous.round === round && previous.binding === binding;
    if (['requested', 'running'].includes(previous?.state) && previous.expiresAt > nowMs) return { requested: false, reason: 'already_requested' };
    const attempts = same ? Number(previous.attempts || 1) : 0;
    if (attempts >= 3) return { requested: false, reason: 'inspection_limit' };
    const request = { state: 'requested', nonce, round, version, requestedAt: nowMs, expiresAt: nowMs + 30 * 60_000,
      binding, attempts: attempts + 1 };
    transaction.set(ref.collection('automation').doc('portal_verification'), request);
    return { requested: true, nonce, round, version };
  });
}

export async function executePortalVerification({ db, bucket, orderId, round, nonce, version, key, nowMs = Date.now(), inspect = verifyPortalApplication }) {
  const ref = db.collection('assisted_applications').doc(orderId);
  const verificationRef = ref.collection('automation').doc('portal_verification');
  const state = await db.runTransaction(async transaction => {
    const current = await readContext(transaction, ref);
    const request = current.verification;
    if (!verificationEligible({ ...current, round, nowMs: Date.now() }) || request?.state !== 'requested' || request.nonce !== nonce
      || request.round !== round || request.version !== version || request.expiresAt <= nowMs
      || request.binding !== verificationBinding(current)) return null;
    transaction.set(verificationRef, { state: 'running', runId: process.env.GITHUB_RUN_ID || null, startedAt: nowMs }, { merge: true });
    return current;
  });
  if (!state) return { inspected: false, reason: 'superseded' };
  maskValues([personalValuesOf(state.order, state.draft.profile || {}), state.order.candidateAlias?.address || '']);
  // The only inspection target is a route the earlier attempt actually visited.
  // No review URL is invented, and the source evidence belongs to this claim.
  const claim = state.submission[`r${round}`];
  const sourcePath = `assisted-application-uploads/${orderId}/run-${claim.startedAt}-submit-portal-submit_failed.json.enc`;
  let proof = { conclusion: 'unknown', reason: 'source_unavailable' };
  try {
    const [buffer] = await bucket.file(sourcePath).download();
    const source = decryptJson(JSON.parse(buffer.toString('utf8')), key);
    const applyUrl = state.draft.channel?.applyUrl || state.draft.job?.applyUrl || '';
    const targetUrl = source.event?.type === 'submit_failed' && /_ambiguous$/.test(source.event.error || '')
      && source.applyUrl === applyUrl && source.evidence?.finalOutcomes?.at(-1) === 'ambiguous'
      ? verificationTarget({ applyUrl, evidence: source.evidence }) : null;
    if (targetUrl) proof = await inspect({ applyUrl, targetUrl, observedUrls: (source.evidence.steps || []).map(step => step.url).filter(Boolean), job: state.draft.job || {},
      accounts: portalAccountStore({ db, orderId, key, mask: value => maskValues([value]) }) });
  } catch {
    // Fail closed without putting credentials or portal/candidate text in logs.
    proof = { conclusion: 'unknown', reason: 'inspection_unavailable' };
  }
  const mayStore = await db.runTransaction(async transaction => {
    const current = await readContext(transaction, ref);
    return verificationEligible({ ...current, round, nowMs: Date.now() }) && current.verification?.nonce === nonce
      && current.verification.state === 'running' && current.verification.version === version
      && current.verification.binding === verificationBinding(current);
  });
  if (!mayStore) return { inspected: true, recorded: false, conclusion: 'unknown' };
  const proofPath = await storeEvidence({ bucket, orderId, name: 'portal-verification', key,
    payload: { round, nonce, version, binding: state.verification.binding, sourcePath, proof }, nowMs });
  const recorded = await db.runTransaction(async transaction => {
    const current = await readContext(transaction, ref);
    if (!verificationEligible({ ...current, round, nowMs: Date.now() }) || current.verification?.nonce !== nonce
      || current.verification.state !== 'running' || current.verification.version !== version
      || current.verification.binding !== verificationBinding(current)) return false;
    transaction.set(verificationRef, { state: 'completed', completedAt: Date.now(), proofPath, conclusion: 'unknown' }, { merge: true });
    return true;
  });
  if (!recorded) await bucket.file(proofPath).delete({ ignoreNotFound: true });
  return { inspected: true, recorded, conclusion: 'unknown' };
}

if (isInvokedDirectly(import.meta.url)) {
  const { values } = parseArgs({ options: { order: { type: 'string' }, round: { type: 'string' }, nonce: { type: 'string' }, request: { type: 'boolean', default: false } } });
  const orderId = String(values.order || ''); const round = Number(values.round || 1);
  if (!ASSISTED_APPLICATION_ORDER_ID_RE.test(orderId) || !Number.isSafeInteger(round) || round < 1 || round > 20
    || (!values.request && !/^[a-z0-9-]{16,80}$/i.test(String(values.nonce || '')))) throw new Error('invalid_verification_arguments');
  const db = await getFirestoreDb(); const version = currentPortalCodeVersion();
  if (values.request) console.log(JSON.stringify(await requestPortalVerification({ db, orderId, round, version })));
  else {
    const { getStorage } = await import('firebase-admin/storage');
    console.log(JSON.stringify(await executePortalVerification({ db, bucket: getStorage().bucket(ASSISTED_APPLICATION_STORAGE_BUCKET), orderId,
      round, nonce: values.nonce, version, key: runKeyFrom() })));
  }
}
