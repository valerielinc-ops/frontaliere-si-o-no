import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it } from 'vitest';
import { parse } from 'yaml';

import { attest, pushCandidate } from '../scripts/ci/attest-fleet-ledger-maintenance.mjs';
import { digestDocument } from '../scripts/lib/canonical-json-digest.mjs';

const script = new URL('../scripts/ci/attest-fleet-ledger-maintenance.mjs', import.meta.url);
const candidateTool = fileURLToPath(new URL('../scripts/ci/prepare-fleet-ledger-migration.mjs', import.meta.url));
const ledger = 'data/loop-fleet/ledger';
const ref = 'refs/heads/ledger/loop-fleet';
const pin = 'refs/remotes/origin/ledger/loop-fleet';
const roots: string[] = [];
const env = {
  PATH: process.env.PATH,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_ALLOW_PROTOCOL: 'file',
  GIT_AUTHOR_NAME: 'Fixture',
  GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
  GIT_COMMITTER_NAME: 'Fixture',
  GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
};

function git(repo: string, args: string[]) {
  return execFileSync('git', ['-C', repo, ...args], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trimEnd();
}

const sha256 = (data: string) => createHash('sha256').update(data).digest('hex');

function fixture(variant?: 'invalid-json' | 'missing-lf' | 'wrong-type' | 'unprojectable' | 'symlink' | 'noncanonical', withIntermediate = false) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'maintenance-'));
  roots.push(root);
  const repo = path.join(root, 'source');
  const output = path.join(root, 'inventory.json');
  fs.mkdirSync(path.join(repo, ledger), { recursive: true });
  git(repo, ['init', '--quiet', '--object-format=sha1', '--template=']);
  const decision = 'loop-decisions-run-1.jsonl';
  const observation = 'loop-observations.jsonl';
  const index = 'ledger-record-index.jsonl';
  const manifest = 'ledger-record-index-manifest.jsonl';
  const write = (name: string, data: string) => fs.writeFileSync(path.join(repo, ledger, name), data);
  const rows = (...records: unknown[]) => records.map((record) => JSON.stringify(record) + '\n').join('');
  const history = { adsense: { rpm: 1, impressions: 2 } };
  const first = { recordId: 'd', recordType: 'decision', loopId: 'L8', sourceSnapshot: { history } };
  const second = { ...first, recordId: 'o', recordType: 'observation' };
  const other = { ...second, recordId: 'other', loopId: 'L7' };
  const entry = (record: typeof first, file: string) => ({
    record_type: record.recordType, record_id: record.recordId, file, digest: digestDocument(record),
  });
  let decisions = rows(first);
  if (variant === 'invalid-json') decisions += '{\n';
  if (variant === 'missing-lf') decisions = decisions.trimEnd();
  if (variant === 'wrong-type') decisions = rows(second);
  if (variant === 'unprojectable') decisions = rows({ ...first, loopId: 'L7' });
  const observations = rows(second, other);
  write(decision, decisions);
  write(observation, observations);
  const oid = (file: string) => git(repo, ['hash-object', ledger + '/' + file]);
  write(index, rows({ kind: 'loop-fleet-ledger-record-index', schema_version: 1, files: {} },
    entry(first, decision), entry(second, observation), entry(other, observation)));
  write(manifest, rows(...[decision, observation].map((file) => ({
    kind: 'loop-fleet-ledger-record-manifest', schema_version: 1, file, oid: oid(file),
  }))));
  if (variant === 'symlink') fs.symlinkSync(decision, path.join(repo, ledger, 'symlink'));
  if (variant === 'noncanonical') write('Loop-observations-run-2.JSONL', observations);
  const commit = (parent?: string) => {
    git(repo, ['add', '-A']);
    return git(repo, ['commit-tree', git(repo, ['write-tree']), ...(parent ? ['-p', parent] : []), '-m', 'Synthetic']);
  };
  fs.writeFileSync(path.join(repo, 'outside.txt'), 'preserved\n');
  const archiveSha = commit();
  const intermediate = withIntermediate ? commit(archiveSha) : undefined;
  fs.writeFileSync(path.join(repo, 'outside.txt'), 'preserved from parent\n');
  const expected = commit(intermediate ?? archiveSha);
  git(repo, ['update-ref', pin, expected]);
  const inventoryEntries = [[decision, decisions], [observation, observations]].map(([name, data]) =>
    [ledger + '/' + name, oid(name), sha256(data), Buffer.byteLength(data), 1]);
  const attestationSha256 = sha256(JSON.stringify([archiveSha, inventoryEntries]));
  const request = { repo, archiveSha, output, ordinals: '3,4', attestationSha256 };
  return { root, repo, output, expected, intermediate, request, inventoryEntries, decision, observation, decisions, observations, index, manifest };
}

