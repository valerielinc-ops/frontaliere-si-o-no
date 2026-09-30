#!/usr/bin/env node
/**
 * Host-side bounded runner for the Codex Luna Max subscription lane.
 *
 * The setup action passes CODEX_AUTH_JSON over stdin and never writes it to a
 * file or to GITHUB_ENV. This process keeps the credential in memory, serves
 * bounded serialized Codex requests over a private Unix socket, and is the only
 * process that materializes CODEX_HOME/auth.json. The caller receives only
 * Codex's result; the credential never crosses the socket or enters a child
 * environment.
 *
 * CODEX_HOME is ONE private directory per broker (per job), not one per
 * request: the ChatGPT login refresh token is single-use, and Codex writes the
 * refreshed login back to CODEX_HOME/auth.json. A fresh home per request threw
 * that write away, so every call after the first refresh replayed the spent
 * token and failed with "refresh token already used". The home lives outside
 * the workspace, is 0700 with a 0600 auth.json, and is removed by cleanup, the
 * idle TTL, SIGTERM/SIGINT and process exit. Only the in-memory copy is ever
 * refreshed from it; nothing is written back to the job or to the secret.
 *
 * The socket is deliberately the only job-wide hand-off. Its parent directory
 * is 0700 and the socket is 0600. A malformed request never receives auth or
 * consumes a request slot. The idle TTL is a backstop for persistent runners:
 * it restarts whenever a request is accepted or completes and never fires
 * while a request is running or queued. Callers should still invoke explicit
 * cleanup at the end of a job.
 *
 * Requests run in up to --max-concurrency lanes (default 1), so a request can
 * wait in the queue behind others. Parallel lanes open only while the login
 * cannot need a refresh (loginCannotRefresh): the refresh token is single-use,
 * and two Codex processes refreshing it at once would spend it twice. A client
 * that sends `notifyStart: true` receives one CLIENT_START_SIGNAL byte when
 * its own Codex process starts, and can time the execution from there instead
 * of from connect().
 *
 * A request with `profile: 'function'` runs Codex as a plain text function:
 * minimal instructions instead of the coding-agent prompt, no tools, no
 * environment or permission context. callLLM requests never need tools, and
 * the agent prompt cost ~15.4k input tokens per request against ~5.9k for the
 * function profile (local measure, gpt-5.6-luna at effort max, 2026-09-29).
 * The model and the reasoning effort are the same for both profiles.
 */

import fs from 'node:fs';
import crypto from 'node:crypto';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import {
  CODEX_FALLBACK_EFFORT,
  CODEX_FALLBACK_MODEL,
} from '../../../scripts/lib/codex-fallback-contract.mjs';

const CODEX_MODEL = CODEX_FALLBACK_MODEL;
const CODEX_EFFORT = CODEX_FALLBACK_EFFORT;
const CODEX_CLI_VERSION = '0.153.4';
const CODEX_PROFILE = 'codex-luna-max';
const MAX_REQUEST_BYTES = 1024 * 1024;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_AUTH_BYTES = 256 * 1024;
const DEFAULT_TTL_MS = 30 * 60 * 1000;
const DEFAULT_MAX_REQUESTS = 512;
const DEFAULT_MAX_CONCURRENCY = 1;
const MAX_CONCURRENCY_LIMIT = 6;
const DEFAULT_MAX_TIMEOUT_MS = 600_000;
const MAX_TIMEOUT_LIMIT_MS = 3 * 60 * 60 * 1000;
// Tetto di esecuzione di una richiesta. I 10 minuti di default bastano alle
// corsie degli articoli; un job che deve lasciar finire una richiesta lenta
// ma viva (la candidatura assistita a effort max, dove conta che la bozza
// arrivi) passa --max-timeout-ms. Fuori da 60000..10800000 vale il default.
const maxTimeoutRaw = Number(argument('--max-timeout-ms', String(DEFAULT_MAX_TIMEOUT_MS)));
const MAX_TIMEOUT_MS = Number.isInteger(maxTimeoutRaw) && maxTimeoutRaw >= 60_000 && maxTimeoutRaw <= MAX_TIMEOUT_LIMIT_MS
  ? maxTimeoutRaw
  : DEFAULT_MAX_TIMEOUT_MS;
