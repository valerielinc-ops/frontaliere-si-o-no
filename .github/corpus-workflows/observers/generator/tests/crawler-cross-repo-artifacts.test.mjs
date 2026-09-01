import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { TITLE_RE } from '../../scripts/ci/close-recovered-failure-issues.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const WORKFLOWS = path.join(ROOT, '.github/workflows');
const CONTRACT_PATH = path.join(ROOT, 'generator/data/crawler-cross-repo-contract.json');
const CONTRACT = JSON.parse(readFileSync(CONTRACT_PATH, 'utf8'));
const LOOP_MANIFEST = JSON.parse(
  readFileSync(path.join(ROOT, 'scripts/ci/loop-sync-manifest.json'), 'utf8'),
);

function sha256(text) {
  return createHash('sha256').update(text).digest('hex');
}

function occurrences(text, pattern) {
  return [...text.matchAll(pattern)].length;
}

function crawlerIdsFromArtifact(text) {
  const lines = text.split(/\r?\n/);
  const crawlerIds = [];

  for (let index = 0; index < lines.length; index += 1) {
    const stepStart = /^(\s*)-\s+(.*)$/.exec(lines[index]);
    if (!stepStart) continue;

    const stepIndent = stepStart[1].length;
    const fieldIndent = ' '.repeat(stepIndent + 2);
    const fields = [fieldIndent + stepStart[2]];
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      const indentation = /^(\s*)\S/.exec(lines[cursor]);
      if (indentation && indentation[1].length <= stepIndent) break;
      fields.push(lines[cursor]);
      index = cursor;
    }

    let crawlerId = '';
    let background = false;
    for (const line of fields) {
      if (!line.startsWith(fieldIndent) || line.startsWith(`${fieldIndent}  `)) continue;
      const id = /^\s*id:\s*crawler-([a-z0-9-]+)\s*$/.exec(line);
      if (id) crawlerId = id[1];
      if (/^\s*background:\s*true\s*$/.test(line)) background = true;
    }
    if (crawlerId && background) crawlerIds.push(crawlerId);
  }

  return crawlerIds;
}

test('il parser del roster tollera field-order e ignora wait o campi annidati non-background', () => {
  const workflow = [
    '      - name: Run coop',
    '        id: crawler-coop',
    '        if: success()',
    '        background: true',
    '        run: echo coop',
    '      - name: Run alfa',
    '        background: true',
    '        continue-on-error: false',
    '        id: crawler-alfa',
    '        run: echo alfa',
    '      - name: Ignore nested shell text',
    '        run: |-',
    '          id: crawler-fake',
    '          background: true',
    '      - name: Wait',
    '        id: crawler-generation-wait',
    '        wait-all: true',
  ].join('\n');
  assert.deepEqual(crawlerIdsFromArtifact(workflow), ['coop', 'alfa']);
});

test('il parser del roster conserva il formato corrente minimale', () => {
  const workflow = [
    '      - name: Run coop',
    '        id: crawler-coop',
    '        background: true',
  ].join('\n');
  assert.deepEqual(crawlerIdsFromArtifact(workflow), ['coop']);
});

