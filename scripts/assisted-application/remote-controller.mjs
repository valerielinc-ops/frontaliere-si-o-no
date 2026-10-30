#!/usr/bin/env node
/** Hosted half of the existing per-order workflow. Only the Mac opens a portal. */
import { parseArgs } from 'node:util';
import { execFileSync } from 'node:child_process';
import { getFirestoreDb } from '../lib/firestore-admin.mjs';
import { executionController, CONTROLLER_HEARTBEAT_MS } from '../../functions/src/assistedApplicationExecution.js';
import { isInvokedDirectly } from '../lib/is-invoked-directly.mjs';
import { writeExecutionArtifacts } from './lib/execution-artifacts.mjs';

export function controllerWorkerSource({ checkoutSha, githubSha, githubRef, workerSourceSha }) {
  if (githubRef !== 'refs/heads/main' || githubSha !== checkoutSha || !/^[a-f0-9]{40}$/.test(checkoutSha || '')
    || !/^[a-f0-9]{40}$/.test(workerSourceSha || '')) throw new Error('remote_controller_source_mismatch');
  // Controller code always comes from this run's trusted main. The older
  // worker source is separately attested by the server-owned execution doc
  // and the Mac compiler's origin/main ancestry + immutable release checks.
  return workerSourceSha;
}

export async function waitForRemoteExecution({ db, orderId, executionId, sourceSha, runId, timeoutMs = 110 * 60_000 }) {
  const controller = executionController({ db, orderId, executionId, sourceSha, runId });
  await controller.ready();
  let unsubscribe = () => {}; let timer; let heartbeat; let renewing = false;
  try {
    return await new Promise((resolve, reject) => {
      heartbeat = setInterval(async () => {
        if (renewing) return;
        renewing = true;
        try { await controller.heartbeat(); }
        catch { reject(new Error('remote_controller_lease_lost')); }
        finally { renewing = false; }
      }, CONTROLLER_HEARTBEAT_MS);
      timer = setTimeout(() => reject(new Error('remote_execution_timeout')), timeoutMs);
      unsubscribe = controller.ref.onSnapshot(snapshot => {
        const execution = snapshot.data();
        if (execution?.id !== executionId) return reject(new Error('remote_execution_superseded'));
        if (execution.runtimeUnavailableAt) return reject(new Error('remote_runtime_unavailable'));
        if (execution.state === 'finished') {
          if (execution.outcome === 'unknown') reject(new Error('remote_execution_outcome_unknown'));
          else resolve({ executionId, status: 'finished', outcome: execution.outcome, artifacts: execution.artifacts || {} });
        }
      }, () => reject(new Error('remote_execution_observer_unavailable')));
    });
  } catch (error) {
    await controller.defer();
    throw error;
  } finally {
    clearInterval(heartbeat); clearTimeout(timer); unsubscribe();
    await controller.stop();
  }
}

async function main() {
  const { values } = parseArgs({ options: { order: { type: 'string' }, execution: { type: 'string' }, source: { type: 'string' } } });
  const actualSource = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', timeout: 5000 }).trim();
  const workerSourceSha = controllerWorkerSource({ checkoutSha: actualSource, githubSha: process.env.GITHUB_SHA,
    githubRef: process.env.GITHUB_REF, workerSourceSha: values.source });
  const result = await waitForRemoteExecution({ db: await getFirestoreDb(), orderId: values.order, executionId: values.execution,
    sourceSha: workerSourceSha, runId: process.env.GITHUB_RUN_ID });
  writeExecutionArtifacts(result.artifacts);
  // A completed executor is not an assertion of employer receipt. The normal
  // submission guard, event trigger and encrypted evidence own that outcome.
  console.log('[assisted-application] remote executor completed');
}
if (isInvokedDirectly(import.meta.url)) main().catch(() => { console.error('[assisted-application] remote controller failed'); process.exitCode = 1; });
