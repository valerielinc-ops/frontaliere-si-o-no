#!/usr/bin/env node
/**
 * Swiss runner: runs, from a Mac with a Swiss network exit, the assisted-application runs that a portal
 * refuses from GitHub's network (`application_region_unsupported`; owner decision 2026-11-11, «lancialo da
 * questo mac che è in svizzera»). The Cloud Functions queue them in `assisted_application_local_dispatch`
 * instead of dispatching the workflow (functions/src/assistedApplicationSwissRunner.js).
 *
 * One cycle (`--once`, what the launch agent runs every 2 minutes; `--loop` repeats it):
 *   1. reads the network exit's country (ipinfo.io, then ipapi.co). Not `CH`, or unknown: it takes no work
 *      and says why in its heartbeat (the Functions then hold the queued orders for the owner);
 *   2. writes its heartbeat, then leases at most one request in a transaction (never two runs of the same
 *      order; a request whose flow moved on is closed as stale and never runs);
 *   3. starts the same Codex auth broker the workflow starts (.github/actions/setup-claude-haiku-fallback/
 *      codex-auth-broker.mjs), fed this Mac's Codex login, or reuses a live one (SWISS_RUNNER_BROKER_SOCKET);
 *   4. runs scripts/assisted-application/agent.mjs with the workflow's variables (Remote Config through
 *      scripts/load-rc-env.mjs, the broker socket, the stop-report paths), the system Chrome when Playwright
 *      has no Chromium build for this OS, and a headless browser unless SWISS_RUNNER_HEADED=1;
 *   5. keeps the heartbeat alive while the agent runs, kills it at the workflow's 120 minutes, reports a
 *      failed run to the flow as the workflow does (report-runner-failure.mjs), and releases the lease.
 *
 * Nothing secret or personal reaches the log: the agent's `::add-mask::` lines (meant for the Actions log
 * masker) are consumed here and every value they name, with every Remote Config value, is struck out of
 * all later output. The runner itself prints only opaque order ids, modes, rounds and codes.
 *
 * Environment: GOOGLE_APPLICATION_CREDENTIALS (required); SWISS_RUNNER_ID; SWISS_RUNNER_STATE_DIR;
 * SWISS_RUNNER_HEADED; SWISS_RUNNER_CODEX_BIN; SWISS_RUNNER_CODEX_AUTH; SWISS_RUNNER_BROKER_SOCKET;
 * SWISS_RUNNER_CHROME. Install: scripts/dev/install-swiss-runner.sh (README.md next to this file).
 */
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isInvokedDirectly } from '../lib/is-invoked-directly.mjs';
import {
  completeLocalDispatch,
  leaseLocalDispatch,
  writeRunnerHeartbeat,
} from '../../functions/src/assistedApplicationSwissRunner.js';

export const RUNNER_VERSION = 'swiss-runner/1';
export const SWISS_COUNTRY = 'CH';
export const EGRESS_SOURCES = Object.freeze(['https://ipinfo.io/country', 'https://ipapi.co/country/']);
/** The workflow's `timeout-minutes: 120`. */
export const AGENT_TIMEOUT_MS = 120 * 60 * 1000;
export const HEARTBEAT_EVERY_MS = 60 * 1000;
export const DEFAULT_LOOP_INTERVAL_MS = 30 * 1000;
export const SYSTEM_CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const BROKER_SCRIPT = path.join(REPO_ROOT, '.github', 'actions', 'setup-claude-haiku-fallback', 'codex-auth-broker.mjs');
const CHROME_PRELOAD = path.join(REPO_ROOT, 'scripts', 'assisted-application', 'local-runner-chrome-preload.cjs');
const BROKER_MAX_TIMEOUT_MS = '1800000';

// ── Network exit ────────────────────────────────────────────────────────────

