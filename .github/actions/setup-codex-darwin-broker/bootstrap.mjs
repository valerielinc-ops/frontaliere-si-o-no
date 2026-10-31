/** Darwin-only bootstrap. Preparation receives no credential; the existing broker owns auth. */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { probeDarwinSandbox } from './sandbox-probe.mjs';
import { probeConciergeTools } from '../setup-claude-haiku-fallback/concierge-tool-probe.mjs';
import { resolvePinnedCodexNative } from '../setup-claude-haiku-fallback/concierge-tools.mjs';
import { isInvokedDirectly } from '../../../scripts/lib/is-invoked-directly.mjs';
import { nativeConciergeAuth } from './native-auth.mjs';

const VERSION = '0.153.4';
const action = path.dirname(fileURLToPath(import.meta.url));
const broker = path.resolve(action, '../setup-claude-haiku-fallback/codex-auth-broker.mjs');
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const outside = (child, parent) => {
  const relative = path.relative(fs.realpathSync(parent), fs.realpathSync(child));
  return relative.startsWith('..') || path.isAbsolute(relative);
};
function output(name, value) {
  if (!process.env.GITHUB_OUTPUT || /[\r\n]/.test(value)) throw new Error('darwin_broker_output_invalid');
  fs.appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
}
function privateDirectory(value) {
  const stat = fs.lstatSync(value);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o777) !== 0o700) throw new Error('darwin_broker_directory_not_private');
}
function checkFile(file, digest) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || hash(file) !== digest) throw new Error('darwin_broker_attestation_failed');
}

export async function prepareDarwinBroker({
  workspace = process.env.GITHUB_WORKSPACE } = {}) {
  if (process.platform !== 'darwin') throw new Error('darwin_broker_platform_invalid');
    if (process.env.CODEX_AUTH_JSON) throw new Error('darwin_broker_prepare_must_not_receive_auth');
    // Probe the mandatory OS sandbox before either downloading or accepting auth.
    execFileSync('/usr/bin/sandbox-exec', ['-p', '(version 1) (deny default) (allow process*) (allow file-read*)', '/usr/bin/true'],
      { timeout: 10_000, stdio: 'ignore', env: { PATH: '/usr/bin:/bin' } });
    // Scratch is explicitly denied to model tools. Runtime/auth/workspaces
    // must therefore live in a private owner cache, while only IPC is short.
    const cache = path.join(os.homedir(), 'Library/Caches/frontaliere-codex');
    fs.mkdirSync(cache, { recursive: true, mode: 0o700 }); privateDirectory(cache);
    const prefix = fs.mkdtempSync(path.join(fs.realpathSync(cache), 'codex-luna-max-codex-cli.'));
    fs.chmodSync(prefix, 0o700);
    let brokerRoot;
    try {
      if (workspace && !outside(prefix, workspace)) throw new Error('darwin_broker_runtime_inside_workspace');
      // The manager's existing Node is already trusted. Copying a Homebrew
      // executable breaks its @rpath/libnode linkage; attest the real runtime.
      const node = fs.realpathSync(process.execPath);
      const nodeHash = hash(node);
      fs.symlinkSync(node, path.join(prefix, 'node'));
      checkFile(node, nodeHash);
      // Homebrew's real Node image is in Cellar, while npm remains under
      // /opt/homebrew/lib. Resolve only the existing fixed installation paths.
      const npmCandidate = [path.resolve(path.dirname(node), '../lib/node_modules/npm/bin/npm-cli.js'),
        '/opt/homebrew/bin/npm', '/usr/local/bin/npm'].find(file => fs.existsSync(file));
      if (!npmCandidate) throw new Error('darwin_broker_existing_npm_missing');
      const npm = fs.realpathSync(npmCandidate);
      if (path.basename(npm) !== 'npm-cli.js' || !fs.statSync(npm).isFile()) throw new Error('darwin_broker_existing_npm_invalid');
      const npmHome = path.join(prefix, 'npm-home'); fs.mkdirSync(npmHome, { mode: 0o700 });
      const userNpmConfig = path.join(npmHome, 'user.npmrc'); const globalNpmConfig = path.join(npmHome, 'global.npmrc');
      fs.writeFileSync(userNpmConfig, '', { mode: 0o600 }); fs.writeFileSync(globalNpmConfig, '', { mode: 0o600 });
      const env = { PATH: `${prefix}:/usr/bin:/bin`, HOME: npmHome, CI: 'true',
        OPENSSL_CONF: '/dev/null',
        NPM_CONFIG_USERCONFIG: userNpmConfig, NPM_CONFIG_GLOBALCONFIG: globalNpmConfig, npm_config_cache: path.join(prefix, 'npm-cache') };
      checkFile(node, nodeHash);
      execFileSync(node, [npm, 'install', '--prefix', prefix, '--no-save', '--no-package-lock', '--no-fund', '--no-audit', `@openai/codex@${VERSION}`],
        { env, timeout: 180_000, stdio: ['ignore', 'ignore', 'ignore'] });
      const cli = resolvePinnedCodexNative(prefix);
      if (outside(cli, prefix)) throw new Error('darwin_broker_cli_outside_prefix');
      checkFile(node, nodeHash);
      const version = execFileSync(cli, ['--version'], { env: { PATH: env.PATH, HOME: npmHome, CODEX_HOME: npmHome, OPENSSL_CONF: '/dev/null' }, encoding: 'utf8', timeout: 10_000 }).trim();
      if (version !== `codex-cli ${VERSION}`) throw new Error('darwin_broker_cli_version_invalid');
      // No model call or credential: verify the pinned CLI really enforces
      // Darwin's sandbox, rather than merely finding sandbox-exec on disk.
      const cliHash = hash(cli);
      await probeDarwinSandbox({ cli, temporary: prefix, env, assertRuntime: () => { checkFile(node, nodeHash); checkFile(cli, cliHash); } });
      await probeConciergeTools({ cli, temporary: prefix, assertRuntime: () => { checkFile(node, nodeHash); checkFile(cli, cliHash); } });
      brokerRoot = fs.mkdtempSync(path.join(fs.realpathSync('/tmp'), 'aa-codex-ipc-')); fs.chmodSync(brokerRoot, 0o700);
      const socket = path.join(brokerRoot, 'auth.sock');
      const manifest = path.join(prefix, 'runtime.json');
      fs.writeFileSync(manifest, JSON.stringify({ prefix, node, nodeHash, cli, cliHash, broker, brokerHash: hash(broker), brokerRoot, socket }), { mode: 0o600 });
      return { manifest, manifest_sha256: hash(manifest), node, node_sha256: nodeHash, socket };
    } catch (error) { if (brokerRoot) fs.rmSync(brokerRoot, { recursive: true, force: true }); fs.rmSync(prefix, { recursive: true, force: true }); throw error; }
}

