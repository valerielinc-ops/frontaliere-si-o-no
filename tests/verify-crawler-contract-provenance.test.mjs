import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {
  buildRawContentsUrl,
  compareArtifactProvenance,
  verifyCrawlerContractProvenance,
} from '../scripts/ci/verify-crawler-contract-provenance.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const CONTRACT_PATH = path.join(ROOT, '.github/corpus-workflows/contract.json');
const CONTRACT = JSON.parse(fs.readFileSync(CONTRACT_PATH, 'utf8'));
const ARTIFACT = CONTRACT.artifacts.find(({ file }) => file === 'translate-pending.yml');
const LOCAL_BYTES = fs.readFileSync(path.join(ROOT, '.github/corpus-workflows/translate-pending.yml'));
const digest = (value) => crypto.createHash('sha256').update(value).digest('hex');

test('buildRawContentsUrl encodes the remote path and exact source revision', () => {
  const url = buildRawContentsUrl({
    repository: CONTRACT.sourceRepository,
    filePath: '.github/corpus-workflows/translate-pending.yml',
    ref: CONTRACT.sourceCommit,
  });
  assert.equal(
    url,
    `https://api.github.com/repos/${CONTRACT.sourceRepository}/contents/.github/corpus-workflows/translate-pending.yml?ref=${CONTRACT.sourceCommit}`,
  );
});

test('compareArtifactProvenance requires local and remote bytes to match the declaration', () => {
  const result = compareArtifactProvenance({
    artifact: ARTIFACT,
    localBytes: LOCAL_BYTES,
    remoteBytes: LOCAL_BYTES,
  });
  assert.equal(result.ok, true);
  assert.equal(result.localSha256, ARTIFACT.artifactSha256);
  assert.equal(result.remoteSha256, ARTIFACT.artifactSha256);

  const changed = Buffer.concat([LOCAL_BYTES, Buffer.from('\n')]);
  const mismatch = compareArtifactProvenance({
    artifact: ARTIFACT,
    localBytes: LOCAL_BYTES,
    remoteBytes: changed,
  });
  assert.equal(mismatch.ok, false);
  assert.deepEqual(mismatch.reasons, [
    'remote-artifact-digest-mismatch',
    'local-remote-bytes-mismatch',
  ]);
});

test('verifyCrawlerContractProvenance proves translate-pending against the remote source commit', async () => {
  const requests = [];
  const result = await verifyCrawlerContractProvenance({
    rootDir: ROOT,
    file: 'translate-pending.yml',
    expectedRepository: CONTRACT.sourceRepository,
    fetchImpl: async (url, init) => {
      requests.push({ url, init });
      return new Response(LOCAL_BYTES, { status: 200 });
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.artifacts.length, 1);
  assert.equal(result.artifacts[0].file, 'translate-pending.yml');
  assert.equal(result.artifacts[0].remoteSha256, digest(LOCAL_BYTES));
  assert.equal(requests.length, 1);
  assert.match(requests[0].url, new RegExp(`ref=${CONTRACT.sourceCommit}$`));
  assert.equal(requests[0].init.headers.Accept, 'application/vnd.github.raw');
});

test('verifyCrawlerContractProvenance reports a remote digest drift', async () => {
  const result = await verifyCrawlerContractProvenance({
    rootDir: ROOT,
    file: 'translate-pending.yml',
    expectedRepository: CONTRACT.sourceRepository,
    fetchImpl: async () => new Response(Buffer.concat([LOCAL_BYTES, Buffer.from('\n')]), { status: 200 }),
  });

  assert.equal(result.ok, false);
  assert.deepEqual(result.artifacts[0].reasons, [
    'remote-artifact-digest-mismatch',
    'local-remote-bytes-mismatch',
  ]);
});
