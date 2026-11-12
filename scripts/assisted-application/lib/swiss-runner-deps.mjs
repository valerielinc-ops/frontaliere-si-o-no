import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const NPM_CI_ARGS = Object.freeze(['ci', '--ignore-scripts', '--no-audit', '--no-fund']);
export const SWISS_RUNNER_STORAGE_PROBE_MAX_ATTEMPTS = 3;
export const SWISS_RUNNER_STORAGE_PROBE_RETRY_DELAYS_MS = Object.freeze([60_000, 5 * 60_000]);
const REQUIRED_PACKAGES = Object.freeze({
  root: Object.freeze(['@google-cloud/storage', '@pdf-lib/fontkit', 'firebase-admin', 'pdf-lib', 'playwright']),
  functions: Object.freeze(['@google-cloud/storage', '@pdf-lib/fontkit', 'firebase-admin', 'firebase-functions', 'pdf-lib']),
});

export function swissRunnerDependencyHome({ env = process.env, home = os.homedir() } = {}) {
  return path.resolve(env.SWISS_RUNNER_DEPS_DIR || path.join(home, '.local', 'share', 'frontaliere', 'swiss-runner'));
}

export function sha256File(filePath, fsImpl = fs) {
  return createHash('sha256').update(fsImpl.readFileSync(filePath)).digest('hex');
}

export function needsSwissRunnerDependencyInstall({ expectedHash, installedHash, treeExists }) {
  return treeExists !== true || !expectedHash || installedHash !== expectedHash;
}

function existsAsDirectory(filePath, fsImpl) {
  try { return fsImpl.statSync(filePath).isDirectory(); } catch { return false; }
}

function treeMatches({ treeRoot, definition, expectedHash, fsImpl }) {
  if (!existsAsDirectory(treeRoot, fsImpl)) return false;
  try {
    if (sha256File(path.join(treeRoot, 'package-lock.json'), fsImpl) !== expectedHash) return false;
    if (sha256File(path.join(treeRoot, 'package.json'), fsImpl) !== definition.manifestHash) return false;
  } catch {
    return false;
  }
  const modules = path.join(treeRoot, 'node_modules');
  return existsAsDirectory(modules, fsImpl)
    && REQUIRED_PACKAGES[definition.kind].every((name) => existsAsDirectory(path.join(modules, ...name.split('/')), fsImpl));
}

function resolveInstalledTree({ definition, expectedHash, fsImpl }) {
  const keyedTree = path.join(definition.baseDir, `deps-${expectedHash}`);
  if (treeMatches({ treeRoot: keyedTree, definition, expectedHash, fsImpl })) return keyedTree;

  // The first private tree was provisioned directly in root-deps/; recognize it by its exact lock and
  // manifest so the next cycle can adopt it without reinstalling or disturbing the live symlink.
  if (treeMatches({ treeRoot: definition.baseDir, definition, expectedHash, fsImpl })) return definition.baseDir;
  return null;
}

function currentLinkMatches(linkPath, targetPath, fsImpl) {
  try {
    const stat = fsImpl.lstatSync(linkPath);
    if (!stat.isSymbolicLink()) return fsImpl.realpathSync(linkPath) === fsImpl.realpathSync(targetPath);
    const linkTarget = fsImpl.readlinkSync(linkPath);
    return path.resolve(path.dirname(linkPath), linkTarget) === path.resolve(targetPath);
  } catch {
    return false;
  }
}

function modulesPath(treeRoot) {
  return path.join(treeRoot, 'node_modules');
}

function safeFailure(kind) {
  return Object.assign(new Error(`Swiss runner ${kind} dependency install failed`), { code: `deps_install_failed:${kind}` });
}