// Codex rinnova un login ChatGPT quando `last_refresh` ha piu' di 8 giorni o
// l'access token e' scaduto. Le corsie parallele si aprono solo con un giorno
// di margine sul primo e con un access token che sopravvive alla richiesta
// piu' lunga ammessa, piu' mezz'ora.
const LOGIN_REFRESH_SAFE_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const LOGIN_ACCESS_TOKEN_MIN_REMAINING_MS = MAX_TIMEOUT_MS + 30 * 60 * 1000;
// Profilo `function`: Codex risponde come una funzione di testo. Le feature
// spente sono i tool dell'agente; tutte esistono nella 0.153.4 pinnata e
// `--strict-config` rifiuta una feature o una chiave sconosciuta.
const FUNCTION_PROFILE_INSTRUCTIONS = 'You are a stateless text-processing function called by a batch job. Read the request, produce the requested output directly, and never use tools, run commands or ask questions.\n';
const FUNCTION_PROFILE_DISABLED_FEATURES = Object.freeze([
  'shell_tool', 'unified_exec', 'multi_agent', 'image_generation', 'browser_use',
  'computer_use', 'apps', 'plugins', 'view_image', 'goals', 'sleep_tool',
  'tool_suggest', 'skill_search',
]);
const REQUEST_PROFILES = new Set(['agent', 'function']);
const MAX_STDERR_TAIL_CHARS = 16 * 1024;
// Sta nei 300 caratteri dell'errore che il broker restituisce, dopo il suo prefisso.
const MAX_FAILURE_REASON_CHARS = 200;
const CLIENT_LIVENESS_PROBE = '\0';
// Scritto prima della riga JSON quando il processo Codex della richiesta e'
// partito (evento 'spawn'). Il client misurava il timeout di esecuzione dalla
// connect(): con sei chiamanti in coda ogni richiesta scadeva mentre era
// appena partita, il broker
// uccideva quel Codex a meta' e passava al successivo, gia' quasi scaduto
// anche lui (send-newsletter, run 36116142119: zero risposte in 16 minuti).
const CLIENT_START_SIGNAL = '\x01';

function argument(name, fallback = '') {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] || fallback : fallback;
}

const socketArgument = argument('--socket');
const socketPath = socketArgument ? path.resolve(socketArgument) : '';
const codexCliArgument = argument('--codex-bin');
const codexCliRealpathArgument = argument('--codex-realpath');
const codexCliSha256Argument = argument('--codex-sha256').toLowerCase();
const codexCliPrefixArgument = argument('--codex-prefix');
const ttlRaw = Number(argument('--ttl-ms', String(DEFAULT_TTL_MS)));
const ttlMs = Number.isFinite(ttlRaw) && ttlRaw > 0 ? ttlRaw : DEFAULT_TTL_MS;
const maxRequestsRaw = Number(argument('--max-requests', String(DEFAULT_MAX_REQUESTS)));
const maxRequests = Number.isInteger(maxRequestsRaw) && maxRequestsRaw > 0
  ? maxRequestsRaw
  : DEFAULT_MAX_REQUESTS;
const maxConcurrencyRaw = Number(argument('--max-concurrency', String(DEFAULT_MAX_CONCURRENCY)));
const maxConcurrency = Number.isInteger(maxConcurrencyRaw) && maxConcurrencyRaw > 0
  ? Math.min(maxConcurrencyRaw, MAX_CONCURRENCY_LIMIT)
  : DEFAULT_MAX_CONCURRENCY;

if (!socketArgument || !socketPath || socketPath === path.dirname(socketPath)) {
  console.error('Codex auth broker socket is required');
  process.exit(2);
}

function readStdin() {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let bytes = 0;
    process.stdin.on('data', (chunk) => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > MAX_AUTH_BYTES) {
        reject(new Error('Codex auth broker input exceeds its limit'));
        process.stdin.destroy();
        return;
      }
      chunks.push(Buffer.from(chunk));
    });
    process.stdin.once('error', reject);
    process.stdin.once('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}

function validateSocketParent() {
  const parent = path.dirname(socketPath);
  const stat = fs.lstatSync(parent);
  if (!stat.isDirectory() || (stat.mode & 0o777) !== 0o700) {
    throw new Error('Codex auth broker parent must be a private 0700 directory');
  }
  if (fs.existsSync(socketPath)) {
    const socketStat = fs.lstatSync(socketPath);
    if (socketStat.isSymbolicLink()) throw new Error('Codex auth broker socket must not be a symlink');
    throw new Error('Codex auth broker socket already exists');
  }
}

// Niente regola ":slash_tmp", a differenza di claude-codex-fallback/action.yml:
// li' workspace, CODEX_HOME e TMPDIR stanno sotto RUNNER_TEMP, qui runCodex()
// li costruisce sotto os.tmpdir(), cioe' /tmp (il broker parte con `env -i`).
// Negare /tmp negava la radice del workspace stesso e, insieme a ":tmpdir",
// bwrap non poteva montare TMPDIR dentro un /tmp in sola lettura: nel gemello
// del corpus ogni richiesta moriva prima del modello ("Codex CLI exited with
// code 1", frontaliere-articles run 36001495484). ":root" = "deny" nasconde gia'
// il resto di /tmp: con `codex sandbox` 0.153.4 il workspace resta leggibile,
// auth.json, config.toml e gli altri file di /tmp no, e TMPDIR resta negato.
function permissionConfig() {
  return `default_permissions = "${CODEX_PROFILE}"

[permissions.${CODEX_PROFILE}]
description = "Read-only Codex primary in an empty temporary workspace"
extends = ":read-only"

[permissions.${CODEX_PROFILE}.network]
enabled = false

[permissions.${CODEX_PROFILE}.filesystem]
":root" = "deny"
":minimal" = "read"
":tmpdir" = "deny"

[permissions.${CODEX_PROFILE}.filesystem.":workspace_roots"]
"." = "read"
`;
}

function childEnv(codexHome, codexTmp) {
  const env = {
    PATH: safePath(),
    CODEX_HOME: codexHome,
    TMPDIR: codexTmp,
  };
  for (const key of ['LANG', 'LC_ALL', 'TERM']) {
    if (process.env[key]) env[key] = process.env[key];
  }
  return env;
}

function safePath() {
  const nodeDir = path.dirname(process.execPath);
  return process.platform === 'win32'
    ? `${nodeDir};C:\\Windows\\System32;C:\\Windows`
    : `${nodeDir}:/usr/bin:/bin`;
}

function sha256File(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function assertOutsideWorkspace(target, label) {
  let workspace;
  try { workspace = fs.realpathSync(process.cwd()); } catch { return; }
  const relative = path.relative(workspace, target);
  if (relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))) {
    throw new Error(`Codex CLI ${label} must be outside the mutable workspace`);
  }
}

