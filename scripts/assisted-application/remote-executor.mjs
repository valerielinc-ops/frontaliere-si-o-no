#!/usr/bin/env node
/** Single-slot outbound Mac consumer. The hosted workflow still owns the order's concurrency slot. */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { parseArgs } from 'node:util';
import { createRequire } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { execFile, execFileSync, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { getFirestoreDb } from '../lib/firestore-admin.mjs';
import { acquireSingleFlightLockHandle } from '../lib/single-flight-lock.mjs';
import { compileExecutionRelease, removePrivateTree, verifyExecutionRelease } from './lib/execution-release.mjs';
import { createDarwinIsolation } from './lib/darwin-isolation.mjs';
import { prepareDarwinBroker, verifyDarwinNode } from '../../.github/actions/setup-codex-darwin-broker/bootstrap.mjs';
import { REMOTE_EXECUTOR, REMOTE_EXECUTOR_FLAG, executionLease } from '../../functions/src/assistedApplicationExecution.js';
import { parseCodexLogin } from '../../functions/src/codexFallback.js';
import { isInvokedDirectly } from '../lib/is-invoked-directly.mjs';
import { processGroupAlive, waitForDetachedChild, reapRegisteredProcessGroups } from './lib/execution-process.mjs';
import { startBrowserEgress } from './lib/browser-egress.mjs';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { createProcessRegistry, cleanupStaleProcessRegistry } from './lib/process-registry.mjs';

const execute = promisify(execFile);
const PAUSE_MS = 20_000;
const BATCH = 25;
const JOB_TIMEOUT_MS = 105 * 60_000;
const ownRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const plainEnvironment = home => ({ PATH: `${path.dirname(process.execPath)}:${path.join(os.homedir(), '.local/bin')}:/usr/bin:/bin`, HOME: home,
  LANG: process.env.LANG || 'en_US.UTF-8', OPENSSL_CONF: '/dev/null' });

async function freeProviderReady() {
  const response = await fetch('https://api.nopecha.com/v1/status', { signal: AbortSignal.timeout(10_000), redirect: 'error' });
  const quota = response.ok ? await response.json() : null;
  if (!response.ok || quota?.status !== 'Active' || !(Number(quota?.credit) > 0)) throw new Error('remote_free_provider_unavailable');
}

async function preflightRelease(release, temporary) {
  // Import only, exactly like the hosted entry-point check: no order argument,
  // Admin credentials, model auth or candidate material is supplied.
  await execute(process.execPath, ['--input-type=module', '-e', "await import('./scripts/assisted-application/agent.mjs')"],
    { cwd: release.root, env: { ...plainEnvironment(temporary), TMPDIR: temporary }, timeout: 30_000, maxBuffer: 32 * 1024 });
}

async function reserveFixturePort() {
  const server = createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port;
}

async function browserAndExtension(release, jobRoot) {
  const require = createRequire(path.join(release.root, 'package.json'));
  const chromium = require('playwright').chromium;
  if (!fs.existsSync(chromium.executablePath())) await execute(process.execPath,
    [path.join(path.dirname(require.resolve('playwright/package.json')), 'cli.js'), 'install', 'chromium'],
    { env: plainEnvironment(os.homedir()), timeout: 180_000, maxBuffer: 1024 * 1024 });
  await execute('/bin/bash', [path.join(release.root, 'scripts/assisted-application/install-nopecha.sh'), path.join(jobRoot, 'nopecha')],
    { env: plainEnvironment(os.homedir()), timeout: 120_000, maxBuffer: 1024 * 1024 });
  return chromium.executablePath();
}

async function readiness({ release, stateDirectory, credentialsPath }) {
  // This is before getFirestoreDb or Remote Config: no candidate or credential
  // enters either the sandbox smoke tests or the extension's local fixture.
  // An exhausted/free-ineligible IP must not repeatedly install the runtime.
  await freeProviderReady();
  const broker = await prepareDarwinBroker({ temporary: stateDirectory, workspace: release.root });
  const jobRoot = fs.mkdtempSync(path.join(stateDirectory, 'readiness-')); fs.chmodSync(jobRoot, 0o700);
  let egress; let registry;
  try {
    await preflightRelease(release, jobRoot);
    const chromiumPath = await browserAndExtension(release, jobRoot);
    const fixturePort = await reserveFixturePort(); egress = await startBrowserEgress({ fixturePort });
    registry = await createProcessRegistry({ jobRoot, browserBundle: /^(.*\.app)(?:\/|$)/.exec(chromiumPath)?.[1], authorizeBrowser: async () => true });
    const isolation = await createDarwinIsolation({ jobRoot, releaseRoot: release.root,
      dependencyRoot: release.manifest.dependencyRoot, credentialsPath, brokerSocket: broker.socket, chromiumPath, proxyPort: egress.port,
      node: broker.node, nodeSha256: broker.node_sha256, registrySocket: registry.socket, registryNonce: registry.nonce });
    const env = { ...plainEnvironment(isolation.home), TMPDIR: isolation.documents,
        NOPECHA_EXTENSION_PATH: path.join(jobRoot, 'nopecha/extension'),
        ASSISTED_APPLICATION_EXECUTOR: REMOTE_EXECUTOR,
        ASSISTED_APPLICATION_BROWSER_WRAPPER: isolation.browserLauncher,
        ASSISTED_APPLICATION_BROWSER_PROFILE: isolation.browserProfile,
        ASSISTED_APPLICATION_BROWSER_HOME: isolation.browserHome,
        ASSISTED_APPLICATION_BROWSER_TEMP: isolation.browserRoot,
        ASSISTED_APPLICATION_BROWSER_PROXY: egress.server, ASSISTED_APPLICATION_FIXTURE_PORT: String(fixturePort),
        ASSISTED_APPLICATION_PROCESS_REGISTRY_SOCKET: registry.socket, ASSISTED_APPLICATION_PROCESS_REGISTRY_NONCE: registry.nonce };
    const child = spawn(verifyDarwinNode(broker), [
      path.join(release.root, 'scripts/assisted-application/nopecha-e2e.mjs')], { cwd: release.root, env, detached: true, stdio: 'ignore' });
    try { registry.bindAgentGroup(child.pid); } catch { await waitForDetachedChild(child, 1); throw new Error('remote_readiness_agent_group_failed'); }
    await waitForDetachedChild(child, 60_000);
  } finally {
    try { await registry?.close(); await reapRegisteredProcessGroups(path.join(jobRoot, 'process-groups')); removePrivateTree(jobRoot); }
    finally { await egress?.close(); removePrivateTree(path.dirname(broker.socket)); removePrivateTree(path.dirname(broker.manifest)); }
  }
}

async function runRequest({ db, repository, stateDirectory, credentialsPath, orderId, execution }) {
  const jobRoot = fs.mkdtempSync(path.join(stateDirectory, 'job-')); fs.chmodSync(jobRoot, 0o700);
  let broker; let prepared; let egress; let registry; let unreaped = false;
  fs.writeFileSync(path.join(jobRoot, 'process.json'), JSON.stringify({ state: 'preparing', pid: process.pid }), { mode: 0o600 });
  try {
    await freeProviderReady();
    const release = await compileExecutionRelease({ repository, stateDirectory, sourceSha: execution.sourceSha });
    await preflightRelease(release, jobRoot);
    const { currentPortalCodeVersion } = await import(pathToFileURL(path.join(release.root, 'scripts/assisted-application/lib/portal-code-version.mjs')).href);
    const expectedEngine = currentPortalCodeVersion(release.root);
    const native = await import(pathToFileURL(path.join(release.root, '.github/actions/setup-codex-darwin-broker/bootstrap.mjs')).href);
    prepared = await native.prepareDarwinBroker({ temporary: stateDirectory, workspace: release.root });
    const chromiumPath = await browserAndExtension(release, jobRoot);
    egress = await startBrowserEgress();
    registry = await createProcessRegistry({ jobRoot, browserBundle: /^(.*\.app)(?:\/|$)/.exec(chromiumPath)?.[1], authorizeBrowser: async () => {
      const current = (await db.collection('assisted_applications').doc(orderId).collection('automation').doc('execution').get()).data();
      const matches = current?.id === execution.id && current.sourceSha === execution.sourceSha && current.round === execution.round
        && current.dispatchAt === execution.dispatchAt && current.state === 'running'
        && current.materialVersion === execution.materialVersion && current.engineVersion === expectedEngine
        && current.generation === Number(execution.generation || 0) + 1 && current.lease?.generation === current.generation
        && current.lease?.owner === execution.controller.runId && current.lease.expiresAt > Date.now()
        && current.controller?.runId === execution.controller.runId && current.controller.expiresAt > Date.now();
      if (!matches) return false;
      await executionLease({ db, orderId, executionId: current.id, sourceSha: current.sourceSha, engineVersion: expectedEngine,
        owner: current.lease.owner, token: current.lease.token }).assert();
      return true;
    } });
    const isolation = await createDarwinIsolation({ jobRoot, releaseRoot: release.root, dependencyRoot: release.manifest.dependencyRoot,
      credentialsPath, brokerSocket: prepared.socket, chromiumPath, proxyPort: egress.port,
      node: prepared.node, nodeSha256: prepared.node_sha256, registrySocket: registry.socket, registryNonce: registry.nonce });
    const { getRemoteConfig } = await import('firebase-admin/remote-config');
    const template = await getRemoteConfig().getTemplate();
    const key = name => template.parameters?.[name]?.defaultValue?.value || '';
    broker = await native.startDarwinBroker({ ...prepared, auth: key('CODEX_AUTH_JSON') });
    verifyExecutionRelease(release.root, release.manifestSha);
    const env = { ...plainEnvironment(isolation.home), TMPDIR: isolation.documents,
      GOOGLE_APPLICATION_CREDENTIALS: credentialsPath, ASSISTED_APPLICATION_RUN_KEY: key('ASSISTED_APPLICATION_RUN_KEY'),
      CODEX_AUTH_BROKER_SOCKET: broker.socket, CODEX_BROKER_MAX_TIMEOUT_MS: '1800000',
      GITHUB_RUN_ID: execution.controller.runId, ASSISTED_APPLICATION_EXECUTOR: REMOTE_EXECUTOR,
      ASSISTED_APPLICATION_EXECUTION_ID: execution.id, ASSISTED_APPLICATION_SOURCE_SHA: execution.sourceSha,
      ASSISTED_APPLICATION_DISPATCH_AT: String(execution.dispatchAt),
      ASSISTED_APPLICATION_RELEASE_ROOT: release.root, ASSISTED_APPLICATION_RELEASE_MANIFEST_SHA256: release.manifestSha,
      ASSISTED_APPLICATION_BROWSER_WRAPPER: isolation.browserLauncher, ASSISTED_APPLICATION_BROWSER_PROFILE: isolation.browserProfile,
      ASSISTED_APPLICATION_BROWSER_HOME: isolation.browserHome, ASSISTED_APPLICATION_BROWSER_TEMP: isolation.browserRoot,
      ASSISTED_APPLICATION_BROWSER_PROXY: egress.server,
      ASSISTED_APPLICATION_PROCESS_REGISTRY_SOCKET: registry.socket, ASSISTED_APPLICATION_PROCESS_REGISTRY_NONCE: registry.nonce,
      ASSISTED_APPLICATION_STOP_REPORT: path.join(isolation.documents, 'portal-stop.json'),
      ASSISTED_APPLICATION_PORTAL_PASS: path.join(isolation.documents, 'portal-pass.json'),
      NOPECHA_EXTENSION_PATH: path.join(jobRoot, 'nopecha/extension'), ASSISTED_APPLICATION_HEADED: '1' };
    env.ASSISTED_APPLICATION_JOB_ROOT = jobRoot;
    const node = native.verifyDarwinNode(prepared);
    const child = spawn(node, [
      path.join(release.root, 'scripts/assisted-application/supervised-agent.mjs'), '--order', orderId, '--mode', 'submit', '--round', String(execution.round)],
    { cwd: release.root, env, detached: true, stdio: ['ignore', 'ignore', 'ignore'] });
    if (child.pid) {
      try { registry.bindAgentGroup(child.pid); fs.writeFileSync(path.join(jobRoot, 'process.json'), JSON.stringify({ state: 'running', pid: child.pid, pgid: child.pid, started: '' }), { mode: 0o600 }); }
      catch { await waitForDetachedChild(child, 1); throw new Error('remote_executor_job_marker_failed'); }
    }
    await waitForDetachedChild(child, JOB_TIMEOUT_MS);
  } catch (error) {
    unreaped = error?.processGroupUnreaped === true;
    const code = /^(execution|darwin|remote)_[a-z_]{1,80}$/.test(error?.message || '') ? error.message : 'remote_runtime_unavailable';
    // Candidate-free signal to the still-authoritative hosted controller.
    // Only that controller may return a pre-click delivery to the normal clock.
    const ref = db.collection('assisted_applications').doc(orderId).collection('automation').doc('execution');
    await db.runTransaction(async transaction => {
      const current = (await transaction.get(ref)).data();
      if (current?.id === execution.id && current.state !== 'finished') transaction.set(ref,
        { runtimeUnavailableAt: Date.now(), runtimeStatus: 'unavailable',
          runtimeCode: code }, { merge: true });
    });
    if (unreaped) throw error;
    return { code };
  } finally {
    try { await registry?.close(); await reapRegisteredProcessGroups(path.join(jobRoot, 'process-groups')); }
    catch (error) { unreaped = true; throw error; }
    finally {
      try { await egress?.close(); await broker?.cleanup(); } finally {
        if (!broker && prepared) { removePrivateTree(path.dirname(prepared.socket)); removePrivateTree(path.dirname(prepared.manifest)); }
        if (!unreaped) removePrivateTree(jobRoot);
      }
    }
  }
}

export async function nextRemoteBatch({ db, cursor = null }) {
  let query = db.collection('assisted_applications').where('automationState', '==', 'submitting').orderBy('__name__').limit(BATCH);
  if (cursor) query = query.startAfter(cursor);
  const page = await query.get();
  return { docs: page.docs, cursor: page.docs.length === BATCH ? page.docs.at(-1) : null };
}

async function main() {
  const { values } = parseArgs({ options: { repository: { type: 'string' }, state: { type: 'string' },
    credentials: { type: 'string' }, manifest: { type: 'string' } } });
  if (process.platform !== 'darwin' || !values.repository || !values.state || !values.credentials || !values.manifest) throw new Error('remote_executor_arguments');
  const stateDirectory = fs.realpathSync(values.state); const credentialsPath = fs.realpathSync(values.credentials);
  if ((fs.statSync(stateDirectory).mode & 0o077) !== 0 || (fs.statSync(credentialsPath).mode & 0o077) !== 0) throw new Error('remote_executor_private_paths_required');
  const releaseManifest = verifyExecutionRelease(ownRoot, values.manifest);
  const lock = acquireSingleFlightLockHandle(path.join(stateDirectory, 'worker.lock'), { stalePolicy: 'owner-dead-only' });
  if (!lock) return;
  let heartbeat; let db;
  try {
    // Crash leftovers contain only this executor's jobs; never inspect or
    // remove an arbitrary temporary directory or another agent's files.
    for (const name of fs.readdirSync(stateDirectory)) if (/^(job|readiness)-[A-Za-z0-9]+$/.test(name)) {
      const root = path.join(stateDirectory, name); const marker = path.join(root, 'process.json');
      if (fs.existsSync(marker)) {
        const owner = JSON.parse(fs.readFileSync(marker, 'utf8'));
        if (owner.state === 'running') {
          let started = '';
          try { started = execFileSync('/bin/ps', ['-p', String(owner.pid), '-o', 'lstart='], { encoding: 'utf8', timeout: 2000 }).trim(); } catch { /* no process */ }
          if (processGroupAlive(owner.pgid || owner.pid) || (started && (!owner.started || started === owner.started))) throw new Error('remote_executor_child_still_active');
        }
      }
      await reapRegisteredProcessGroups(path.join(root, 'process-groups'));
      cleanupStaleProcessRegistry(root);
      removePrivateTree(root);
    }
    await readiness({ release: { root: ownRoot, manifest: releaseManifest }, stateDirectory, credentialsPath });
    process.env.GOOGLE_APPLICATION_CREDENTIALS = credentialsPath;
    db = await getFirestoreDb();
    const { getRemoteConfig } = await import('firebase-admin/remote-config');
    const registry = db.collection('assisted_application_executors').doc(REMOTE_EXECUTOR);
    let enabled = false; let renewing = false; let wroteDisabled = false; let providerBlockedUntil = 0;
    heartbeat = setInterval(async () => {
      if (renewing || !enabled) return;
      renewing = true;
      try { await registry.set({ ready: enabled, heartbeatAt: Date.now(), sourceSha: releaseManifest.sourceSha, slots: 1, protocol: 1 }, { merge: true }); }
      catch { /* A stale registry fails closed in the dispatcher. */ }
      finally { renewing = false; }
    }, PAUSE_MS);
    heartbeat.unref();
    let cursor = null;
    for (;;) {
      const template = await getRemoteConfig().getTemplate();
      const value = key => template.parameters?.[key]?.defaultValue?.value || '';
      const subscription = parseCodexLogin(value('CODEX_AUTH_JSON'));
      const credentialsReady = subscription.ok && subscription.expiresAt - Date.now() >= 30 * 60_000
        && Buffer.from(value('ASSISTED_APPLICATION_RUN_KEY'), 'base64').length === 32;
      enabled = value(REMOTE_EXECUTOR_FLAG) === REMOTE_EXECUTOR && credentialsReady && providerBlockedUntil <= Date.now();
      if (enabled || !wroteDisabled) await registry.set({ ready: enabled, heartbeatAt: Date.now(), sourceSha: releaseManifest.sourceSha, slots: 1, protocol: 1 }, { merge: true });
      wroteDisabled = !enabled;
      if (!enabled) { await wait(60_000); continue; }
      const batch = await nextRemoteBatch({ db, cursor }); cursor = batch.cursor;
      for (const doc of batch.docs) {
        const execution = (await doc.ref.collection('automation').doc('execution').get()).data();
        const claimable = execution?.state === 'ready' || (execution?.state === 'running' && execution.lease?.expiresAt <= Date.now());
        if (execution?.executor !== REMOTE_EXECUTOR || execution.protocol !== 1 || !claimable || execution.runtimeUnavailableAt
          || execution.controller?.expiresAt <= Date.now()) continue;
        const result = await runRequest({ db, repository: values.repository, stateDirectory, credentialsPath, orderId: doc.id, execution });
        cursor = doc;
        if (result?.code === 'remote_free_provider_unavailable') {
          enabled = false; providerBlockedUntil = Date.now() + 10 * 60_000;
          await registry.set({ ready: false, heartbeatAt: Date.now() }, { merge: true });
          break;
        }
        // Reload the operational switch after every job, not after an entire
        // potentially long batch. The next sweep continues after this order.
        break;
      }
      if (!cursor) await wait(PAUSE_MS);
    }
  } finally { clearInterval(heartbeat); await db?.terminate?.(); lock(); }
}
if (isInvokedDirectly(import.meta.url)) main().catch(() => { console.error('[assisted-application] remote executor not ready'); process.exitCode = 1; });
