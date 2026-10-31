/** Trusted manager/agent homes; the browser alone receives the strict OS profile. */
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import http from 'node:http';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import net from 'node:net';
import { probeProcessEnvironmentPrivacy } from '../../../.github/actions/setup-codex-darwin-broker/process-privacy-probe.mjs';

const execute = promisify(execFile);
const physical = value => fs.existsSync(value) ? fs.realpathSync(value) : path.join(fs.realpathSync(path.dirname(value)), path.basename(value));
const quote = value => JSON.stringify(physical(value));
const SYSTEM_READS = ['/System', '/usr/bin', '/usr/lib', '/usr/libexec', '/usr/share', '/usr/sbin', '/bin', '/sbin',
  '/Library', '/dev', '/private/var/db', '/private/etc', '/Applications'].filter(value => fs.existsSync(value));
const base = () => `(version 1)\n(deny default)\n(allow process*)\n(allow syscall*)\n(allow sysctl-read)\n(allow mach-bootstrap)\n(allow mach-lookup)\n(allow file-read-metadata file-test-existence)\n(allow file-read* (literal "/"))\n(allow file-write* (literal "/dev/null"))\n${SYSTEM_READS.map(value => `(allow file-read* file-map-executable (subpath ${quote(value)}))`).join('\n')}\n`;

export function privateBrowserEnvironment({ home, temporary, env = process.env }) {
  return { PATH: '/usr/bin:/bin', HOME: home, TMPDIR: temporary, OPENSSL_CONF: '/dev/null',
    ...Object.fromEntries(['LANG', 'LC_ALL', 'TZ', 'DISPLAY', 'XAUTHORITY'].filter(key => env[key]).map(key => [key, env[key]])) };
}