/**
 * Validate the action-attested CLI before reading CODEX_AUTH_JSON. The
 * consumer only gets the Unix socket and cannot choose this path; the broker
 * accepts an absolute path from the setup action only after checking that it
 * remains in the private temporary prefix, has the expected digest, and
 * reports the pinned version without inheriting credentials.
 */
function validateCodexCli() {
  if (!path.isAbsolute(codexCliArgument) || !path.isAbsolute(codexCliRealpathArgument) || !path.isAbsolute(codexCliPrefixArgument)) {
    throw new Error('Codex CLI requires absolute --codex-bin, --codex-realpath, and --codex-prefix');
  }
  if (!/^[a-f0-9]{64}$/.test(codexCliSha256Argument)) {
    throw new Error('Codex CLI requires a valid --codex-sha256 attestation');
  }

  const prefixStat = fs.lstatSync(codexCliPrefixArgument);
  if (prefixStat.isSymbolicLink() || !prefixStat.isDirectory() || (prefixStat.mode & 0o777) !== 0o700) {
    throw new Error('Codex CLI prefix must be a real private 0700 directory');
  }
  const prefix = fs.realpathSync(codexCliPrefixArgument);
  if (!path.basename(prefix).startsWith('codex-luna-max-codex-cli.')) {
    throw new Error('Codex CLI prefix is not an action-owned temporary directory');
  }
  assertOutsideWorkspace(prefix, 'prefix');

  const cliStat = fs.lstatSync(codexCliArgument);
  if (cliStat.isSymbolicLink() || !cliStat.isFile() || (cliStat.mode & 0o111) === 0) {
    throw new Error('Codex CLI path must be a real file, not a symlink');
  }
  const cli = fs.realpathSync(codexCliArgument);
  const expectedCli = fs.realpathSync(codexCliRealpathArgument);
  if (cli !== expectedCli) throw new Error('Codex CLI realpath attestation does not match');
  const relative = path.relative(prefix, cli);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('Codex CLI must remain inside its private temporary prefix');
  }
  assertOutsideWorkspace(cli, 'binary');
  if (sha256File(cli) !== codexCliSha256Argument) {
    throw new Error('Codex CLI digest attestation does not match');
  }

  const versionProbe = spawnSync(cli, ['--version'], {
    cwd: prefix,
    env: {
      PATH: safePath(),
      CODEX_HOME: prefix,
      TMPDIR: prefix,
    },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 5000,
    killSignal: 'SIGKILL',
  });
  if (versionProbe.error) throw new Error(`Codex CLI version probe failed: ${versionProbe.error.message}`);
  const versionOutput = `${versionProbe.stdout || ''}\n${versionProbe.stderr || ''}`;
  const versionMatch = versionOutput.match(/(?:^|[^0-9])v?(\d+\.\d+\.\d+)(?:[^0-9]|$)/);
  if (versionProbe.status !== 0 || versionMatch?.[1] !== CODEX_CLI_VERSION) {
    throw new Error(`Codex CLI version mismatch: expected ${CODEX_CLI_VERSION}`);
  }
  return { cli, prefix };
}

/**
 * The broker is a long-lived host process, so killing only the direct Codex
 * child is not enough: the CLI may have helper processes in the same process
 * group. `detached: true` below makes the child a group leader on POSIX; send
 * the signal to the negative PGID there and fall back to ChildProcess.kill on
 * platforms where process groups are not available.
 */
function terminateChild(child, signal = 'SIGKILL') {
  const pid = Number(child?.pid);
  if (process.platform !== 'win32' && Number.isInteger(pid) && pid > 1 && pid !== process.pid) {
    try {
      process.kill(-pid, signal);
      return;
    } catch (error) {
      // The group may have exited between the signal and this call. For any
      // other failure, still try the direct child handle below.
      if (!['ESRCH', 'EINVAL', 'EPERM'].includes(error?.code)) {
        console.error(`Codex auth broker process-group cleanup failed: ${error.message}`);
      }
    }
  }
  try { child?.kill?.(signal); } catch { /* child already exited */ }
}

function assertPrivateRuntime(runtimeRoot, directories, files) {
  const root = path.resolve(runtimeRoot);
  const assertInside = (target) => {
    const relative = path.relative(root, path.resolve(target));
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new Error('Codex auth broker runtime path escaped its private root');
    }
  };
  const assertEntry = (target, kind, mode) => {
    assertInside(target);
    const stat = fs.lstatSync(target);
    if (stat.isSymbolicLink() || (kind === 'directory' ? !stat.isDirectory() : !stat.isFile())) {
      throw new Error(`Codex auth broker ${kind} must be a real filesystem entry`);
    }
    if ((stat.mode & 0o777) !== mode) {
      throw new Error(`Codex auth broker ${kind} has unexpected permissions`);
    }
  };
  assertEntry(root, 'directory', 0o700);
  for (const directory of directories) assertEntry(directory, 'directory', 0o700);
  for (const file of files) assertEntry(file, 'file', 0o600);
}

