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
import { safeErrorInfo, verificationTarget, verifyPortalApplication } from './lib/portal/verify.mjs';
import { applicationExistsEvidenceOf, applicationExistsProbeEntry, applicationExistsRoute, vacancyBoundToOrder } from '../../functions/src/lib/applicationExistsReconciliation.js';
import { portalJobKey } from './lib/portal/stages.mjs';
import { readPublicPortalProtocol } from './lib/portal/protocol.mjs';
import { decryptJson, maskValues, personalValuesOf, runKeyFrom, storeEvidence } from './lib/secure-run.mjs';

export function verificationBinding({ flow, submission }) {
  return createHash('sha256').update(JSON.stringify({ round: flow?.round || 1, dispatch: flow?.dispatch || null,
    claim: submission?.[`r${Number(flow?.round) || 1}`] || null })).digest('hex');
}

const LEGACY_HOLDS = ['portal_ambiguous', 'portal_antibot_ambiguous'];
// Stops that leave the outcome of an earlier send unconfirmed; a later run may have overwritten its claim.
const UNCERTAIN_HOLDS = [...LEGACY_HOLDS, 'portal:account_application_history_uncertain', 'portal:account_application_already_applied'];

/** Runner events of the round that ended in an ambiguous send: our own evidence that a send was attempted. */
export async function ambiguousSendEvents(ref, round) {
  const snapshot = await ref.collection('automation_events').where('type', '==', 'submit_failed').where('round', '==', Number(round) || 1).get();
  return snapshot.docs.filter(doc => /_ambiguous$/.test(String(doc.data()?.error || '')) || doc.data()?.error === 'submission_receipt_invalid').length;
}

