import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';

import { RC_TO_ENV, SOCIAL_SERVER_SECRET_RC_KEYS } from '../scripts/load-rc-env.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const SOCIAL_WORKFLOW_RC_SCOPES = {
  '.github/workflows/fb-articles-daily-schedule.yml':
    [
      'FB_PAGE_ID,FB_PAGE_ACCESS_TOKEN,SOCIAL_COPY_EXPERIMENT_CONFIG',
      'GITHUB_PAT',
    ],
  '.github/workflows/fb-events-daily-schedule.yml':
    [
      'FB_PAGE_ID,FB_PAGE_ACCESS_TOKEN,SOCIAL_COPY_EXPERIMENT_CONFIG',
      'GITHUB_PAT',
    ],
  '.github/workflows/fb-jobs-daily-schedule.yml':
    [
      'FB_PAGE_ID,FB_PAGE_ACCESS_TOKEN,SOCIAL_COPY_EXPERIMENT_CONFIG',
      'GITHUB_PAT',
    ],
  '.github/workflows/monitor-telegram-member-count.yml':
    ['TELEGRAM_BOT_TOKEN,TELEGRAM_CHANNEL_ID,GITHUB_PAT'],
  '.github/workflows/topic-candidates-mining.yml':
    ['FB_PAGE_ACCESS_TOKEN'],
  '.github/workflows/reddit-jobs-daily-schedule.yml':
    [
      'REDDIT_CLIENT_ID,REDDIT_CLIENT_SECRET,REDDIT_USERNAME,REDDIT_PASSWORD,REDDIT_USER_AGENT,REDDIT_DATA_API_APPROVED,SOCIAL_COPY_EXPERIMENT_CONFIG',
      'GITHUB_PAT',
    ],
  '.github/workflows/social-publish-readiness-watch.yml':
    ['FB_PAGE_ID,FB_PAGE_ACCESS_TOKEN,FB_PAGE_ACCESS_TOKEN_EXPIRES_AT,FB_USER_ACCESS_TOKEN,FB_USER_ACCESS_TOKEN_EXPIRES_AT,INSTAGRAM_ACCESS_TOKEN,INSTAGRAM_ACCESS_TOKEN_EXPIRES_AT,INSTAGRAM_BUSINESS_ACCOUNT_ID,REDDIT_DATA_API_APPROVED,REDDIT_CLIENT_ID,REDDIT_CLIENT_SECRET'],
  '.github/workflows/instagram-story-insights.yml':
    ['FB_PAGE_ID,FB_USER_ACCESS_TOKEN,INSTAGRAM_BUSINESS_ACCOUNT_ID,INSTAGRAM_ACCESS_TOKEN'],
  '.github/workflows/social-robot-confirm.yml': ['GITHUB_PAT'],
} as const;

