/** Admission happens before opening a portal; a lost heartbeat terminates this executor. */
import { executionLease, EXECUTION_HEARTBEAT_MS } from '../../../functions/src/assistedApplicationExecution.js';
import { currentPortalCodeVersion } from './portal-code-version.mjs';
import { verifyExecutionRelease } from './execution-release.mjs';
import { readExecutionArtifacts } from './execution-artifacts.mjs';

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
  let renewing = false;
  const timer = setInterval(async () => {
    if (renewing) return;
    renewing = true;
    try { await lease.heartbeat(); }
    catch { clearInterval(timer); onLeaseLost(); }
    finally { renewing = false; }
  }, EXECUTION_HEARTBEAT_MS);
  timer.unref?.();
  const checked = { ...lease,
    assertInTransaction(transaction) { verifySource(); return lease.assertInTransaction(transaction); },
    assertOutcomeInTransaction(transaction) { verifySource(); return lease.assertOutcomeInTransaction(transaction); },
  };
  return { lease: checked, async close() { clearInterval(timer); await lease.complete({ artifacts: readExecutionArtifacts(env) }); } };
}
