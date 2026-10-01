import fs from 'node:fs';
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

  it('rejects a source SHA when origin/main advances before publication', () => {
    expect(isCurrentPublishSource('a'.repeat(40), 'b'.repeat(40))).toBe(false);
    expect(stepNamed('Publish client article chunks for synced corpus').if).toContain(
      "steps.recheck_synced_chunk_source_before_publish.outputs.current == 'true'",
    );
  });

  it('defers main delivery but always checks the refresh snapshot on non-previews', () => {
    const mainDelivery = "github.event.inputs.dry_run != 'true' && steps.commit.outputs.published-via-pr != 'true'";
    expect(stepNamed('Assert the pulled corpus actually reached main').if).toBe(mainDelivery);
    expect(stepNamed('Assert the refresh snapshot was committed').if).toBe("github.event.inputs.dry_run != 'true'");
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
    expect(replayStep('Publish client article chunks after article sync merge').run).toContain(
      'scripts/publish-article-chunks.mjs --strict --no-ticker',
    );
    expect(replayStep('Replay article sitemap, RSS and ticker surfaces').run).toContain(
      'publish_edge_batch 1 news-sitemap --only=/sitemap-news.xml',
    );
    expect(replayStep('Replay article sitemap, RSS and ticker surfaces').run).toContain(
      'publish_edge_batch 10 rss-feeds --only=/rss.xml,/rss-it.xml,/rss-en.xml,/rss-de.xml,/rss-fr.xml,/rss-svizzera.xml,/rss-svizzera-it.xml,/rss-svizzera-en.xml,/rss-svizzera-de.xml,/rss-svizzera-fr.xml',
    );
    expect(replayStep('Replay article sitemap, RSS and ticker surfaces').run).toContain(
      'data/news-ticker-live.json "public, max-age=300, must-revalidate"',
    );
    expect(replayStep('Replay article sitemap, RSS and ticker surfaces').run).toContain(
      'cf-purge-cache.mjs --files=https://cdn.frontaliereticino.ch/data/news-ticker-live.json',
    );
    expect(replayStep('Replay article sitemap, RSS and ticker surfaces')['continue-on-error']).toBeUndefined();
  });
});
