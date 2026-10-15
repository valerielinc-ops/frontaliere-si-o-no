#!/usr/bin/env node

import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const REPO_ROOT = resolve(dirname(SCRIPT_PATH), '../..');
const DEFAULT_PROJECT = 'tsconfig.interactive.json';
const STATE_ROOT = join(tmpdir(), 'frontaliere-tsc-watch');

function runGit(args) {
  const result = spawnSync('git', args, {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.status !== 0) {
    throw new Error((result.stderr || 'git command failed').trim());
  }
  return result.stdout.trim();
}

const GIT_COMMON_DIR = resolve(
  runGit(['rev-parse', '--path-format=absolute', '--git-common-dir']),
);
const REPO_KEY = createHash('sha256').update(GIT_COMMON_DIR).digest('hex').slice(0, 20);
const LOCK_DIR = join(STATE_ROOT, REPO_KEY);
const METADATA_PATH = join(LOCK_DIR, 'metadata.json');

function readMetadata() {
  try {
    return JSON.parse(readFileSync(METADATA_PATH, 'utf8'));
  } catch {
    return null;
  }
}

function writeMetadata(metadata) {
  mkdirSync(LOCK_DIR, { recursive: true });
  const temporaryPath = join(LOCK_DIR, `metadata.${process.pid}.tmp`);
  writeFileSync(temporaryPath, `${JSON.stringify(metadata, null, 2)}\n`);
  renameSync(temporaryPath, METADATA_PATH);
}

function isAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

function processCommand(pid) {
  if (!isAlive(pid)) return '';
  const result = spawnSync('ps', ['-p', String(pid), '-o', 'command='], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  return result.status === 0 ? result.stdout.trim() : '';
}

function isWorker(metadata) {
  const command = processCommand(metadata?.workerPid);
  return command.includes('typecheck-watch.mjs') && /\bworker\b/.test(command);
}

function isTypeScriptWatch(metadata) {
  const command = processCommand(metadata?.tscPid);
  return (
    (command.includes('typescript/bin/tsc') || command.includes('typescript/lib/tsc.js')) &&
    command.includes('--watch')
  );
}

function hasOwner(metadata) {
  return (
    isWorker(metadata) ||
    isTypeScriptWatch(metadata) ||
    isAlive(metadata?.starterPid)
  );
}

function projectPath(project) {
  const candidate = resolve(REPO_ROOT, project || DEFAULT_PROJECT);
  if (candidate !== REPO_ROOT && !candidate.startsWith(`${REPO_ROOT}${sep}`)) {
    throw new Error(`Il progetto TypeScript deve restare dentro ${REPO_ROOT}`);
  }
  if (!existsSync(candidate)) {
    throw new Error(`Progetto TypeScript non trovato: ${candidate}`);
  }
  return candidate;
}

function projectName(candidate) {
  return relative(REPO_ROOT, candidate) || '.';
}

function logPath() {
  return join(REPO_ROOT, '.cache', 'tsc', 'typecheck-watch.log');
}

function withHeapLimit(value) {
  if (/--max-old-space-size(?:=|\s)\d+/.test(value || '')) return value;
  return `${value || ''} --max-old-space-size=2048`.trim();
}

function acquireLock(metadata) {
  mkdirSync(STATE_ROOT, { recursive: true });
  try {
    mkdirSync(LOCK_DIR);
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
    const existing = readMetadata();
    if (hasOwner(existing)) return false;
    rmSync(LOCK_DIR, { recursive: true, force: true });
    mkdirSync(LOCK_DIR);
  }
  writeMetadata(metadata);
  return true;
}

function cleanupWorker() {
  const metadata = readMetadata();
  if (metadata?.workerPid !== process.pid) return;
  rmSync(LOCK_DIR, { recursive: true, force: true });
}

function start() {
  const project = projectName(projectPath(process.argv[3]));
  const metadata = {
    state: 'starting',
    starterPid: process.pid,
    workerPid: null,
    tscPid: null,
    repoRoot: REPO_ROOT,
    gitCommonDir: GIT_COMMON_DIR,
    project,
    log: logPath(),
    startedAt: new Date().toISOString(),
  };

  if (!acquireLock(metadata)) {
    const existing = readMetadata();
    console.log(
      `[tsc-watch] già attivo per questo repository: worker ${existing?.workerPid ?? 'in avvio'}, ` +
        `progetto ${existing?.project ?? 'sconosciuto'} (${existing?.repoRoot ?? REPO_ROOT})`,
    );
    return;
  }

  try {
    const worker = spawn(process.execPath, [SCRIPT_PATH, 'worker', project], {
      cwd: REPO_ROOT,
      detached: true,
      stdio: 'ignore',
      env: { ...process.env },
    });
    worker.unref();
    writeMetadata({ ...metadata, starterPid: null, workerPid: worker.pid });
    console.log(`[tsc-watch] avviato: worker ${worker.pid}, progetto ${project}`);
    console.log(`[tsc-watch] log: ${logPath()}`);
  } catch (error) {
    rmSync(LOCK_DIR, { recursive: true, force: true });
    throw error;
  }
}

function startWorker(project) {
  const metadata = readMetadata();
  if (!metadata || metadata.project !== project) {
    throw new Error('Metadata del watcher assente o non coerente');
  }

  const log = logPath();
  mkdirSync(dirname(log), { recursive: true });
  const logFd = openSync(log, 'a');
  const tscPath = resolve(REPO_ROOT, 'node_modules/typescript/bin/tsc');
  const tscArgs = [
    tscPath,
    '--watch',
    '--noEmit',
    '--pretty',
    'false',
    '--preserveWatchOutput',
    '--project',
    project,
  ];
  const command = process.platform === 'win32' ? process.execPath : '/usr/bin/nice';
  const args = process.platform === 'win32' ? tscArgs : ['-n', '10', process.execPath, ...tscArgs];
  const child = spawn(command, args, {
    cwd: REPO_ROOT,
    env: { ...process.env, NODE_OPTIONS: withHeapLimit(process.env.NODE_OPTIONS) },
    stdio: ['ignore', logFd, logFd],
  });
  closeSync(logFd);

  writeMetadata({
    ...metadata,
    state: 'running',
    starterPid: null,
    workerPid: process.pid,
    tscPid: child.pid,
    log,
  });

  let stopping = false;
  const stopChild = (signal) => {
    if (stopping) return;
    stopping = true;
    if (child.exitCode === null) child.kill(signal);
  };
  process.on('SIGTERM', () => stopChild('SIGTERM'));
  process.on('SIGINT', () => stopChild('SIGINT'));

  child.on('error', (error) => {
    writeFileSync(log, `${error.stack || error}\n`, { flag: 'a' });
  });
  child.on('close', (code, signal) => {
    cleanupWorker();
    if (signal) process.exitCode = 1;
    else process.exitCode = code ?? 1;
  });
}

function status() {
  const metadata = readMetadata();
  if (!metadata) {
    console.log('[tsc-watch] non attivo per questo repository');
    return;
  }
  const active = hasOwner(metadata);
  console.log(`[tsc-watch] ${active ? 'attivo' : 'residuo non attivo'}`);
  console.log(`  repository: ${metadata.repoRoot}`);
  console.log(`  progetto:   ${metadata.project}`);
  console.log(`  worker:     ${metadata.workerPid ?? '—'}`);
  console.log(`  tsc:        ${metadata.tscPid ?? '—'}`);
  console.log(`  log:        ${metadata.log}`);
  if (!active) console.log('  esegui start per ripulire il lock e riavviare il watcher');
}

function stop() {
  const metadata = readMetadata();
  if (!metadata) {
    console.log('[tsc-watch] non attivo per questo repository');
    return;
  }
  if (isWorker(metadata)) {
    process.kill(metadata.workerPid, 'SIGTERM');
    console.log(`[tsc-watch] arresto richiesto al worker ${metadata.workerPid}`);
    return;
  }
  if (isTypeScriptWatch(metadata)) {
    process.kill(metadata.tscPid, 'SIGTERM');
    console.log(`[tsc-watch] arresto richiesto a tsc ${metadata.tscPid}`);
    return;
  }
  rmSync(LOCK_DIR, { recursive: true, force: true });
  console.log('[tsc-watch] lock residuo rimosso');
}

const command = process.argv[2] || 'status';
if (command === 'worker') startWorker(process.argv[3] || DEFAULT_PROJECT);
else if (command === 'start') start();
else if (command === 'status') status();
else if (command === 'stop') stop();
else throw new Error(`Comando sconosciuto: ${command} (usa start, status o stop)`);