const counts = { files: 2, records: 2 };

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

it('binds the Git order, source, object IDs and only projectable records', () => {
  const f = fixture();
  attest(f.request, counts);
  expect(fs.statSync(f.output).mode & 0o777).toBe(0o600);
  const inventory = JSON.parse(fs.readFileSync(f.output, 'utf8'));
  expect(inventory.source).toBe(f.request.archiveSha);
  expect(inventory.files.map(({ path, gitOid, sha256, bytes, records, gzipBytes }) => {
    expect(gzipBytes).toBeGreaterThan(0);
    return [path, gitOid, sha256, bytes, records];
  })).toEqual(f.inventoryEntries);
  const original = fs.readFileSync(f.output, 'utf8');
  expect(() => attest(f.request, counts)).toThrow();
  expect(fs.readFileSync(f.output, 'utf8')).toBe(original);
});

it('attests the same selected files in a Git tree larger than 1 MiB', () => {
  const f = fixture();
  attest(f.request, counts);
  const baseline = JSON.parse(fs.readFileSync(f.output, 'utf8'));
  const paddingCount = 12_000;
  const paddingOid = git(f.repo, ['rev-parse', ':outside.txt']);
  const padding = Array.from({ length: paddingCount }, (_, index) =>
    `100644 ${paddingOid}\t${ledger}/fixture-padding-${String(index).padStart(5, '0')}-synthetic.jsonl\n`,
  ).join('');
  execFileSync('git', ['-C', f.repo, 'update-index', '--index-info'], { env, input: padding, stdio: 'pipe' });
  const archiveSha = git(f.repo, ['commit-tree', git(f.repo, ['write-tree']), '-m', 'Large synthetic tree']);
  const listing = execFileSync('git', ['-C', f.repo, 'ls-tree', '-z', archiveSha + ':' + ledger], {
    env, maxBuffer: 8 * 1024 * 1024, stdio: 'pipe',
  });
  expect(listing.length).toBeGreaterThan(1024 * 1024);

  const output = path.join(f.root, 'large-inventory.json');
  const ordinals = `${paddingCount + 3},${paddingCount + 4}`;
  const attestationSha256 = sha256(JSON.stringify([archiveSha, f.inventoryEntries]));
  expect(() => attest({ repo: f.repo, archiveSha, output, ordinals,
    attestationSha256: f.request.attestationSha256 }, counts)).toThrow();
  expect(fs.existsSync(output)).toBe(false);
  attest({ repo: f.repo, archiveSha, output, ordinals, attestationSha256 }, counts);
  expect(fs.statSync(output).mode & 0o777).toBe(0o600);
  expect(JSON.parse(fs.readFileSync(output, 'utf8'))).toEqual({ source: archiveSha, files: baseline.files });
});

it.each(['4,3', '3,3', '03,4', '+3,4', '3, 4', '3,4\n', '0,4', '3,99', '1,4', '3', '3,4,5'])(
  'rejects ordinal input %j without creating an inventory', (ordinals) => {
    const f = fixture();
    expect(() => attest({ ...f.request, ordinals }, counts)).toThrow();
    expect(fs.existsSync(f.output)).toBe(false);
  },
);

