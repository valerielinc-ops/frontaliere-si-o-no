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
  it('reports missing publisher credentials and skips only the live publish step', () => {
    const workflow = YAML.parse(fs.readFileSync(
      path.join(ROOT, '.github', 'workflows', 'instagram-reel-experiment.yml'),
      'utf8',
    )) as WorkflowDocument;
    const steps = workflow.jobs.build.steps as WorkflowStep[];
    const warn = steps.find((step) => /missing Instagram publisher credentials/.test(step.name ?? ''));
    const recheck = steps.find((step) => /credential transaction is idle/.test(step.name ?? ''));
    const publish = steps.find((step) => /Render and publish controlled Reel through Graph API/.test(step.name ?? ''));

    expect(warn?.if).toBe("env.DRY_RUN != 'true' && env.INSTAGRAM_PUBLISHER_CREDENTIALS_PRESENT != 'true'");
    expect(publish?.if).toBe("env.DRY_RUN == 'true' || env.INSTAGRAM_PUBLISHER_CREDENTIALS_PRESENT == 'true'");
    expect(recheck?.if).toBe("env.DRY_RUN != 'true'");
    expect(steps.indexOf(recheck!)).toBe(steps.indexOf(publish!) - 1);
  });

  it('limits the direct-login access token to the loader, publisher, readiness probe, and refresh steps', () => {
    const expectedTokenSteps: Record<string, string[]> = {
      '.github/workflows/instagram-daily-broadcast.yml': [
        'Load Instagram Login publisher identity from server Remote Config',
        'Confirm Instagram credential transaction is idle before delivery',
        'Post to Instagram',
      ],
      '.github/workflows/instagram-reel-experiment.yml': [
        'Load Instagram Login publisher identity from server Remote Config',
        'Confirm Instagram credential transaction is idle before delivery',
        'Render and publish controlled Reel through Graph API',
      ],
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
