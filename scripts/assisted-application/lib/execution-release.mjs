/** Immutable source/dependency releases built from the existing clone, never its working tree. */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile, execFileSync, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { pipeline } from 'node:stream/promises';
import { withSingleFlightLockAsync } from '../../lib/single-flight-lock.mjs';

const execute = promisify(execFile);
const sha256 = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const SOURCE_PATHS = ['scripts', 'functions', '.github', 'package.json', 'package-lock.json'];
function git(repository, args) {
  return execFileSync('git', ['-C', repository, ...args], { encoding: 'utf8', timeout: 30_000, maxBuffer: 8 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'ignore'] });
}
function filesBelow(root, allowedLinks = new Set()) {
  return fs.readdirSync(root, { withFileTypes: true }).flatMap(entry => {
    const target = path.join(root, entry.name);
    if (entry.isSymbolicLink()) {
      if (allowedLinks.has(target)) return [];
      throw new Error('execution_release_source_symlink');
    }
    return entry.isDirectory() ? filesBelow(target, allowedLinks) : [target];
  });
}
function protect(root) {
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const target = path.join(root, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) protect(target);
    else fs.chmodSync(target, fs.statSync(target).mode & 0o111 ? 0o500 : 0o400);
  }
  fs.chmodSync(root, 0o500);
}
export function removePrivateTree(root) {
  if (!fs.existsSync(root)) return;
  const makeWritable = directory => {
    fs.chmodSync(directory, 0o700);
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) if (entry.isDirectory() && !entry.isSymbolicLink()) makeWritable(path.join(directory, entry.name));
  };
  makeWritable(root); fs.rmSync(root, { recursive: true, force: true });
}

export function verifyExecutionRelease(root, expectedManifestSha) {
  const manifestPath = path.join(root, 'execution-release.json');
  if (sha256(manifestPath) !== expectedManifestSha) throw new Error('execution_release_manifest_changed');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (Object.keys(manifest.dependencies).sort().join(',') !== 'functions/node_modules,node_modules') throw new Error('execution_release_dependency_shape');
  const actual = filesBelow(root, new Set(Object.keys(manifest.dependencies).map(relative => path.join(root, relative))))
    .map(file => path.relative(root, file)).filter(relative => relative !== 'execution-release.json').sort();
  if (actual.join('\n') !== Object.keys(manifest.files).sort().join('\n')) throw new Error('execution_release_untracked_source');
  for (const [relative, digest] of Object.entries(manifest.files)) {
    const file = path.resolve(root, relative);
    if (!file.startsWith(`${root}${path.sep}`) || fs.lstatSync(file).isSymbolicLink() || sha256(file) !== digest) throw new Error('execution_release_source_changed');
  }
  for (const [relative, expected] of Object.entries(manifest.dependencies)) {
    if (fs.realpathSync(path.join(root, relative)) !== expected) throw new Error('execution_release_dependencies_changed');
  }
  const installed = JSON.parse(fs.readFileSync(path.join(manifest.dependencyRoot, 'installed.json'), 'utf8'));
  if (installed.lockVersion !== manifest.lockVersion) throw new Error('execution_release_lock_changed');
  return manifest;
}