/** The country of this machine's network exit, from the first source that answers with a country code. */
export async function readEgressCountry({ fetchImpl = fetch, sources = EGRESS_SOURCES, timeoutMs = 10_000 } = {}) {
  for (const url of sources) {
    try {
      const response = await fetchImpl(url, { headers: { accept: 'text/plain' }, signal: AbortSignal.timeout(timeoutMs) });
      if (!response?.ok) continue;
      const country = String(await response.text()).trim().toUpperCase();
      if (/^[A-Z]{2}$/.test(country)) return { country, source: new URL(url).host };
    } catch {
      // the next source answers, or the exit stays unknown
    }
  }
  return { country: null, source: null };
}

/** Only a verified Swiss exit takes work. */
export function egressVerdict({ country } = {}) {
  if (!country) return { eligible: false, reason: 'egress_unknown' };
  if (country !== SWISS_COUNTRY) return { eligible: false, reason: 'egress_not_swiss' };
  return { eligible: true, reason: null };
}

// ── Log masking ─────────────────────────────────────────────────────────────

const MASK = '***';

/**
 * A line filter doing what the Actions log masker does: a `::add-mask::value` line registers the value and is
 * never written; every registered value is struck out of every later line.
 */
export function createLogMasker(write) {
  const secrets = new Set();
  let ordered = [];
  let buffer = '';
  const addSecret = (value) => {
    const text = String(value ?? '');
    if (text.trim().length < 3 || /[\r\n]/.test(text) || secrets.has(text)) return;
    secrets.add(text);
    ordered = [...secrets].sort((a, b) => b.length - a.length);
  };
  const scrub = (line) => ordered.reduce((out, secret) => out.split(secret).join(MASK), line);
  const emit = (line) => {
    const mask = /^::add-mask::(.*)$/.exec(line.replace(/\r$/, ''));
    if (mask) {
      addSecret(mask[1]);
      return;
    }
    write(`${scrub(line)}\n`);
  };
  return {
    addSecret,
    scrub,
    push(chunk) {
      buffer += String(chunk);
      let newline = buffer.indexOf('\n');
      while (newline >= 0) {
        emit(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf('\n');
      }
    },
    flush() {
      if (buffer) emit(buffer);
      buffer = '';
    },
    get size() { return secrets.size; },
  };
}

/** Values worth masking among the loaded variables: not the switches («true», «0», «legacy»). */
export function maskableValue(value) {
  const text = String(value ?? '').trim();
  return text.length >= 8 && !/^(?:true|false|on|off|\d+)$/i.test(text);
}

/** `export KEY='value'` lines (scripts/load-rc-env.mjs, local mode) to an object; multi-line values included. */
export function parseExportLines(text) {
  const env = {};
  const pattern = /^export ([A-Za-z_][A-Za-z0-9_]*)='((?:[^']|'\\'')*)'$/gm;
  for (const match of String(text || '').matchAll(pattern)) env[match[1]] = match[2].replace(/'\\''/g, "'");
  return env;
}

// ── Browser ─────────────────────────────────────────────────────────────────

/**
 * The Chrome the agent must use instead of Playwright's own, or null when Playwright has its Chromium.
 * Playwright 1.63 has no Chromium build for macOS 13: its executable path then does not exist.
 */
export function systemChromeFor({ playwrightExecutable, exists = fs.existsSync, systemChrome = SYSTEM_CHROME }) {
  if (playwrightExecutable && exists(playwrightExecutable)) return null;
  return systemChrome && exists(systemChrome) ? systemChrome : null;
}

async function playwrightExecutablePath(repoRoot) {
  try {
    const { createRequire } = await import('node:module');
    const { chromium } = createRequire(path.join(repoRoot, 'package.json'))('playwright');
    return chromium.executablePath();
  } catch {
    return null;
  }
}

/** The agent's environment: the workflow's variables, with the browser and the headed switch decided here. */
export function agentEnvironment({ baseEnv, rcEnv, leased, brokerSocket, runDir, chromePath, headed }) {
  const env = { ...baseEnv, ...rcEnv };
  // Never inherited: only SWISS_RUNNER_HEADED=1 opens a visible window on this Mac (safe default: headless).
  delete env.ASSISTED_APPLICATION_HEADED;
  delete env.ASSISTED_APPLICATION_CHROME_PATH;
  delete env.GITHUB_RUN_ID;
  Object.assign(env, {
    ORDER_ID: leased.orderId,
    MODE: leased.mode,
    ROUND: String(leased.round),
    CODEX_AUTH_BROKER_SOCKET: brokerSocket,
    CODEX_BROKER_MAX_TIMEOUT_MS: BROKER_MAX_TIMEOUT_MS,
    ASSISTED_APPLICATION_STOP_REPORT: path.join(runDir, 'portal-stop.json'),
    ASSISTED_APPLICATION_PORTAL_PASS: path.join(runDir, 'portal-pass.json'),
    NODE_OPTIONS: ['--trace-warnings', chromePath ? `-r ${CHROME_PRELOAD}` : ''].filter(Boolean).join(' '),
  });
  if (chromePath) env.ASSISTED_APPLICATION_CHROME_PATH = chromePath;
  if (headed) env.ASSISTED_APPLICATION_HEADED = '1';
  return env;
}

// ── Codex auth broker ───────────────────────────────────────────────────────

function versionKey(name) {
  return (String(name).match(/\d+/g) || []).slice(0, 3).map(Number);
}

/** The Codex CLI to attest: SWISS_RUNNER_CODEX_BIN, else the newest standalone release of this Mac's Codex. */
export function findCodexBinary({ env = process.env, home = os.homedir(), fsImpl = fs } = {}) {
  if (env.SWISS_RUNNER_CODEX_BIN) return path.resolve(env.SWISS_RUNNER_CODEX_BIN);
  const releases = path.join(home, '.codex', 'packages', 'standalone', 'releases');
  let names = [];
  try { names = fsImpl.readdirSync(releases); } catch { return null; }
  const found = names
    .filter((name) => fsImpl.existsSync(path.join(releases, name, 'bin', 'codex')))
    .sort((a, b) => {
      const [left, right] = [versionKey(a), versionKey(b)];
      for (let index = 0; index < 3; index += 1) if ((left[index] || 0) !== (right[index] || 0)) return (right[index] || 0) - (left[index] || 0);
      return 0;
    });
  return found.length ? path.join(releases, found[0], 'bin', 'codex') : null;
}

function socketAlive(socketPath, timeoutMs = 2000) {
  return new Promise((resolve) => {
    if (!socketPath || !fs.existsSync(socketPath)) return resolve(false);
    const client = net.createConnection(socketPath);
    const done = (alive) => { client.destroy(); resolve(alive); };
    client.setTimeout(timeoutMs, () => done(false));
    client.once('connect', () => done(true));
    client.once('error', () => done(false));
  });
}

async function waitFor(check, { timeoutMs, everyMs = 200 }) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (await check()) return true;
    await new Promise((resolve) => setTimeout(resolve, everyMs));
  }
  return false;
}