it.each(['invalid-json', 'missing-lf', 'wrong-type', 'unprojectable', 'symlink', 'noncanonical'] as const)(
  'rejects %s content without creating an inventory', (variant) => {
    const f = fixture(variant);
    expect(() => attest(f.request, counts)).toThrow();
    expect(fs.existsSync(f.output)).toBe(false);
  },
);

it('rejects a mismatched digest, source or count and refuses non-commit archive objects', () => {
  const f = fixture();
  for (const request of [
    { ...f.request, attestationSha256: 'a'.repeat(64) },
    { ...f.request, archiveSha: f.expected },
    { ...f.request, archiveSha: git(f.repo, ['rev-parse', f.expected + ':' + ledger]) },
  ]) expect(() => attest(request, counts)).toThrow();
  expect(() => attest(f.request, { ...counts, records: 3 })).toThrow();
  expect(fs.existsSync(f.output)).toBe(false);
});

it('rejects malformed dispatch input before starting Git and emits a fixed error', () => {
  const f = fixture();
  const bin = path.join(f.root, 'bin');
  fs.mkdirSync(bin);
  const marker = path.join(bin, 'called');
  fs.writeFileSync(path.join(bin, 'git'), '#!/bin/sh\n: > "${0%/*}/called"\n', { mode: 0o700 });
  const result = spawnSync(process.execPath, [fileURLToPath(script), 'prepare', f.root], {
    env: {
      PATH: bin, EXPECTED_SHA: f.expected, CANDIDATE_SHA: 'a'.repeat(40), READ_TOKEN: 'fixture',
      ORDINALS: '1,2;3', ATTESTATION_SHA256: f.request.attestationSha256,
    },
    encoding: 'utf8',
  });
  expect(result.status).toBe(1);
  expect(result.stdout).toBe('');
  expect(result.stderr).toBe('ERROR ledger maintenance arguments\n');
  expect(fs.existsSync(marker)).toBe(false);
  expect(fs.existsSync(f.output)).toBe(false);
});

it.each([
  ['exit 2', 'ERROR ledger maintenance tip-fetch'],
  ['exit 0', 'ERROR ledger maintenance tip-verify'],
  ['exit 0', 'ERROR stale ledger tip'],
])('reports a fixed tip diagnostic for %s (%s)', (fetch, diagnostic) => {
  const f = fixture();
  const bin = path.join(f.root, 'bin');
  fs.mkdirSync(bin);
  const verify = diagnostic === 'ERROR stale ledger tip' ? "printf '%040d\\n' 0" : 'exit 2';
  fs.writeFileSync(path.join(bin, 'timeout'), `#!/bin/sh
echo 'fixture-sensitive fetch stderr' >&2
${fetch}
`, { mode: 0o700 });
  fs.writeFileSync(path.join(bin, 'git'), `#!/bin/sh
echo 'fixture-sensitive Git stderr' >&2
${verify}
`, { mode: 0o700 });
  const result = spawnSync(process.execPath, [fileURLToPath(script), 'prepare', f.root], {
    env: {
      PATH: bin, EXPECTED_SHA: f.expected, CANDIDATE_SHA: 'a'.repeat(40), READ_TOKEN: 'fixture',
      ORDINALS: Array.from({ length: 152 }, (_, index) => index + 1).join(','),
      ATTESTATION_SHA256: f.request.attestationSha256,
    },
    encoding: 'utf8',
  });
  expect(result.status).toBe(1);
  expect(result.stdout).toBe('');
  expect(result.stderr).toBe(diagnostic + '\n');
});

