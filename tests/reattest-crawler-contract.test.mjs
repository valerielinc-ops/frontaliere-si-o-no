import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {
  reattestCrawlerContract,
  reattestCrawlerContractText,
  SOURCE_COMMIT_RE,
} from '../scripts/ci/reattest-crawler-contract.mjs';

const OLD_SHA = '1'.repeat(40);
const NEW_SHA = '2'.repeat(40);
const WORKFLOW_PATH = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  '../.github/workflows/reattest-crawler-contract.yml',
);
const SOURCE_INPUTS = [
  'functions/src/githubApiHeaders.js',
  'scripts/assemble-jobs-dataset.mjs',
  'scripts/check-crawler-generation-token.mjs',
  'scripts/check-crawler-group-live-run.mjs',
  'scripts/generate-crawler-group-workflows.mjs',
  'scripts/ci/crawler-generation-roster.json',
  'scripts/ci/crawler-retry-cmd.sh',
  'scripts/ci/prepare-crawler-workflow-corpus-sync.mjs',
  'scripts/ci/translate-recovery-successor-guard.mjs',
  'scripts/ci/validate-workflow-data.mjs',
  'scripts/cleanup-jobs.mjs',
];

function fixture() {
  return {
    schemaVersion: 1,
    sourceRef: 'main',
    sourceCommit: OLD_SHA,
    generatorSha256: 'generator-digest',
    artifactObservation: {
      sourceRef: 'main',
      sourceCommit: OLD_SHA,
      generatorSha256: 'generator-digest',
    },
    artifacts: [{ file: 'crawler-group-01.yml', artifactSha256: 'artifact-digest' }],
  };
}

test('reattest updates both lineage pins and preserves generated digests', () => {
  const before = fixture();
  const after = reattestCrawlerContract(before, NEW_SHA);

  assert.equal(after.sourceCommit, NEW_SHA);
  assert.equal(after.artifactObservation.sourceCommit, NEW_SHA);
  assert.equal(after.artifacts[0].artifactSha256, before.artifacts[0].artifactSha256);
  assert.equal(before.sourceCommit, OLD_SHA);
  assert.equal(before.artifactObservation.sourceCommit, OLD_SHA);
});

test('reattest text is deterministic and idempotent', () => {
  const text = `${JSON.stringify(fixture(), null, 2)}\n`;
  const first = reattestCrawlerContractText(text, NEW_SHA);
  const second = reattestCrawlerContractText(first, NEW_SHA);

  assert.notEqual(first, text);
  assert.equal(second, first);
  assert.match(first, new RegExp(`"sourceCommit": "${NEW_SHA}"`));
});

test('rejects malformed source commits and malformed observations', () => {
  assert.equal(SOURCE_COMMIT_RE.test(NEW_SHA), true);
  assert.throws(() => reattestCrawlerContract(fixture(), 'main'), /40-character commit SHA/);
  assert.throws(
    () => reattestCrawlerContract({ ...fixture(), artifactObservation: null }, NEW_SHA),
    /artifactObservation must be a JSON object/,
  );
});

test('workflow reattests every contract source input', () => {
  const workflow = fs.readFileSync(WORKFLOW_PATH, 'utf8');

  for (const sourceInput of SOURCE_INPUTS) {
    assert.match(
      workflow,
      new RegExp(`^\\s*- ['"]?${sourceInput.replaceAll('.', '\\.')}`, 'mu'),
      `missing reattestation trigger for ${sourceInput}`,
    );
  }
});

test('workflow publishes through a trusted App/PAT identity, never GITHUB_TOKEN', () => {
  const workflow = fs.readFileSync(WORKFLOW_PATH, 'utf8');

  assert.doesNotMatch(workflow, /GH_TOKEN:\s*\$\{\{\s*github\.token\s*\}\}/u);
  assert.match(workflow, /persist-credentials:\s*false/u);
  assert.match(workflow, /Mint trusted GitHub App token/u);
  assert.match(workflow, /GITHUB_PAT/u);
  assert.match(workflow, /git remote set-url origin .*\$\{PUSH_TOKEN\}/u);
  assert.match(workflow, /GH_TOKEN=\$PUSH_TOKEN/u);
});
