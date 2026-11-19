import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

import { isInvokedDirectly } from '../lib/is-invoked-directly.mjs';
import {
  LOOP_FLEET_LEDGER_INDEX_FILE,
  LOOP_FLEET_LEDGER_MANIFEST_FILE,
} from '../lib/loop-fleet-ledger-index.mjs';

import { projectRecord } from './prepare-fleet-ledger-projection.mjs';

const LEDGER = 'data/loop-fleet/ledger';
const REF = 'refs/remotes/origin/ledger/loop-fleet';
const OPTIONS = ['repo', 'archive-sha', 'expected-sha', 'inventory', 'output'];
const SHA = /^[a-f0-9]{40}$/u;
const CANDIDATE = /^loop-(?:observations|decisions)(?:-run-[0-9]+)?\.jsonl$/u;
const FILE_LIMIT = 72 * 1024 * 1024;
const TOTAL_LIMIT = 150 * 1024 * 1024;
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const projection = fileURLToPath(new URL('./prepare-fleet-ledger-projection.mjs', import.meta.url));
const indexModule = new URL('../lib/loop-fleet-ledger-index.mjs', import.meta.url).href;
const gitEnv = {
  PATH: process.env.PATH,
  LC_ALL: 'C',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_NO_LAZY_FETCH: '1',
  GIT_NO_REPLACE_OBJECTS: '1',
  GIT_OPTIONAL_LOCKS: '0',
  GIT_TERMINAL_PROMPT: '0',
  GIT_ALLOW_PROTOCOL: '',
  GIT_AUTHOR_NAME: 'Fleet Ledger Maintenance',
  GIT_AUTHOR_EMAIL: 'fleet-ledger@maintenance.invalid',
  GIT_COMMITTER_NAME: 'Fleet Ledger Maintenance',
  GIT_COMMITTER_EMAIL: 'fleet-ledger@maintenance.invalid',
};

function requireThat(condition) {
  if (!condition) throw new Error('invalid migration');
}

function command(file, args, input, maxBuffer = FILE_LIMIT, env = gitEnv) {
  return execFileSync(file, args, {
    env, input, maxBuffer, timeout: 60_000, stdio: ['pipe', 'pipe', 'pipe'],
  });
}

function git(repo, args, input, maxBuffer, env) {
  return command('git', ['-C', repo, '-c', 'core.fsmonitor=false', ...args], input, maxBuffer, env);
}

function optionsFrom(argv) {
  requireThat(process.versions.node.split('.')[0] === '22' && argv.length === OPTIONS.length * 2);
  const options = new Map();
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i].slice(2);
    const value = argv[i + 1];
    requireThat(argv[i] === '--' + key && OPTIONS.includes(key) && !options.has(key));
    requireThat(key.endsWith('-sha') ? SHA.test(value) : path.isAbsolute(value) && path.resolve(value) === value);
    options.set(key, value);
  }
  return Object.fromEntries(options);
}

function statIfPresent(file) {
  try {
    return fs.lstatSync(file);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return null;
  }
}

function privateMode(stat, mode) {
  return stat.uid === process.getuid() && (stat.mode & 0o7777) === mode;
}

function checkOutput(output) {
  const parent = path.dirname(output);
  requireThat(fs.realpathSync.native(parent) === parent && !statIfPresent(output));
  const stat = fs.lstatSync(parent);
  requireThat(stat.isDirectory() && privateMode(stat, 0o700));
  for (let dir = parent; ; dir = path.dirname(dir)) {
    requireThat(!statIfPresent(path.join(dir, '.git')));
    requireThat(!(statIfPresent(path.join(dir, 'HEAD')) && statIfPresent(path.join(dir, 'objects'))));
    if (dir === path.dirname(dir)) break;
  }
}