export async function startDarwinBroker({ manifest: manifestPath, manifest_sha256, auth }) {
  checkFile(manifestPath, manifest_sha256);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  privateDirectory(manifest.prefix);
  if (path.dirname(manifestPath) !== manifest.prefix || !path.basename(manifest.prefix).startsWith('codex-luna-max-codex-cli.')) throw new Error('darwin_broker_manifest_invalid');
  checkFile(manifest.node, manifest.nodeHash); checkFile(manifest.cli, manifest.cliHash); checkFile(broker, manifest.brokerHash);
  const nativeAuth = nativeConciergeAuth(auth);
  const root = manifest.brokerRoot; privateDirectory(root);
  if (path.dirname(root) !== fs.realpathSync('/tmp') || !/^aa-codex-ipc-[A-Za-z0-9]+$/.test(path.basename(root))
    || manifest.socket !== path.join(root, 'auth.sock')) throw new Error('darwin_broker_socket_invalid');
  const socket = manifest.socket;
  checkFile(manifest.node, manifest.nodeHash);
  const child = spawn(manifest.node, [broker, '--socket', socket, '--ttl-ms', '3600000', '--max-concurrency', '1',
    '--concierge-json-only',
    '--max-timeout-ms', '1800000', '--codex-cli-version', VERSION,
    '--codex-bin', manifest.cli, '--codex-realpath', manifest.cli, '--codex-sha256', manifest.cliHash, '--codex-prefix', manifest.prefix],
  { env: { PATH: `${path.dirname(manifest.node)}:/usr/bin:/bin`, HOME: root, OPENSSL_CONF: '/dev/null' }, detached: true, stdio: ['pipe', 'ignore', 'ignore'] });
  child.stdin.on('error', () => {});
  child.stdin.end(nativeAuth);
  let exited = false; child.once('exit', () => { exited = true; });
  child.once('error', () => { exited = true; });
  let ready = false;
  for (let attempt = 0; attempt < 100 && !exited; attempt++) {
    if (fs.existsSync(socket) && fs.lstatSync(socket).isSocket()) { ready = true; break; }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  if (!ready) {
    child.kill('SIGTERM'); fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(manifest.prefix, { recursive: true, force: true });
    throw new Error('darwin_broker_not_ready');
  }
  child.unref(); child.stdin.unref?.();
  return { socket, async cleanup() {
    try { checkFile(manifest.node, manifest.nodeHash); execFileSync(manifest.node, [broker, '--cleanup', '--socket', socket], {
      timeout: 20_000, stdio: 'ignore', env: { PATH: `${path.dirname(manifest.node)}:/usr/bin:/bin`, HOME: root, OPENSSL_CONF: '/dev/null' } }); }
    catch { child.kill('SIGTERM'); }
    finally {
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(manifest.prefix, { recursive: true, force: true });
    }
  } };
}

export function verifyDarwinNode({ manifest: manifestPath, manifest_sha256 }) {
  checkFile(manifestPath, manifest_sha256);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  checkFile(manifest.node, manifest.nodeHash);
  return manifest.node;
}

async function main() {
  if (process.argv[2] === 'prepare') {
    for (const [key, value] of Object.entries(await prepareDarwinBroker())) output(key, value);
  } else if (process.argv[2] === 'start') {
    const auth = process.env.CODEX_AUTH_JSON; delete process.env.CODEX_AUTH_JSON;
    const result = await startDarwinBroker({ manifest: process.env.CODEX_DARWIN_MANIFEST,
      manifest_sha256: process.env.CODEX_DARWIN_MANIFEST_SHA256, auth });
    output('socket', result.socket);
  } else throw new Error('darwin_broker_command_invalid');
}
if (isInvokedDirectly(import.meta.url)) main().catch(error => { console.error(String(error.message).replace(/[^a-z_]/gi, '_').slice(0, 100)); process.exitCode = 1; });