export async function compileExecutionRelease({ repository, stateDirectory, sourceSha, node = process.execPath }) {
  if (!/^[a-f0-9]{40}$/.test(sourceSha || '')) throw new Error('execution_release_sha_invalid');
  const origin = git(repository, ['remote', 'get-url', 'origin']).trim();
  let trustedOrigin = /^git@github\.com:valerielinc-ops\/frontaliere-si-o-no(?:\.git)?$/.test(origin);
  if (!trustedOrigin) {
    try {
      const url = new URL(origin);
      trustedOrigin = url.protocol === 'https:' && url.hostname === 'github.com' && !url.username && !url.password && !url.search && !url.hash
        && /^\/valerielinc-ops\/frontaliere-si-o-no(?:\.git)?$/.test(url.pathname);
    } catch { /* Only the existing authorised repository is a source. */ }
  }
  if (!trustedOrigin) throw new Error('execution_source_repository_invalid');
  // The existing clone supplies all objects. No second clone or generated
  // public/data/content tree is created, and the dirty checkout is never read.
  const common = path.resolve(repository, git(repository, ['rev-parse', '--git-common-dir']).trim());
  const fetched = await withSingleFlightLockAsync(path.join(common, 'info', 'assisted-executor-fetch.lock'), () =>
    execute('git', ['-C', repository, 'fetch', '--quiet', 'origin', 'main'], { timeout: 60_000, maxBuffer: 1024 }));
  if (!fetched.acquired) throw new Error('execution_source_fetch_busy');
  git(repository, ['merge-base', '--is-ancestor', sourceSha, 'origin/main']);
  const releases = path.join(stateDirectory, 'releases'); fs.mkdirSync(releases, { recursive: true, mode: 0o700 });
  const root = path.join(releases, sourceSha);
  if (fs.existsSync(root)) {
    const manifestSha = sha256(path.join(root, 'execution-release.json'));
    const manifest = verifyExecutionRelease(root, manifestSha);
    const rows = git(repository, ['ls-tree', '-r', '-z', sourceSha, '--', ...SOURCE_PATHS, 'packages']).split('\0').filter(Boolean);
    const expected = rows.map(row => /^(\d+) blob ([a-f0-9]{40})\t(.+)$/.exec(row))
      .filter(match => match && (SOURCE_PATHS.some(prefix => match[3] === prefix || match[3].startsWith(`${prefix}/`)) || /^packages\/[^/]+\/package\.json$/.test(match[3])));
    for (const match of expected) {
      const file = path.join(root, match[3]); const data = fs.readFileSync(file);
      const blob = crypto.createHash('sha1').update(`blob ${data.length}\0`).update(data).digest('hex');
      if (blob !== match[2]) throw new Error('execution_release_not_git_source');
    }
    const expectedLockVersion = crypto.createHash('sha256').update(manifest.files['package-lock.json']).update(manifest.files['functions/package-lock.json'])
      .update(JSON.stringify(Object.keys(manifest.files).filter(file => /^packages\/[^/]+\/package\.json$/.test(file)).sort().map(file => manifest.files[file]))).digest('hex');
    if (expected.length !== Object.keys(manifest.files).length || manifest.sourceSha !== sourceSha || expectedLockVersion !== manifest.lockVersion
      || manifest.dependencyRoot !== path.join(stateDirectory, 'dependencies', manifest.lockVersion)) throw new Error('execution_release_cached_identity');
    return { root, manifestSha, manifest };
  }
  const staging = fs.mkdtempSync(path.join(releases, 'prepare-')); fs.chmodSync(staging, 0o700);
  try {
    const workspaces = git(repository, ['ls-tree', '-r', '--name-only', sourceSha, '--', 'packages']).split('\n')
      .filter(name => /^packages\/[^/]+\/package\.json$/.test(name)).sort();
    const archive = spawn('git', ['-C', repository, 'archive', '--format=tar', sourceSha, '--', ...SOURCE_PATHS, ...workspaces], { stdio: ['ignore', 'pipe', 'ignore'] });
    const unpack = spawn('/usr/bin/tar', ['-xf', '-', '-C', staging], { stdio: ['pipe', 'ignore', 'ignore'] });
    const exited = child => new Promise((resolve, reject) => {
      const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('execution_release_archive_timeout')); }, 90_000);
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('exit', code => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error('execution_release_archive_failed')); });
    });
    await Promise.all([exited(archive), exited(unpack), pipeline(archive.stdout, unpack.stdin)]);
    const sourceFiles = filesBelow(staging);
    const files = Object.fromEntries(sourceFiles.map(file => [path.relative(staging, file), sha256(file)]));
    const lockVersion = crypto.createHash('sha256').update(files['package-lock.json']).update(files['functions/package-lock.json'])
      .update(JSON.stringify(workspaces.map(file => files[file]))).digest('hex');
    const dependencyRoot = path.join(stateDirectory, 'dependencies', lockVersion);
    if (!fs.existsSync(path.join(dependencyRoot, 'installed.json'))) {
      fs.mkdirSync(dependencyRoot, { recursive: true, mode: 0o700 });
      for (const relative of ['package.json', 'package-lock.json', 'functions/package.json', 'functions/package-lock.json', ...workspaces]) {
        const destination = path.join(dependencyRoot, relative); fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
        fs.copyFileSync(path.join(staging, relative), destination);
      }
      const npm = fs.realpathSync(path.resolve(path.dirname(fs.realpathSync(node)), '../lib/node_modules/npm/bin/npm-cli.js'));
      const npmHome = path.join(dependencyRoot, 'npm-home'); fs.mkdirSync(npmHome, { recursive: true, mode: 0o700 });
      const env = { PATH: `${path.dirname(node)}:/usr/bin:/bin`, HOME: npmHome, CI: 'true', NPM_CONFIG_USERCONFIG: '/dev/null', NPM_CONFIG_GLOBALCONFIG: '/dev/null' };
      for (const cwd of [dependencyRoot, path.join(dependencyRoot, 'functions')]) await execute(node,
        [npm, 'ci', '--ignore-scripts', '--no-fund', '--no-audit'], { cwd, env, timeout: 300_000, maxBuffer: 1024 * 1024 });
      fs.writeFileSync(path.join(dependencyRoot, 'installed.json'), JSON.stringify({ lockVersion }), { mode: 0o400 });
      protect(dependencyRoot);
    }
    const dependencies = {};
    for (const relative of ['node_modules', 'functions/node_modules']) {
      const target = path.join(dependencyRoot, relative); fs.symlinkSync(target, path.join(staging, relative));
      dependencies[relative] = fs.realpathSync(target);
    }
    const manifest = { sourceSha, files, dependencies, dependencyRoot, lockVersion };
    fs.writeFileSync(path.join(staging, 'execution-release.json'), JSON.stringify(manifest), { mode: 0o400 });
    const manifestSha = sha256(path.join(staging, 'execution-release.json'));
    protect(staging); fs.renameSync(staging, root);
    verifyExecutionRelease(root, manifestSha);
    return { root, manifestSha, manifest };
  } catch (error) { removePrivateTree(staging); throw error; }
}
