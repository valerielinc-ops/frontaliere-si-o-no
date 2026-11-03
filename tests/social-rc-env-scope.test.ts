import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

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
  '.github/workflows/reddit-jobs-daily-schedule.yml':
    [
      'REDDIT_CLIENT_ID,REDDIT_CLIENT_SECRET,REDDIT_USERNAME,REDDIT_PASSWORD,REDDIT_USER_AGENT,REDDIT_DATA_API_APPROVED,SOCIAL_COPY_EXPERIMENT_CONFIG',
      'GITHUB_PAT',
    ],
  '.github/workflows/social-publish-readiness-watch.yml':
    ['FB_PAGE_ID,FB_USER_ACCESS_TOKEN,INSTAGRAM_ACCESS_TOKEN,INSTAGRAM_BUSINESS_ACCOUNT_ID,REDDIT_DATA_API_APPROVED,REDDIT_CLIENT_ID,REDDIT_CLIENT_SECRET'],
  '.github/workflows/social-robot-confirm.yml': ['GITHUB_PAT'],
} as const;

describe('social workflow Remote Config scopes', () => {
  it.each(Object.entries(SOCIAL_WORKFLOW_RC_SCOPES))(
    '%s exports only its declared social keys',
    (relativePath, expectedScope) => {
      const workflow = readFileSync(resolve(ROOT, relativePath), 'utf8');
      const invocations = [...workflow.matchAll(/node scripts\/load-rc-env\.mjs\b/gu)];
      const scopes = invocations.map(({ index = 0 }) => {
        const nextStep = workflow.indexOf('\n      - ', index);
        const step = workflow.slice(index, nextStep < 0 ? undefined : nextStep);
        return step.match(/--only-env=([A-Z0-9_,]+)/u)?.[1] ?? null;
      });

      expect(scopes).toEqual(expectedScope);
    },
  );
});