it.each([
  ['invalid', 'receipt'],
  ['different-sha', 'receipt-candidate-mismatch'],
  ['valid', 'application'],
])('reports a fixed diagnostic for the %s receipt fixture', (variant, stage) => {
  const f = fixture();
  const candidate = 'a'.repeat(40);
  fs.mkdirSync(path.join(f.root, 'stage'));
  fs.writeFileSync(path.join(f.root, 'stage/receipt.json'), variant === 'invalid'
    ? 'fixture-sensitive invalid JSON'
    : JSON.stringify({
      archiveSha: '1c6010d0791d4e8de3125c4f7637319da2ff70fd', expectedSha: f.expected,
      candidateSha: variant === 'different-sha' ? 'b'.repeat(40) : candidate,
      files: 152, records: 374, indexEntries: 374,
    }), { mode: 0o600 });
  const result = spawnSync(process.execPath, [fileURLToPath(script), 'app', f.root], {
    env: { PATH: process.env.PATH, EXPECTED_SHA: f.expected, CANDIDATE_SHA: candidate, READ_TOKEN: 'fixture' },
    encoding: 'utf8',
  });
  expect(result.status).toBe(1);
  expect(result.stdout).toBe('');
  expect(result.stderr).toBe(`ERROR ledger maintenance ${stage}\n`);
});

function prepareTransport(shallow: boolean) {
  const f = fixture(undefined, true);
  const remote = path.join(f.root, 'remote.git');
  fs.mkdirSync(remote);
  git(remote, ['init', '--bare', '--quiet', '--object-format=sha1', '--template=']);
  git(f.repo, ['push', remote, f.expected + ':' + ref]);
  const source = path.join(f.root, 'pinned');
  fs.mkdirSync(source);
  git(source, ['init', '--quiet', '--object-format=sha1', '--template=']);
  git(source, ['fetch', '--no-tags', ...(shallow ? ['--depth=1'] : []), remote, ref + ':' + pin]);
  if (shallow) {
    git(source, ['fetch', '--no-tags', '--depth=1', remote, f.request.archiveSha]);
    expect(git(remote, ['rev-parse', f.expected + '^'])).toBe(f.intermediate);
    const missing = spawnSync('git', ['-C', source, 'cat-file', '-e', f.intermediate!], { env });
    expect(missing.status).toBe(1);
  }
  attest({ ...f.request, repo: source }, counts);
  const stage = path.join(f.root, 'stage');
  execFileSync(process.execPath, [candidateTool, '--repo', source, '--archive-sha', f.request.archiveSha,
    '--expected-sha', f.expected, '--inventory', f.output, '--output', stage], { env, stdio: 'pipe' });
  const { candidateSha: candidate, files, records } = JSON.parse(fs.readFileSync(path.join(stage, 'receipt.json'), 'utf8'));
  expect({ files, records }).toEqual(counts);
  const repo = path.join(stage, 'candidate');
  expect(git(repo, ['diff', '--name-status', f.expected, candidate]).split('\n')).toEqual([
    'D\t' + ledger + '/' + f.manifest,
    ...[f.index, f.decision, f.observation].map((name) => 'M\t' + ledger + '/' + name),
  ]);
  return { ...f, repo, source, remote, candidate };
}

it.each([false, true])('publishes the candidate with shallow=%s and handles an already published SHA', (shallow) => {
  const f = prepareTransport(shallow);
  expect(pushCandidate({ ...f, writeToken: '', allowFallback: true })).toBe('fallback');
  expect(pushCandidate({ ...f, writeToken: 'fixture', allowFallback: false })).toBe('published');
  expect(pushCandidate({ ...f, writeToken: '', allowFallback: true })).toBe('published');
  expect(git(f.remote, ['show-ref', '--verify', '--hash', ref])).toBe(f.candidate);
  expect(git(f.remote, ['rev-list', '--parents', '-1', f.candidate])).toBe(f.candidate + ' ' + f.expected);
  expect(git(f.remote, ['show', f.candidate + ':outside.txt'])).toBe('preserved from parent');
  if (shallow) expect(fs.readFileSync(path.join(f.repo, '.git/shallow'), 'utf8')).toBe(f.expected + '\n');
});

it('stops on an obsolete tip even when the candidate would be a fast-forward', () => {
  const f = prepareTransport(true);
  git(f.remote, ['update-ref', ref, f.request.archiveSha, f.expected]);
  expect(() => pushCandidate({ ...f, writeToken: 'fixture', allowFallback: true })).toThrow();
  expect(git(f.remote, ['show-ref', '--verify', '--hash', ref])).toBe(f.request.archiveSha);
});