/**
 * L'ultima riga d'errore stampata da Codex, ridotta a cio' che puo' passare dal
 * socket. Senza, ogni fallimento si leggeva "Codex CLI exited with code 1" e un
 * profilo sandbox che rompeva tutte le richieste e' rimasto invisibile per due
 * settimane. Si tiene la CODA della riga perche' Codex concatena gli errori
 * dal piu' esterno, quindi la causa (es. il messaggio di bwrap) sta in fondo.
 * Le sequenze a forma di token vengono oscurate anche se Codex non stampa
 * credenziali, perche' questo testo finisce nei log del job.
 */
function codexFailureReason(stderr) {
  const lines = String(stderr || '')
    .replace(/\x1b\[[0-9;]*[A-Za-z]/g, '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const line = [...lines].reverse().find((candidate) => /error/i.test(candidate)) || lines.at(-1) || '';
  const safe = line
    .replace(/eyJ[\w-]+\.[\w-]+\.[\w-]+/g, '[redacted]')
    .replace(/[A-Za-z0-9_+=-]{32,}/g, '[redacted]')
    .replace(/\s+/g, ' ');
  return safe.length > MAX_FAILURE_REASON_CHARS
    ? `…${safe.slice(-(MAX_FAILURE_REASON_CHARS - 1))}`
    : safe;
}

/**
 * The login as Codex left it in the per-job home, or '' when the file is
 * missing, not a regular file, or not a JSON object (e.g. Codex was killed
 * while rewriting it). Only a usable login replaces the in-memory copy.
 */
function readUsableAuth(authPath) {
  try {
    if (!fs.lstatSync(authPath).isFile()) return '';
    const text = fs.readFileSync(authPath, 'utf8');
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? text : '';
  } catch {
    return '';
  }
}

/**
 * The broker's single CODEX_HOME, created on first use. auth.json is written
 * from memory only when the home is new or its login is unusable, so a token
 * refreshed by request N is what request N+1 starts from.
 */
function prepareAuthHome(credential) {
  if (!authHome) {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-luna-max-auth-'));
    authHome = home;
    fs.chmodSync(home, 0o700);
  }
  const authPath = path.join(authHome, 'auth.json');
  const configPath = path.join(authHome, 'config.toml');
  if (!readUsableAuth(authPath)) {
    fs.rmSync(authPath, { force: true });
    fs.writeFileSync(authPath, credential, { encoding: 'utf8', mode: 0o600 });
  }
  fs.chmodSync(authPath, 0o600);
  writeConfigIfChanged(configPath, permissionConfig());
  assertPrivateRuntime(authHome, [], [authPath, configPath]);
  return { codexHome: authHome, authPath };
}

/**
 * Con piu' corsie un altro Codex puo' leggere config.toml mentre questa
 * richiesta si prepara: un writeFileSync che tronca e riscrive gli farebbe
 * leggere un file vuoto o a meta'. Si scrive solo se cambia, e con una
 * rinomina atomica nella stessa directory 0700.
 */
function writeConfigIfChanged(configPath, content) {
  let current = null;
  try {
    if (fs.lstatSync(configPath).isFile()) current = fs.readFileSync(configPath, 'utf8');
  } catch { /* assente: si scrive */ }
  if (current === content) {
    fs.chmodSync(configPath, 0o600);
    return;
  }
  const staging = `${configPath}.${process.pid}.${crypto.randomBytes(4).toString('hex')}`;
  fs.writeFileSync(staging, content, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  fs.chmodSync(staging, 0o600);
  fs.renameSync(staging, configPath);
}

/** Il campo `exp` (secondi) di un JWT, senza verificarne la firma; NaN se illeggibile. */
function jwtExpiryMs(token) {
  try {
    const payload = JSON.parse(Buffer.from(String(token).split('.')[1] || '', 'base64url').toString('utf8'));
    const exp = Number(payload?.exp);
    return Number.isFinite(exp) ? exp * 1000 : Number.NaN;
  } catch {
    return Number.NaN;
  }
}

/**
 * true solo se il login in memoria non puo' essere rinnovato da una richiesta
 * che parte adesso: senza refresh token (login a chiave API) oppure con
 * `last_refresh` recente e un access token che sopravvive alla richiesta piu'
 * lunga. Un login illeggibile o senza date conta come rinnovabile: le
 * richieste restano una alla volta, come prima delle corsie.
 */
function loginCannotRefresh(nowMs = Date.now()) {
  let parsed;
  try { parsed = JSON.parse(authJson); } catch { return false; }
  if (!parsed || typeof parsed !== 'object') return false;
  const tokens = parsed.tokens;
  if (!tokens || typeof tokens !== 'object' || !tokens.refresh_token) {
    return typeof parsed.OPENAI_API_KEY === 'string' && parsed.OPENAI_API_KEY !== '';
  }
  const lastRefreshMs = Date.parse(String(parsed.last_refresh || ''));
  const accessExpiryMs = jwtExpiryMs(tokens.access_token);
  if (!Number.isFinite(lastRefreshMs) || !Number.isFinite(accessExpiryMs)) return false;
  if (lastRefreshMs > nowMs) return false;
  return nowMs - lastRefreshMs < LOGIN_REFRESH_SAFE_AGE_MS
    && accessExpiryMs - nowMs > LOGIN_ACCESS_TOKEN_MIN_REMAINING_MS;
}

/** Keep the in-memory login in step with a refresh Codex wrote to the home. */
function adoptRefreshedAuth() {
  if (!authHome) return;
  const refreshed = readUsableAuth(path.join(authHome, 'auth.json'));
  if (refreshed) authJson = refreshed;
}

function removeAuthHome() {
  const home = authHome;
  authHome = '';
  if (!home) return;
  try { fs.rmSync(home, { recursive: true, force: true }); } catch (error) {
    console.error(`Codex auth broker auth home cleanup failed: ${error.message}`);
  }
}

function runCodex({ authJson: credential, prompt, timeoutMs, schema, profile = 'agent', onSpawn, job }) {
  // Per-request tree: workspace, TMPDIR and the output files. The login lives
  // in the per-job home instead (prepareAuthHome), outside this tree.
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-luna-max-broker-'));
  const codexWorkspace = path.join(runtimeRoot, 'workspace');
  const codexTmp = path.join(runtimeRoot, 'tmp');
  const codexOut = path.join(runtimeRoot, 'out');
  const outputPath = path.join(codexOut, 'last-message.txt');
  const schemaPath = path.join(codexOut, 'output-schema.json');
  const instructionsPath = path.join(codexOut, 'function-instructions.md');
  const functionProfile = profile === 'function';
  let codexHome = '';
  let child = null;
  let runtimeCleaned = false;

  const finish = () => {
    // Schema, prompt output, and the private workspace are all below a fresh
    // 0700 root. This runs on success, failure, and timeout. The per-job
    // login stays in its home; a refresh Codex wrote there becomes the
    // in-memory copy too.
    if (runtimeCleaned) return;
    runtimeCleaned = true;
    if (job && job.runtimeCleanup === finish) job.runtimeCleanup = null;
    fs.rmSync(runtimeRoot, { recursive: true, force: true });
    adoptRefreshedAuth();
  };
  // Register before any setup/spawn work: a signal can arrive while the
  // runtime tree is being materialized, before the child handle exists.
  if (job) job.runtimeCleanup = finish;

  const run = new Promise((resolve, reject) => {
    try {
      fs.chmodSync(runtimeRoot, 0o700);
      fs.mkdirSync(codexWorkspace, { mode: 0o700 });
      fs.mkdirSync(codexTmp, { mode: 0o700 });
      fs.mkdirSync(codexOut, { mode: 0o700 });
      fs.chmodSync(codexWorkspace, 0o700);
      fs.chmodSync(codexTmp, 0o700);
      fs.chmodSync(codexOut, 0o700);
      ({ codexHome } = prepareAuthHome(credential));
      fs.writeFileSync(outputPath, '', { encoding: 'utf8', mode: 0o600 });
      fs.chmodSync(outputPath, 0o600);

      const args = [
        'exec',
        '--ephemeral',
        '--strict-config',
        '--ignore-rules',
        '--cd', codexWorkspace,
        '--skip-git-repo-check',
        '--model', CODEX_MODEL,
        '-c', `model_reasoning_effort=${CODEX_EFFORT}`,
        '-c', 'shell_environment_policy.ignore_default_excludes=false',
        '-c', 'shell_environment_policy.inherit=none',
        '-c', 'shell_environment_policy.include_only=["PATH","LANG","LC_ALL","TERM"]',
        '--output-last-message', outputPath,
      ];
      if (schema) {
        fs.writeFileSync(schemaPath, JSON.stringify(schema), { encoding: 'utf8', mode: 0o600 });
        fs.chmodSync(schemaPath, 0o600);
        args.push('--output-schema', schemaPath);
      }
      if (functionProfile) {
        fs.writeFileSync(instructionsPath, FUNCTION_PROFILE_INSTRUCTIONS, { encoding: 'utf8', mode: 0o600 });
        fs.chmodSync(instructionsPath, 0o600);
        args.push(
          '-c', `model_instructions_file=${JSON.stringify(instructionsPath)}`,
          '-c', 'include_permissions_instructions=false',
          '-c', 'include_environment_context=false',
          '-c', 'web_search="disabled"',
          ...FUNCTION_PROFILE_DISABLED_FEATURES.flatMap((feature) => ['--disable', feature]),
        );
      }
      assertPrivateRuntime(
        runtimeRoot,
        [codexWorkspace, codexTmp, codexOut],
        [outputPath, ...(schema ? [schemaPath] : []), ...(functionProfile ? [instructionsPath] : [])],
      );
      args.push('-');

      if (fs.realpathSync(codexCliPath) !== codexCliPath || sha256File(codexCliPath) !== codexCliSha256) {
        throw new Error('Codex CLI changed after attestation');
      }
      child = spawn(codexCliPath, args, {
        stdio: ['pipe', 'ignore', 'pipe'],
        env: childEnv(codexHome, codexTmp),
        cwd: codexWorkspace,
        detached: process.platform !== 'win32',
      });
      if (job) job.child = child;
      let stderrTail = '';
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk) => {
        stderrTail = (stderrTail + chunk).slice(-MAX_STDERR_TAIL_CHARS);
      });
      let settled = false;
      let timer = null;
      // Conta come partito solo un processo che e' partito davvero: uno spawn
      // fallito emette 'error', e la richiesta riceve risposta da li'. Il
      // budget di SIGKILL, il timer del socket e il segnale al client partono
      // tutti da questo evento, cosi' nessun lato taglia l'esecuzione prima
      // del budget che l'altro sta misurando (review della gemella del corpus,
      // nanakokyobashi-rgb/frontaliere-articles#1874).
      child.once('spawn', () => {
        if (settled) return;
        timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          terminateChild(child, 'SIGKILL');
          const error = new Error(`Codex CLI timed out after ${timeoutMs}ms`);
          error.name = 'TimeoutError';
          reject(error);
        }, timeoutMs);
        timer.unref?.();
        onSpawn?.();
      });
      child.on('error', (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      });
      child.on('close', (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (code !== 0) {
          const reason = codexFailureReason(stderrTail);
          reject(new Error(`Codex CLI exited with code ${code}${reason ? `: ${reason}` : ''}`));
          return;
        }
        try {
          const result = fs.readFileSync(outputPath, 'utf8').trim();
          if (!result) throw new Error('Codex CLI returned an empty last message');
          resolve(result);
        } catch (error) {
          reject(error);
        }
      });
      child.stdin.end(prompt);
    } catch (error) {
      reject(error);
    }
  });
  return run.finally(finish);
}