export function verificationEligible({ order, flow, draft, submission, round, nowMs = Date.now(), ambiguousEvents = 0 }) {
  const claim = submission?.[`r${round}`];
  const retentionDue = retentionPurgeDueAt(order);
  const marker = flow?.ambiguousSubmit;
  // The claim as the click left it, or released/overwritten by a later run while a send of ours is on record
  // (a recorded ambiguous runner event, the click that survived as priorClickedAt, or the flow's own marker).
  const clickedClaim = claim?.state === 'sending' && claim.channel === 'portal' && Number(claim.clickedAt) > 0;
  const ownSend = ambiguousEvents > 0 || Number(claim?.priorClickedAt) > 0 || Number(claim?.clickedAt) > 0
    || Boolean(marker && Number(marker.round) === round && !marker.clearedAt);
  const releasedClaim = Boolean(claim) && claim.channel === 'portal' && claim.state !== 'sent' && ownSend;
  const heldLegacy = flow?.heldBy?.length === 1 && LEGACY_HOLDS.includes(flow.heldBy[0]);
  const heldUncertain = flow?.heldBy?.length === 1 && UNCERTAIN_HOLDS.includes(flow.heldBy[0]);
  return hasAssistedApplicationConsent(order) && (talentPoolConsentActive(order) || (retentionDue !== null && retentionDue > nowMs))
    && order?.paymentStatus === 'paid' && !order.withdrawnAt && !order.retentionPurgedAt && !submission?.withdrawnAt
    && !['submitted', 'withdrawn', 'refunded'].includes(order.submissionStatus)
    && !['pending', 'succeeded', 'refunded'].includes(order.refundStatus)
    && roundWasSent(flow, round) && flow?.state === 'owner_takeover' && Number(flow.round) === round && !flow.postingExpiredAt
    && draft?.status === 'ready' && Number(draft.round) === round && !draft.sent
    && ((heldLegacy && clickedClaim) || (heldUncertain && releasedClaim));
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
  const ambiguousEvents = await ambiguousSendEvents(ref, round);
  return db.runTransaction(async transaction => {
    const state = await readContext(transaction, ref);
    if (!verificationEligible({ ...state, round, nowMs, ambiguousEvents })) return { requested: false, reason: 'ineligible' };
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

export async function executePortalVerification({ db, bucket, orderId, round, nonce, version, key, nowMs = Date.now(), inspect = verifyPortalApplication, loadProtocol = readPublicPortalProtocol,
  inspectExists = verifyPortalApplication, runEffect = null }) {
  const ref = db.collection('assisted_applications').doc(orderId);
  const verificationRef = ref.collection('automation').doc('portal_verification');
  const ambiguousEvents = await ambiguousSendEvents(ref, round);
  const state = await db.runTransaction(async transaction => {
    const current = await readContext(transaction, ref);
    const request = current.verification;
    if (!verificationEligible({ ...current, round, nowMs: Date.now(), ambiguousEvents }) || request?.state !== 'requested' || request.nonce !== nonce
      || request.round !== round || request.version !== version || request.expiresAt <= nowMs
      || request.binding !== verificationBinding(current)) return null;
    transaction.set(verificationRef, { state: 'running', runId: process.env.GITHUB_RUN_ID || null, startedAt: nowMs }, { merge: true });
    return current;
  });
  if (!state) return { inspected: false, reason: 'superseded' };
  maskValues([personalValuesOf(state.order, state.draft.profile || {}), state.order.candidateAlias?.address || '']);
  const claim = state.submission[`r${round}`];
  const applyUrl = state.draft.channel?.applyUrl || state.draft.job?.applyUrl || '';
  // A claim still as the click left it keeps the original inspection: a review route the earlier attempt actually
  // visited. A claim a later run released or overwrote has no such source of its own: the portal itself is asked,
  // read-only, whether the order's alias account already has an application for the order's vacancy.
  const clickedClaim = claim?.state === 'sending' && Number(claim.clickedAt) > 0 && LEGACY_HOLDS.includes(state.flow.heldBy?.[0]);
  const sourcePath = clickedClaim ? `assisted-application-uploads/${orderId}/run-${claim.startedAt}-submit-portal-submit_failed.json.enc` : null;
  let proof = { conclusion: 'unknown', reason: 'source_unavailable' };
  let probeEvidence = null;
  let stage = 'source';
  try {
    const accounts = portalAccountStore({ db, orderId, key, mask: value => maskValues([value]) });
    if (clickedClaim) {
      const [buffer] = await bucket.file(sourcePath).download();
      const source = decryptJson(JSON.parse(buffer.toString('utf8')), key);
      const validSource = source.event?.type === 'submit_failed' && /_ambiguous$/.test(source.event.error || '')
        && source.applyUrl === applyUrl && source.evidence?.finalOutcomes?.at(-1) === 'ambiguous';
      const sourceProtocol = validSource && !portalJobKey(applyUrl) ? await loadProtocol(applyUrl) : null;
      const targetUrl = validSource ? verificationTarget({ applyUrl, evidence: source.evidence, sourceProtocol }) : null;
      if (targetUrl) proof = await inspect({ applyUrl, targetUrl, sourceProtocol, observedUrls: (source.evidence.steps || []).map(step => step.url).filter(Boolean), job: state.draft.job || {}, accounts });
    } else {
      stage = 'probe_entry';
      const probe = applicationExistsProbeEntry(applyUrl);
      if (!probe) proof = { conclusion: 'unknown', reason: 'portal_without_application_exists_route' };
      else {
        stage = 'inspect';
        proof = await inspectExists({ applyUrl, targetUrl: probe.entryUrl, probe, job: state.draft.job || {}, accounts,
          aliasEmail: String(state.order.candidateAlias?.address || ''), allowRecovery: true });
        stage = 'route';
        const live = applicationExistsRoute(proof.applicationExists ? `https://${proof.applicationExists.host}${proof.applicationExists.pagePath}` : '');
        const urls = [state.draft.channel?.applyUrl, state.draft.channel?.postingUrl, state.draft.job?.applyUrl, state.draft.job?.postingUrl, state.order.jobUrl];
        // The whole vacancy id comes from the live URL; the binding is to the order's own posting URLs.
        probeEvidence = live ? applicationExistsEvidenceOf({ ...live, vacancyBound: vacancyBoundToOrder(live, urls) }) : null;
      }
    }
  } catch (error) {
    // Fail closed without putting credentials or portal/candidate text in logs: where it failed and what class of
    // error, as identifiers only (safeErrorInfo), never the message.
    proof = { conclusion: 'unknown', reason: 'inspection_unavailable', error: safeErrorInfo(error, stage) };
    probeEvidence = null;
  }
  const mayStore = await db.runTransaction(async transaction => {
    const current = await readContext(transaction, ref);
    return verificationEligible({ ...current, round, nowMs: Date.now(), ambiguousEvents }) && current.verification?.nonce === nonce
      && current.verification.state === 'running' && current.verification.version === version
      && current.verification.binding === verificationBinding(current);
  });
  if (!mayStore) return { inspected: true, recorded: false, conclusion: 'unknown' };
  const proofPath = await storeEvidence({ bucket, orderId, name: 'portal-verification', key,
    payload: { round, nonce, version, binding: state.verification.binding, sourcePath, proof }, nowMs });
  // Settlement uses the same criteria as the runner's own handoff (decideApplicationExistsReconciliation): our
  // send on record, the alias account, the order's vacancy. Anything missing leaves the order held and unknown.
  let settled = null;
  if (probeEvidence) {
    const { settleFromApplicationExists } = await import('../../functions/src/assistedApplicationAutomation.js');
    const effect = runEffect || (await import('../../functions/src/assistedApplicationAutomationEffects.js')).runAutomationEffect;
    settled = await settleFromApplicationExists({ db, orderId, evidence: probeEvidence, round, runEffect: effect, nowMs: Date.now(),
      allowOwnerTakeover: true, actor: 'portal_verification' });
  }
  const conclusion = settled?.ok ? 'application_exists' : 'unknown';
  let recorded = false;
  try {
    recorded = await db.runTransaction(async transaction => {
      const current = await readContext(transaction, ref);
      // A settled order is no longer eligible: its own nonce and running state are what bind the record then.
      const bound = current.verification?.nonce === nonce && current.verification.state === 'running' && current.verification.version === version;
      if (!bound || (!settled?.ok && (!verificationEligible({ ...current, round, nowMs: Date.now(), ambiguousEvents })
        || current.verification.binding !== verificationBinding(current)))) return false;
      transaction.set(verificationRef, { state: 'completed', completedAt: Date.now(), proofPath, conclusion }, { merge: true });
      return true;
    });
  } finally {
    if (!recorded) await bucket.file(proofPath).delete({ ignoreNotFound: true });
  }
  return { inspected: true, recorded, conclusion };
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
