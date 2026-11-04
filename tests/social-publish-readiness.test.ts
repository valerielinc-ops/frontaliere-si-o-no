/**
 * Guard for scripts/lib/social-readiness.mjs — the decision table that tells a
 * social channel's "waiting on a platform review" apart from its "the platform
 * already said no" and from its "it can post right now and nobody noticed".
 *
 * The three states were previously one state ("parked, owner decision"), and
 * that conflation is what these tests pin. The case that matters most is the
 * last describe block: a channel whose credentials arrived while every poster
 * kept soft-skipping is the failure this module exists to make loud.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { RC_TO_ENV } from '../scripts/load-rc-env.mjs';

import {
  classifyInstagram,
  classifyTikTok,
  classifyReddit,
  classifyAll,
  actionableChannels,
  instagramSetupActionChannels,
  isExternalWait,
  isActionable,
  formatVerdictTable,
  READY,
  ACTION_REQUIRED,
  AWAITING_EXTERNAL_APPROVAL,
  PATH_REFUSED,
  CREDENTIAL_MISSING,
  REDDIT_DATA_API_DENIED_ON,
} from '../scripts/lib/social-readiness.mjs';

describe('readiness workflow summary CLI', () => {
  it('writes one-probe channel outputs and includes safe probe diagnostics', () => {
    const root = process.cwd();
    const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'social-readiness-cli-'));
    const outputPath = path.join(temporaryDirectory, 'github-output');
    try {
      const result = spawnSync(
        process.execPath,
        [path.join(root, 'scripts/check-social-publish-readiness.mjs'), '--github-summary'],
        {
          cwd: root,
          encoding: 'utf8',
          env: {
            ...process.env,
            GITHUB_OUTPUT: outputPath,
            FB_PAGE_ID: 'test-page',
            FB_USER_ACCESS_TOKEN: '',
            INSTAGRAM_BUSINESS_ACCOUNT_ID: 'test-instagram-account',
            INSTAGRAM_ACCESS_TOKEN: '',
            REDDIT_CLIENT_ID: '',
            REDDIT_CLIENT_SECRET: '',
          },
        },
      );

      expect(result.error).toBeUndefined();
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('social publish readiness');
      expect(result.stdout).toContain('Page link probe skipped because FB_PAGE_ID or FB_USER_ACCESS_TOKEN is missing');
      expect(result.stdout).toContain('Publish permission probe skipped because FB_USER_ACCESS_TOKEN is missing');
      const output = readFileSync(outputPath, 'utf8');
      expect(output).toMatch(/^ready=$/mu);
      expect(output).toMatch(/^action_required=instagram$/mu);
      expect(output).toMatch(/^capability_action_required=$/mu);
      expect(output).toMatch(/^capability_ready=$/mu);
      expect(output).toContain('reason_instagram=The configured Instagram account cannot be verified against the Facebook Page');
      expect(output).not.toContain('test-page');
      expect(output).not.toContain('test-instagram-account');
    } finally {
      rmSync(temporaryDirectory, { recursive: true, force: true });
    }
  });

  it('loads token expiry metadata privately and creates a deduplicated lifecycle alert', () => {
    const workflow = readFileSync(new URL('../.github/workflows/social-publish-readiness-watch.yml', import.meta.url), 'utf8');

    expect(workflow).toContain('FB_USER_ACCESS_TOKEN_EXPIRES_AT');
    expect(workflow).toContain('FB_PAGE_ACCESS_TOKEN_EXPIRES_AT');
    expect(workflow).toContain('INSTAGRAM_ACCESS_TOKEN_EXPIRES_AT');
    expect(workflow).toContain('for name in FB_PAGE_ACCESS_TOKEN FB_USER_ACCESS_TOKEN');
    expect(workflow).toContain('unset FB_PAGE_ID FB_PAGE_ACCESS_TOKEN');
    expect(workflow).toContain("steps.probe.outputs.meta_token_lifecycle_action_required == 'true'");
    expect(workflow).toContain('Meta social token expiry needs owner action');
    expect(workflow).toContain('no token values or account IDs.');
  });
});

describe('Instagram — Page link, publisher identity, and Meta publishing grant', () => {
  it('maps the Page-link verifier token only from its server-side Remote Config key', () => {
    expect(RC_TO_ENV.SERVER_FB_USER_ACCESS_TOKEN).toEqual(['FB_USER_ACCESS_TOKEN']);
    expect(RC_TO_ENV.SERVER_FB_USER_ACCESS_TOKEN_EXPIRES_AT).toEqual(['FB_USER_ACCESS_TOKEN_EXPIRES_AT']);
    expect(RC_TO_ENV.SERVER_FB_PAGE_ACCESS_TOKEN_EXPIRES_AT).toEqual(['FB_PAGE_ACCESS_TOKEN_EXPIRES_AT']);
    expect(RC_TO_ENV.SERVER_INSTAGRAM_ACCESS_TOKEN_EXPIRES_AT).toEqual(['INSTAGRAM_ACCESS_TOKEN_EXPIRES_AT']);
  });

  it('requires owner action when the Page is linked but Meta has not granted publishing permission', () => {
    const v = classifyInstagram({
      env: {
        FB_PAGE_ID: 'page',
        FB_USER_ACCESS_TOKEN: 'user-token',
        INSTAGRAM_BUSINESS_ACCOUNT_ID: 'ig',
      },
      probe: {
        pageLinkStatus: 'matched',
        permissionStatuses: { instagram_basic: 'granted' },
        publishPermissionStatus: 'missing',
      },
    });
    expect(v.state).toBe(ACTION_REQUIRED);
    expect(v.reason).toMatch(/instagram_content_publish permission as granted/);
    expect(isExternalWait(v.state)).toBe(false);
    expect(isActionable(v.state)).toBe(true);
  });

  it('is ready only after Page link, publisher identity, and publishing permission are verified', () => {
    const v = classifyInstagram({
      env: { INSTAGRAM_ACCESS_TOKEN: 'ig-token', INSTAGRAM_BUSINESS_ACCOUNT_ID: 'ig' },
      probe: {
        pageLinkStatus: 'matched',
        publisherTokenStatus: 'matched',
        publisherTokenSourceStatus: 'matched',
        pageTaskStatus: 'granted',
        permissionStatuses: { instagram_basic: 'granted' },
        publishPermissionStatus: 'granted',
      },
    });
    expect(v.state).toBe(READY);
  });

  it('does not report ready when a token and account ID exist but publishing probes are unavailable', () => {
    const v = classifyInstagram({
      env: { INSTAGRAM_ACCESS_TOKEN: 'ig-token', INSTAGRAM_BUSINESS_ACCOUNT_ID: 'ig' },
      probe: { pageLinkStatus: 'unavailable' },
    });
    expect(v.state).toBe(ACTION_REQUIRED);
  });

  it('does not report ready when Page and scope match but publisher token identity is unavailable', () => {
    const v = classifyInstagram({
      env: { INSTAGRAM_ACCESS_TOKEN: 'ig-token', INSTAGRAM_BUSINESS_ACCOUNT_ID: 'ig' },
      probe: {
        pageLinkStatus: 'matched',
        publisherTokenStatus: 'unavailable',
        publishPermissionStatus: 'granted',
      },
    });
    expect(v.state).toBe(ACTION_REQUIRED);
  });

  it('does not report ready when the configured Page token came from another user token/app grant', () => {
    const v = classifyInstagram({
      env: { INSTAGRAM_ACCESS_TOKEN: 'ig-token', INSTAGRAM_BUSINESS_ACCOUNT_ID: 'ig' },
      probe: {
        pageLinkStatus: 'matched',
        publisherTokenStatus: 'matched',
        publisherTokenSourceStatus: 'mismatch',
        pageTaskStatus: 'granted',
        publishPermissionStatus: 'granted',
      },
    });
    expect(v.state).toBe(ACTION_REQUIRED);
    expect(v.reason).toMatch(/same Page and user token/);
  });

  it('requires action when the publisher token resolves but Meta has not granted publish scope', () => {
    const v = classifyInstagram({
      env: { INSTAGRAM_ACCESS_TOKEN: 'ig-token', INSTAGRAM_BUSINESS_ACCOUNT_ID: 'ig' },
      probe: {
        pageLinkStatus: 'matched',
        publisherTokenStatus: 'matched',
        permissionStatuses: { instagram_basic: 'granted' },
        publishPermissionStatus: 'missing',
      },
    });
    expect(v.state).toBe(ACTION_REQUIRED);
  });

  it('requires action when Meta does not expose the Page link and does not infer that ids prove it', () => {
    const v = classifyInstagram({
      env: { FB_PAGE_ID: 'page', INSTAGRAM_BUSINESS_ACCOUNT_ID: 'ig' },
      probe: { pageLinkStatus: 'unverified' },
    });
    expect(v.state).toBe(ACTION_REQUIRED);
    expect(v.reason).toMatch(/cannot be verified against the Facebook Page/);
    expect(isActionable(v.state)).toBe(true);
  });

  it('requires action when the Page exposes a different account than the configured id', () => {
    const v = classifyInstagram({
      env: { INSTAGRAM_ACCESS_TOKEN: 'ig-token', INSTAGRAM_BUSINESS_ACCOUNT_ID: 'ig-configured' },
      probe: { pageLinkStatus: 'mismatch' },
    });
    expect(v.state).toBe(ACTION_REQUIRED);
    expect(v.reason).toMatch(/does not match INSTAGRAM_BUSINESS_ACCOUNT_ID/);
  });

  it('does not call a configured id alone a verified Page link', () => {
    const v = classifyInstagram({
      env: { FB_PAGE_ID: 'p', INSTAGRAM_BUSINESS_ACCOUNT_ID: 'ig' },
      probe: { pageLinkStatus: 'unverified' },
    });
    expect(v.state).toBe(ACTION_REQUIRED);
  });

  it('is a missing credential, not a wait, when nothing was ever submitted', () => {
    const v = classifyInstagram({ env: {}, probe: {} });
    expect(v.state).toBe(CREDENTIAL_MISSING);
    expect(isActionable(v.state)).toBe(true);
  });

  it('requires the target account id when only an access token is configured', () => {
    expect(classifyInstagram({ env: { INSTAGRAM_ACCESS_TOKEN: 'token' } }).state).toBe(ACTION_REQUIRED);
  });
});

describe('TikTok — internal publishing policy hold', () => {
  it('stays blocked regardless of user tokens, refresh credentials, or API audit status', () => {
    for (const env of [
      {},
      { TIKTOK_ACCESS_TOKEN: 'act...' },
      { TIKTOK_REFRESH_TOKEN: 'r', TIKTOK_CLIENT_KEY: 'k', TIKTOK_CLIENT_SECRET: 's' },
      { TIKTOK_ACCESS_TOKEN: 'a', TIKTOK_PRIVACY_LEVEL: 'PUBLIC_TO_EVERYONE' },
    ]) {
      const v = classifyTikTok({ env, probe: { appLive: true } });
      expect(v.state).toBe(AWAITING_EXTERNAL_APPROVAL);
      expect(v.reason).toMatch(/internal utilities/);
      expect(isActionable(v.state)).toBe(false);
    }
  });
});

describe('Reddit — the refusal that is not a wait', () => {
  it('is path-refused, never awaiting-external-approval', () => {
    const v = classifyReddit({ env: {} });
    expect(v.state).toBe(PATH_REFUSED);
    expect(isExternalWait(v.state)).toBe(false);
    // A refusal is work to do (find another path), not patience to exercise.
    expect(isActionable(v.state)).toBe(true);
  });

  it('carries the denial date and points at the replacement path', () => {
    const v = classifyReddit({ env: {} });
    expect(v.reason).toContain(REDDIT_DATA_API_DENIED_ON);
    expect(v.reason).toMatch(/Devvit/);
  });

  it('does not treat credentials alone as approval to use the Data API', () => {
    const v = classifyReddit({ env: { REDDIT_CLIENT_ID: 'id', REDDIT_CLIENT_SECRET: 'sec' } });
    expect(v.state).toBe(PATH_REFUSED);
    expect(v.reason).toMatch(/REDDIT_DATA_API_APPROVED=true/);
  });

  it('reopens the classic path only with explicit approval and credentials', () => {
    const v = classifyReddit({ env: {
      REDDIT_DATA_API_APPROVED: 'true',
      REDDIT_CLIENT_ID: 'id',
      REDDIT_CLIENT_SECRET: 'sec',
    } });
    expect(v.state).toBe(READY);
  });

  it('reports missing credentials if approval is recorded but credentials are absent', () => {
    expect(classifyReddit({ env: { REDDIT_DATA_API_APPROVED: 'true' } }).state).toBe(CREDENTIAL_MISSING);
  });

  it('treats whitespace-only credentials as absent', () => {
    expect(classifyReddit({ env: { REDDIT_CLIENT_ID: '   ', REDDIT_CLIENT_SECRET: '\t' } }).state).toBe(PATH_REFUSED);
  });
});

describe('classifyAll / actionableChannels', () => {
  it('covers every channel exactly once', () => {
    const all = classifyAll({ env: {}, probes: {} });
    expect(all.map((v) => v.channel).sort()).toEqual(['instagram', 'reddit', 'tiktok']);
  });

  it('keeps TikTok external waits out of actionable while Instagram verification remains actionable', () => {
    const all = classifyAll({
      env: { FB_PAGE_ID: 'p', INSTAGRAM_BUSINESS_ACCOUNT_ID: 'ig', TIKTOK_CLIENT_KEY: 'k' },
      probes: { instagram: { pageLinkStatus: 'matched' }, tiktok: { appLive: true } },
    });
    expect(actionableChannels(all).map((v) => v.channel).sort()).toEqual(['instagram', 'reddit']);
    expect(instagramSetupActionChannels(all).map((v) => v.channel)).toEqual(['instagram']);
  });

  it('keeps the Instagram setup issue open for both incomplete linkage and missing credentials', () => {
    const all = classifyAll({ env: {}, probes: {} });
    expect(instagramSetupActionChannels(all).map((v) => v.channel)).toEqual(['instagram']);
  });

  it('surfaces an eligible channel whose credential quietly arrived — the RC_TO_ENV failure mode', () => {
    // Instagram RC params existed for days while load-rc-env.mjs did not map
    // them; a token without its target account id still needs action.
    const all = classifyAll({
      env: { INSTAGRAM_ACCESS_TOKEN: 'EAAG', TIKTOK_ACCESS_TOKEN: 'act' },
      probes: {},
    });
    expect(actionableChannels(all).map((v) => v.channel).sort()).toEqual(['instagram', 'reddit']);
  });

  it('never throws on a completely empty environment', () => {
    expect(() => classifyAll()).not.toThrow();
    expect(classifyAll()).toHaveLength(3);
  });

  it('formats one aligned line per channel', () => {
    const lines = formatVerdictTable(classifyAll({ env: {}, probes: {} })).split('\n');
    expect(lines).toHaveLength(3);
    expect(lines.every((l) => /\S/.test(l))).toBe(true);
  });
});