function validateRequest(request) {
  if (request?.op === 'cleanup') return '';
  if (!request || request.op !== 'exec') return 'unsupported request';
  if (typeof request.prompt !== 'string' || !request.prompt.trim()) return 'prompt is required';
  const timeoutMs = Number(request.timeoutMs);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_TIMEOUT_MS) return 'invalid timeout';
  if (request.schema !== null && request.schema !== undefined && typeof request.schema !== 'object') {
    return 'invalid output schema';
  }
  if (request.profile !== null && request.profile !== undefined && !REQUEST_PROFILES.has(request.profile)) {
    return 'invalid profile';
  }
  return '';
}

let authJson = '';
let authHome = '';
let listeningPath = '';
let codexCliPath = '';
let codexCliSha256 = '';
let codexCliPrefix = '';
let server;
let closed = false;
let acceptedRequests = 0;
// Richieste Codex concluse con successo in questo broker. Finche' e' zero le
// richieste corrono una alla volta: la prima e' quella che rinnova un login
// vecchio e riscrive auth.json nella home del job.
let completedRequests = 0;
const activeRequests = new Set();
const pendingRequests = [];
let expiry;

function cleanupJobRuntime(job) {
  if (!job) return;
  terminateChild(job.child, 'SIGKILL');
  job.child = null;
  const runtimeCleanup = job.runtimeCleanup;
  job.runtimeCleanup = null;
  try { runtimeCleanup?.(); } catch (error) {
    console.error(`Codex auth broker runtime cleanup failed: ${error.message}`);
  }
}