test('il contratto censisce 23 gruppi + translate-pending e tutti i crawler unici', () => {
  assert.equal(CONTRACT.schemaVersion, 1);
  assert.equal(CONTRACT.groupCount, 23);
  assert.equal(CONTRACT.artifactCount, 24);
  assert.equal(CONTRACT.observerCount, 6);
  assert.equal(CONTRACT.artifacts.length, 24);

  const groups = CONTRACT.artifacts.filter((artifact) => /^crawler-group-\d{2}\.yml$/.test(artifact.file));
  assert.equal(groups.length, 23);
  const members = groups.flatMap((artifact) => artifact.members);
  assert.equal(members.length, CONTRACT.crawlerCount);
  assert.equal(new Set(members).size, CONTRACT.crawlerCount);
  assert.ok(CONTRACT.crawlerCount > 0);
  assert.ok(CONTRACT.siteRuntimePaths.length > 0);
  assert.deepEqual(CONTRACT.siteRuntimePaths, [...new Set(CONTRACT.siteRuntimePaths)].sort());
  assert.ok(CONTRACT.siteRuntimePaths.every((runtimePath) =>
    runtimePath.startsWith('scripts/') || runtimePath === 'functions/src/githubApiHeaders.js'));
  assert.ok(CONTRACT.siteRuntimePaths.includes('functions/src/githubApiHeaders.js'));
  assert.ok(CONTRACT.artifacts.some((artifact) => artifact.file === 'translate-pending.yml'));
  for (const observer of CONTRACT.observers) {
    assert.equal(sha256(readFileSync(path.join(ROOT, observer.target), 'utf8')), observer.sha256);
  }
  const observerWorkflow = readFileSync(
    path.join(WORKFLOWS, 'crawler-generation-observer-shadow.yml'),
    'utf8',
  );
  assert.match(observerWorkflow, /format\('crawler-generation-sentinel-\{0\}', inputs\.generation_token\)/);
  assert.match(observerWorkflow, /format\('crawler-generation-observer-event-\{0\}', github\.event\.workflow_run\.id\)/);
  assert.match(observerWorkflow, /^  workflow_dispatch:$/m);
  assert.match(observerWorkflow, /^  workflow_run:$/m);
  assert.match(observerWorkflow, /^  schedule:$/m);
  assert.match(observerWorkflow, /cron: '23 2,8,14,20 \* \* \*'/);
  assert.match(observerWorkflow, /max-parallel: 2/);
  assert.match(observerWorkflow, /group: crawler-generation-observer-\$\{\{ matrix\.generation\.generation_token \}\}/);
  assert.match(observerWorkflow, /name: crawler-generation-observer-\$\{\{ matrix\.generation\.generation_token \}\}/);
  assert.match(observerWorkflow, /crawler-generation-observer-selector\.mjs/);
  assert.deepEqual(
    [...observerWorkflow.matchAll(/^      - (Crawler Group \d{2} \(sparse cross-repo execution\))$/gm)]
      .map((match) => match[1]),
    Array.from(
      { length: 23 },
      (_, index) => `Crawler Group ${String(index + 1).padStart(2, '0')} (sparse cross-repo execution)`,
    ),
  );
  assert.match(
    observerWorkflow,
    /!startsWith\(github\.event\.workflow_run\.display_title, 'crawler-generation--group-'\)/,
  );
  assert.match(observerWorkflow, /TRIGGER_RUN_ID: \$\{\{ github\.event\.workflow_run\.id \}\}/);
  assert.match(observerWorkflow, /^  actions: read$/m);
  assert.match(observerWorkflow, /^  contents: read$/m);
  assert.doesNotMatch(observerWorkflow, /^\s+(?:actions|contents): write$/m);
  assert.doesNotMatch(observerWorkflow, /translate-pending|repository_dispatch|git push|secrets\./);
  assert.doesNotMatch(observerWorkflow, /\b(?:POST|issues: write|contents: write)\b/);
});

test('ogni artifact coincide con lo hash emesso dal generatore del sito', () => {
  for (const artifact of CONTRACT.artifacts) {
    const text = readFileSync(path.join(WORKFLOWS, artifact.file), 'utf8');
    assert.equal(
      sha256(text),
      artifact.artifactSha256,
      `${artifact.file} modificato senza rigenerare il contratto`,
    );
  }
});

test('le installazioni standalone usano il retry site-owned', () => {
  assert.ok(CONTRACT.siteRuntimePaths.includes('scripts/ci/crawler-retry-cmd.sh'));
  for (const artifact of CONTRACT.artifacts) {
    const text = readFileSync(path.join(WORKFLOWS, artifact.file), 'utf8');
    const lines = text.split('\n');
    assert.deepEqual(
      lines.filter((line) => /^\s*(run:\s*)?npm ci\b/.test(line)),
      [],
      `${artifact.file}: npm ci senza retry`,
    );
    assert.deepEqual(
      lines.filter((line) =>
        !/^\s*#/.test(line.trim()) && /(^|[\s;&|])npx\s/.test(line) &&
        !line.includes('crawler-retry-cmd.sh')),
      [],
      `${artifact.file}: npx senza retry`,
    );
  }
});