function acquireInstallLock(stateRoot, fsImpl) {
  const lockPath = path.join(stateRoot, '.deps-install.lock');
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      fsImpl.writeFileSync(lockPath, `${process.pid}\n`, { flag: 'wx', mode: 0o600 });
      return () => { try { fsImpl.rmSync(lockPath, { force: true }); } catch { /* already gone */ } };
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      let pid = 0;
      try { pid = Number(fsImpl.readFileSync(lockPath, 'utf8').trim()); } catch { /* malformed or removed */ }
      let alive = false;
      try { alive = Number.isSafeInteger(pid) && pid > 0 && process.kill(pid, 0); } catch { alive = false; }
      if (alive) throw Object.assign(new Error('Swiss runner dependency install already active'), { code: 'deps_installing' });
      try { fsImpl.rmSync(lockPath, { force: true }); } catch { /* retry below */ }
    }
  }
  throw Object.assign(new Error('Swiss runner dependency install already active'), { code: 'deps_installing' });
}

function runNpmCi({ cwd, npmBin = process.env.SWISS_RUNNER_NPM_BIN || 'npm', spawnImpl = spawn }) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawnImpl(npmBin, NPM_CI_ARGS, { cwd, env: process.env, stdio: 'ignore', windowsHide: true });
    } catch {
      reject(new Error('npm could not start'));
      return;
    }
    child.once('error', () => reject(new Error('npm could not start')));
    child.once('close', (code) => resolve({ code }));
  });
}

function makeDefinition({ kind, repoRoot, stateRoot, fsImpl }) {
  const sourceDir = kind === 'root' ? repoRoot : path.join(repoRoot, 'functions');
  const baseDir = path.join(stateRoot, `${kind}-deps`);
  const lockPath = path.join(sourceDir, 'package-lock.json');
  const manifestPath = path.join(sourceDir, 'package.json');
  if (!fsImpl.existsSync(lockPath) || !fsImpl.existsSync(manifestPath)) throw safeFailure(kind);
  return {
    kind,
    sourceDir,
    baseDir,
    lockPath,
    manifestPath,
    linkPath: path.join(sourceDir, 'node_modules'),
    manifestHash: sha256File(manifestPath, fsImpl),
    expectedHash: sha256File(lockPath, fsImpl),
  };
}

function installStage({ definition, repoRoot, fsImpl }) {
  fsImpl.mkdirSync(definition.baseDir, { recursive: true, mode: 0o700 });
  const stageDir = fsImpl.mkdtempSync(path.join(definition.baseDir, `.install-${definition.expectedHash.slice(0, 12)}-`));
  try {
    fsImpl.copyFileSync(definition.manifestPath, path.join(stageDir, 'package.json'));
    fsImpl.copyFileSync(definition.lockPath, path.join(stageDir, 'package-lock.json'));
    if (definition.kind === 'root') {
      const workspaces = path.join(repoRoot, 'packages');
      if (fsImpl.existsSync(workspaces)) fsImpl.symlinkSync(workspaces, path.join(stageDir, 'packages'), 'dir');
    }
    return stageDir;
  } catch {
    fsImpl.rmSync(stageDir, { recursive: true, force: true });
    throw safeFailure(definition.kind);
  }
}

function planDependencyTree({ definition, fsImpl }) {
  const installedPath = resolveInstalledTree({
    definition,
    expectedHash: definition.expectedHash,
    fsImpl,
  });
  const installedHash = installedPath ? definition.expectedHash : null;
  const installNeeded = needsSwissRunnerDependencyInstall({
    expectedHash: definition.expectedHash,
    installedHash,
    treeExists: Boolean(installedPath),
  });
  const targetPath = path.join(definition.baseDir, `deps-${definition.expectedHash}`);
  return {
    definition,
    installNeeded,
    installedPath,
    targetPath,
    stagePath: null,
    backupPath: null,
    needsLink: !currentLinkMatches(definition.linkPath, modulesPath(installedPath || targetPath), fsImpl),
  };
}

function publishStage(plan, fsImpl) {
  if (!plan.stagePath) return;
  const targetPath = plan.targetPath;
  if (fsImpl.existsSync(targetPath)) {
    plan.backupPath = path.join(plan.definition.baseDir, `.previous-${plan.definition.kind}-${randomUUID()}`);
    fsImpl.renameSync(targetPath, plan.backupPath);
  }
  try {
    fsImpl.renameSync(plan.stagePath, targetPath);
    plan.stagePath = null;
    plan.installedPath = targetPath;
  } catch {
    if (plan.backupPath) {
      try { fsImpl.renameSync(plan.backupPath, targetPath); } catch { /* retained for recovery */ }
      plan.backupPath = null;
    }
    throw safeFailure(plan.definition.kind);
  }
}

