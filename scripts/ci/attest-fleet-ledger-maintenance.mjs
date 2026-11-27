import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

import { isInvokedDirectly } from '../lib/is-invoked-directly.mjs';
import { projectRecord } from './prepare-fleet-ledger-projection.mjs';

const ARCHIVE_L8 = '1c6010d0791d4e8de3125c4f7637319da2ff70fd';
const SCOPES = Object.freeze({
  l8: Object.freeze({
    archiveSha: ARCHIVE_L8,
    counts: Object.freeze({ files: 152, records: 374 }),
    allowAutoPin: true,
  }),
  // Pin the L9 redaction to the archived current tip and its measured rows.
  'l9-mrr': Object.freeze({
    counts: Object.freeze({ files: 2, records: 146 }),
    allowAutoPin: false,
  }),
});
const REMOTE = 'https://github.com/valerielinc-ops/frontaliere-si-o-no.git';
const REF = 'refs/heads/ledger/loop-fleet';
const PIN = 'refs/remotes/origin/ledger/loop-fleet';
const LEDGER = 'data/loop-fleet/ledger';
const SHA = /^[a-f0-9]{40}$/u;
const DIGEST = /^[a-f0-9]{64}$/u;
const RECORD_FILE = /^loop-(observation|decision)s(?:-run-[0-9]+)?\.jsonl$/u;
const MIGRATION_STAGES = [
  'arguments', 'source', 'inventory', 'preflight', 'staging', 'materialization',
  'projection', 'writer-diff', 'commit', 'receipt', 'cleanup',
];
const STALE_TIP = Symbol('stale tip');
const CANDIDATE_MISMATCH = Symbol('candidate mismatch');
const MiB = 1024 * 1024;
const TREE_LIMIT = 8 * MiB;
const FILE_LIMIT = 72 * MiB;
const TOTAL_LIMIT = 150 * MiB;
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const gitEnv = {
  PATH: process.env.PATH,
  LC_ALL: 'C',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_NO_LAZY_FETCH: '1',
  GIT_NO_REPLACE_OBJECTS: '1',
  GIT_OPTIONAL_LOCKS: '0',
  GIT_TERMINAL_PROMPT: '0',
};

function requireThat(condition) {
  if (!condition) throw new Error('invalid maintenance');
}