test('loop-drift osserva live i 24 artifact portabili e il contratto del generatore', () => {
  const entries = new Map(
    LOOP_MANIFEST.files.map((entry) => [entry.path, entry]),
  );
  for (const artifact of CONTRACT.artifacts) {
    const entry = entries.get(`.github/workflows/${artifact.file}`);
    assert.ok(entry, `${artifact.file}: mapping loop-sync assente`);
    assert.equal(entry.mode, 'identical', artifact.file);
    assert.equal(entry.sitePath, `.github/corpus-workflows/${artifact.file}`, artifact.file);
    assert.equal(entry.baseline.site, artifact.artifactSha256.slice(0, 16), artifact.file);
    assert.equal(entry.baseline.corpus, artifact.artifactSha256.slice(0, 16), artifact.file);
  }

  const contractEntry = entries.get('generator/data/crawler-cross-repo-contract.json');
  assert.ok(contractEntry, 'mapping loop-sync del contract assente');
  assert.equal(contractEntry.mode, 'identical');
  assert.equal(contractEntry.sitePath, '.github/corpus-workflows/contract.json');
  const contractHash = sha256(readFileSync(CONTRACT_PATH, 'utf8')).slice(0, 16);
  assert.equal(contractEntry.baseline.site, contractHash);
  assert.equal(contractEntry.baseline.corpus, contractHash);
});

