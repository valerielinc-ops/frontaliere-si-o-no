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

import {
  classifyInstagram,
  classifyTikTok,
  classifyReddit,
  classifyAll,
  actionableChannels,
  isExternalWait,
  isActionable,
  formatVerdictTable,
  READY,
  AWAITING_EXTERNAL_APPROVAL,
  PATH_REFUSED,
  CREDENTIAL_MISSING,
  REDDIT_DATA_API_DENIED_ON,
} from '../scripts/lib/social-readiness.mjs';

describe('Instagram — Meta App Review', () => {
  it('is an external wait when the account exists but the Page token has no Instagram scope', () => {
    const v = classifyInstagram({
      env: { FB_PAGE_ID: '951226518080080', INSTAGRAM_BUSINESS_ACCOUNT_ID: '17841439417386982' },
      probe: { pageLinked: false },
    });
    expect(v.state).toBe(AWAITING_EXTERNAL_APPROVAL);
    expect(v.waitingOn).toMatch(/App Review/);
    expect(isExternalWait(v.state)).toBe(true);
    expect(isActionable(v.state)).toBe(false);
  });

  it('flips to ready the moment the Page starts exposing instagram_business_account', () => {
    const v = classifyInstagram({
      env: { FB_PAGE_ID: '951226518080080', INSTAGRAM_BUSINESS_ACCOUNT_ID: '17841439417386982' },
      probe: { pageLinked: true },
    });
    expect(v.state).toBe(READY);
    expect(v.reason).toMatch(/SERVER_INSTAGRAM_ACCESS_TOKEN/);
  });

  it('does NOT call the account id alone a sign of approval — it is a public identifier, not a grant', () => {
    // The whole point of probing the Page instead of trusting Remote Config:
    // the owner can paste this id in at any time, review or no review.
    const v = classifyInstagram({
      env: { FB_PAGE_ID: 'p', INSTAGRAM_BUSINESS_ACCOUNT_ID: 'ig' },
      probe: {},
    });
    expect(v.state).not.toBe(READY);
  });

  it('is a missing credential, not a wait, when nothing was ever submitted', () => {
    expect(classifyInstagram({ env: {}, probe: {} }).state).toBe(CREDENTIAL_MISSING);
  });

  it('is ready on a live access token even if the probe cannot run at all', () => {
    const v = classifyInstagram({ env: { INSTAGRAM_ACCESS_TOKEN: 'EAAG...' }, probe: { pageLinked: false } });
    expect(v.state).toBe(READY);
  });
});

describe('TikTok — app audit', () => {
  it('separates "no developer app" from "app exists, audit queued"', () => {
    expect(classifyTikTok({ env: {}, probe: { appLive: false } }).state).toBe(CREDENTIAL_MISSING);
    expect(classifyTikTok({ env: { TIKTOK_CLIENT_KEY: 'k' }, probe: { appLive: true } }).state).toBe(AWAITING_EXTERNAL_APPROVAL);
  });

  it('treats an unaudited app with a user token as READY — SELF_ONLY posting is still publishing', () => {
    const v = classifyTikTok({ env: { TIKTOK_ACCESS_TOKEN: 'act...' }, probe: { appLive: true } });
    expect(v.state).toBe(READY);
    expect(v.reason).toMatch(/SELF_ONLY/);
  });

  it('recognises the refresh-token trio as a usable credential, not just the static token', () => {
    // TikTok access tokens last 24h: the trio is the shape a cron actually runs on.
    const v = classifyTikTok({
      env: { TIKTOK_REFRESH_TOKEN: 'r', TIKTOK_CLIENT_KEY: 'k', TIKTOK_CLIENT_SECRET: 's' },
      probe: { appLive: true },
    });
    expect(v.state).toBe(READY);
  });

  it('reports the audit as cleared once the privacy level moves past SELF_ONLY', () => {
    const v = classifyTikTok({ env: { TIKTOK_ACCESS_TOKEN: 'a', TIKTOK_PRIVACY_LEVEL: 'PUBLIC_TO_EVERYONE' }, probe: {} });
    expect(v.reason).toMatch(/audited/);
  });

  it('still blames the platform when the client key exists but the probe fails', () => {
    const v = classifyTikTok({ env: { TIKTOK_CLIENT_KEY: 'k' }, probe: { appLive: false } });
    expect(v.state).toBe(AWAITING_EXTERNAL_APPROVAL);
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

  it('reopens the classic path if the two values ever do appear', () => {
    const v = classifyReddit({ env: { REDDIT_CLIENT_ID: 'id', REDDIT_CLIENT_SECRET: 'sec' } });
    expect(v.state).toBe(READY);
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

  it('keeps platform waits OUT of the actionable set — that is the entire point', () => {
    const all = classifyAll({
      env: { FB_PAGE_ID: 'p', INSTAGRAM_BUSINESS_ACCOUNT_ID: 'ig', TIKTOK_CLIENT_KEY: 'k' },
      probes: { instagram: { pageLinked: false }, tiktok: { appLive: true } },
    });
    expect(actionableChannels(all).map((v) => v.channel)).toEqual(['reddit']);
  });

  it('surfaces a channel whose credential quietly arrived — the RC_TO_ENV failure mode', () => {
    // Instagram/TikTok RC params existed for days while load-rc-env.mjs did not
    // map them: the posters read undefined and soft-skipped, every day, silently.
    const all = classifyAll({
      env: { INSTAGRAM_ACCESS_TOKEN: 'EAAG', TIKTOK_ACCESS_TOKEN: 'act' },
      probes: {},
    });
    expect(actionableChannels(all).map((v) => v.channel).sort()).toEqual(['instagram', 'reddit', 'tiktok']);
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