function swapDependencySymlink(plan, fsImpl) {
  const { linkPath } = plan.definition;
  const targetPath = modulesPath(plan.installedPath);
  const previousLink = `${linkPath}.swiss-runner-previous`;
  try {
    fsImpl.lstatSync(linkPath);
  } catch (error) {
    if (error?.code === 'ENOENT') {
      try { fsImpl.renameSync(previousLink, linkPath); } catch (restoreError) {
        if (restoreError?.code !== 'ENOENT') throw safeFailure(plan.definition.kind);
      }
    }
  }
  if (currentLinkMatches(linkPath, targetPath, fsImpl)) {
    try { fsImpl.rmSync(previousLink, { recursive: true, force: true }); } catch { /* stale copy is harmless */ }
    return { rollback() {}, finalize() {} };
  }

  fsImpl.mkdirSync(path.dirname(linkPath), { recursive: true });
  const tempLink = `${linkPath}.swiss-runner-${process.pid}-${randomUUID()}`;
  let previousKind = 'missing';
  let previousTarget = null;
  try {
    const current = fsImpl.lstatSync(linkPath);
    if (current.isSymbolicLink()) {
      previousKind = 'symlink';
      previousTarget = fsImpl.readlinkSync(linkPath);
    } else {
      previousKind = 'directory';
      if (fsImpl.existsSync(previousLink)) throw new Error('previous dependency link needs recovery');
      fsImpl.renameSync(linkPath, previousLink);
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') throw safeFailure(plan.definition.kind);
  }

  try {
    fsImpl.symlinkSync(targetPath, tempLink, 'dir');
    fsImpl.renameSync(tempLink, linkPath);
  } catch {
    try { fsImpl.rmSync(tempLink, { force: true }); } catch { /* already gone */ }
    if (previousKind === 'directory' && fsImpl.existsSync(previousLink)) {
      try { fsImpl.renameSync(previousLink, linkPath); } catch { /* retained for recovery */ }
    }
    throw safeFailure(plan.definition.kind);
  }

  return {
    rollback() {
      if (previousKind === 'symlink') {
        const restoreLink = `${linkPath}.swiss-runner-restore-${process.pid}-${randomUUID()}`;
        fsImpl.symlinkSync(previousTarget, restoreLink, 'dir');
        fsImpl.renameSync(restoreLink, linkPath);
      } else if (previousKind === 'directory') {
        fsImpl.rmSync(linkPath, { force: true });
        fsImpl.renameSync(previousLink, linkPath);
      } else {
        fsImpl.rmSync(linkPath, { force: true });
      }
    },
    finalize() {
      if (previousKind === 'directory') fsImpl.rmSync(previousLink, { recursive: true, force: true });
    },
  };
}

function cleanupOldTrees(plans, fsImpl) {
  for (const plan of plans) {
    const { definition } = plan;
    let entries = [];
    try { entries = fsImpl.readdirSync(definition.baseDir, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      const candidate = path.join(definition.baseDir, entry.name);
      if (entry.name.startsWith('deps-') && candidate !== plan.installedPath && entry.isDirectory()) {
        try { fsImpl.rmSync(candidate, { recursive: true, force: true }); } catch { /* clean again next cycle */ }
      } else if (entry.name.startsWith('.previous-') && entry.isDirectory()) {
        try { fsImpl.rmSync(candidate, { recursive: true, force: true }); } catch { /* clean again next cycle */ }
      } else if (entry.name.startsWith('.install-') && entry.isDirectory()) {
        try { fsImpl.rmSync(candidate, { recursive: true, force: true }); } catch { /* clean again next cycle */ }
      }
    }
    if (plan.installedPath !== definition.baseDir) {
      for (const name of ['node_modules', 'package.json', 'package-lock.json']) {
        try { fsImpl.rmSync(path.join(definition.baseDir, name), { recursive: true, force: true }); } catch { /* keep a legacy tree if it cannot be removed */ }
      }
    }
  }
}

/** Provision exact root and Functions trees before changing either live node_modules link. */
export async function ensureSwissRunnerDependencies({
  repoRoot,
  env = process.env,
  home = os.homedir(),
  fsImpl = fs,
  npmBin = env.SWISS_RUNNER_NPM_BIN || 'npm',
  executeNpmCi = null,
  onInstalling = async () => {},
} = {}) {
  const root = path.resolve(repoRoot || process.cwd());
  const stateRoot = swissRunnerDependencyHome({ env, home });
  fsImpl.mkdirSync(stateRoot, { recursive: true, mode: 0o700 });
  let unlock;
  const plans = [];
  const published = [];
  const swapped = [];
  try {
    unlock = acquireInstallLock(stateRoot, fsImpl);
    for (const kind of ['root', 'functions']) {
      const definition = makeDefinition({ kind, repoRoot: root, stateRoot, fsImpl });
      plans.push(planDependencyTree({ definition, fsImpl }));
    }

    const needsWork = plans.some((plan) => plan.installNeeded || plan.needsLink);
    if (needsWork) await onInstalling();

    for (const plan of plans) {
      if (!plan.installNeeded) continue;
      const { definition } = plan;
      plan.stagePath = installStage({ definition, repoRoot: root, fsImpl });
      let result;
      try {
        result = await (executeNpmCi || runNpmCi)({ cwd: plan.stagePath, npmBin, args: NPM_CI_ARGS });
      } catch {
        throw safeFailure(definition.kind);
      }
      const code = Number.isInteger(result?.code) ? result.code : Number.isInteger(result?.status) ? result.status : 1;
      if (code !== 0 || !treeMatches({ treeRoot: plan.stagePath, definition, expectedHash: definition.expectedHash, fsImpl })) {
        throw safeFailure(definition.kind);
      }
    }

    for (const plan of plans) {
      const { definition } = plan;
      if (sha256File(definition.lockPath, fsImpl) !== definition.expectedHash
        || sha256File(definition.manifestPath, fsImpl) !== definition.manifestHash) {
        throw safeFailure(definition.kind);
      }
    }

    for (const plan of plans) {
      publishStage(plan, fsImpl);
      if (plan.backupPath) published.push(plan);
    }
    for (const plan of plans) swapped.push(swapDependencySymlink(plan, fsImpl));
    for (const link of swapped) {
      try { link.finalize(); } catch { /* stale private copies are cleaned on a later cycle */ }
    }
    try { cleanupOldTrees(plans, fsImpl); } catch { /* the live links are already committed */ }

    const [rootPlan, functionsPlan] = plans;
    return {
      rootHash: rootPlan.definition.expectedHash,
      functionsHash: functionsPlan.definition.expectedHash,
      versionKey: `${rootPlan.definition.expectedHash}:${functionsPlan.definition.expectedHash}`,
      rootModules: path.join(rootPlan.installedPath, 'node_modules'),
      functionsModules: path.join(functionsPlan.installedPath, 'node_modules'),
      changed: needsWork,
    };
  } catch (error) {
    for (const link of swapped.reverse()) {
      try { link.rollback(); } catch { /* a later cycle can recover from its private install tree */ }
    }
    for (const plan of published.reverse()) {
      try {
        fsImpl.rmSync(plan.targetPath, { recursive: true, force: true });
        if (plan.backupPath && fsImpl.existsSync(plan.backupPath)) fsImpl.renameSync(plan.backupPath, plan.targetPath);
      } catch { /* never remove the live prior symlink target */ }
    }
    if (error?.code === 'deps_installing') throw error;
    if (/^deps_install_failed:(?:root|functions)$/.test(String(error?.code || ''))) throw error;
    throw Object.assign(new Error('Swiss runner dependency preflight failed'), { code: 'deps_install_failed' });
  } finally {
    for (const plan of plans) {
      if (plan.stagePath) {
        try { fsImpl.rmSync(plan.stagePath, { recursive: true, force: true }); } catch { /* best-effort staging cleanup */ }
      }
    }
    unlock?.();
  }
}

export async function probeSwissRunnerStorageUpload({
  versionKey,
  stateRoot,
  env = process.env,
  fsImpl = fs,
  randomBytesImpl = undefined,
  uuidImpl = randomUUID,
  bucketFactory = null,
  onProbing = async () => {},
  now = Date.now,
} = {}) {
  const markerDir = path.join(stateRoot || swissRunnerDependencyHome({ env }), 'storage-probes');
  const key = createHash('sha256').update(String(versionKey || 'unknown')).digest('hex');
  const marker = path.join(markerDir, `${key}.ok`);
  const retryStatePath = path.join(markerDir, `${key}.retry.json`);
  if (fsImpl.existsSync(marker)) return { eligible: true, cached: true };

  let retryState = { attempts: 0, nextAttemptAt: 0 };
  try {
    const parsed = JSON.parse(fsImpl.readFileSync(retryStatePath, 'utf8'));
    if (Number.isInteger(parsed?.attempts) && parsed.attempts >= 0) {
      retryState = {
        attempts: Math.min(parsed.attempts, SWISS_RUNNER_STORAGE_PROBE_MAX_ATTEMPTS),
        nextAttemptAt: Number.isFinite(parsed.nextAttemptAt) ? parsed.nextAttemptAt : 0,
      };
    }
  } catch { /* first probe or a partial state file; this attempt rewrites it if needed */ }
  if (retryState.attempts >= SWISS_RUNNER_STORAGE_PROBE_MAX_ATTEMPTS
    || retryState.nextAttemptAt > now()) {
    return { eligible: false, reason: 'storage_upload_unavailable' };
  }

  let file = null;
  let uploaded = false;
  try {
    await onProbing();
    let bucket;
    if (bucketFactory) {
      bucket = await bucketFactory();
    } else {
      const [{ getApps, initializeApp, applicationDefault }, { getStorage }, { ASSISTED_APPLICATION_STORAGE_BUCKET }] = await Promise.all([
        import('firebase-admin/app'),
        import('firebase-admin/storage'),
        import('../../functions/src/assistedApplicationCvCheck.js'),
      ]);
      if (getApps().length === 0) initializeApp({ credential: applicationDefault(), projectId: 'frontaliere-ticino' });
      bucket = getStorage().bucket(ASSISTED_APPLICATION_STORAGE_BUCKET);
    }
    const { randomBytes } = await import('node:crypto');
    const bytes = (randomBytesImpl || randomBytes)(8);
    file = bucket.file(`diagnostics/swiss-runner-${uuidImpl()}.bin`);
    await file.save(bytes, { resumable: false, metadata: { contentType: 'application/octet-stream' } });
    uploaded = true;
    await file.delete({ ignoreNotFound: true });
    uploaded = false;
    fsImpl.mkdirSync(markerDir, { recursive: true, mode: 0o700 });
    try { fsImpl.writeFileSync(marker, 'ok\n', { flag: 'wx', mode: 0o600 }); } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
    }
    try { fsImpl.rmSync(retryStatePath, { force: true }); } catch { /* success marker takes precedence */ }
    return { eligible: true, cached: false };
  } catch {
    if (file && (uploaded || file)) {
      try { await file.delete({ ignoreNotFound: true }); } catch { /* retry cleanup once; never keep a probe on purpose */ }
    }
    const attempts = retryState.attempts + 1;
    const exhausted = attempts >= SWISS_RUNNER_STORAGE_PROBE_MAX_ATTEMPTS;
    const nextAttemptAt = exhausted
      ? null
      : now() + SWISS_RUNNER_STORAGE_PROBE_RETRY_DELAYS_MS[attempts - 1];
    try {
      fsImpl.mkdirSync(markerDir, { recursive: true, mode: 0o700 });
      const temporary = `${retryStatePath}.${process.pid}.${uuidImpl()}.tmp`;
      fsImpl.writeFileSync(temporary, `${JSON.stringify({ attempts, nextAttemptAt, exhausted })}\n`, { flag: 'wx', mode: 0o600 });
      fsImpl.renameSync(temporary, retryStatePath);
    } catch { /* unavailable state storage cannot make the runner eligible */ }
    return { eligible: false, reason: 'storage_upload_unavailable' };
  }
}