export async function createDarwinIsolation({ jobRoot, releaseRoot, dependencyRoot, credentialsPath, brokerSocket,
  chromiumPath, proxyPort, registrySocket, registryNonce, node = process.execPath, nodeSha256 = null }) {
  if (process.platform !== 'darwin') throw new Error('execution_isolation_platform');
  if (!Number.isInteger(proxyPort) || proxyPort < 1 || proxyPort > 65535) throw new Error('execution_isolation_proxy_missing');
  if (!registrySocket || !/^[a-f0-9-]{36}$/.test(registryNonce || '')) throw new Error('execution_isolation_registry_missing');
  for (const relative of ['home', 'documents', 'browser', 'browser/home', 'browser/profile']) fs.mkdirSync(path.join(jobRoot, relative), { recursive: true, mode: 0o700 });
  const documents = path.join(jobRoot, 'documents'); const browserRoot = path.join(jobRoot, 'browser');
  const nodeHash = createHash('sha256').update(fs.readFileSync(node)).digest('hex');
  if (nodeSha256 && nodeSha256 !== nodeHash) throw new Error('execution_isolation_node_changed');
  const browserBundle = /^(.*\.app)(?:\/|$)/.exec(chromiumPath)?.[1] || path.dirname(chromiumPath);
  const browserReads = [...SYSTEM_READS, browserBundle, path.join(jobRoot, 'nopecha'), documents, browserRoot].map(physical);
  for (const secret of [credentialsPath, path.dirname(brokerSocket), path.dirname(registrySocket)]) {
    const candidate = physical(secret);
    if (browserReads.some(root => candidate === root || candidate.startsWith(`${root}${path.sep}`))) throw new Error('execution_isolation_secret_in_browser_tree');
  }
  const browserProfile = `${base()}\n(allow network-outbound (remote tcp "localhost:${proxyPort}"))\n(allow file-map-executable (subpath ${quote(browserBundle)}))\n(allow file-read* (subpath ${quote(browserBundle)}) (subpath ${quote(path.join(jobRoot, 'nopecha'))}) (subpath ${quote(documents)}))
(allow file-read* file-write* (subpath ${quote(browserRoot)}))\n`;
  const browserProfilePath = path.join(jobRoot, 'browser.sb');
  fs.writeFileSync(browserProfilePath, browserProfile, { mode: 0o600 });
  // The browser must read a positive control and reject this file before
  // credentials are loaded. The deterministic agent is inside the manager TCB.
  const canaryRoot = fs.mkdtempSync(path.join(fs.realpathSync('/tmp'), 'aa-canary-')); fs.chmodSync(canaryRoot, 0o700);
  const canary = path.join(canaryRoot, 'private.txt'); fs.writeFileSync(canary, 'owner-home-must-not-be-readable', { mode: 0o600 });
  const readable = path.join(documents, 'readable.txt'); fs.writeFileSync(readable, 'job-readable', { mode: 0o600 });
  try {
    const control = await execute('/bin/cat', [canary], { timeout: 10_000, env: { PATH: '/usr/bin:/bin' } });
    if (control.stdout !== 'owner-home-must-not-be-readable') throw new Error('execution_isolation_canary_control_failed');
    {
      const profile = browserProfilePath;
      const env = privateBrowserEnvironment({ home: path.join(browserRoot, 'home'), temporary: browserRoot });
      const control = await execute('/usr/bin/sandbox-exec', ['-f', profile, '/bin/cat', readable], { env, timeout: 10_000 });
      if (control.stdout !== 'job-readable') throw new Error('execution_isolation_positive_failed');
      let denied = false;
      try { await execute('/usr/bin/sandbox-exec', ['-f', profile, '/bin/cat', canary], { env, timeout: 10_000 }); }
      catch (error) { denied = error.code === 1 && !String(error.stdout || '')
        && /operation not permitted|permission denied/i.test(String(error.stderr || '')); }
      if (!denied) throw new Error('execution_isolation_owner_read_allowed');
    }
    const nodeControl = await execute(node, ['-e', "process.stdout.write('agent-runtime-ready')"],
      { env: privateBrowserEnvironment({ home: path.join(jobRoot, 'home'), temporary: documents }), timeout: 10_000, maxBuffer: 4096 });
    if (nodeControl.stdout !== 'agent-runtime-ready') throw new Error('execution_isolation_agent_runtime_failed');
    await probeBrowserNetworkIsolation({ profile: browserProfilePath, root: canaryRoot,
      proxy: `http://127.0.0.1:${proxyPort}`, brokerSocket, registrySocket,
      env: privateBrowserEnvironment({ home: path.join(browserRoot, 'home'), temporary: browserRoot }) });
    await probeProcessEnvironmentPrivacy({ node, sandbox: async args => {
      try { return { ok: true, ...(await execute('/usr/bin/sandbox-exec', ['-f', browserProfilePath, ...args], {
        env: privateBrowserEnvironment({ home: path.join(browserRoot, 'home'), temporary: browserRoot }), timeout: 10_000, maxBuffer: 4096 })) }; }
      catch (error) { return { ok: false, stdout: String(error.stdout || '') }; }
    } });
  } finally { fs.rmSync(canaryRoot, { recursive: true, force: true }); fs.rmSync(readable, { force: true }); }
  const launcher = path.join(jobRoot, 'browser-launch.sh');
  // Paths are generated by this manager, never derived from employer content.
  const shellQuote = value => `'${value.replace(/'/g, `'\\''`)}'`;
  fs.writeFileSync(launcher, `#!/bin/sh\nset -eu\nnode_digest="$(/usr/bin/shasum -a 256 ${shellQuote(node)} | /usr/bin/cut -d ' ' -f 1)"\n[ "$node_digest" = '${nodeHash}' ] || exit 1\nbrowser_witness="$(${shellQuote(node)} ${shellQuote(path.join(releaseRoot, 'scripts/assisted-application/lib/execution-process.mjs'))} --register ${shellQuote(registrySocket)} "$$" ${shellQuote(registryNonce)})"\nexport ASSISTED_APPLICATION_BROWSER_WITNESS="$browser_witness"\nexec /usr/bin/sandbox-exec -f ${shellQuote(browserProfilePath)} ${shellQuote(chromiumPath)} "$@"\n`, { mode: 0o700 });
  return { browserSandboxProfile: browserProfilePath, browserLauncher: launcher, browserRoot, documents,
    browserHome: path.join(browserRoot, 'home'), browserProfile: path.join(browserRoot, 'profile'), home: path.join(jobRoot, 'home') };
}

