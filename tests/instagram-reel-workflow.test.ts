import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import YAML from 'yaml';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

type WorkflowStep = {
  name?: string;
  id?: string;
  if?: string;
  run?: string;
  env?: Record<string, string | undefined>;
};

type WorkflowJob = {
  env?: Record<string, string | undefined>;
  steps?: WorkflowStep[];
};

type WorkflowDocument = {
  env?: Record<string, string | undefined>;
  jobs: Record<string, WorkflowJob>;
};

describe('Instagram Reel experiment workflow', () => {
  it('uses the owner-approved web publisher and queues Reels without Graph credentials', () => {
    const workflow = YAML.parse(fs.readFileSync(
      path.join(ROOT, '.github', 'workflows', 'instagram-reel-experiment.yml'),
      'utf8',
    )) as WorkflowDocument;
    const steps = workflow.jobs.build.steps as WorkflowStep[];
    const warn = steps.find((step) => /owner-approved browser publisher is disabled/.test(step.name ?? ''));
    const publish = steps.find((step) => /Render and queue controlled Reel for Instagram web publisher/.test(step.name ?? ''));
    const config = steps.find((step) => step.name === 'Load Remote Config');
    const commit = steps.find((step) => /Commit Reel browser queue and ledger/.test(step.name ?? ''));
    const source = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'instagram-reel-experiment.yml'), 'utf8');

    expect(warn?.if).toContain("env.SOCIAL_ROBOT_INSTAGRAM_BROWSER_PUBLISHING_OWNER_APPROVED != 'true'");
    expect(publish?.if).toContain("env.SOCIAL_ROBOT_INSTAGRAM_BROWSER_PUBLISHING_OWNER_APPROVED == 'true'");
    expect(config?.run).toContain('SOCIAL_ROBOT_PUBLISHING_MODE');
    expect(config?.run).toContain('SOCIAL_ROBOT_INSTAGRAM_BROWSER_PUBLISHING_OWNER_APPROVED');
    expect(config?.run).not.toContain('INSTAGRAM_ACCESS_TOKEN');
    expect(publish?.run).toContain('scripts/post-to-instagram-reel.mjs');
    expect(commit?.run).toContain('data/instagram-queue.json');
    expect(source).not.toContain('INSTAGRAM_LOGIN_ACCESS_TOKEN');
    expect(source).not.toContain('INSTAGRAM_ACCESS_TOKEN');
  });

  it('keeps carousel and Reel browser workflows independent from Instagram Login tokens', () => {
    for (const relativePath of [
      '.github/workflows/instagram-daily-broadcast.yml',
      '.github/workflows/instagram-reel-experiment.yml',
    ]) {
      const source = fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
      expect(source, relativePath).not.toContain('INSTAGRAM_LOGIN_ACCESS_TOKEN');
      expect(source, relativePath).not.toContain('INSTAGRAM_ACCESS_TOKEN');
    }
  });

  it('limits the direct-login access token to the loader, publisher, readiness probe, and refresh steps', () => {
    const expectedTokenSteps: Record<string, string[]> = {
      '.github/workflows/social-publish-readiness-watch.yml': [
        'Load Instagram Login publisher identity from server Remote Config',
        'Probe every channel',
      ],
      '.github/workflows/instagram-login-token-refresh.yml': [
        'Load Instagram Login metadata for stale-run check',
        'Refresh Instagram Login token and rotate GitHub secret',
      ],
    };
    const tokenSecret = '${{ secrets.INSTAGRAM_LOGIN_ACCESS_TOKEN }}';

    for (const [relativePath, allowedSteps] of Object.entries(expectedTokenSteps)) {
      const workflow = YAML.parse(fs.readFileSync(path.join(ROOT, relativePath), 'utf8')) as WorkflowDocument;
      expect(workflow.env?.INSTAGRAM_LOGIN_ACCESS_TOKEN, relativePath).toBeUndefined();
      for (const [jobName, job] of Object.entries(workflow.jobs)) {
        expect(job.env?.INSTAGRAM_LOGIN_ACCESS_TOKEN, `${relativePath} job ${jobName}`).toBeUndefined();
        for (const step of job.steps ?? []) {
          const receivesToken = step.env?.INSTAGRAM_LOGIN_ACCESS_TOKEN === tokenSecret;
          expect(receivesToken, `${relativePath}: ${step.name ?? step.id ?? 'unnamed step'}`)
            .toBe(allowedSteps.includes(step.name ?? ''));
        }
      }
    }

    const refreshWorkflow = YAML.parse(fs.readFileSync(
      path.join(ROOT, '.github/workflows/instagram-login-token-refresh.yml'),
      'utf8',
    )) as WorkflowDocument;
    const refreshSteps = refreshWorkflow.jobs.refresh.steps as WorkflowStep[];
    expect(refreshSteps.some((step) => step.run === 'node scripts/load-rc-env.mjs --only-env=GITHUB_PAT')).toBe(true);
    expect(refreshSteps.find((step) => step.name === 'Load Instagram Login metadata for stale-run check')?.run)
      .toBe('node scripts/load-instagram-login-env.mjs --allow-pending-token-write-lock');
  });
});
