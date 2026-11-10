// @vitest-environment node
/**
 * Wiring of the Google Indexing API job chain across workflows.
 *
 * 1. Top-up after every publish. monitor-gsc-seo.yml used to listen to
 *    `workflow_run` on "Publish to GitHub Pages (deploy + validate)": from
 *    2026-10-24 to 2026-11-10 it never fired (only `schedule` runs), because
 *    deploy-publish.yml is dispatched with GITHUB_TOKEN and GitHub drops the
 *    next workflow_run hop. The publisher now dispatches it explicitly.
 * 2. Ledger durability. Both writers of the shared ledger read/write it in
 *    Firestore, serialized by one concurrency group — never the Actions cache,
 *    whose eviction made every run start empty.
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'yaml';

const read = (f: string) => readFileSync(resolve(f), 'utf8');
const monitorWf = read('.github/workflows/monitor-gsc-seo.yml');
const monitor = parse(monitorWf);
const postDeployWf = read('.github/workflows/post-deploy-publish.yml');
const postDeploy = parse(postDeployWf);
const fastPublish = parse(read('.github/workflows/fast-publish-article.yml'));

type Step = { name?: string; if?: string; run?: string; uses?: string; env?: Record<string, string>; id?: string };
const stepNamed = (steps: Step[], re: RegExp) => steps.find((s) => re.test(s.name || ''));

describe('post-publish Indexing API top-up', () => {
  const steps: Step[] = postDeploy.jobs.publish.steps;
  const dispatch = stepNamed(steps, /Dispatch Indexing API top-up/);

  it('is an explicit dispatch of monitor-gsc-seo.yml in post-publish mode, after the indexing step', () => {
    expect(dispatch?.run).toMatch(/gh workflow run monitor-gsc-seo\.yml --repo "\$GITHUB_REPOSITORY" --ref main -f mode=post-publish/);
    expect(existsSync(resolve('.github/workflows/monitor-gsc-seo.yml'))).toBe(true);
    const names = steps.map((s) => s.name);
    expect(names.indexOf(dispatch!.name)).toBeGreaterThan(names.indexOf('Post-deploy indexing (parallel)'));
    expect(dispatch?.if).toContain("steps.live_identity.outputs.status == 'match'");
  });

  it('dispatches with a token that can: the caller grants GITHUB_TOKEN actions: read only', () => {
    expect(postDeploy.jobs.publish.permissions.actions).toBe('read');
    expect(dispatch?.run).toContain('APP_TOKEN_ACTIONS');
    expect(dispatch?.run).toContain('GITHUB_PAT');
    expect(JSON.stringify(dispatch)).not.toContain('secrets.GITHUB_TOKEN');
    const mint = stepNamed(steps, /Mint App token for the Indexing API top-up/);
    expect(mint?.run).toContain('scripts/ci/mint-app-token.mjs');
    expect(steps.indexOf(mint!)).toBeLessThan(steps.indexOf(dispatch!));
  });

  it('monitor-gsc-seo.yml accepts the dispatch and no longer relies on workflow_run', () => {
    expect(monitor.on.workflow_run).toBeUndefined();
    expect(monitor.on.workflow_dispatch.inputs.mode.options).toContain('post-publish');
    expect(monitor.jobs.monitor.if).toContain("inputs.mode != 'post-publish'");
    expect(monitor.jobs.indexing.if).toContain('always()');
  });
});

describe('Indexing API ledger lives in Firestore', () => {
  const writers: Array<[string, { concurrency: { group: string }; steps: Step[] }]> = [
    ['monitor-gsc-seo.yml#indexing', monitor.jobs.indexing],
    ['fast-publish-article.yml#notify-search-engines', fastPublish.jobs['notify-search-engines']],
  ];

  it.each(writers)('%s: pull → write → push, never the Actions cache', (_name, job) => {
    expect(job.concurrency.group).toBe('indexing-api-jobs-ledger');
    expect(job.steps.some((s) => (s.uses || '').startsWith('actions/cache'))).toBe(false);
    const pull = job.steps.findIndex((s) => /indexing-ledger-store\.mjs pull/.test(s.run || ''));
    const push = job.steps.findIndex((s) => /indexing-ledger-store\.mjs push/.test(s.run || ''));
    const use = job.steps.findIndex((s) => /submit-google-indexing-jobs\.js|notify-article-search-engines\.mjs/.test(s.run || ''));
    expect(pull).toBeGreaterThan(-1);
    expect(use).toBeGreaterThan(pull);
    expect(push).toBeGreaterThan(use);
    expect(job.steps[push].if).toContain('always()');
    expect(job.steps[push].if).toContain(`steps.${job.steps[pull].id}.outcome == 'success'`);
  });

  it('the scheduled run may not spend the reserve left to the post-publish top-ups', () => {
    expect(monitor.env.INDEXING_API_DAILY_QUOTA).toBe('200');
    expect(Number(monitor.env.INDEXING_API_TOPUP_RESERVE)).toBeGreaterThan(0);
    expect(monitorWf).toContain('--max-first-run "$FIRST_RUN_SHARE"');
  });
});