/**
 * Start the workflow's broker with this Mac's Codex login, or reuse SWISS_RUNNER_BROKER_SOCKET when it answers.
 * The CLI is copied into a private `codex-luna-max-codex-cli.*` prefix, as the setup action does, so the
 * broker's attestation (path, digest, version) holds; the login reaches the broker on stdin only.
 */
export async function startCodexBroker({ env = process.env, log }) {
  if (await socketAlive(env.SWISS_RUNNER_BROKER_SOCKET)) {
    return { socket: env.SWISS_RUNNER_BROKER_SOCKET, reused: true, stop: async () => {} };
  }
  const codexBin = findCodexBinary({ env });
  if (!codexBin || !fs.existsSync(codexBin)) throw Object.assign(new Error('codex_cli_missing'), { code: 'codex_cli_missing' });
  const authPath = env.SWISS_RUNNER_CODEX_AUTH || path.join(os.homedir(), '.codex', 'auth.json');
  if (!fs.existsSync(authPath)) throw Object.assign(new Error('codex_login_missing'), { code: 'codex_login_missing' });
  const prefix = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-luna-max-codex-cli.'));
  const socketDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swiss-runner-broker.'));
  const brokerCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'swiss-runner-broker-cwd.'));
  fs.chmodSync(prefix, 0o700);
  fs.chmodSync(socketDir, 0o700);
  const removeAll = () => {
    for (const dir of [prefix, socketDir, brokerCwd]) fs.rmSync(dir, { recursive: true, force: true });
  };
  try {
    const binDir = path.dirname(codexBin);
    for (const name of fs.readdirSync(binDir)) {
      if (!name.startsWith('codex')) continue;
      const source = path.join(binDir, name);
      if (!fs.statSync(source).isFile()) continue;
      fs.copyFileSync(source, path.join(prefix, name));
      fs.chmodSync(path.join(prefix, name), 0o755);
    }
    const cli = fs.realpathSync(path.join(prefix, 'codex'));
    const sha256 = createHash('sha256').update(fs.readFileSync(cli)).digest('hex');
    // The first start of a freshly copied binary waits for macOS's code check (seconds): this probe takes it,
    // with a generous timeout, so the broker's own 5-second version probe finds the binary already checked.
    const probe = spawnSync(cli, ['--version'], { cwd: prefix, env: { PATH: '/usr/bin:/bin', CODEX_HOME: prefix, TMPDIR: prefix }, encoding: 'utf8', timeout: 60_000 });
    const version = `${probe.stdout || ''}\n${probe.stderr || ''}`.match(/(?:^|[^0-9])v?(\d+\.\d+\.\d+)(?:[^0-9]|$)/)?.[1];
    if (probe.status !== 0 || !version) throw Object.assign(new Error('codex_cli_version_unknown'), { code: 'codex_cli_version_unknown' });
    const socket = path.join(socketDir, 'codex.sock');
    const child = spawn(process.execPath, [BROKER_SCRIPT,
      '--socket', socket, '--ttl-ms', String(AGENT_TIMEOUT_MS + 30 * 60 * 1000), '--max-requests', '512',
      '--max-concurrency', '2', '--max-timeout-ms', BROKER_MAX_TIMEOUT_MS, '--codex-cli-version', version,
      '--codex-bin', cli, '--codex-realpath', cli, '--codex-sha256', sha256, '--codex-prefix', prefix,
    ], { cwd: brokerCwd, env: { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: os.homedir() }, stdio: ['pipe', 'pipe', 'pipe'] });
    child.stdout.on('data', (chunk) => log.push(chunk));
    child.stderr.on('data', (chunk) => log.push(chunk));
    child.stdin.end(fs.readFileSync(authPath));
    let exited = false;
    child.once('exit', () => { exited = true; });
    const ready = await waitFor(async () => exited || await socketAlive(socket), { timeoutMs: 30_000 });
    if (!ready || exited) {
      child.kill('SIGKILL');
      throw Object.assign(new Error('codex_broker_unavailable'), { code: 'codex_broker_unavailable' });
    }
    return {
      socket,
      reused: false,
      stop: async () => {
        if (!exited) {
          child.kill('SIGTERM');
          await waitFor(() => exited, { timeoutMs: 10_000 });
          if (!exited) child.kill('SIGKILL');
        }
        removeAll();
      },
    };
  } catch (error) {
    removeAll();
    throw error;
  }
}

