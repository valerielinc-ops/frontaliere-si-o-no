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
  'scripts/lib/canonical-json-digest.mjs',
  'scripts/lib/crawler-contract-cardinality.mjs',
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
    crawlerRosterCardinality: {
      sourceCommit: OLD_SHA,
      groupCount: 1,
      artifactCount: 2,
      crawlerCount: 1,
    },
    artifacts: [{ file: 'crawler-group-01.yml', artifactSha256: 'artifact-digest' }],
  };
}

test('reattest updates both lineage pins and preserves generated digests', () => {
  const before = fixture();
  const after = reattestCrawlerContract(before, NEW_SHA);

  assert.equal(after.sourceCommit, NEW_SHA);
  assert.equal(after.sourceCommitVerified, true);
  assert.equal(after.artifactObservation.sourceCommit, NEW_SHA);
  assert.equal(after.crawlerRosterCardinality.sourceCommit, NEW_SHA);
  assert.equal(after.artifacts[0].artifactSha256, before.artifacts[0].artifactSha256);
  assert.equal(before.sourceCommit, OLD_SHA);
  assert.equal(before.artifactObservation.sourceCommit, OLD_SHA);
  assert.equal(before.crawlerRosterCardinality.sourceCommit, OLD_SHA);
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

test('workflow pushes and merges through a trusted App/PAT identity', () => {
  const workflow = fs.readFileSync(WORKFLOW_PATH, 'utf8');

  assert.doesNotMatch(workflow, /GH_TOKEN:\s*\$\{\{\s*github\.token\s*\}\}/u);
  assert.match(workflow, /persist-credentials:\s*false/u);
  assert.match(workflow, /Mint trusted GitHub App token/u);
  assert.match(workflow, /GITHUB_PAT/u);
  assert.match(workflow, /git remote set-url origin .*\$\{PUSH_TOKEN\}/u);
  assert.match(workflow, /GH_TOKEN=\$PUSH_TOKEN/u);
  assert.match(workflow, /git commit -m "ci: reattest crawler contract to landed main \[skip ci\]"/u);
});

test('safe reattestation PRs bypass PR workflows only after the trusted exact-head gate', () => {
  const workflow = fs.readFileSync(WORKFLOW_PATH, 'utf8');
  const openStep = workflow.slice(workflow.indexOf('      - name: Open or update the reattestation PR'));

  assert.match(openStep, /gh pr (?:edit|create)/u);
  assert.doesNotMatch(openStep, /PR_API_TOKEN/u);
  assert.match(openStep, /review-test-policy\.mjs non-code-merge-check/u);
  assert.match(openStep, /--admin --squash --delete-branch --match-head-commit "\$head_sha"/u);
  assert.doesNotMatch(openStep, /gh pr merge[^\n]*--auto/u);
});

test('workflow verifies current artifacts against the landed source revision', () => {
  const workflow = fs.readFileSync(WORKFLOW_PATH, 'utf8');
  const verifyStep = workflow.slice(
    workflow.indexOf('      - name: Verify crawler contract provenance'),
    workflow.indexOf('      - name: Open or update the reattestation PR'),
  );

  assert.match(verifyStep, /verification_contract="\$RUNNER_TEMP\/crawler-contract-for-\$SOURCE_COMMIT\.json"/u);
  assert.match(verifyStep, /--path "\$verification_contract"/u);
  assert.match(verifyStep, /--source-commit "\$SOURCE_COMMIT"/u);
  assert.match(verifyStep, /verify-crawler-contract-provenance\.mjs \\\n\s+--contract "\$verification_contract"/u);
});

test('workflow verifies the reconciled contract before publishing it', () => {
  const workflow = fs.readFileSync(WORKFLOW_PATH, 'utf8');
  const openStep = workflow.slice(workflow.indexOf('      - name: Open or update the reattestation PR'));
  const reattest = openStep.indexOf('reattest-crawler-contract.mjs');
  const verify = openStep.indexOf('verify-crawler-contract-provenance.mjs');
  const add = openStep.indexOf('git add -- "$CONTRACT_PATH"', verify);
  const push = openStep.indexOf('git push --set-upstream origin "$REATTEST_BRANCH"');

  assert.match(
    openStep,
    /verify-crawler-contract-provenance\.mjs \\\n\s+--contract "\$CONTRACT_PATH" \\\n\s+--strict/u,
  );
  assert.ok(reattest >= 0, 'persistent branch must be reattested');
  assert.ok(verify > reattest, 'persistent contract must be verified after reattestation');
  assert.ok(add > verify, 'persistent contract must pass strict verification before git add');
  assert.ok(push > verify, 'persistent contract must pass strict verification before push');
});

test('workflow configures commit identity before reconciling the persistent branch', () => {
  const workflow = fs.readFileSync(WORKFLOW_PATH, 'utf8');
  const openStep = workflow.slice(workflow.indexOf('      - name: Open or update the reattestation PR'));
  const identity = openStep.indexOf("git config user.name 'frontaliere automation'");
  const email = openStep.indexOf("git config user.email 'frontaliere-automation@users.noreply.github.com'");
  const merge = openStep.indexOf('git merge --no-edit origin/main');

  assert.ok(identity >= 0, 'persistent branch reconciliation must set a committer name');
  assert.ok(email >= 0, 'persistent branch reconciliation must set a committer email');
  assert.ok(merge >= 0, 'persistent branch reconciliation must merge origin/main');
  assert.ok(identity < merge, 'committer name must precede the merge');
  assert.ok(email < merge, 'committer email must precede the merge');
});

test('workflow resolves only the generated contract when persistent branch reconciliation conflicts', () => {
  const workflow = fs.readFileSync(WORKFLOW_PATH, 'utf8');
  const openStep = workflow.slice(workflow.indexOf('      - name: Open or update the reattestation PR'));
  const merge = openStep.indexOf('if ! git merge --no-edit origin/main; then');
  const conflictPaths = openStep.indexOf('conflicted_paths=$(git diff --name-only --diff-filter=U)');
  const abort = openStep.indexOf('git merge --abort || true');
  const resolve = openStep.indexOf('git checkout --theirs -- "$CONTRACT_PATH"');
  const commit = openStep.indexOf('git commit --no-edit');

  assert.ok(merge >= 0, 'persistent branch reconciliation must inspect merge failure');
  assert.ok(conflictPaths > merge, 'conflict paths must be collected after merge failure');
  assert.match(openStep, /if \[ "\$conflicted_paths" != "\$CONTRACT_PATH" \]; then/u);
  assert.ok(abort > conflictPaths, 'unexpected conflicts must abort the merge');
  assert.ok(resolve > conflictPaths, 'only the contract conflict may be auto-resolved');
  assert.ok(commit > resolve, 'the resolved merge must be committed before reattestation');
});
