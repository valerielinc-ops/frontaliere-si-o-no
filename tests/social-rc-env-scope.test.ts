import { readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import YAML from 'yaml';

import {
  missingRequiredSocialEnvKeys,
  NON_SOCIAL_PRIVATE_SERVER_SECRET_RC_KEYS,
  PRIVATE_SERVER_SECRET_RC_KEYS,
  RC_TO_ENV,
  selectMappedEnvKeysForLoad,
  SERVER_ONLY_RC_KEYS,
  SOCIAL_SERVER_SECRET_RC_KEYS,
} from '../scripts/load-rc-env.mjs';

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
    [null, 'FB_PAGE_ACCESS_TOKEN'],
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
  it('skips the optional private Facebook token loader when Firebase credentials are absent', () => {
    const workflow = YAML.parse(readFileSync(resolve(ROOT, '.github/workflows/topic-candidates-mining.yml'), 'utf8'));
    const steps = workflow.jobs.mine.steps;
    const credentialsStep = steps.find((step: any) => step.name === 'Write Firebase service-account JSON to /tmp');
    const privateLoaderIndex = steps.findIndex((step: any) => step.name === 'Load Facebook Page token from private Remote Config');
    const privateLoader = steps[privateLoaderIndex];
    const mineIndex = steps.findIndex((step: any) => step.name === 'Mine topic candidates');

    expect(credentialsStep.id).toBe('firebase_credentials');
    expect(credentialsStep.run).toContain('echo "available=true" >> "$GITHUB_OUTPUT"');
    expect(credentialsStep.run).toContain('echo "available=false" >> "$GITHUB_OUTPUT"');
    expect(privateLoader.if).toBe("${{ steps.firebase_credentials.outputs.available == 'true' }}");
    expect(privateLoader.run).toContain('--only-env=FB_PAGE_ACCESS_TOKEN --include-social-secrets');
    expect(mineIndex).toBeGreaterThan(privateLoaderIndex);
  });

  it('maps every allowlisted private social parameter to an environment variable', () => {
    const missing = [...SOCIAL_SERVER_SECRET_RC_KEYS].filter((rcKey) => !(rcKey in RC_TO_ENV));
    expect(missing).toEqual([]);
  });

  it('maps every private server credential selected by the loader', () => {
    expect([...PRIVATE_SERVER_SECRET_RC_KEYS].filter((rcKey) => !(rcKey in RC_TO_ENV))).toEqual([]);
    expect([...Object.keys(RC_TO_ENV).filter((rcKey) => rcKey.startsWith('SERVER_'))]
      .filter((rcKey) => !SERVER_ONLY_RC_KEYS.has(rcKey))).toEqual([]);
    expect([...SERVER_ONLY_RC_KEYS]
      .filter((rcKey) => !PRIVATE_SERVER_SECRET_RC_KEYS.has(rcKey)
        && !['SERVER_GA4_PROPERTY_ID', 'SERVER_POSTHOG_PROJECT_ID', 'SERVER_POSTHOG_HOST'].includes(rcKey)))
      .toEqual([]);
    expect(SERVER_ONLY_RC_KEYS.has('SERVER_GA4_PROPERTY_ID')).toBe(true);
    expect(PRIVATE_SERVER_SECRET_RC_KEYS.has('SERVER_GA4_PROPERTY_ID')).toBe(false);
    expect(SOCIAL_SERVER_SECRET_RC_KEYS.has('SERVER_PHARMACY_FACEBOOK_PAGE_ACCESS_TOKEN')).toBe(true);
    expect(PRIVATE_SERVER_SECRET_RC_KEYS.has('SERVER_PIXABAY_API_KEY')).toBe(true);
  });

  it('maps OAuth token metadata and sandbox credentials only through the private template', () => {
    for (const [rcKey, envKey] of [
      ['SERVER_LINKEDIN_MEMBER_ACCESS_TOKEN_EXPIRES_AT', 'LINKEDIN_MEMBER_ACCESS_TOKEN_EXPIRES_AT'],
      ['SERVER_LINKEDIN_MEMBER_URN', 'LINKEDIN_MEMBER_URN'],
      ['SERVER_R2_ACCESS_KEY_ID', 'R2_ACCESS_KEY_ID'],
      ['SERVER_R2_SECRET_ACCESS_KEY', 'R2_SECRET_ACCESS_KEY'],
      ['SERVER_TIKTOK_CLIENT_KEY', 'TIKTOK_CLIENT_KEY'],
      ['SERVER_TIKTOK_OPEN_ID', 'TIKTOK_OPEN_ID'],
      ['SERVER_TIKTOK_ACCESS_TOKEN_EXPIRES_AT', 'TIKTOK_ACCESS_TOKEN_EXPIRES_AT'],
      ['SERVER_TIKTOK_REFRESH_TOKEN_EXPIRES_AT', 'TIKTOK_REFRESH_TOKEN_EXPIRES_AT'],
      ['SERVER_TIKTOK_SANDBOX_ACCESS_TOKEN', 'TIKTOK_SANDBOX_ACCESS_TOKEN'],
      ['SERVER_TIKTOK_SANDBOX_OPEN_ID', 'TIKTOK_SANDBOX_OPEN_ID'],
      ['SERVER_TIKTOK_SANDBOX_REFRESH_TOKEN', 'TIKTOK_SANDBOX_REFRESH_TOKEN'],
    ]) {
      expect(SOCIAL_SERVER_SECRET_RC_KEYS.has(rcKey)).toBe(true);
      expect(RC_TO_ENV[rcKey]).toContain(envKey);
    }
  });

  it('never maps LinkedIn Sign-In secrets or session tokens from the downloadable client template', () => {
    for (const key of [
      'LINKEDIN_SIGNIN_CLIENT_SECRET',
      'LINKEDIN_SIGNIN_ACCESS_TOKEN',
      'LINKEDIN_SIGNIN_REFRESH_TOKEN',
    ]) {
      expect(RC_TO_ENV).not.toHaveProperty(key);
    }
    expect(RC_TO_ENV.LINKEDIN_SIGNIN_CLIENT_ID).toEqual(['LINKEDIN_SIGNIN_CLIENT_ID']);
  });

  it('has one private source for the LinkedIn target identity and R2 write credentials', () => {
    for (const envKey of ['LINKEDIN_MEMBER_URN', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY']) {
      const sources = Object.entries(RC_TO_ENV)
        .filter(([, envKeys]) => envKeys.includes(envKey))
        .map(([rcKey]) => rcKey);
      expect(sources).toHaveLength(1);
      expect(SOCIAL_SERVER_SECRET_RC_KEYS.has(sources[0])).toBe(true);
    }
  });

  it('never exports private server values by default or from a social-only allowlist', () => {
    for (const rcKey of PRIVATE_SERVER_SECRET_RC_KEYS) {
      expect(selectMappedEnvKeysForLoad({
        rcKey,
        mappedEnvKeys: RC_TO_ENV[rcKey],
      }), rcKey).toEqual([]);
    }

    const socialOnly = new Set(['R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY']);
    for (const rcKey of NON_SOCIAL_PRIVATE_SERVER_SECRET_RC_KEYS) {
      expect(selectMappedEnvKeysForLoad({
        rcKey,
        mappedEnvKeys: RC_TO_ENV[rcKey],
        onlySocialEnvKeys: socialOnly,
        includeSocialSecrets: true,
      }), rcKey).toEqual([]);
    }

    expect(selectMappedEnvKeysForLoad({
      rcKey: 'SERVER_MAILEROO_ACCOUNT_API_KEY',
      mappedEnvKeys: RC_TO_ENV.SERVER_MAILEROO_ACCOUNT_API_KEY,
      onlyPrivateServerEnvKeys: new Set(['MAILEROO_ACCOUNT_API_KEY']),
      includePrivateServerSecrets: true,
    })).toEqual(['MAILEROO_ACCOUNT_API_KEY']);
  });

  it('requires every non-social private workflow load to carry an exact allowlist', () => {
    const privateEnvKeys = new Set(
      [...NON_SOCIAL_PRIVATE_SERVER_SECRET_RC_KEYS].flatMap((rcKey) => RC_TO_ENV[rcKey]),
    );
    const visit = (value: unknown, file: string) => {
      if (Array.isArray(value)) {
        for (const item of value) visit(item, file);
        return;
      }
      if (!value || typeof value !== 'object') return;
      const step = value as { run?: unknown };
      if (typeof step.run === 'string' && step.run.includes('load-rc-env.mjs')) {
        const hasPrivateOptIn = step.run.includes('--include-private-server-secrets');
        const scope = step.run.match(/--only-private-server-env=([A-Z0-9_,]+)/u)?.[1];
        if (hasPrivateOptIn) expect(scope, file).toBeTruthy();
        if (scope) {
          expect(hasPrivateOptIn, file).toBe(true);
          for (const envKey of scope.split(',')) {
            expect(privateEnvKeys.has(envKey), `${file}: ${envKey}`).toBe(true);
          }
        }
      }
      for (const child of Object.values(value)) visit(child, file);
    };

    for (const name of readdirSync(resolve(ROOT, '.github/workflows')).filter((file) => file.endsWith('.yml'))) {
      const workflow = YAML.parse(readFileSync(resolve(ROOT, '.github/workflows', name), 'utf8'));
      visit(workflow, name);
    }

    const sharedAiAction = readFileSync(resolve(ROOT, '.github/actions/setup-omniroute/action.yml'), 'utf8');
    expect(sharedAiAction).toContain('--include-private-server-secrets');
    expect(sharedAiAction).toContain('--only-private-server-env=CHUTES_API_KEY,ZAI_API_KEY');
  });

  it('loads the assisted-application evidence key privately before importing the agent', () => {
    const workflow = YAML.parse(readFileSync(resolve(ROOT, '.github/workflows/assisted-application-agent.yml'), 'utf8'));
    const steps = workflow.jobs.agent.steps;
    const privateLoaderIndex = steps.findIndex((step: any) => step.name === 'Load private assisted-application evidence key');
    const privateLoader = steps[privateLoaderIndex];
    const genericLoaderIndex = steps.findIndex((step: any) => step.name === 'Load RC secrets');
    const agentImportIndex = steps.findIndex((step: any) => step.name === 'Verify agent entry point before handling candidate data');

    expect(privateLoader.run).toBe('node scripts/load-rc-env.mjs --include-private-server-secrets --only-private-server-env=ASSISTED_APPLICATION_RUN_KEY');
    expect(privateLoaderIndex).toBeGreaterThan(genericLoaderIndex);
    expect(agentImportIndex).toBeGreaterThan(privateLoaderIndex);
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

    const unselected = spawnSync(process.execPath, [
      script,
      '--include-social-secrets',
      '--only-social-env=R2_ACCESS_KEY_ID,R2_SECRET_ACCESS_KEY',
      '--require-social-env=R2_ACCESS_KEY_ID,FB_PAGE_ACCESS_TOKEN',
    ], { env, encoding: 'utf8' });
    expect(unselected.status).toBe(1);
    expect(unselected.stderr).toContain('--require-social-env keys must also be selected');

    const broadPrivate = spawnSync(process.execPath, [script, '--include-private-server-secrets'], { env, encoding: 'utf8' });
    expect(broadPrivate.status).toBe(1);
    expect(broadPrivate.stderr).toContain('--include-private-server-secrets requires --only-env or --only-private-server-env');

    const optionalPrivateWithoutFirebaseAuth = spawnSync(process.execPath, [
      script,
      '--include-private-server-secrets',
      '--only-private-server-env=CHUTES_API_KEY',
    ], { env, encoding: 'utf8' });
    expect(optionalPrivateWithoutFirebaseAuth.status).toBe(0);
    expect(optionalPrivateWithoutFirebaseAuth.stderr).toContain('GOOGLE_APPLICATION_CREDENTIALS not set');

    const unoptedPrivate = spawnSync(process.execPath, [script, '--only-env=MAILEROO_ACCOUNT_API_KEY'], { env, encoding: 'utf8' });
    expect(unoptedPrivate.status).toBe(1);
    expect(unoptedPrivate.stderr).toContain('--include-private-server-secrets');
  });

  it('fails closed for absent required private keys without exposing values', () => {
    expect(missingRequiredSocialEnvKeys(
      new Set(['R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY']),
      new Set(['R2_ACCESS_KEY_ID']),
    )).toEqual(['R2_SECRET_ACCESS_KEY']);
    expect(JSON.stringify(missingRequiredSocialEnvKeys(
      new Set(['R2_ACCESS_KEY_ID']),
      new Set(),
    ))).not.toContain('fixture');
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

  it('loads the shared R2 write pair from the private template in every writer workflow', () => {
    for (const relativePath of [
      '.github/workflows/fast-publish-article.yml',
      '.github/workflows/instagram-daily-broadcast.yml',
      '.github/workflows/instagram-reel-experiment.yml',
      '.github/workflows/sync-articles-sitemaps.yml',
      '.github/workflows/deploy.yml',
      '.github/workflows/rerender-article-corpus.yml',
      '.github/workflows/rerender-article-hubs.yml',
      '.github/workflows/resync-cdn-article-chunks.yml',
      '.github/workflows/license-audit.yml',
      '.github/workflows/blog-cover-ledger.yml',
      '.github/workflows/event-image-library.yml',
      '.github/workflows/crawl-events.yml',
    ]) {
      const workflow = readFileSync(resolve(ROOT, relativePath), 'utf8');
      expect(workflow).toContain('--include-social-secrets');
      expect(workflow).toContain('R2_ACCESS_KEY_ID');
      expect(workflow).toContain('R2_SECRET_ACCESS_KEY');
    }
  });

  it('requires R2 credentials in the loader process before every required writer can continue', () => {
    for (const relativePath of [
      '.github/workflows/fast-publish-article.yml',
      '.github/workflows/instagram-daily-broadcast.yml',
      '.github/workflows/instagram-reel-experiment.yml',
      '.github/workflows/sync-articles-sitemaps.yml',
      '.github/workflows/deploy.yml',
      '.github/workflows/rerender-article-corpus.yml',
      '.github/workflows/rerender-article-hubs.yml',
      '.github/workflows/resync-cdn-article-chunks.yml',
      '.github/workflows/license-audit.yml',
      '.github/workflows/blog-cover-ledger.yml',
      '.github/workflows/event-image-library.yml',
    ]) {
      const workflow = readFileSync(resolve(ROOT, relativePath), 'utf8');
      expect(workflow, relativePath).toContain('--require-social-env=R2_ACCESS_KEY_ID,R2_SECRET_ACCESS_KEY');
      expect(workflow, relativePath).not.toMatch(/node scripts\/load-rc-env\.mjs[^\n]*\n\s*test -n/u);
    }
  });

  it('loads private R2 keys after public bucket metadata and before each non-social R2 writer', () => {
    const writers = [
      {
        path: '.github/workflows/deploy.yml', job: 'build-locale',
        writer: 'Push generated assets to CDN (early — ahead of the shard pushes)',
      },
      {
        path: '.github/workflows/rerender-article-corpus.yml', job: 'rerender',
        writer: 'Ensure the static shell scripts are on the CDN',
      },
      {
        path: '.github/workflows/rerender-article-hubs.yml', job: 'rerender',
        writer: 'Ensure the static shell scripts are on the CDN',
      },
      {
        path: '.github/workflows/resync-cdn-article-chunks.yml', job: 'resync',
        writer: 'Acquire article chunk section locks',
      },
      {
        path: '.github/workflows/license-audit.yml', job: 'audit',
        writer: 'Provision the existing R2 client for the inventory probe',
      },
      {
        path: '.github/workflows/blog-cover-ledger.yml', job: 'repair',
        writer: 'Upload generated bytes and unified ledger to the CDN',
      },
      {
        path: '.github/workflows/event-image-library.yml', job: 'generate',
        writer: 'Upload generated WebP assets to R2',
      },
      {
        path: '.github/workflows/crawl-events.yml', job: 'crawl-events',
        writer: "Push this run's mirrored event images to the CDN",
      },
      {
        path: '.github/workflows/sync-articles-sitemaps.yml', job: 'sync',
        writer: 'Acquire article chunk section locks for synced corpus',
      },
    ];

    for (const { path, job: jobName, writer } of writers) {
      const document = YAML.parse(readFileSync(resolve(ROOT, path), 'utf8'));
      const steps = document.jobs[jobName].steps;
      const privateIndex = steps.findIndex((step: any) => step.name === 'Load private R2 publishing credentials'
        || step.name === 'Load private R2 image credentials');
      const writerIndex = steps.findIndex((step: any) => step.name === writer);
      const privateRun = steps[privateIndex]?.run || '';
      const publicLoaderIndex = steps.findIndex((step: any) => (
        typeof step.run === 'string' && step.run.includes('node scripts/load-rc-env.mjs')
        && !step.run.includes('--include-social-secrets')
      ));

      expect(privateIndex, `${path}: private credential loader`).toBeGreaterThanOrEqual(0);
      expect(publicLoaderIndex, `${path}: public metadata loader`).toBeGreaterThanOrEqual(0);
      expect(privateIndex, `${path}: private loader follows public metadata`).toBeGreaterThan(publicLoaderIndex);
      expect(writerIndex, `${path}: R2 writer`).toBeGreaterThan(privateIndex);
      expect(privateRun).toContain('--only-social-env=R2_ACCESS_KEY_ID,R2_SECRET_ACCESS_KEY');
      if (path !== '.github/workflows/crawl-events.yml') {
        expect(privateRun).toContain('--require-social-env=R2_ACCESS_KEY_ID,R2_SECRET_ACCESS_KEY');
        expect(privateRun).not.toContain('test -n');
      }
    }

    const deploy = YAML.parse(readFileSync(resolve(ROOT, '.github/workflows/deploy.yml'), 'utf8'));
    const deployLoader = deploy.jobs['build-locale'].steps.find((step: any) => step.name === 'Load private R2 publishing credentials');
    expect(deployLoader.if).toContain("vars.CDN_TARGET == 'r2'");
  });
});