function git(repo, args, { maxBuffer = MiB, remote, token, hooks } = {}) {
  const env = {
    ...gitEnv,
    GIT_ALLOW_PROTOCOL: remote === REMOTE ? 'https' : remote ? 'file' : '',
  };
  const config = ['-c', 'core.fsmonitor=false', '-c', 'credential.helper=',
    '-c', 'http.followRedirects=false', '-c', 'push.gpgSign=false',
    '-c', 'core.hooksPath=' + (hooks ?? '/dev/null')];
  if (token) {
    requireThat(remote === REMOTE && /^[A-Za-z0-9._-]{1,4096}$/u.test(token));
    env.LEDGER_HEADER = 'Authorization: Basic ' + Buffer.from('x-access-token:' + token).toString('base64');
    config.push('--config-env=http.https://github.com/.extraHeader=LEDGER_HEADER');
  }
  const gitArgs = ['-C', repo, ...config, ...args];
  // On Actions, bound the whole transport, including Git's HTTPS helper.
  const [command, ...commandArgs] = remote === REMOTE
    ? ['timeout', '--kill-after=5s', '90s', 'git', ...gitArgs]
    : ['git', ...gitArgs];
  return execFileSync(command, commandArgs, {
    env, maxBuffer, timeout: 100_000, killSignal: 'SIGKILL', stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function parseOrdinals(csv, count) {
  requireThat(Number.isSafeInteger(count) && count > 0 && count <= 300
    && typeof csv === 'string' && csv.length <= count * 8
    && /^[1-9][0-9]{0,6}(?:,[1-9][0-9]{0,6})*$/u.test(csv));
  const positions = csv.split(',').map(Number);
  requireThat(positions.length === count && positions.every((value, i) => !i || value > positions[i - 1]));
  return positions;
}

function privateDirectory(dir) {
  requireThat(path.isAbsolute(dir) && fs.realpathSync.native(dir) === dir);
  const stat = fs.lstatSync(dir);
  requireThat(stat.isDirectory() && stat.uid === process.getuid() && (stat.mode & 0o7777) === 0o700);
}

function exists(file) {
  return fs.lstatSync(file, { throwIfNoEntry: false }) !== undefined;
}

function checkOutput(output) {
  requireThat(path.isAbsolute(output) && path.resolve(output) === output && !exists(output));
  const parent = path.dirname(output);
  privateDirectory(parent);
  for (let dir = parent; ; dir = path.dirname(dir)) {
    requireThat(!exists(path.join(dir, '.git')));
    requireThat(!(exists(path.join(dir, 'HEAD')) && exists(path.join(dir, 'objects'))));
    if (dir === path.dirname(dir)) break;
  }
}

function assertCommit(repo, sha) {
  requireThat(git(repo, ['rev-parse', '--verify', '--end-of-options', sha]).toString() === sha + '\n'
    && git(repo, ['cat-file', '-t', sha]).toString() === 'commit\n');
}

export function attest({ repo, archiveSha, ordinals, attestationSha256, output }, counts) {
  requireThat(SHA.test(archiveSha) && DIGEST.test(attestationSha256)
    && Number.isSafeInteger(counts.records) && counts.records >= counts.files);
  const positions = parseOrdinals(ordinals, counts.files);
  checkOutput(output);
  assertCommit(repo, archiveSha);
  const subtree = archiveSha + ':' + LEDGER;
  requireThat(git(repo, ['cat-file', '-t', subtree]).toString() === 'tree\n');
  const rows = decoder.decode(git(repo, ['ls-tree', '-z', subtree], { maxBuffer: TREE_LIMIT })).split('\0');
  requireThat(rows.pop() === '' && positions.at(-1) <= rows.length);
  const seen = new Set();
  const tree = rows.map((row) => {
    const match = /^(100644|100755) blob ([a-f0-9]{40})\t([a-zA-Z0-9][a-zA-Z0-9._-]*)$/u.exec(row);
    requireThat(match && !seen.has(match[3]));
    const [, , oid, name] = match;
    requireThat(!/^loop-(?:observations|decisions)/iu.test(name) || RECORD_FILE.test(name));
    seen.add(name);
    return { oid, name };
  });

  let totalBytes = 0;
  let totalRecords = 0;
  const files = positions.map((position) => {
    const { oid, name } = tree[position - 1];
    const selected = RECORD_FILE.exec(name);
    requireThat(selected);
    const data = git(repo, ['cat-file', 'blob', oid], { maxBuffer: FILE_LIMIT });
    totalBytes += data.length;
    requireThat(data.length <= FILE_LIMIT && totalBytes <= TOTAL_LIMIT && data.at(-1) === 10);
    requireThat(createHash('sha1').update('blob ' + data.length + '\0').update(data).digest('hex') === oid);
    let records = 0;
    for (let start = 0; start < data.length; ) {
      const end = data.indexOf(10, start);
      const record = JSON.parse(decoder.decode(data.subarray(start, end)));
      requireThat(record && typeof record === 'object' && !Array.isArray(record)
        && record.recordType === selected[1] && typeof record.recordId === 'string'
        && record.recordId !== '' && record.recordId.trim() === record.recordId);
      if (projectRecord(record) !== null) {
        records++;
        requireThat(++totalRecords <= counts.records);
      }
      start = end + 1;
    }
    requireThat(records > 0);
    return {
      path: LEDGER + '/' + name, gitOid: oid, sha256: createHash('sha256').update(data).digest('hex'),
      bytes: data.length, gzipBytes: gzipSync(data).length, records,
    };
  });
  const entries = files.map(({ path, gitOid, sha256, bytes, records }) => [path, gitOid, sha256, bytes, records]);
  requireThat(totalRecords === counts.records
    && createHash('sha256').update(JSON.stringify([archiveSha, entries])).digest('hex') === attestationSha256);
  const inventory = JSON.stringify({ source: archiveSha, files });
  requireThat(Buffer.byteLength(inventory) <= MiB);
  const fd = fs.openSync(output, 'wx', 0o600);
  try {
    try {
      fs.fchmodSync(fd, 0o600);
      fs.writeFileSync(fd, inventory);
    } finally {
      fs.closeSync(fd);
    }
  } catch (error) {
    fs.unlinkSync(output);
    throw error;
  }
}

function readback(repo, remote, readToken) {
  const result = git(repo, ['ls-remote', '--exit-code', '--refs', remote, REF], { remote, token: readToken }).toString();
  const sha = result.slice(0, 40);
  requireThat(SHA.test(sha) && result === sha + '\t' + REF + '\n');
  return sha;
}

function assertCandidateParent(repo, expected, candidate) {
  requireThat(SHA.test(expected) && SHA.test(candidate) && expected !== candidate);
  requireThat(git(repo, ['rev-list', '--parents', '-n', '1', candidate]).toString() === candidate + ' ' + expected + '\n');
}

export function pushCandidate({ repo, source, remote, expected, candidate, readToken, writeToken, allowFallback }) {
  assertCandidateParent(repo, expected, candidate);
  const before = readback(repo, remote, readToken);
  if (before === candidate) return 'published';
  requireThat(before === expected);
  if (!writeToken) {
    requireThat(allowFallback);
    return 'fallback';
  }

  // Only the negotiated parent is needed from the source's shallow boundary.
  const sourceShallow = path.join(source, '.git/shallow');
  if (exists(sourceShallow) && fs.readFileSync(sourceShallow, 'utf8').split('\n').includes(expected)) {
    const shallow = path.join(repo, '.git/shallow');
    if (exists(shallow)) requireThat(fs.readFileSync(shallow, 'utf8') === expected + '\n');
    else fs.writeFileSync(shallow, expected + '\n', { flag: 'wx', mode: 0o600 });
  }

  const hooks = fs.mkdtempSync(path.join(repo, '.git/maintenance-hooks-'));
  try {
    fs.writeFileSync(path.join(hooks, 'pre-push'), `#!/bin/sh
IFS=' ' read -r local_ref local_oid remote_ref remote_oid extra || exit 1
[ "$local_ref" = '${candidate}' ] && [ "$local_oid" = '${candidate}' ] &&
[ "$remote_ref" = '${REF}' ] && [ "$remote_oid" = '${expected}' ] &&
[ -z "$extra" ] || exit 1
extra=''
if IFS= read -r extra || [ -n "$extra" ]; then exit 1; fi
`, { flag: 'wx', mode: 0o700 });
    try {
      git(repo, ['push', '--thin', '--no-follow-tags', '--recurse-submodules=no',
        remote, candidate + ':' + REF], { remote, hooks, token: remote === REMOTE ? writeToken : undefined });
    } catch {
      const afterFailure = readback(repo, remote, readToken);
      if (afterFailure === candidate) return 'published';
      requireThat(allowFallback && afterFailure === expected);
      return 'fallback';
    }
    requireThat(readback(repo, remote, readToken) === candidate);
    return 'published';
  } finally {
    fs.rmSync(hooks, { recursive: true, force: true });
  }
}

function receipt(root, expected, candidate, archive, counts) {
  const file = path.join(root, 'stage/receipt.json');
  const stat = fs.lstatSync(file);
  requireThat(stat.isFile() && stat.size <= 1024 && (stat.mode & 0o7777) === 0o600);
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  requireThat(Object.keys(data).length === 6 && data.archiveSha === archive && data.expectedSha === expected
    && typeof data.candidateSha === 'string' && SHA.test(data.candidateSha)
    && data.files === counts.files && data.records === counts.records
    && Number.isSafeInteger(data.indexEntries) && data.indexEntries >= data.records);
  if (candidate !== undefined && data.candidateSha !== candidate) throw CANDIDATE_MISMATCH;
  return data.candidateSha;
}

function stepSecret(file, key, capability) {
  const stat = fs.lstatSync(file);
  requireThat(stat.isFile() && stat.size <= 16 * 1024 && stat.uid === process.getuid()
    && (stat.mode & 0o7777) === 0o600);
  const entries = fs.readFileSync(file, 'utf8').split('\n');
  if (capability && entries.filter((entry) => entry.startsWith(capability + '=')).join() !== capability + '=true') {
    return '';
  }
  const prefix = key + '=';
  const lines = entries.filter((line) => line.startsWith(prefix));
  return lines.length === 1 ? lines[0].slice(prefix.length) : '';
}

function run() {
  let stage = 'arguments';
  try {
    requireThat(process.argv.length === 4);
    const [, , operation, root] = process.argv;
    requireThat(operation === 'prepare' || operation === 'app' || operation === 'fallback');
    const {
      AUTO_PIN: autoPinInput = 'false', ORDINALS: ordinals,
      PROJECTION_SCOPE: projectionScope = 'l8',
      ATTESTATION_SHA256: attestationSha256, READ_TOKEN: readToken,
    } = process.env;
    let { EXPECTED_SHA: expected = '', CANDIDATE_SHA: candidate = '' } = process.env;
    const scope = Object.hasOwn(SCOPES, projectionScope) ? SCOPES[projectionScope] : undefined;
    const autoPin = operation === 'prepare' && autoPinInput === 'true';
    requireThat(process.versions.node.split('.')[0] === '22' && readToken);
    requireThat(scope && (!autoPin || scope.allowAutoPin));
    requireThat(operation !== 'prepare' || autoPinInput === 'true' || autoPinInput === 'false');
    requireThat(autoPin ? !expected && !candidate
      : SHA.test(expected) && SHA.test(candidate) && expected !== candidate);
    const counts = scope.counts;
    const archive = scope.archiveSha ?? expected;
    stage = 'root';
    privateDirectory(root);
    const source = fs.realpathSync.native(process.cwd());
    if (operation === 'prepare') {
      stage = 'arguments';
      requireThat(DIGEST.test(attestationSha256));
      parseOrdinals(ordinals, counts.files);
      stage = 'tip-fetch';
      git(source, ['fetch', '--no-tags', '--no-recurse-submodules', '--depth=1', '--filter=blob:limit=1g',
        REMOTE, REF + ':' + PIN], { remote: REMOTE, token: readToken });
      stage = 'tip-verify';
      const tip = git(source, ['show-ref', '--verify', '--hash', PIN]).toString();
      if (!autoPin && tip !== expected + '\n') {
        throw STALE_TIP;
      }
      const tipSha = tip.slice(0, 40);
      requireThat(SHA.test(tipSha) && tip === tipSha + '\n' && tipSha !== '0'.repeat(40));
      assertCommit(source, tipSha);
      expected = tipSha;
      if (archive !== tipSha) {
        stage = 'archive-fetch';
        git(source, ['fetch', '--no-tags', '--no-recurse-submodules', '--depth=1', '--filter=blob:limit=1g',
          REMOTE, archive], { remote: REMOTE, token: readToken });
      }
      const inventory = path.join(root, 'inventory.json');
      const staging = path.join(root, 'stage');
      stage = 'inventory';
      attest({ repo: source, archiveSha: archive, ordinals, attestationSha256, output: inventory }, counts);
      stage = 'candidate';
      const tool = fileURLToPath(new URL('./prepare-fleet-ledger-migration.mjs', import.meta.url));
      const result = spawnSync(process.execPath, [tool, '--repo', source, '--archive-sha', archive,
        '--expected-sha', expected, '--inventory', inventory, '--output', staging], {
        env: gitEnv, timeout: 300_000, killSignal: 'SIGKILL',
        stdio: ['ignore', 'ignore', 'pipe'], maxBuffer: 1024, encoding: 'utf8',
      });
      // Accept only the preparer's exact single-line failure protocol.
      if (!result.error && result.status === 1) {
        const code = MIGRATION_STAGES.find((code) => result.stderr === 'ERROR migration ' + code + '\n');
        if (code) stage = 'candidate-' + code;
      }
      requireThat(!result.error && result.status === 0);
    }

    stage = 'receipt';
    candidate = receipt(root, expected, autoPin ? undefined : candidate, archive, counts);
    let result = 'verified';
    if (operation === 'prepare') {
      assertCandidateParent(path.join(root, 'stage/candidate'), expected, candidate);
    } else {
      stage = 'application';
      const allowFallback = operation === 'app';
      const writeToken = allowFallback
        ? stepSecret(path.join(root, 'app.env'), 'APP_TOKEN', 'APP_TOKEN_DATA_REFRESH')
        : stepSecret(path.join(root, 'fallback.env'), 'GITHUB_PAT');
      result = pushCandidate({
        repo: path.join(root, 'stage/candidate'), source, remote: REMOTE, expected, candidate,
        readToken, writeToken, allowFallback,
      });
    }

    stage = 'summary';
    if (result !== 'fallback') {
      const summary = result + ' archive=' + archive + ' parent=' + expected
        + ' candidate=' + candidate + ' files=' + counts.files + ' records=' + counts.records;
      fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary + '\n');
    }
    if (operation === 'prepare') {
      stage = 'output';
      fs.appendFileSync(process.env.GITHUB_OUTPUT, 'expected_sha=' + expected + '\ncandidate_sha=' + candidate + '\n');
    }
    process.stdout.write(result + '\n');
  } catch (error) {
    const code = error === CANDIDATE_MISMATCH ? 'receipt-candidate-mismatch' : stage;
    process.stderr.write(error === STALE_TIP ? 'ERROR stale ledger tip\n' : `ERROR ledger maintenance ${code}\n`);
    process.exitCode = 1;
  }
}

if (isInvokedDirectly(import.meta.url)) {
  process.umask(0o077);
  run();
}
