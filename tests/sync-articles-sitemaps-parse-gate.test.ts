import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';
import { isCurrentPublishSource } from '../scripts/lib/article-chunk-publish-freshness.mjs';

type WorkflowStep = {
  name?: string;
  run?: string;
  if?: string;
  'continue-on-error'?: unknown;
};

type WorkflowJob = {
  if?: string;
  steps: WorkflowStep[];
};

const WORKFLOW_PATH = path.resolve(
  __dirname,
  '..',
  '.github/workflows/sync-articles-sitemaps.yml',
);
const workflow = parse(fs.readFileSync(WORKFLOW_PATH, 'utf8')) as {
  jobs: {
    sync: WorkflowJob;
    'replay-after-article-sync': WorkflowJob;
  };
};
const steps = workflow.jobs.sync.steps;
const replaySteps = workflow.jobs['replay-after-article-sync'].steps;
const workflowSource = fs.readFileSync(WORKFLOW_PATH, 'utf8');

function stepNamed(name: string): WorkflowStep {
  const step = steps.find((candidate) => candidate.name === name);
  if (!step) throw new Error(`Missing workflow step: ${name}`);
  return step;
}

const REPO_ROOT = path.resolve(__dirname, '..');
const SHA = (digit: string) => digit.repeat(40);

type EdgeRecheckScenario = {
  /** SHA of the checkout when the step starts. */
  head: string;
  /** main tip seen by each successive `git fetch`; the last one repeats. */
  mains: string[];
  /** Paths `git diff --name-only` reports after each fetch (same index). */
  diffs?: string[][];
  /** Content of the renewer failure file before the step runs. */
  lockFailure?: string;
};

/**
 * Runs the real `run:` script of the edge recheck step with `git` and `npx`
 * replaced by recording stubs. `node` stays real, so the verdict comes from
 * the freshness helper the workflow actually calls.
 */