test('il retry e limitato al checkout sparse pre-logica, con backoff', () => {
  assert.deepEqual(
    {
      attempts: CONTRACT.checkout.attempts,
      backoffSeconds: CONTRACT.checkout.backoffSeconds,
      retryScope: CONTRACT.checkout.retryScope,
    },
    { attempts: 2, backoffSeconds: 30, retryScope: 'checkout-before-logic-only' },
  );
  assert.equal(CONTRACT.checkout.reporter, 'corpus-issue-github-token');
  assert.ok(CONTRACT.checkout.excludedMb > 5_000);

  for (const artifact of CONTRACT.artifacts) {
    const text = readFileSync(path.join(WORKFLOWS, artifact.file), 'utf8');
    assert.equal(occurrences(text, /^\s+uses: actions\/checkout@v5$/gm), 2, artifact.file);
    assert.equal(occurrences(text, /^\s+id: site_checkout_primary$/gm), 1, artifact.file);
    assert.equal(occurrences(text, /^\s+id: site_checkout_retry$/gm), 1, artifact.file);
    assert.equal(occurrences(text, /^\s+id: checkout$/gm), 1, artifact.file);
    assert.match(text, /continue-on-error: true/);
    assert.match(text, /if: steps\.site_checkout_primary\.outcome == 'failure'/);
    assert.match(text, /steps\.site_checkout_retry\.outcome == 'success'/);
    assert.equal(occurrences(text, /^\s+- name: Report exhausted site checkout$/gm), 1, artifact.file);
    assert.match(text, /steps\.site_checkout_retry\.outcome == 'failure'/);
    assert.match(text, /GH_TOKEN: \$\{\{ github\.token \}\}/);
    assert.match(text, new RegExp(`ISSUE_TITLE: "?Workflow Failure: ${artifact.file === 'translate-pending.yml' ? 'Translate Pending Jobs' : 'Crawler Group \\d{2}'} \\(sparse cross-repo execution\\)"?`));
    const issueTitle = /ISSUE_TITLE: "?([^"\n]+)"?/.exec(text)?.[1];
    assert.ok(issueTitle && TITLE_RE.test(issueTitle), `${artifact.file}: titolo non richiudibile`);
    assert.match(text, /gh issue list --repo "\$GITHUB_REPOSITORY"/);
    assert.match(text, /gh issue comment/);
    assert.match(text, /gh issue create/);
    assert.doesNotMatch(text, /Report exhausted site checkout[\s\S]{0,1600}GITHUB_PAT/);
    assert.match(text, /^  actions: read$/m);
    assert.match(text, /^  issues: write$/m);
    assert.match(text, /sleep 30/);
    assert.match(text, /sparse-checkout: \|-/);
    assert.doesNotMatch(text, /^\s+token:/m);
    assert.match(text, /!\/public\/images\//);
    assert.match(text, /!\/packages\/articles\/content\//);
    assert.doesNotMatch(text, /!\/data\/jobs\//);
    assert.doesNotMatch(text, /[&*]a\d+/);

    const checkoutRetryAt = text.indexOf('id: site_checkout_retry');
    const checkoutReadyAt = text.indexOf('id: checkout');
    const firstCrawlerAt = text.search(/^\s+background: true$/m);
    const firstTranslatePhaseAt = text.search(/^\s+- name: (?:"?Phase|Check if housekeeping)/m);
    const firstLogicAt = firstCrawlerAt >= 0 ? firstCrawlerAt : firstTranslatePhaseAt;
    assert.ok(
      checkoutRetryAt >= 0 && checkoutReadyAt > checkoutRetryAt && firstLogicAt > checkoutReadyAt,
      `${artifact.file}: logica prima della conferma checkout`,
    );
  }
});

test('il reporter diagnostico usa identita e workflow standalone corpus richiudibile', () => {
  let reporterCount = 0;
  for (const artifact of CONTRACT.artifacts) {
    const text = readFileSync(path.join(WORKFLOWS, artifact.file), 'utf8');
    const artifactReporters = occurrences(text, /^\s+uses: \.\/\.github\/actions\/report-failure$/gm);
    assert.equal(artifactReporters, 1, `${artifact.file}: reporter diagnostico non unico`);
    reporterCount += artifactReporters;
    const group = /^crawler-group-(\d{2})\.yml$/.exec(artifact.file);
    const workflowName = group
      ? `Crawler Group ${group[1]} (sparse cross-repo execution)`
      : 'Translate Pending Jobs (sparse cross-repo execution)';
    const escapedName = workflowName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    assert.match(text, new RegExp(`title: "Workflow Failure: ${escapedName}"`));
    assert.match(text, /closed-by: close-recovered-failure-issues/);
    assert.match(text, /github-token: \$\{\{ github\.token \}\}/);
    assert.match(text, /repo: \$\{\{ github\.repository \}\}/);
    assert.match(text, new RegExp(`workflow-name: ${escapedName}`));
    assert.match(
      text,
      /if: failure\(\) && \(steps\.site_checkout_primary\.outcome == 'success' \|\| steps\.site_checkout_retry\.outcome == 'success'\)/,
    );
    assert.match(text, new RegExp(`workflow-file: \\.github/corpus-workflows/${artifact.file.replace('.', '\\.')}\\b`));
    assert.doesNotMatch(text, /workflow-file: .*logic\.yml/);
    assert.doesNotMatch(text, /repo: valerielinc-ops\/frontaliere-si-o-no/);
    const reporterAt = text.indexOf('uses: ./.github/actions/report-failure');
    const firstCrawlerAt = text.indexOf('background: true');
    if (artifact.members.length > 0) {
      assert.ok(reporterAt < firstCrawlerAt, `${artifact.file}: reporter setup dopo la logica crawler`);
      assert.match(text, /name: Report shared setup failure to GitHub Issues/);
    } else {
      assert.equal(firstCrawlerAt, -1, `${artifact.file}: translate non deve contenere crawler`);
      assert.match(text, /name: Report failure to GitHub Issues/);
    }
  }
  assert.equal(reporterCount, 24);
});

test('nessun artifact usa codeload/reusable cross-repo o replica la logica dopo un fallimento parziale', () => {
  for (const artifact of CONTRACT.artifacts) {
    const text = readFileSync(path.join(WORKFLOWS, artifact.file), 'utf8');
    assert.doesNotMatch(text, /uses:\s+valerielinc-ops\/frontaliere-si-o-no\/.github\/workflows\//);
    assert.doesNotMatch(text, /uses:\s+valerielinc-ops\/frontaliere-si-o-no\/.github\/actions\//);
    assert.match(text, /uses: \.\/\.github\/actions\//);

    const crawlerIds = crawlerIdsFromArtifact(text);
    assert.deepEqual(crawlerIds, artifact.members, `${artifact.file}: roster diverso dal contratto`);
    assert.equal(new Set(crawlerIds).size, crawlerIds.length, `${artifact.file}: crawler duplicato`);
    assert.equal(occurrences(text, /^\s+background: true$/gm), artifact.members.length);

    // Un solo job runnable: il secondo tentativo e un secondo checkout nello
    // stesso job, non un job `_retry` che rilancia crawl/push gia avvenuti.
    assert.equal(occurrences(text, /^  [a-z0-9_]+:\n    runs-on:/gm), 1, artifact.file);
    assert.doesNotMatch(text, /^  [a-z0-9_]+_retry:/m);
  }
});