// ── Remote Config ───────────────────────────────────────────────────────────

/** The workflow's «Load RC secrets» step, for this process: variables returned, never printed. */
export async function loadRemoteConfigEnv({ repoRoot = REPO_ROOT, env = process.env } = {}) {
  const childEnv = { ...env };
  delete childEnv.GITHUB_ENV;
  delete childEnv.GITHUB_ACTIONS;
  delete childEnv.CI;
  const result = spawnSync(process.execPath, [path.join(repoRoot, 'scripts', 'load-rc-env.mjs')], {
    cwd: repoRoot, env: childEnv, encoding: 'utf8', timeout: 5 * 60 * 1000, maxBuffer: 64 * 1024 * 1024,
  });
  const rcEnv = parseExportLines(result.stdout);
  if (result.status !== 0 || !rcEnv.ASSISTED_APPLICATION_RUN_KEY) {
    throw Object.assign(new Error('remote_config_unavailable'), { code: 'remote_config_unavailable' });
  }
  return rcEnv;
}

// ── One run ─────────────────────────────────────────────────────────────────

function killGroup(child, signal) {
  try { process.kill(-child.pid, signal); } catch { try { child.kill(signal); } catch { /* gone */ } }
}

/**
 * Run the agent for one leased request, as the workflow's «Run agent» step does.
 * `signal`: aborted by runCycle when the network exit stops being Swiss; the agent is then stopped and its
 * run reported as failed (before it starts, the request just goes back to the queue).
 * @returns {Promise<{status:'done'|'failed'|'retry', exitCode:number|null, code:string|null}>}
 */