function readInventory(file, archive) {
  requireThat(fs.realpathSync.native(file) === file);
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  let document;
  try {
    const stat = fs.fstatSync(fd);
    requireThat(stat.isFile() && stat.nlink === 1 && privateMode(stat, 0o600) && stat.size <= 1024 * 1024);
    const data = Buffer.alloc(stat.size + 1);
    let size = 0;
    while (size < data.length) {
      const read = fs.readSync(fd, data, size, data.length - size, null);
      if (!read) break;
      size += read;
    }
    requireThat(size === stat.size);
    document = JSON.parse(decoder.decode(data.subarray(0, size)));
  } finally {
    fs.closeSync(fd);
  }
  requireThat(document?.source === archive && Array.isArray(document.files)
    && document.files.length > 0 && document.files.length <= 300);
  const inventory = new Map();
  let total = 0;
  for (const { path: file, gitOid, sha256, bytes, gzipBytes, records } of document.files) {
    requireThat(typeof file === 'string' && file === LEDGER + '/' + path.basename(file)
      && CANDIDATE.test(path.basename(file)) && !inventory.has(file));
    requireThat(typeof gitOid === 'string' && SHA.test(gitOid)
      && typeof sha256 === 'string' && /^[a-f0-9]{64}$/u.test(sha256));
    requireThat(Number.isSafeInteger(records) && records >= 0
      && [bytes, gzipBytes].every((value) => Number.isSafeInteger(value) && value > 0));
    total += bytes;
    requireThat(bytes <= FILE_LIMIT && total <= TOTAL_LIMIT);
    inventory.set(file, { path: file, gitOid, sha256, bytes, gzipBytes, records });
  }
  return inventory;
}

function ledgerTree(repo, sha) {
  requireThat(git(repo, ['cat-file', '-t', sha]).toString().trim() === 'commit');
  requireThat(git(repo, ['cat-file', '-t', sha + ':' + LEDGER]).toString().trim() === 'tree');
  const entries = new Map();
  const tree = decoder.decode(git(repo, ['ls-tree', '-z', sha + ':' + LEDGER]));
  for (const row of tree.split('\0').slice(0, -1)) {
    const match = /^(100644|100755) blob ([a-f0-9]{40})\t([a-zA-Z0-9][a-zA-Z0-9._-]*)$/u.exec(row);
    requireThat(match && !entries.has(LEDGER + '/' + match[3]));
    const [, mode, oid, name] = match;
    requireThat(!/^loop-(?:observations|decisions)/iu.test(name) || CANDIDATE.test(name));
    entries.set(LEDGER + '/' + name, { mode, oid });
  }
  return entries;
}

function containsEconomicRecord(bytes) {
  return decoder.decode(bytes).split('\n').some((line) => {
    if (!line.trim()) return false;
    const record = JSON.parse(line);
    requireThat(record && typeof record === 'object' && !Array.isArray(record));
    return projectRecord(record) !== null;
  });
}

function readBlob(repo, oid) {
  return git(repo, ['cat-file', 'blob', oid], undefined, TOTAL_LIMIT);
}

function preflight(repo, archive, expected, inventory, indexFile, manifestFile) {
  const before = ledgerTree(repo, archive);
  const current = ledgerTree(repo, expected);
  requireThat(current.has(indexFile) && current.has(manifestFile));
  for (const file of before.keys()) {
    if (CANDIDATE.test(path.basename(file))) requireThat(current.has(file));
  }
  for (const [file, metadata] of inventory) {
    requireThat(before.get(file)?.oid === metadata.gitOid && current.get(file)?.oid === metadata.gitOid);
  }
  for (const [file, { oid }] of current) {
    const metadata = inventory.get(file);
    if (metadata) {
      const data = readBlob(repo, oid);
      requireThat(data.length === metadata.bytes
        && createHash('sha256').update(data).digest('hex') === metadata.sha256
        && createHash('sha1').update('blob ' + data.length + '\0').update(data).digest('hex') === oid);
    } else if (CANDIDATE.test(path.basename(file)) && before.get(file)?.oid !== oid) {
      requireThat(!containsEconomicRecord(readBlob(repo, oid)));
    }
  }
  return current;
}

function write(file, data) {
  fs.writeFileSync(file, data, { flag: 'wx', mode: 0o600 });
}