it('allows one fallback only while readback confirms the parent after rejection', () => {
  const f = prepareTransport(false);
  const preReceive = path.join(f.remote, 'hooks', 'pre-receive');
  fs.mkdirSync(path.dirname(preReceive), { recursive: true });
  fs.writeFileSync(preReceive, '#!/bin/sh\nexit 1\n', { mode: 0o700 });
  expect(pushCandidate({ ...f, writeToken: 'fixture-app', allowFallback: true })).toBe('fallback');
  expect(git(f.remote, ['show-ref', '--verify', '--hash', ref])).toBe(f.expected);
  expect(() => pushCandidate({ ...f, writeToken: 'fixture-pat', allowFallback: false })).toThrow();
  expect(git(f.remote, ['show-ref', '--verify', '--hash', ref])).toBe(f.expected);
});

it('rejects a fast-forward if the tip changes between the readback and push negotiation', () => {
  const f = prepareTransport(false);
  const bin = path.join(f.root, 'bin');
  fs.mkdirSync(bin);
  const realGit = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
  fs.writeFileSync(path.join(bin, 'git'), [
    '#!/bin/sh',
    'for argument do',
    '  if [ "$argument" = push ]; then',
    '    "$REAL_GIT" -C "$FIXTURE_REMOTE" update-ref refs/heads/ledger/loop-fleet "$FIXTURE_ARCHIVE" || exit 1',
    '    break',
    '  fi',
    'done',
    'exec "$REAL_GIT" "$@"',
    '',
  ].join('\n'), { mode: 0o700 });
  // The Git helper intentionally forwards only PATH, so the wrapper embeds fixture paths as shell literals.
  const wrapper = path.join(bin, 'git');
  const literal = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
  fs.writeFileSync(wrapper, fs.readFileSync(wrapper, 'utf8').replace('#!/bin/sh\n',
    '#!/bin/sh\nREAL_GIT=' + literal(realGit) + '\nFIXTURE_REMOTE=' + literal(f.remote)
      + '\nFIXTURE_ARCHIVE=' + literal(f.request.archiveSha) + '\n'));
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import { pushCandidate } from ${JSON.stringify(script.href)};
    try {
      pushCandidate({ ...JSON.parse(process.argv[1]), writeToken: 'fixture', allowFallback: true });
      process.exitCode = 2;
    } catch {
      process.exitCode = 0;
    }
  `, JSON.stringify(f)], { env: { ...env, PATH: bin + path.delimiter + process.env.PATH } });
  expect(result.status).toBe(0);
  expect(git(f.remote, ['show-ref', '--verify', '--hash', ref])).toBe(f.request.archiveSha);
});

it('pins the reviewed dispatch and gates all write secrets behind the dry-run and fallback guards', () => {
  const workflow = parse(fs.readFileSync(new URL('../.github/workflows/fleet-ledger-maintenance.yml', import.meta.url), 'utf8'));
  expect(Object.keys(workflow.on)).toEqual(['workflow_dispatch']);
  expect(workflow.on.workflow_dispatch.inputs.dry_run).toMatchObject({ type: 'boolean', default: true });
  expect(workflow.permissions).toEqual({ contents: 'read' });
  const job = workflow.jobs.maintenance;
  expect(job.if).toContain("github.ref == 'refs/heads/main'");
  expect(job.if).toContain('github.workflow_sha == github.sha');
  expect(job.steps[0].with).toMatchObject({ ref: '${{ github.sha }}', 'persist-credentials': false });
  const [app, fallback] = job.steps.slice(-2);
  expect(app.if).toContain('success() && !inputs.dry_run');
  expect(fallback.if).toContain("success() && !inputs.dry_run && steps.app.outputs.result == 'fallback'");
  expect(fallback.run).toContain('--only-env=GITHUB_PAT');
  expect(job.steps.slice(0, -2).every((step) => !JSON.stringify(step).includes('secrets.'))).toBe(true);
});