function cleanupRuntime() {
  for (const job of activeRequests) cleanupJobRuntime(job);
}

function cancelRequest(job) {
  if (!job || job.cancelled || job.responseStarted) return;
  job.cancelled = true;
  // Una richiesta abbandonata mentre era in coda non ha mai eseguito Codex:
  // non consuma uno dei --max-requests slot del job.
  if (!job.started && job.requestAccepted) {
    acceptedRequests = Math.max(0, acceptedRequests - 1);
  }
  if (activeRequests.has(job)) cleanupJobRuntime(job);
}

function hasQueuedWork() {
  return activeRequests.size > 0
    || pendingRequests.some((job) => !job.cancelled && !job.client.destroyed);
}

/**
 * Idle TTL, non una durata massima. Fino al 2026-09-25 questo timer partiva al
 * listen() e non veniva mai rinnovato: a 30 minuti dall'avvio il broker
 * chiudeva richiesta attiva e coda e cancellava il socket, cosi' ogni job che
 * usava Codex oltre il minuto 30 perdeva la lane («closed without a response»,
 * poi `connect ENOENT`; send-newsletter run 36116142119, broker partito alle
 * 09:08:19.8 e chiuso alle 09:38:19.79). Riparte a ogni richiesta accettata o
 * conclusa e, se scade mentre c'e' lavoro, si riarma invece di chiudere.
 */
function refreshIdleExpiry() {
  if (closed) return;
  clearTimeout(expiry);
  expiry = setTimeout(expireIfIdle, ttlMs);
  expiry.unref?.();
}

function expireIfIdle() {
  if (closed) return;
  if (hasQueuedWork()) {
    refreshIdleExpiry();
    return;
  }
  cleanup();
}