async function materializeLedger(repo, expected, ledgerDir) {
  // Archive the validated subtree in the isolated repo so source attributes
  // cannot omit files or substitute their contents.
  const tree = git(repo, ['rev-parse', expected + ':' + LEDGER]).toString().trim();
  fs.mkdirSync(ledgerDir, { recursive: true, mode: 0o700 });
  const archive = spawn('git', ['-C', repo, '-c', 'core.attributesFile=/dev/null', 'archive', '--format=tar', tree], {
    env: { ...gitEnv, GIT_ATTR_NOSYSTEM: '1' }, stdio: ['ignore', 'pipe', 'ignore'],
  });
  const extract = spawn('tar', ['-xf', '-', '-C', ledgerDir, '--no-same-permissions'], {
    env: gitEnv, stdio: ['pipe', 'ignore', 'ignore'],
  });
  const stop = () => {
    archive.kill('SIGKILL');
    extract.kill('SIGKILL');
  };
  const wait = (child) => new Promise((resolve, reject) => {
    child.once('error', stop);
    child.once('close', (code) => {
      if (code === 0) resolve();
      else {
        stop();
        reject(new Error('ledger materialization failed'));
      }
    });
  });
  const timeout = setTimeout(stop, 60_000);
  try {
    const results = await Promise.allSettled([
      wait(archive), wait(extract), pipeline(archive.stdout, extract.stdin).catch((error) => {
        stop();
        throw error;
      }),
    ]);
    requireThat(results.every(({ status }) => status === 'fulfilled'));
  } finally {
    clearTimeout(timeout);
  }
}