describe('social workflow Remote Config scopes', () => {
  it('maps every allowlisted private social parameter to an environment variable', () => {
    const missing = [...SOCIAL_SERVER_SECRET_RC_KEYS].filter((rcKey) => !(rcKey in RC_TO_ENV));
    expect(missing).toEqual([]);
  });

  it('maps OAuth token metadata and sandbox credentials only through the private template', () => {
    for (const [rcKey, envKey] of [
      ['SERVER_LINKEDIN_MEMBER_ACCESS_TOKEN_EXPIRES_AT', 'LINKEDIN_MEMBER_ACCESS_TOKEN_EXPIRES_AT'],
      ['SERVER_TIKTOK_CLIENT_KEY', 'TIKTOK_CLIENT_KEY'],
      ['SERVER_TIKTOK_ACCESS_TOKEN_EXPIRES_AT', 'TIKTOK_ACCESS_TOKEN_EXPIRES_AT'],
      ['SERVER_TIKTOK_REFRESH_TOKEN_EXPIRES_AT', 'TIKTOK_REFRESH_TOKEN_EXPIRES_AT'],
      ['SERVER_TIKTOK_SANDBOX_ACCESS_TOKEN', 'TIKTOK_SANDBOX_ACCESS_TOKEN'],
      ['SERVER_TIKTOK_SANDBOX_REFRESH_TOKEN', 'TIKTOK_SANDBOX_REFRESH_TOKEN'],
    ]) {
      expect(SOCIAL_SERVER_SECRET_RC_KEYS.has(rcKey)).toBe(true);
      expect(RC_TO_ENV[rcKey]).toContain(envKey);
    }
  });

  it.each(Object.entries(SOCIAL_WORKFLOW_RC_SCOPES))(
    '%s exports only its declared social keys',
    (relativePath, expectedScope) => {
      const workflow = readFileSync(resolve(ROOT, relativePath), 'utf8');
      const invocations = [...workflow.matchAll(/node scripts\/load-rc-env\.mjs\b/gu)];
      const scopes = invocations.map(({ index = 0 }) => {
        const nextStep = workflow.indexOf('\n      - ', index);
        const step = workflow.slice(index, nextStep < 0 ? undefined : nextStep);
        const scope = step.match(/--only-env=([A-Z0-9_,]+)/u)?.[1] ?? null;
        const needsServerSecrets = scope?.split(',').some((envKey) => (
          [...SOCIAL_SERVER_SECRET_RC_KEYS].some((rcKey) => RC_TO_ENV[rcKey]?.includes(envKey))
        ));
        if (needsServerSecrets) expect(step).toContain('--include-social-secrets');
        return scope;
      });

      expect(scopes).toEqual(expectedScope);
    },
  );

  it('requires explicit private-template opt-in and fails closed if credentials are unavailable', () => {
    const script = resolve(ROOT, 'scripts/load-rc-env.mjs');
    const env = { ...process.env, GOOGLE_APPLICATION_CREDENTIALS: '', GITHUB_ENV: '' };
    const broad = spawnSync(process.execPath, [script, '--include-social-secrets'], { env, encoding: 'utf8' });
    expect(broad.status).toBe(1);
    expect(broad.stderr).toContain('--include-social-secrets requires --only-env or --only-social-env');

    const scopedMixed = spawnSync(process.execPath, [script, '--include-social-secrets', '--only-social-env=LINKEDIN_POST_ACCESS_TOKEN'], { env, encoding: 'utf8' });
    expect(scopedMixed.status).toBe(1);
    expect(scopedMixed.stderr).toContain('GOOGLE_APPLICATION_CREDENTIALS is required for private social credentials');

    const implicit = spawnSync(process.execPath, [script, '--only-env=FB_PAGE_ACCESS_TOKEN'], { env, encoding: 'utf8' });
    expect(implicit.status).toBe(1);
    expect(implicit.stderr).toContain('--include-social-secrets');

    const unavailable = spawnSync(process.execPath, [script, '--only-env=FB_PAGE_ACCESS_TOKEN', '--include-social-secrets'], { env, encoding: 'utf8' });
    expect(unavailable.status).toBe(1);
    expect(unavailable.stderr).toContain('GOOGLE_APPLICATION_CREDENTIALS is required for private social credentials');
  });

  it('limits the mixed post-deploy workflow to its LinkedIn Company and Reddit server credentials', () => {
    const workflow = readFileSync(resolve(ROOT, '.github/workflows/post-deploy-publish.yml'), 'utf8');
    const invocation = workflow.match(/node scripts\/load-rc-env\.mjs[\s\S]{0,250}?--only-social-env=([A-Z0-9_,]+)/u);
    expect(invocation?.[1]?.split(',')).toEqual([
      'LINKEDIN_POST_CLIENT_SECRET',
      'LINKEDIN_POST_REFRESH_TOKEN',
      'LINKEDIN_POST_ACCESS_TOKEN',
      'REDDIT_CLIENT_SECRET',
      'REDDIT_PASSWORD',
      'REDDIT_REFRESH_TOKEN',
    ]);
  });
});