function cleanup() {
  const firstCleanup = !closed;
  closed = true;
  clearTimeout(expiry);
  for (const job of pendingRequests.splice(0)) {
    job.cancelled = true;
    job.client.destroy();
  }
  for (const job of activeRequests) {
    job.cancelled = true;
    job.client.destroy();
  }
  cleanupRuntime();
  removeAuthHome();
  authJson = '';
  if (codexCliPrefix) {
    try { fs.rmSync(codexCliPrefix, { recursive: true, force: true }); } catch (error) {
      console.error(`Codex auth broker CLI prefix cleanup failed: ${error.message}`);
    }
    codexCliPrefix = '';
  }
  if (!firstCleanup) return;
  try { server?.close(); } catch { /* already closed */ }
  try { fs.unlinkSync(socketPath); } catch { /* runner cleanup may win */ }
  if (listeningPath) {
    try { fs.unlinkSync(listeningPath); } catch { /* gia' rinominato al suo posto */ }
  }
  try { fs.rmdirSync(path.dirname(socketPath)); } catch { /* socket/client may remain */ }
}

function responseFor(client, body, onSent = cleanup) {
  if (client.destroyed) {
    onSent();
    return;
  }
  const response = `${JSON.stringify(body)}\n`;
  if (Buffer.byteLength(response) > MAX_RESPONSE_BYTES) {
    client.end(`${JSON.stringify({ ok: false, error: 'response exceeds its limit' })}\n`, onSent);
    return;
  }
  client.end(response, onSent);
}

/**
 * Quante richieste possono correre adesso. Una sola finche' nessuna richiesta
 * e' andata a buon fine, o quando il login potrebbe rinnovarsi: il refresh
 * token e' monouso, e due Codex che lo rinnovano insieme lo spenderebbero due
 * volte. Altrimenti fino a --max-concurrency: a effort max il tempo di una
 * richiesta e' quasi tutto ragionamento, e sei richieste parallele hanno
 * risposto in 11,5 s contro circa 43 s in fila (misura locale del 2026-09-29).
 */
function laneLimit(nowMs = Date.now()) {
  if (maxConcurrency <= 1 || completedRequests === 0) return 1;
  return loginCannotRefresh(nowMs) ? maxConcurrency : 1;
}

function nextPendingRequest() {
  while (pendingRequests.length > 0) {
    const candidate = pendingRequests.shift();
    if (!candidate.cancelled && !candidate.client.destroyed) return candidate;
  }
  return null;
}

function startNextRequest() {
  while (!closed && activeRequests.size < laneLimit()) {
    const job = nextPendingRequest();
    if (!job) return;
    startRequest(job);
  }
}

function startRequest(job) {
  activeRequests.add(job);
  job.started = true;
  const timeoutMs = Number(job.parsed.timeoutMs);
  // Il budget di esecuzione, dai due lati del socket, parte quando il processo
  // Codex e' davvero partito, non quando la richiesta esce dalla coda (review
  // della gemella del corpus, nanakokyobashi-rgb/frontaliere-articles#1874).
  const onSpawn = () => {
    if (job.cancelled || job.client.destroyed) return;
    job.client.setTimeout(Math.max(5000, timeoutMs + 10_000), () => {
      cancelRequest(job);
      job.client.destroy();
    });
    if (job.parsed.notifyStart === true) {
      // Un client sparito nel frattempo emette 'error'/'close', che cancellano
      // la richiesta come qualsiasi altra disconnessione.
      try { job.client.write(CLIENT_START_SIGNAL); } catch { /* client gia' chiuso */ }
    }
  };
  const credential = authJson;
  runCodex({
    authJson: credential,
    prompt: job.parsed.prompt,
    timeoutMs,
    schema: job.parsed.schema ?? null,
    profile: job.parsed.profile === 'function' ? 'function' : 'agent',
    onSpawn,
    job,
  }).then(
    (result) => {
      completedRequests += 1;
      if (job.cancelled) return;
      job.responseStarted = true;
      responseFor(job.client, { ok: true, result }, () => {});
    },
    (error) => {
      if (job.cancelled) return;
      job.responseStarted = true;
      responseFor(job.client, { ok: false, error: String(error?.message || error).slice(0, 300) }, () => {});
    },
  ).finally(() => {
    job.child = null;
    activeRequests.delete(job);
    refreshIdleExpiry();
    startNextRequest();
  });
}