function runEdgeRecheck(scenario: EdgeRecheckScenario) {
  const step = replaySteps.find(
    (candidate) => candidate.name === 'Recheck post-merge replay source before edge publication',
  );
  if (!step?.run) throw new Error('Missing edge recheck step');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-replay-edge-recheck-'));
  try {
    const bin = path.join(dir, 'bin');
    const state = path.join(dir, 'state');
    fs.mkdirSync(bin);
    fs.mkdirSync(state);
    fs.writeFileSync(path.join(state, 'head'), `${scenario.head}\n`);
    fs.writeFileSync(path.join(state, 'mains'), `${scenario.mains.join('\n')}\n`);
    fs.writeFileSync(path.join(state, 'fetches'), '0\n');
    (scenario.diffs ?? []).forEach((paths, index) => {
      fs.writeFileSync(path.join(state, `diff-${index + 1}`), paths.length ? `${paths.join('\n')}\n` : '');
    });
    fs.writeFileSync(path.join(bin, 'git'), [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      `state=${JSON.stringify(state)}`,
      'echo "git $*" >> "$state/calls.log"',
      'case "$1 ${2:-}" in',
      '  "rev-parse HEAD") cat "$state/head" ;;',
      '  "rev-parse origin/main") cat "$state/main" ;;',
      '  "fetch --no-tags")',
      '    fetches=$(( $(cat "$state/fetches") + 1 ))',
      '    echo "$fetches" > "$state/fetches"',
      '    total=$(wc -l < "$state/mains" | tr -d " ")',
      '    line=$fetches',
      '    if [ "$line" -gt "$total" ]; then line=$total; fi',
      '    sed -n "${line}p" "$state/mains" > "$state/main"',
      '    ;;',
      '  "diff --name-only") cat "$state/diff-$(cat "$state/fetches")" 2>/dev/null || true ;;',
      '  "checkout --detach") cp "$state/main" "$state/head" ;;',
      '  *) echo "unexpected git $*" >&2; exit 64 ;;',
      'esac',
      '',
    ].join('\n'), { mode: 0o755 });
    fs.writeFileSync(path.join(bin, 'npx'), [
      '#!/usr/bin/env bash',
      `echo "$*" >> ${JSON.stringify(path.join(state, 'npx.log'))}`,
      '',
    ].join('\n'), { mode: 0o755 });

    const output = path.join(dir, 'github-output');
    const summary = path.join(dir, 'step-summary');
    fs.writeFileSync(output, '');
    fs.writeFileSync(summary, '');
    // The renewer PID must be a live process: this one is.
    fs.writeFileSync(path.join(dir, 'sync-replay-article-lock-renewer.pid'), `${process.pid}\n`);
    if (scenario.lockFailure) {
      fs.writeFileSync(path.join(dir, 'sync-replay-article-lock-renewer.failure'), scenario.lockFailure);
    }

    const result = spawnSync('bash', ['-e', '-c', step.run], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}`,
        RUNNER_TEMP: dir,
        GITHUB_OUTPUT: output,
        GITHUB_STEP_SUMMARY: summary,
      },
    });
    const read = (file: string) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '');
    return {
      status: result.status,
      stdout: result.stdout,
      stderr: result.stderr,
      outputs: read(output).split('\n').filter(Boolean),
      summary: read(summary),
      publishes: read(path.join(state, 'npx.log')).split('\n').filter(Boolean),
      gitCalls: read(path.join(state, 'calls.log')).split('\n').filter(Boolean),
    };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe('post-merge replay edge recheck (executed step script)', () => {
  const GENERATOR = 'scripts/publish-article-chunks.mjs';
  const REFRESH_PUBLISH = '-y tsx@4.23.15 scripts/publish-article-chunks.mjs --strict --no-ticker';

  it('allows edge publication for a current source while the lock is held', () => {
    const result = runEdgeRecheck({ head: SHA('a'), mains: [SHA('a')] });
    expect(result.status, result.stderr).toBe(0);
    expect(result.outputs).toContain('verdict=current');
    expect(result.outputs).toContain('edge_publish=true');
    expect(result.publishes).toEqual([]);
  });

  it('allows edge publication when main advanced on unrelated paths only', () => {
    const result = runEdgeRecheck({
      head: SHA('a'),
      mains: [SHA('b')],
      diffs: [['README.md', 'scripts/lib/example.mjs']],
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.outputs).toContain('verdict=unrelated-advance');
    expect(result.outputs).toContain('edge_publish=true');
    expect(result.publishes).toEqual([]);
  });

  for (const [label, scenario] of [
    ['a current source', { head: SHA('a'), mains: [SHA('a')] }],
    ['an unrelated advance', { head: SHA('a'), mains: [SHA('b')], diffs: [['README.md']] }],
  ] as const) {
    it(`refuses edge publication for ${label} when the section lock was lost before the verdict`, () => {
      const result = runEdgeRecheck({
        ...scenario,
        mains: [...scenario.mains],
        diffs: 'diffs' in scenario ? scenario.diffs.map((paths) => [...paths]) : undefined,
        lockFailure: 'renewer lost the frontaliere section lease\n',
      });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('renewer lost the frontaliere section lease');
      expect(result.outputs).toContain('verdict=lock-lost');
      expect(result.outputs).toContain('edge_publish=false');
      expect(result.outputs).not.toContain('edge_publish=true');
      expect(result.summary).toContain('lock-lost');
    });
  }

  it('refreshes and republishes when only the chunk generator changed on main', () => {
    const result = runEdgeRecheck({
      head: SHA('a'),
      mains: [SHA('b')],
      diffs: [[GENERATOR]],
    });
    expect(result.status, result.stderr).toBe(0);
    // One limited refresh round: checkout of origin/main, then the generator
    // of THAT checkout republishes the chunks; the next round finds it current.
    expect(result.gitCalls).toContain('git checkout --detach --force origin/main');
    expect(result.publishes).toEqual([REFRESH_PUBLISH]);
    expect(result.outputs).toContain('verdict=current');
    expect(result.outputs).toContain(`source_sha=${SHA('b')}`);
    expect(result.outputs).toContain('edge_publish=true');
    expect(result.summary).toContain('Limited refresh rounds: 1/2');
  });

  it('refuses edge publication once the refresh ceiling is reached', () => {
    const surface = ['packages/articles/content/blog-body/it/x.ts'];
    const result = runEdgeRecheck({
      head: SHA('a'),
      mains: [SHA('b'), SHA('c'), SHA('d')],
      diffs: [surface, surface, surface],
    });
    expect(result.status).not.toBe(0);
    expect(result.publishes).toEqual([REFRESH_PUBLISH, REFRESH_PUBLISH]);
    expect(result.outputs).toContain('verdict=superseded');
    expect(result.outputs).toContain('edge_publish=false');
    expect(result.outputs).not.toContain('edge_publish=true');
  });
});

describe('article corpus sync parser gate', () => {
  it('blocks the refresh PR when changed article modules do not parse', () => {
    const validationIndex = steps.findIndex(
      (step) => step.name === 'Validate changed article modules before commit',
    );
    const commitIndex = steps.findIndex((step) => step.name === 'Commit if changed');
    const validation = stepNamed('Validate changed article modules before commit');

    expect(validationIndex).toBeGreaterThanOrEqual(0);
    expect(commitIndex).toBeGreaterThan(validationIndex);
    expect(validation.if).toContain("steps.gate.outputs.skipped != 'true'");
    expect(validation.run).toContain('packages/articles/content');
    expect(validation.run).toContain('npm test -- tests/generated-content-parses.test.ts');
    expect(validation['continue-on-error']).toBeUndefined();
    expect(spawnSync('bash', ['-n', '-c', validation.run], { encoding: 'utf8' }).status).toBe(0);
  });

  it('delivers changed corpus artifacts through the stable PR publisher', () => {
    const commitRun = stepNamed('Commit if changed').run ?? '';

    expect(commitRun).toContain('scripts/lib/open-data-refresh-pr.sh');
    expect(commitRun).toContain('--path packages/articles/content');
    expect(commitRun).toContain('--branch chore/sync-articles-sitemaps');
    expect(commitRun).toContain('published-via-pr=false');
    expect(commitRun).toContain('published-via-pr=true');
    expect(commitRun).toContain('## Implementato');
    expect(commitRun).toContain('## Non implementato (ancora)');
    expect(commitRun).not.toContain('--regenerate-cmd');
    expect(commitRun).not.toContain('scripts/lib/git-push-with-retry.sh');
    expect(spawnSync('bash', ['-n', '-c', commitRun], { encoding: 'utf8' }).status).toBe(0);
  });

  it('publishes changed corpus registries through the shared strict CDN path', () => {
    const commitIndex = steps.findIndex((step) => step.name === 'Commit if changed');
    const acquireIndex = steps.findIndex((step) => step.name === 'Acquire article chunk section locks for synced corpus');
    const recheckIndex = steps.findIndex((step) => step.name === 'Recheck synced article chunk source before publication');
    const publishIndex = steps.findIndex((step) => step.name === 'Publish client article chunks for synced corpus');
    const releaseIndex = steps.findIndex((step) => step.name === 'Release article chunk section locks for synced corpus');
    const publish = stepNamed('Publish client article chunks for synced corpus');
    const recheck = stepNamed('Recheck synced article chunk source before publication');
    const release = stepNamed('Release article chunk section locks for synced corpus');

    expect(commitIndex).toBeGreaterThanOrEqual(0);
    expect(acquireIndex).toBeGreaterThan(commitIndex);
    expect(recheckIndex).toBeGreaterThan(acquireIndex);
    expect(publishIndex).toBeGreaterThan(acquireIndex);
    expect(recheckIndex).toBeLessThan(publishIndex);
    expect(releaseIndex).toBeGreaterThan(publishIndex);
    expect(publish.if).toContain("steps.commit.outputs.article-content-changed == 'true'");
    expect(publish.if).toContain("steps.commit.outputs.published-via-pr != 'true'");
    expect(publish.if).toContain("steps.check_synced_chunk_source.outputs.current == 'true'");
    expect(publish.if).toContain("steps.recheck_synced_chunk_source_before_publish.outputs.current == 'true'");
    expect(publish.run).toContain('scripts/publish-article-chunks.mjs --strict --no-ticker');
    expect(publish['continue-on-error']).toBeUndefined();
    expect(recheck.if).toContain("steps.verify_synced_chunk_lock_before_publish.outcome == 'success'");
    expect(recheck.run).toContain('git fetch --no-tags --depth=1 origin main');
    expect(recheck.run).toContain('scripts/lib/article-chunk-publish-freshness.mjs');
    expect(recheck.run).toContain('git checkout --detach --force origin/main');
    expect(recheck.run).toContain('echo "current=$CURRENT" >> "$GITHUB_OUTPUT"');
    expect(recheck.run).toContain('exit 1');
    expect(release.if).toContain('always()');
    expect(release.run).toContain('scripts/lib/r2-section-lock.mjs release --section frontaliere,svizzera');

    const commitRun = stepNamed('Commit if changed').run ?? '';
    expect(commitRun).toContain('article-content-changed=true');
    expect(commitRun).toContain('article-content-changed=false');
    expect(commitRun.indexOf('article-content-changed=false')).toBeLessThan(
      commitRun.indexOf('scripts/lib/open-data-refresh-pr.sh'),
    );
  });

  it('shares the source freshness and lock checks with the existing chunk publishers', () => {
    const source = stepNamed('Check synced article chunk source is current').run ?? '';
    const before = stepNamed('Verify synced article chunk lock before publication').run ?? '';
    const after = stepNamed('Verify synced article chunk lock after publication').run ?? '';
    expect(source).toContain('git fetch --no-tags --depth=1 origin main');
    expect(source).toContain('scripts/lib/article-chunk-publish-freshness.mjs');
    expect(source).toContain('git checkout --detach --force origin/main');
    expect(before).toContain('LOCK_RENEW_FAILURE_FILE');
    expect(before).toContain('kill -0');
    expect(after).toContain('LOCK_RENEW_FAILURE_FILE');
    expect(after).toContain('kill -0');
  });

  it('refreshes a source SHA when origin/main advances before publication', () => {
    expect(isCurrentPublishSource('a'.repeat(40), 'b'.repeat(40))).toBe(false);
    expect(stepNamed('Recheck synced article chunk source before publication').run).toContain(
      'git checkout --detach --force origin/main',
    );
    expect(stepNamed('Publish client article chunks for synced corpus').if).toContain(
      "steps.recheck_synced_chunk_source_before_publish.outputs.current == 'true'",
    );
  });

  it('defers main delivery but always checks the refresh snapshot on non-previews', () => {
    const mainDelivery = "github.event.inputs.dry_run != 'true' && steps.commit.outputs.published-via-pr != 'true'";
    expect(stepNamed('Assert the pulled corpus actually reached main').if).toBe(mainDelivery);
    expect(stepNamed('Assert the refresh snapshot was committed').if).toBe(mainDelivery);
  });

  it('replays every PR-skipped live surface from the merged main tree', () => {
    const replay = workflow.jobs['replay-after-article-sync'];
    const replayStep = (name: string): WorkflowStep => {
      const step = replaySteps.find((candidate) => candidate.name === name);
      if (!step) throw new Error(`Missing replay workflow step: ${name}`);
      return step;
    };
    const installIndex = replaySteps.findIndex((step) => step.name === 'Install replay dependencies');
    const loadSecretsIndex = replaySteps.findIndex((step) => step.name === 'Load secrets from Remote Config');

    expect(workflowSource).toContain('push:\n    branches: [main]');
    expect(installIndex).toBeGreaterThanOrEqual(0);
    expect(loadSecretsIndex).toBeGreaterThan(installIndex);
    expect(replayStep('Install replay dependencies').run).toBe('npm ci --no-audit --no-fund');
    const corpusPath = 'packages' + '/articles' + '/content/**';
    const tickerPath = 'public' + '/news-ticker-live.json';
    expect(workflowSource).toContain(`- '${corpusPath}'`);
    expect(workflowSource).toContain("- 'public/sitemap-news.xml'");
    expect(workflowSource).toContain("- 'public/rss*.xml'");
    expect(workflowSource).toContain(`- '${tickerPath}'`);
    expect(replay.if).toBe("github.event_name == 'push'");
    expect(replayStep('Recheck post-merge replay source before publication').run).toContain(
      'git checkout --detach --force origin/main',
    );
    const edgeRecheck = replayStep('Recheck post-merge replay source before edge publication');
    expect(edgeRecheck.run).toContain('git diff --name-only "$SOURCE_SHA" "$MAIN_SHA"');
    expect(edgeRecheck.run).toContain('--changed-paths-file "$DIFF_PATHS"');
    expect(edgeRecheck.run).toContain('GITHUB_STEP_SUMMARY');
    expect(edgeRecheck.run).toContain('GITHUB_OUTPUT');
    expect(edgeRecheck.run).toContain('MAX_REFRESH_ROUNDS=2');
    expect(edgeRecheck.run).toContain('superseded');
    expect(edgeRecheck.run).toContain('git checkout --detach --force origin/main');
    expect(edgeRecheck.run).toContain('scripts/publish-article-chunks.mjs --strict --no-ticker');
    expect(edgeRecheck.run).toContain('edge_publish=false');
    // The lock is verified in the branch that allows publication, right
    // before the verdict that the edge step reads.
    const allowBranch = edgeRecheck.run?.slice(
      edgeRecheck.run.indexOf('current|unrelated-advance)'),
      edgeRecheck.run.indexOf('superseded)'),
    ) ?? '';
    expect(allowBranch.indexOf('verify_replay_lock')).toBeGreaterThan(-1);
    expect(allowBranch.indexOf('verify_replay_lock')).toBeLessThan(allowBranch.indexOf('write_verdict "$VERDICT"'));
    expect(spawnSync('bash', ['-n', '-c', edgeRecheck.run ?? ''], { encoding: 'utf8' }).status).toBe(0);
    expect(edgeRecheck.run).not.toContain(
      'main advanced during client publication; refusing to publish stale edge surfaces',
    );
    expect(replayStep('Publish client article chunks after article sync merge').run).toContain(
      'scripts/publish-article-chunks.mjs --strict --no-ticker',
    );
    const edgeReplay = replayStep('Replay article sitemap, RSS and ticker surfaces');
    expect(edgeReplay.if).toContain("steps.recheck_replay_source_before_edge.outputs.verdict == 'current'");
    expect(edgeReplay.if).toContain("steps.recheck_replay_source_before_edge.outputs.verdict == 'unrelated-advance'");
    expect(edgeReplay.if).toContain("steps.recheck_replay_source_before_edge.outputs.edge_publish == 'true'");
    expect(edgeReplay.if).toContain("steps.recheck_replay_source_before_edge.outcome == 'success'");
    expect(edgeReplay.run).toContain(
      'publish_edge_batch 1 news-sitemap --only=/sitemap-news.xml',
    );
    expect(edgeReplay.run).toContain(
      'publish_edge_batch 10 rss-feeds --only=/rss.xml,/rss-it.xml,/rss-en.xml,/rss-de.xml,/rss-fr.xml,/rss-svizzera.xml,/rss-svizzera-it.xml,/rss-svizzera-en.xml,/rss-svizzera-de.xml,/rss-svizzera-fr.xml',
    );
    expect(edgeReplay.run).toContain(
      'data/news-ticker-live.json "public, max-age=300, must-revalidate"',
    );
    expect(edgeReplay.run).toContain(
      'cf-purge-cache.mjs --files=https://cdn.frontaliereticino.ch/data/news-ticker-live.json',
    );
    expect(edgeReplay['continue-on-error']).toBeUndefined();
  });
});