export async function probeBrowserNetworkIsolation({ profile, root, proxy, env, brokerSocket, registrySocket }) {
  const tcp = http.createServer((_request, response) => response.end('manager-canary'));
  const unix = http.createServer((_request, response) => response.end('manager-canary'));
  const socket = brokerSocket || path.join(root, 'ipc');
  if (fs.existsSync(socket)) throw new Error('execution_isolation_broker_already_active');
  const curl = ['--silent', '--show-error', '--max-time', '5', '--noproxy', '*'];
  const run = args => execute('/usr/bin/curl', args, { env, timeout: 10_000, maxBuffer: 4096 });
  const denied = async args => {
    const before = await run(args);
    if (before.stdout !== 'manager-canary') throw new Error('execution_isolation_network_control_failed');
    let blocked = false;
    try { await execute('/usr/bin/sandbox-exec', ['-f', profile, '/usr/bin/curl', ...args], { env, timeout: 10_000, maxBuffer: 4096 }); }
    catch (error) { blocked = error.code === 7 && !String(error.stdout || ''); }
    if (!blocked || (await run(args)).stdout !== 'manager-canary') throw new Error('execution_isolation_network_not_denied');
  };
  try {
    tcp.listen(0, '127.0.0.1'); await once(tcp, 'listening');
    unix.listen(socket); await once(unix, 'listening');
    fs.chmodSync(socket, 0o600);
    await denied([...curl, `http://127.0.0.1:${tcp.address().port}/`]);
    await denied([...curl, '--unix-socket', socket, 'http://localhost/']);
    if (registrySocket) {
      const registryControl = () => new Promise((resolve, reject) => {
        const client = net.createConnection({ path: registrySocket });
        client.setTimeout(2000, () => { client.destroy(); reject(new Error('execution_isolation_registry_control_failed')); });
        client.once('error', reject); client.once('connect', () => { client.destroy(); resolve(); });
      });
      await registryControl(); let blocked = false;
      try { await execute('/usr/bin/sandbox-exec', ['-f', profile, '/usr/bin/curl', ...curl,
        '--unix-socket', registrySocket, 'http://localhost/'], { env, timeout: 10_000, maxBuffer: 4096 }); }
      catch (error) { blocked = error.code === 7 && !String(error.stdout || ''); }
      await registryControl();
      if (!blocked) throw new Error('execution_isolation_registry_unproven');
    }
    const throughProxy = await execute('/usr/bin/sandbox-exec', ['-f', profile, '/usr/bin/curl', '--silent', '--show-error',
      '--max-time', '15', '--proxy', proxy, '--noproxy', '', '--output', '/dev/null', '--write-out', '%{http_connect}',
      'https://api.nopecha.com/v1/status'], { env, timeout: 20_000, maxBuffer: 4096 });
    if (throughProxy.stdout !== '200') throw new Error('execution_isolation_public_connect_failed');
    for (const target of ['http://127.0.0.1/', 'http://10.0.0.1/', 'http://100.64.0.1/', 'http://[::1]/']) {
      const result = await execute('/usr/bin/sandbox-exec', ['-f', profile, '/usr/bin/curl', '--silent', '--show-error', '--max-time', '5',
        '--proxy', proxy, '--noproxy', '', '--output', '/dev/null', '--write-out', '%{http_code}', target], { env, timeout: 10_000, maxBuffer: 4096 });
      if (result.stdout !== '403') throw new Error('execution_isolation_private_target_not_denied');
    }
  } finally {
    tcp.closeAllConnections?.(); unix.closeAllConnections?.();
    await Promise.all([tcp, unix].map(server => new Promise(resolve => server.close(resolve))));
    fs.rmSync(socket, { force: true });
  }
}
