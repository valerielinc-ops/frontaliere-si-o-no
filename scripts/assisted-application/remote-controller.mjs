#!/usr/bin/env node
/** Hosted half of the existing per-order workflow. Only the Mac opens a portal. */
import { parseArgs } from 'node:util';
import { execFileSync } from 'node:child_process';
import { getFirestoreDb } from '../lib/firestore-admin.mjs';
import { executionController, CONTROLLER_HEARTBEAT_MS } from '../../functions/src/assistedApplicationExecution.js';
import { isInvokedDirectly } from '../lib/is-invoked-directly.mjs';
import { writeExecutionArtifacts } from './lib/execution-artifacts.mjs';

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
  if (process.env.GITHUB_REF !== 'refs/heads/main' || process.env.GITHUB_SHA !== actualSource || values.source !== actualSource) throw new Error('remote_controller_source_mismatch');
  const result = await waitForRemoteExecution({ db: await getFirestoreDb(), orderId: values.order, executionId: values.execution,
    sourceSha: actualSource, runId: process.env.GITHUB_RUN_ID });
  writeExecutionArtifacts(result.artifacts);
  // A completed executor is not an assertion of employer receipt. The normal
  // submission guard, event trigger and encrypted evidence own that outcome.
  console.log('[assisted-application] remote executor completed');
}
if (isInvokedDirectly(import.meta.url)) main().catch(() => { console.error('[assisted-application] remote controller failed'); process.exitCode = 1; });