function handleClient(client) {
  let request = '';
  let bytes = 0;
  let handled = false;
  const job = { client, parsed: null, requestAccepted: false, responseStarted: false, cancelled: false, started: false };
  client.setEncoding('utf8');
  client.setTimeout(5000, () => client.destroy());
  const cancelOnDisconnect = () => {
    if (job.requestAccepted && !job.responseStarted && !closed) cancelRequest(job);
  };
  client.on('error', cancelOnDisconnect);
  client.on('close', cancelOnDisconnect);
  client.on('end', () => {
    // The client half-closes after sending its JSON line. Probe the writable
    // side so a reset is distinguishable from a normal request EOF.
    if (!handled) {
      handled = true;
      responseFor(client, { ok: false, error: 'request must end with a JSON line' }, () => {});
      return;
    }
    if (job.requestAccepted && !job.responseStarted && !closed) {
      client.write(CLIENT_LIVENESS_PROBE, (error) => {
        if (!error || closed) return;
        cancelRequest(job);
        client.destroy();
      });
    }
  });
  client.on('data', (chunk) => {
    if (handled) return;
    bytes += Buffer.byteLength(chunk);
    if (bytes > MAX_REQUEST_BYTES) {
      handled = true;
      responseFor(client, { ok: false, error: 'request exceeds its limit' }, () => {});
      return;
    }
    request += chunk;
    const newline = request.indexOf('\n');
    if (newline < 0) return;
    handled = true;
    let parsed;
    try { parsed = JSON.parse(request.slice(0, newline)); } catch {
      responseFor(client, { ok: false, error: 'invalid request' }, () => {});
      return;
    }
    const validationError = validateRequest(parsed);
    if (validationError) {
      responseFor(client, { ok: false, error: validationError }, () => {});
      return;
    }
    if (parsed?.op === 'cleanup') {
      job.responseStarted = true;
      responseFor(client, { ok: true, cleaned: true });
      return;
    }
    if (acceptedRequests >= maxRequests) {
      responseFor(client, { ok: false, error: 'request limit exhausted' }, () => {});
      return;
    }
    acceptedRequests += 1;
    job.parsed = parsed;
    job.requestAccepted = true;
    client.setTimeout(0);
    pendingRequests.push(job);
    refreshIdleExpiry();
    startNextRequest();
  });
}

/**
 * Ask a running broker to terminate itself. This mode never reads stdin, so
 * the cleanup step can use the action output socket without receiving or
 * exporting CODEX_AUTH_JSON.
 */
function requestCleanup() {
  return new Promise((resolve, reject) => {
    let response = '';
    let settled = false;
    let client;
    try {
      client = net.createConnection(socketPath);
    } catch (error) {
      reject(error);
      return;
    }
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      client.destroy();
      if (error) reject(error);
      else resolve(value);
    };
    client.setEncoding('utf8');
    client.setTimeout(5000, () => finish(new Error('Codex auth broker cleanup timed out')));
    client.on('error', (error) => finish(error));
    client.on('data', (chunk) => {
      response += chunk;
      const newline = response.indexOf('\n');
      if (newline < 0) return;
      let parsed;
      try { parsed = JSON.parse(response.slice(0, newline)); } catch {
        finish(new Error('Codex auth broker cleanup returned invalid JSON'));
        return;
      }
      if (!parsed?.ok) {
        finish(new Error(String(parsed?.error || 'Codex auth broker cleanup rejected')));
        return;
      }
      finish(null, parsed);
    });
    client.on('end', () => {
      if (!settled) finish(new Error('Codex auth broker cleanup closed without a response'));
    });
    client.on('close', (hadError) => {
      if (!settled) finish(new Error(`Codex auth broker cleanup connection closed${hadError ? ' with an error' : ''}`));
    });
    client.on('connect', () => {
      try { client.end('{"op":"cleanup"}\n'); } catch (error) { finish(error); }
    });
  });
}

function start(auth, cliConfig) {
  authJson = auth;
  codexCliPath = cliConfig.cli;
  codexCliSha256 = codexCliSha256Argument;
  codexCliPrefix = cliConfig.prefix;
  validateSocketParent();
  // Clients half-close after sending each request while Codex is still
  // running; keep the server side open until the response is written.
  server = net.createServer({ allowHalfOpen: true }, handleClient);
  server.on('error', (error) => {
    console.error(`Codex auth broker failed: ${error.message}`);
    cleanup();
    process.exitCode = 1;
  });
  // Il file del socket compare al bind(), un attimo prima del listen(): chi
  // aspetta che il path esista (lo step di setup, i test) poteva connettersi
  // nel mezzo e ricevere ECONNREFUSED (gemello del corpus, PR 1773, run
  // 36038787680). Si ascolta su un nome temporaneo nella stessa directory 0700
  // e lo si rinomina solo quando accetta connessioni: «esiste» vuol dire «pronto».
  listeningPath = `${socketPath}.${process.pid}.listening`;
  server.listen(listeningPath, () => {
    try {
      fs.chmodSync(listeningPath, 0o600);
      fs.renameSync(listeningPath, socketPath);
    } catch (error) {
      console.error(`Codex auth broker failed: ${error.message}`);
      cleanup();
      process.exitCode = 1;
      return;
    }
    refreshIdleExpiry();
  });
}

if (process.argv.includes('--cleanup')) {
  requestCleanup().catch((error) => {
    console.error(`Codex auth broker cleanup unavailable: ${error.message}`);
    process.exitCode = 1;
  });
} else {
  let cliConfig;
  try {
    cliConfig = validateCodexCli();
  } catch (error) {
    console.error(`Codex auth broker unavailable: ${error.message}`);
    process.exitCode = 1;
  }
  if (cliConfig) {
    readStdin().then((auth) => {
      if (!auth.trim()) throw new Error('Codex auth broker received an empty credential');
      start(auth, cliConfig);
    }).catch((error) => {
      console.error(`Codex auth broker unavailable: ${error.message}`);
      process.exitCode = 1;
    });
  }
}

process.once('SIGTERM', () => { cleanup(); process.exit(0); });
process.once('SIGINT', () => { cleanup(); process.exit(0); });
// Last resort for an unexpected exit: never leave the per-job login behind.
process.once('exit', () => { removeAuthHome(); });
