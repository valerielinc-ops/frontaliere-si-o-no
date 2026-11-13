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
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'yaml';

const read = (f: string) => readFileSync(resolve(f), 'utf8');
const monitorWf = read('.github/workflows/monitor-gsc-seo.yml');
const monitor = parse(monitorWf);
const postDeployWf = read('.github/workflows/post-deploy-publish.yml');
const postDeploy = parse(postDeployWf);
const fastPublish = parse(read('.github/workflows/fast-publish-article.yml'));
const publisher = parse(read('.github/workflows/deploy-publish.yml'));

type Step = { name?: string; if?: string; run?: string; uses?: string; env?: Record<string, string>; id?: string };
const stepNamed = (steps: Step[], re: RegExp) => steps.find((s) => re.test(s.name || ''));

describe('post-publish Indexing API top-up', () => {
  const steps: Step[] = postDeploy.jobs.publish.steps;
  const dispatch = stepNamed(steps, /Dispatch post-publish indexing loops/);

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

  it('bing-seo-loop.yml (same dead trigger) is dispatched too, audit-only like its former workflow_run runs', () => {
    expect(dispatch?.run).toMatch(/gh workflow run bing-seo-loop\.yml --repo "\$GITHUB_REPOSITORY" --ref main/);
    expect(dispatch?.run).toContain('-f after_publish=true -f apply_fixes=false -f submit_indexnow=false');
    const bing = parse(read('.github/workflows/bing-seo-loop.yml'));
    expect(bing.on.workflow_run).toBeUndefined();
    expect(bing.on.workflow_dispatch.inputs.after_publish.type).toBe('boolean');
  });

  it('no NEW workflow waits for a workflow_run of the publisher that never fires', () => {
    // Ratchet. audit-published-dist.yml has the same dead trigger (zero runs
    // in its history at 2026-11-10); its fix needs a dispatch from
    // deploy-publish.yml, which this change may not touch. Remove it from this
    // list when that lands — the test fails until you do.
    const KNOWN_DEAD = ['audit-published-dist.yml'];
    const offenders = readdirSync(resolve('.github/workflows'))
      .filter((f: string) => /\.ya?ml$/.test(f))
      .filter((f: string) => {
        const on = parse(read(`.github/workflows/${f}`))?.on;
        const wr = on && typeof on === 'object' ? on.workflow_run : undefined;
        return Boolean(wr?.workflows?.includes('Publish to GitHub Pages (deploy + validate)'));
      });
    expect(offenders).toEqual(KNOWN_DEAD);
  });

  it('monitor-gsc-seo.yml accepts the dispatch and no longer relies on workflow_run', () => {
    expect(monitor.on.workflow_run).toBeUndefined();
    expect(monitor.on.workflow_dispatch.inputs.mode.options).toContain('post-publish');
    expect(monitor.jobs.monitor.if).toContain("inputs.mode != 'post-publish'");
    expect(monitor.jobs.indexing.if).toContain('always()');
  });
});

describe('exact post-publish Cathedral SEO audit', () => {
  const watchdog = publisher.jobs['runtime-watchdog'];
  const steps: Step[] = watchdog.steps;
  const dispatch = stepNamed(steps, /Dispatch exact published dist to Cathedral SEO gates/);

  it('dispatches the validated publisher run and source SHA explicitly', () => {
    const command = dispatch?.run?.replace(/\\\n\s*/g, '');
    expect(command).toContain('gh workflow run cathedral-seo-gates-check.yml --repo "$GITHUB_REPOSITORY" --ref main');
    expect(command).toContain('-f deploy_run_id="$PUBLISHER_RUN_ID"');
    expect(command).toContain('-f source_sha="$PUBLISHER_SOURCE_SHA"');
    expect(dispatch?.env?.PUBLISHER_RUN_ID).toBe('${{ github.run_id }}');
    expect(dispatch?.env?.PUBLISHER_SOURCE_SHA).toBe('${{ inputs.source_sha }}');
    expect(dispatch?.if).toContain("needs.publish.result == 'success'");
    expect(dispatch?.if).toContain("needs.validate-dist.result == 'success'");
    expect(dispatch?.if).toContain("needs.validate-live.result == 'success'");
    expect(watchdog.permissions.actions).toBe('write');
  });

  it('accepts the pinned inputs and does not rely on a suppressed workflow_run event', () => {
    const cathedral = parse(read('.github/workflows/cathedral-seo-gates-check.yml'));
    expect(cathedral.on.workflow_run).toBeUndefined();
    expect(cathedral.on.workflow_dispatch.inputs.deploy_run_id).toBeDefined();
    expect(cathedral.on.workflow_dispatch.inputs.source_sha).toBeDefined();
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

describe('the indexing job reads the active-job dataset', () => {
  // Job sitemaps only move with a full publish (frozen at 06-11 from
  // 2026-11-06 while offers kept going live with the section shards), so the
  // submitter also reads the dataset the build publishes on the data CDN. It
  // is fetched over HTTP: the job's sparse checkout keeps out the crawler
  // slices the assembled jobs file would need, and must keep in the canton
  // tables that turn a dataset record into the URL the build emits.
  const indexing = monitor.jobs.indexing;
  const checkout = (indexing.steps as Array<Step & { with?: Record<string, string> }>).find((s) => (s.uses || '').startsWith('actions/checkout'));
  const excluded = String(checkout?.with?.['sparse-checkout'] || '')
    .split('\n').map((l) => l.trim()).filter((l) => l.startsWith('!/')).map((l) => l.slice(2));

  it('keeps the canton tables and the modules the dataset source loads', () => {
    const dataset = read('scripts/lib/indexing-jobs-dataset.mjs');
    expect(dataset).toContain("read('canton-url-slugs.json')");
    expect(dataset).toContain("read('canton-municipalities.json')");
    for (const rel of [
      'data/canton-url-slugs.json',
      'data/canton-municipalities.json',
      'scripts/lib/indexing-jobs-dataset.mjs',
      'scripts/lib/job-sitemap-lastmod.mjs',
      'build-plugins/shared/cantonResolvers.mjs',
      'build-plugins/shared/cdnAssetOffloadRx.mjs',
    ]) {
      expect(existsSync(resolve(rel))).toBe(true);
      expect(excluded.filter((prefix) => rel.startsWith(prefix))).toEqual([]);
    }
  });

  it('does not check out the crawler slices: the dataset comes from the CDN', () => {
    expect(excluded).toContain('data/jobs/');
    expect(read('scripts/lib/indexing-jobs-dataset.mjs')).toMatch(/CDN_ASSET_ORIGIN\}\/data\/jobs-it-index\.json/);
    expect(read('scripts/submit-google-indexing-jobs.js')).toContain('loadDatasetJobEntries');
  });
});