export async function runAgentLocally({ db, leased, startedAt, signal = null, env = process.env, repoRoot = REPO_ROOT, write = (text) => process.stdout.write(text), reportFailure = null }) {
  const masker = createLogMasker(write);
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swiss-runner-run.'));
  let broker = null;
  try {
    let rcEnv;
    try {
      rcEnv = await loadRemoteConfigEnv({ repoRoot, env });
      for (const value of Object.values(rcEnv)) if (maskableValue(value)) masker.addSecret(value);
      broker = await startCodexBroker({ env, log: masker });
    } catch (error) {
      return { status: 'retry', exitCode: null, code: String(error?.code || 'prepare_failed').slice(0, 60) };
    }
    if (signal?.aborted) return { status: 'retry', exitCode: null, code: String(signal.reason || 'aborted').slice(0, 60) };
    const chromePath = systemChromeFor({ playwrightExecutable: await playwrightExecutablePath(repoRoot), systemChrome: env.SWISS_RUNNER_CHROME || SYSTEM_CHROME });
    const agentEnv = agentEnvironment({
      baseEnv: env, rcEnv, leased, brokerSocket: broker.socket, runDir, chromePath, headed: env.SWISS_RUNNER_HEADED === '1',
    });
    write(`swiss-runner agent start order=${leased.orderId} mode=${leased.mode} round=${leased.round} chrome=${chromePath ? 'system' : 'playwright'} headed=${agentEnv.ASSISTED_APPLICATION_HEADED === '1'}\n`);
    const exit = await new Promise((resolve) => {
      const child = spawn(process.execPath, [path.join(repoRoot, 'scripts', 'assisted-application', 'agent.mjs'),
        '--order', leased.orderId, '--mode', leased.mode, '--round', String(leased.round)],
      { cwd: repoRoot, env: agentEnv, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
      child.stdout.on('data', (chunk) => masker.push(chunk));
      child.stderr.on('data', (chunk) => masker.push(chunk));
      let timedOut = false;
      let aborted = null;
      const stop = () => {
        killGroup(child, 'SIGTERM');
        setTimeout(() => killGroup(child, 'SIGKILL'), 30_000).unref();
      };
      const timer = setTimeout(() => { timedOut = true; stop(); }, AGENT_TIMEOUT_MS);
      const onAbort = () => { aborted = String(signal.reason || 'aborted'); stop(); };
      signal?.addEventListener('abort', onAbort, { once: true });
      const settle = (code) => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        resolve({ code, timedOut, aborted });
      };
      child.once('error', () => settle(null));
      child.once('close', (code) => settle(code));
    });
    masker.flush();
    write(`swiss-runner agent exit order=${leased.orderId} code=${exit.code ?? 'none'}${exit.timedOut ? ' timeout' : ''}${exit.aborted ? ` stopped:${exit.aborted}` : ''}\n`);
    if (exit.code === 0 && !exit.timedOut && !exit.aborted) return { status: 'done', exitCode: 0, code: null };
    // The workflow's «Reconcile failed executor with the application queue» step.
    try {
      const report = reportFailure || (await import('./report-runner-failure.mjs')).reportRunnerFailure;
      const reported = await report({ db, orderId: leased.orderId, mode: leased.mode, round: leased.round, runId: String(startedAt), startedAt });
      write(`swiss-runner failure reported order=${leased.orderId} ${reported?.reported ? reported.event : reported?.reason || 'no'}\n`);
    } catch (error) {
      write(`swiss-runner failure report failed order=${leased.orderId} ${String(error?.code || 'error').slice(0, 60)}\n`);
    }
    return { status: 'failed', exitCode: Number.isInteger(exit.code) ? exit.code : null, code: exit.aborted || (exit.timedOut ? 'agent_timeout' : 'agent_failed') };
  } finally {
    masker.flush();
    if (broker) await broker.stop().catch(() => {});
    fs.rmSync(runDir, { recursive: true, force: true });
  }
}

// ── One cycle ───────────────────────────────────────────────────────────────

/**
 * Check the exit, beat, lease at most one request, run it, release it.
 * @param {{db, runnerId:string, now?:()=>number, fetchImpl?:Function, runAgent:Function, log?:(line:string)=>void, version?:string|null, checkEveryMs?:number}} args
 *   `checkEveryMs`: how often, during a run, the heartbeat is written and the exit read again.
 */
export async function runCycle({ db, runnerId, now = Date.now, fetchImpl = fetch, runAgent, log = (line) => process.stdout.write(`${line}\n`), version = null, checkEveryMs = HEARTBEAT_EVERY_MS }) {
  let egress = await readEgressCountry({ fetchImpl });
  let verdict = egressVerdict(egress);
  const beat = (busy = null) => writeRunnerHeartbeat({
    db, runnerId, nowMs: now(), egressCountry: egress.country, eligible: verdict.eligible, reason: verdict.reason, busy, version,
  });
  await beat();
  if (!verdict.eligible) {
    log(`swiss-runner idle: ${verdict.reason} (exit ${egress.country || 'unknown'})`);
    return { eligible: false, reason: verdict.reason, leased: null };
  }
  const { leased, stale } = await leaseLocalDispatch({ db, runnerId, nowMs: now() });
  for (const item of stale) log(`swiss-runner closed stale request order=${item.orderId} ${item.code}`);
  if (!leased) return { eligible: true, reason: null, leased: null };
  const startedAt = now();
  const busy = { orderId: leased.orderId, key: leased.key, since: startedAt };
  await beat(busy);
  // While the run holds its lease, the exit is read again with every heartbeat (review
  // PRR_kwDORN5k2M8AAAABXRWXRQ): an exit that is no longer Swiss stops the agent, the heartbeat says so, and
  // the lease is released. An unreadable exit (a probe that fails) is no proof of another country: the run goes on.
  const controller = new AbortController();
  let inflight = null;
  const timer = setInterval(() => {
    if (inflight) return;
    inflight = (async () => {
      const current = await readEgressCountry({ fetchImpl });
      if (current.country && current.country !== egress.country) {
        egress = current;
        verdict = egressVerdict(current);
        if (!verdict.eligible && !controller.signal.aborted) {
          log(`swiss-runner exit changed to ${current.country}: stopping order=${leased.orderId}`);
          controller.abort('egress_lost');
        }
      }
      await beat(busy);
    })().catch(() => {}).finally(() => { inflight = null; });
  }, checkEveryMs);
  timer.unref?.();
  let outcome;
  try {
    outcome = await runAgent({ db, leased, startedAt, signal: controller.signal });
    if (controller.signal.aborted && outcome?.status === 'retry') outcome = { ...outcome, code: 'egress_lost' };
  } catch (error) {
    outcome = { status: 'failed', exitCode: null, code: String(error?.code || 'runner_error').slice(0, 60) };
  } finally {
    clearInterval(timer);
    // A heartbeat still being written must not land after the release's.
    await inflight;
  }
  const release = await completeLocalDispatch({ db, orderId: leased.orderId, key: leased.key, runnerId, outcome, nowMs: now() });
  await beat();
  log(`swiss-runner released order=${leased.orderId} ${release.status || release.reason}`);
  return { eligible: verdict.eligible, reason: verdict.reason, leased, outcome, release };
}

// ── Process ─────────────────────────────────────────────────────────────────

function stateDir(env = process.env) {
  const dir = env.SWISS_RUNNER_STATE_DIR || path.join(os.homedir(), '.config', 'frontaliere', 'swiss-runner');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

/** A stable opaque id for this Mac's runner (never its host or user name). */
export function runnerIdFor({ env = process.env, dir = stateDir(env) } = {}) {
  if (env.SWISS_RUNNER_ID) return String(env.SWISS_RUNNER_ID).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64);
  const file = path.join(dir, 'runner-id');
  try {
    const existing = fs.readFileSync(file, 'utf8').trim();
    if (/^swiss-[a-f0-9]{8}$/.test(existing)) return existing;
  } catch { /* first start */ }
  const id = `swiss-${randomUUID().replace(/-/g, '').slice(0, 8)}`;
  fs.writeFileSync(file, `${id}\n`, { mode: 0o600 });
  return id;
}

/** One runner process per Mac: a second one exits at once. */
export function acquireLock(dir) {
  const file = path.join(dir, 'runner.lock');
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      fs.writeFileSync(file, String(process.pid), { flag: 'wx', mode: 0o600 });
      return () => { try { fs.rmSync(file, { force: true }); } catch { /* gone */ } };
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      const pid = Number(fs.readFileSync(file, 'utf8'));
      let alive = false;
      try { alive = Number.isInteger(pid) && pid > 0 && process.kill(pid, 0); } catch { alive = false; }
      if (alive) return null;
      fs.rmSync(file, { force: true });
    }
  }
  return null;
}