async function prepare(argv) {
  let stage = 'arguments';
  let createdOutput;
  try {
    const { repo, 'archive-sha': archive, 'expected-sha': expected, inventory: inventoryFile, output } = optionsFrom(argv);
    stage = 'staging';
    checkOutput(output);
    stage = 'source';
    requireThat(fs.realpathSync.native(repo) === repo
      && git(repo, ['rev-parse', '--show-toplevel']).toString().trim() === repo);
    const checkPin = () => requireThat(git(repo, ['show-ref', '--verify', '--hash', REF]).toString().trim() === expected);
    checkPin();
    const objects = fs.realpathSync.native(git(repo, ['rev-parse', '--path-format=absolute', '--git-path', 'objects']).toString().trim());
    requireThat(!/[\r\n]/u.test(objects) && fs.statSync(objects).isDirectory());
    stage = 'inventory';
    const inventory = readInventory(inventoryFile, archive);
    const indexFile = LEDGER + '/' + LOOP_FLEET_LEDGER_INDEX_FILE;
    const manifestFile = LEDGER + '/' + LOOP_FLEET_LEDGER_MANIFEST_FILE;
    stage = 'preflight';
    const current = preflight(repo, archive, expected, inventory, indexFile, manifestFile);
    checkPin();

    stage = 'staging';
    fs.mkdirSync(output, { mode: 0o700 });
    createdOutput = output;
    const candidateRepo = path.join(output, 'candidate');
    fs.mkdirSync(candidateRepo, { mode: 0o700 });
    git(candidateRepo, ['init', '--quiet', '--object-format=sha1', '--template=']);
    write(path.join(candidateRepo, '.git/objects/info/alternates'), objects + '\n');
    git(candidateRepo, ['read-tree', expected]);
    const ledgerDir = path.join(candidateRepo, LEDGER);
    stage = 'materialization';
    await materializeLedger(candidateRepo, expected, ledgerDir);
    const work = fs.mkdtempSync(path.join(output, 'inputs-'));
    const restored = path.join(work, 'restored');
    const indexInput = path.join(work, 'index');
    const projected = path.join(work, 'projected');
    const rebasedInventory = path.join(work, 'inventory.json');
    for (const dir of [restored, indexInput]) fs.mkdirSync(dir, { mode: 0o700 });
    for (const [dir, paths] of [[restored, inventory.keys()], [indexInput, [indexFile, manifestFile]]]) {
      for (const file of paths) {
        const name = path.basename(file);
        const target = path.join(dir, name);
        fs.copyFileSync(path.join(ledgerDir, name), target, fs.constants.COPYFILE_EXCL);
        fs.chmodSync(target, 0o600);
      }
    }
    write(rebasedInventory, JSON.stringify({ source: expected, files: [...inventory.values()] }));
    stage = 'projection';
    const result = command(process.execPath, [projection, '--sha', expected, '--inventory', rebasedInventory,
      '--restored', restored, '--index', indexInput, '--output', projected]).toString();
    const counts = /^OK files=(\d+) records=(\d+) indexEntries=(\d+)\n$/u.exec(result);
    requireThat(counts && counts[0] === result);
    const [, files, records, indexEntries] = counts.map(Number);

    stage = 'writer-diff';
    const changes = new Map([[manifestFile, 'D']]);
    const projectedNames = new Set(fs.readdirSync(projected));
    requireThat(projectedNames.has(LOOP_FLEET_LEDGER_INDEX_FILE) && projectedNames.size === files + 1);
    for (const name of projectedNames) {
      const file = LEDGER + '/' + name;
      const original = current.get(file);
      requireThat(original && (file === indexFile || inventory.has(file)));
      const replacement = path.join(projected, name);
      const destination = path.join(ledgerDir, name);
      const oid = git(candidateRepo, ['hash-object', '-w', '--no-filters', '--', replacement]).toString().trim();
      fs.chmodSync(replacement, fs.statSync(destination).mode & 0o700);
      fs.renameSync(replacement, destination);
      git(candidateRepo, ['update-index', '--cacheinfo', original.mode, oid, file]);
      if (oid !== original.oid) changes.set(file, 'M');
    }
    fs.unlinkSync(path.join(candidateRepo, manifestFile));
    git(candidateRepo, ['update-index', '--force-remove', '--', manifestFile]);

    command(process.execPath, ['--input-type=module', '--eval', `
      import { loadLedgerIndexForWriter } from ${JSON.stringify(indexModule)};
      const { index, trackedFileOids } = loadLedgerIndexForWriter(process.argv[1]);
      if (!index.exists || !trackedFileOids || index.entries.length !== Number(process.argv[2])) process.exit(1);
    `, ledgerDir, String(indexEntries)]);
    const diff = decoder.decode(git(candidateRepo, [
      'diff', '--cached', '--name-status', '--no-renames', '-z', expected, '--',
    ])).split('\0');
    requireThat(diff.pop() === '' && diff.length === changes.size * 2);
    for (let i = 0; i < diff.length; i += 2) {
      requireThat(changes.get(diff[i + 1]) === diff[i]);
      changes.delete(diff[i + 1]);
    }
    stage = 'commit';
    const tree = git(candidateRepo, ['write-tree']).toString().trim();
    const timestamp = git(repo, ['show', '-s', '--format=%ct', expected]).toString().trim();
    requireThat(/^\d+$/u.test(timestamp));
    const date = '@' + timestamp + ' +0000';
    const candidate = git(candidateRepo, ['commit-tree', tree, '-p', expected, '-m', 'Prepare fleet ledger migration'],
      undefined, undefined, { ...gitEnv, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date }).toString().trim();
    requireThat(SHA.test(candidate)
      && git(candidateRepo, ['rev-list', '--parents', '-n', '1', candidate]).toString().trim() === candidate + ' ' + expected);
    checkPin();
    stage = 'receipt';
    fs.rmSync(work, { recursive: true });
    write(path.join(output, 'receipt.json'), JSON.stringify({
      archiveSha: archive, expectedSha: expected, candidateSha: candidate, files, records, indexEntries,
    }) + '\n');
    process.stdout.write(result);
  } catch {
    if (createdOutput) {
      try {
        fs.rmSync(createdOutput, { recursive: true, force: true });
      } catch {
        stage = 'cleanup';
      }
    }
    process.stderr.write(`ERROR migration ${stage}\n`);
    process.exitCode = 1;
  }
}

if (isInvokedDirectly(import.meta.url)) {
  process.umask(0o077);
  await prepare(process.argv.slice(2));
}
