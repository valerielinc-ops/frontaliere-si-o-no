import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'vitest';
import {
  buildRawContentsUrl,
  compareArtifactProvenance,
  verifyCrawlerContractProvenance,
} from '../scripts/ci/verify-crawler-contract-provenance.mjs';
import {
  buildCrawlerRosterCardinality,
  CRAWLER_ROSTER_PATH,
  crawlerArtifactFiles,
  validateCrawlerContractCardinality,
} from '../scripts/lib/crawler-contract-cardinality.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const CONTRACT_PATH = path.join(ROOT, '.github/corpus-workflows/contract.json');
const CONTRACT = JSON.parse(fs.readFileSync(CONTRACT_PATH, 'utf8'));
const ARTIFACT = CONTRACT.artifacts.find(({ file }) => file === 'translate-pending.yml');
const LOCAL_BYTES = fs.readFileSync(path.join(ROOT, '.github/corpus-workflows/translate-pending.yml'));
const ROSTER_BYTES = fs.readFileSync(path.join(ROOT, CRAWLER_ROSTER_PATH));
const ROSTER = JSON.parse(ROSTER_BYTES.toString('utf8'));
const digest = (value) => crypto.createHash('sha256').update(value).digest('hex');

describe('crawler contract provenance verifier', () => {
  it('buildRawContentsUrl encodes the remote path and exact source revision', () => {
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

  it('compareArtifactProvenance requires local and remote bytes to match the declaration', () => {
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

  it('verifyCrawlerContractProvenance proves translate-pending against the remote source commit', async () => {
    const requests: Array<{ url: string; init: RequestInit }> = [];
    const result = await verifyCrawlerContractProvenance({
      rootDir: ROOT,
      file: 'translate-pending.yml',
      expectedRepository: CONTRACT.sourceRepository,
      fetchImpl: async (url: string, init: RequestInit) => {
        requests.push({ url, init });
        return new Response(url.includes(CRAWLER_ROSTER_PATH) ? ROSTER_BYTES : LOCAL_BYTES, { status: 200 });
      },
    });

    assert.equal(result.ok, true);
    assert.equal(result.artifacts.length, 1);
    assert.equal(result.artifacts[0].file, 'translate-pending.yml');
    assert.equal(result.artifacts[0].remoteSha256, digest(LOCAL_BYTES));
    assert.equal(result.cardinality.valid, true);
    assert.equal(requests.length, 2);
    assert.match(requests[0].url, new RegExp(`scripts/ci/crawler-generation-roster\\.json\\?ref=${CONTRACT.sourceCommit}$`));
    assert.match(requests[1].url, new RegExp(`ref=${CONTRACT.sourceCommit}$`));
    const requestHeaders = requests[1].init.headers as Record<string, string>;
    assert.equal(requestHeaders.Accept, 'application/vnd.github.raw');
  });

  it('verifyCrawlerContractProvenance reports a remote digest drift', async () => {
    const result = await verifyCrawlerContractProvenance({
      rootDir: ROOT,
      file: 'translate-pending.yml',
      expectedRepository: CONTRACT.sourceRepository,
      fetchImpl: async (url: string) => new Response(
        url.includes(CRAWLER_ROSTER_PATH)
          ? ROSTER_BYTES
          : Buffer.concat([LOCAL_BYTES, Buffer.from('\n')]),
        { status: 200 },
      ),
    });

    assert.equal(result.ok, false);
    assert.deepEqual(result.artifacts[0].reasons, [
      'remote-artifact-digest-mismatch',
      'local-remote-bytes-mismatch',
    ]);
  });

  it('fails closed when the source roster cardinality disagrees with the contract', () => {
    const malformed = structuredClone(CONTRACT);
    malformed.crawlerCount -= 1;
    malformed.crawlerRosterCardinality.crawlerCount -= 1;
    const result = validateCrawlerContractCardinality({
      contract: malformed,
      sourceCommit: CONTRACT.sourceCommit,
      roster: ROSTER,
    });

    assert.equal(result.valid, false);
    assert.ok(result.errors.includes('crawler_contract_crawlerCount_mismatch'));
    assert.ok(result.errors.includes('crawler_roster_cardinality_crawlerCount_mismatch'));
  });

  it('builds the emitted cardinality from the pinned roster and artifact set', () => {
    assert.deepEqual(
      buildCrawlerRosterCardinality({
        sourceCommit: CONTRACT.sourceCommit,
        roster: ROSTER,
        artifactFiles: CONTRACT.artifacts.map(({ file }) => file),
      }),
      CONTRACT.crawlerRosterCardinality,
    );
    assert.deepEqual(crawlerArtifactFiles(ROSTER.groupCount), CONTRACT.artifacts.map(({ file }) => file).sort());
  });
});