function checkoutVersion(repoRoot = REPO_ROOT) {
  const head = spawnSync('git', ['-C', repoRoot, 'rev-parse', '--short=12', 'HEAD'], { encoding: 'utf8', timeout: 5000 });
  return head.status === 0 ? `${RUNNER_VERSION}@${head.stdout.trim()}` : RUNNER_VERSION;
}

async function main(argv = process.argv.slice(2)) {
  const loop = argv.includes('--loop');
  const intervalIndex = argv.indexOf('--interval-ms');
  const intervalMs = intervalIndex >= 0 ? Math.max(10_000, Number(argv[intervalIndex + 1]) || DEFAULT_LOOP_INTERVAL_MS) : DEFAULT_LOOP_INTERVAL_MS;
  const dir = stateDir();
  const release = acquireLock(dir);
  if (!release) {
    console.log('swiss-runner: another runner is active on this Mac');
    return 0;
  }
  try {
    const { getFirestoreDb } = await import('../lib/firestore-admin.mjs');
    const db = await getFirestoreDb();
    const runnerId = runnerIdFor({ dir });
    const version = checkoutVersion();
    do {
      const result = await runCycle({ db, runnerId, version, runAgent: (args) => runAgentLocally(args) });
      if (!loop) break;
      if (!result.leased) await new Promise((resolve) => setTimeout(resolve, intervalMs));
    } while (loop);
    return 0;
  } finally {
    release();
  }
}

if (isInvokedDirectly(import.meta.url)) {
  main().then((code) => process.exit(code), (error) => {
    console.error(`swiss-runner failed: ${String(error?.code || error?.message || 'error').slice(0, 120)}`);
    process.exit(1);
  });
}
