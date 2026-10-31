/** Admission happens before opening a portal; a lost heartbeat terminates this executor. */
import { executionLease, EXECUTION_HEARTBEAT_MS } from '../../../functions/src/assistedApplicationExecution.js';
import { currentPortalCodeVersion } from './portal-code-version.mjs';
import { verifyExecutionRelease } from './execution-release.mjs';
import { readExecutionArtifacts } from './execution-artifacts.mjs';
import { createPublicAgentFetch } from './browser-egress.mjs';

export async function enterExecution({ db, orderId, flow, mode, env = process.env, sourceSha, engineVersion,
  onLeaseLost = () => process.kill(process.pid, 'SIGTERM') }) {
  const executionId = String(env.ASSISTED_APPLICATION_EXECUTION_ID || '');
  if (!executionId) {
    if (flow.executionId) throw new Error('execution_assigned_to_another_runner');
    return null;
  }
  if (mode !== 'submit' || env.ASSISTED_APPLICATION_EXECUTOR !== 'mac-agenti') throw new Error('execution_mode_invalid');
  const verifySource = () => {
    if (env.ASSISTED_APPLICATION_RELEASE_ROOT) return verifyExecutionRelease(env.ASSISTED_APPLICATION_RELEASE_ROOT,
      env.ASSISTED_APPLICATION_RELEASE_MANIFEST_SHA256).sourceSha;
    if (sourceSha) return sourceSha; // explicit dependency injection for local fixtures only
    throw new Error('execution_immutable_release_missing');
  };
  const actualSource = verifySource();
  if (actualSource !== env.ASSISTED_APPLICATION_SOURCE_SHA) throw new Error('execution_checkout_mismatch');
  const lease = executionLease({ db, orderId, executionId, sourceSha: actualSource,
    engineVersion: engineVersion || currentPortalCodeVersion(), owner: String(env.GITHUB_RUN_ID || '') });
  if (!env.GITHUB_RUN_ID) throw new Error('execution_owner_missing');
  await lease.claim();
  const publicTransport = createPublicAgentFetch();
  const receiptState = { only: false, closed: false, complete: false, until: null, observer: null, observed: false };
  let drainTimer = null; let handover = null; let closing = null;
  let answerSourceGuard = null;
  let lost = false;
  const loseLease = () => { if (!lost) { lost = true; onLeaseLost(); } };
  const bounded = promise => {
    let timer;
    return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('execution_receipt_quiesce_unknown')), 3000); })])
      .finally(() => clearTimeout(timer));
  };
  const closeObservation = () => {
    if (closing) return closing;
    closing = (async () => {
      receiptState.closed = true;
      if (!receiptState.observer) { if (!receiptState.observed) loseLease(); return; }
      try { await bounded(Promise.resolve().then(() => receiptState.observer.close())); }
      catch { loseLease(); }
    })();
    return closing;
  };
  const enterReceiptOnly = outcome => {
    if (handover) return handover;
    receiptState.only = true; receiptState.until = outcome.until;
    handover = (async () => {
      if (!Number.isFinite(outcome.until) || outcome.until <= Date.now() || !receiptState.observer) return closeObservation();
      let acknowledged = false;
      try { acknowledged = await bounded(Promise.resolve().then(() => receiptState.observer.quiesce())) === true; }
      catch { /* Missing acknowledgement never authorises keeping the page open. */ }
      if (!acknowledged) return closeObservation();
      drainTimer = setTimeout(() => { void closeObservation(); }, Math.max(0, outcome.until - Date.now()));
      drainTimer.unref?.();
    })();
    return handover;
  };
  const acceptHeartbeat = async outcome => {
    if (outcome?.receiptComplete) { receiptState.complete = true; clearTimeout(drainTimer); await closeObservation(); }
    else if (outcome?.receiptOnly) await enterReceiptOnly(outcome);
  };
  const receiptControl = {
    get receiptOnly() { return receiptState.only; },
    get closed() { return receiptState.closed; },
    get deadline() { return receiptState.until; },
    async received() { receiptState.complete = true; clearTimeout(drainTimer); await closeObservation(); },
    async cleanupFailed() { await closeObservation(); loseLease(); },
    async bindSourceGuard(guard) {
      if (!guard || typeof guard.fingerprint !== 'string' || !guard.fingerprint || typeof guard.assertInTransaction !== 'function'
        || answerSourceGuard) throw new Error('execution_answer_source_guard_invalid');
      answerSourceGuard = Object.freeze({ fingerprint: guard.fingerprint,
        assertInTransaction: guard.assertInTransaction.bind(guard) });
      verifySource();
      await db.runTransaction(async transaction => {
        await lease.assertInTransaction(transaction);
        await answerSourceGuard.assertInTransaction(transaction);
      });
    },
    register(observer) {
      if (receiptState.observer || typeof observer?.quiesce !== 'function' || typeof observer?.close !== 'function') throw new Error('execution_receipt_observer_invalid');
      receiptState.observer = observer;
      receiptState.observed = true;
      return () => { if (receiptState.observer === observer) receiptState.observer = null; };
    },
    async authorizeContinuation() {
      if (receiptState.only || receiptState.complete || receiptState.closed) return false;
      try {
        verifySource();
        await db.runTransaction(async transaction => {
          await lease.assertInTransaction(transaction);
          if (answerSourceGuard) await answerSourceGuard.assertInTransaction(transaction);
        });
        return true;
      }
      catch {
        try {
          const outcome = await lease.heartbeat({ answerSourceGuard });
          await acceptHeartbeat(outcome);
          // A source attestation error cannot be turned back into permission
          // merely because the database predicates still happen to pass.
          if (!outcome?.receiptOnly && !outcome?.receiptComplete) { await closeObservation(); loseLease(); }
        }
        catch { await closeObservation(); loseLease(); }
        return false;
      }
    },
  };
  let renewing = false;
  const timer = setInterval(async () => {
    if (renewing) return;
    renewing = true;
    try { verifySource(); await acceptHeartbeat(await lease.heartbeat({ answerSourceGuard })); }
    catch { clearInterval(timer); await closeObservation(); loseLease(); }
    finally { renewing = false; }
  }, EXECUTION_HEARTBEAT_MS);
  timer.unref?.();
  const checked = { ...lease,
    assertInTransaction(transaction) { verifySource(); return lease.assertInTransaction(transaction); },
    assertOutcomeInTransaction(transaction) { verifySource(); return lease.assertOutcomeInTransaction(transaction); },
  };
  return { lease: checked, receiptControl, fetchImpl: publicTransport.fetch, async close() {
    clearInterval(timer);
    clearTimeout(drainTimer);
    try { await lease.complete({ artifacts: readExecutionArtifacts(env) }); } finally { await publicTransport.close(); }
  } };
}
