/** Darwin-only bootstrap. Preparation receives no credential; the existing broker owns auth. */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { probeDarwinSandbox } from './sandbox-probe.mjs';
import { isInvokedDirectly } from '../../../scripts/lib/is-invoked-directly.mjs';
import { parseCodexLogin } from '../../../functions/src/codexFallback.js';

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
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o777) !== 0o700) throw new Error('darwin_broker_directory_not_private');
}
function checkFile(file, digest) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || hash(file) !== digest) throw new Error('darwin_broker_attestation_failed');
}

export async function prepareDarwinBroker({ temporary = fs.realpathSync(process.env.RUNNER_TEMP || os.tmpdir()),
  workspace = process.env.GITHUB_WORKSPACE } = {}) {
  if (process.platform !== 'darwin') throw new Error('darwin_broker_platform_invalid');
    if (process.env.CODEX_AUTH_JSON) throw new Error('darwin_broker_prepare_must_not_receive_auth');
    // Probe the mandatory OS sandbox before either downloading or accepting auth.
    execFileSync('/usr/bin/sandbox-exec', ['-p', '(version 1) (deny default) (allow process*) (allow file-read*)', '/usr/bin/true'],
      { timeout: 10_000, stdio: 'ignore', env: { PATH: '/usr/bin:/bin' } });
    const prefix = fs.mkdtempSync(path.join(temporary, 'codex-luna-max-codex-cli.'));
    fs.chmodSync(prefix, 0o700);
    try {
      if (workspace && !outside(prefix, workspace)) throw new Error('darwin_broker_runtime_inside_workspace');
      const node = path.join(prefix, 'node');
      const originalNode = fs.realpathSync(process.execPath);
      const nodeHash = hash(originalNode);
      fs.copyFileSync(originalNode, node);
      fs.chmodSync(node, 0o700);
      checkFile(node, nodeHash);
      // setup-node supplies npm alongside this runtime. Resolve its JS entry,
      // then run it with the copied Node and an empty, credential-free env.
      const npm = fs.realpathSync(path.resolve(path.dirname(originalNode), '../lib/node_modules/npm/bin/npm-cli.js'));
      const npmHome = path.join(prefix, 'npm-home'); fs.mkdirSync(npmHome, { mode: 0o700 });
      const env = { PATH: `${prefix}:/usr/bin:/bin`, HOME: npmHome, CI: 'true',
        NPM_CONFIG_USERCONFIG: '/dev/null', NPM_CONFIG_GLOBALCONFIG: '/dev/null', npm_config_cache: path.join(prefix, 'npm-cache') };
      execFileSync(node, [npm, 'install', '--prefix', prefix, '--no-save', '--no-package-lock', '--no-fund', '--no-audit', `@openai/codex@${VERSION}`],
        { env, timeout: 180_000, stdio: ['ignore', 'ignore', 'ignore'] });
      const cli = fs.realpathSync(path.join(prefix, 'node_modules/.bin/codex'));
      if (outside(cli, prefix)) throw new Error('darwin_broker_cli_outside_prefix');
      const version = execFileSync(cli, ['--version'], { env: { PATH: env.PATH, CODEX_HOME: npmHome }, encoding: 'utf8', timeout: 10_000 }).trim();
      if (version !== `codex-cli ${VERSION}`) throw new Error('darwin_broker_cli_version_invalid');
      // No model call or credential: verify the pinned CLI really enforces
      // Darwin's sandbox, rather than merely finding sandbox-exec on disk.
      await probeDarwinSandbox({ cli, temporary, env });
      const manifest = path.join(prefix, 'runtime.json');
      fs.writeFileSync(manifest, JSON.stringify({ prefix, node, nodeHash, cli, cliHash: hash(cli), broker, brokerHash: hash(broker) }), { mode: 0o600 });
      return { manifest, manifest_sha256: hash(manifest), node };
    } catch (error) { fs.rmSync(prefix, { recursive: true, force: true }); throw error; }
}

export async function startDarwinBroker({ manifest: manifestPath, manifest_sha256, auth }) {
  checkFile(manifestPath, manifest_sha256);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  privateDirectory(manifest.prefix);
  if (path.dirname(manifestPath) !== manifest.prefix || !path.basename(manifest.prefix).startsWith('codex-luna-max-codex-cli.')) throw new Error('darwin_broker_manifest_invalid');
  checkFile(manifest.node, manifest.nodeHash); checkFile(manifest.cli, manifest.cliHash); checkFile(broker, manifest.brokerHash);
  if (!auth || Buffer.byteLength(auth) > 256 * 1024) throw new Error('darwin_broker_auth_missing');
  const subscription = parseCodexLogin(auth);
  if (!subscription.ok || subscription.expiresAt - Date.now() < 30 * 60_000) throw new Error('darwin_broker_subscription_auth_unavailable');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-luna-max-codex-broker.')); fs.chmodSync(root, 0o700);
  const socket = path.join(root, 'auth.sock');
  const child = spawn(manifest.node, [broker, '--socket', socket, '--ttl-ms', '3600000', '--max-concurrency', '1',
    '--max-timeout-ms', '1800000', '--codex-cli-version', VERSION,
    '--codex-bin', manifest.cli, '--codex-realpath', manifest.cli, '--codex-sha256', manifest.cliHash, '--codex-prefix', manifest.prefix],
  { env: { PATH: `${path.dirname(manifest.node)}:/usr/bin:/bin` }, detached: true, stdio: ['pipe', 'ignore', 'ignore'] });
  child.stdin.on('error', () => {});
  child.stdin.end(auth);
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
    try { execFileSync(manifest.node, [broker, '--cleanup', '--socket', socket], { timeout: 20_000, stdio: 'ignore' }); }
    catch { child.kill('SIGTERM'); }
    finally {
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(manifest.prefix, { recursive: true, force: true });
    }
  } };
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
