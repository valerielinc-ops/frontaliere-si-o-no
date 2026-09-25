/**
 * social-readiness.mjs — is a social publishing channel actually able to post,
 * and if not, WHICH KIND of "not" is it?
 *
 * ── The distinction this file exists to make ────────────────────────────────
 *
 * Three channels (Instagram, TikTok, Reddit) each have a complete, merged,
 * fail-soft poster that publishes nothing, and all three were filed as "waiting
 * on the owner". Two of the three were not: they were waiting on a REVIEW QUEUE
 * at Meta / TikTok that the owner had already entered. One was not waiting at
 * all — Reddit REFUSED the Data Access Request on 2026-08-24, so the classic
 * OAuth path is dead, not pending, and no amount of waiting resolves it.
 *
 * Those three states need different handling and had none of them: they were
 * all "parked". So this module gives each channel one of four verdicts:
 *
 *   ready                       credentials present — the poster can publish
 *   awaiting-external-approval  the app/account EXISTS on the platform and a
 *                               platform-side review decides when it can post.
 *                               Nothing to implement; something to OBSERVE.
 *   path-refused                the platform said no. Waiting is not a plan —
 *                               a replacement path is.
 *   credential-missing          nothing has been submitted; no external clock
 *                               is running.
 *
 * The failure mode that motivates the whole thing is real and already happened
 * once: the Instagram/TikTok Remote Config parameters existed for a while, but
 * scripts/load-rc-env.mjs never mapped them, so the posters read `undefined`
 * and soft-skipped every single day — a channel that was credential-ready and
 * silent, with nothing anywhere saying so. `ready` is therefore the state this
 * module is loudest about, not the blocked ones.
 *
 * Pure by construction: every probe result is passed IN. The network lives in
 * scripts/check-social-publish-readiness.mjs, so the whole decision table is
 * unit-testable offline (tests/social-publish-readiness.test.ts).
 */

export const READY = 'ready';
export const AWAITING_EXTERNAL_APPROVAL = 'awaiting-external-approval';
export const PATH_REFUSED = 'path-refused';
export const CREDENTIAL_MISSING = 'credential-missing';

export const CHANNELS = ['instagram', 'tiktok', 'reddit'];

/** A state that means "someone else's clock is running" — track, don't work. */
export function isExternalWait(state) {
  return state === AWAITING_EXTERNAL_APPROVAL;
}

/** A state that means the poster could publish today and probably isn't. */
export function isActionable(state) {
  return state === READY || state === PATH_REFUSED;
}

function present(env, name) {
  return String(env?.[name] ?? '').trim().length > 0;
}

/**
 * Instagram — Meta App Review for `instagram_content_publish`.
 *
 * The observable that flips: with the Page token, asking the Page for its
 * `instagram_business_account` returns the linked IG account id once the
 * review grants `instagram_basic`, and returns nothing (or errors) before.
 * That is why `probe.pageLinked` is the discriminator and not the mere
 * presence of INSTAGRAM_BUSINESS_ACCOUNT_ID — that id is a public identifier
 * the owner can paste into Remote Config at any time, review or no review, so
 * on its own it proves nothing.
 */
export function classifyInstagram({ env = {}, probe = {} } = {}) {
  if (present(env, 'INSTAGRAM_ACCESS_TOKEN')) {
    return {
      channel: 'instagram',
      state: READY,
      reason: 'INSTAGRAM_ACCESS_TOKEN is present — the poster can publish; verify the daily cron is no longer soft-skipping.',
    };
  }
  if (probe.pageLinked) {
    return {
      channel: 'instagram',
      state: READY,
      reason: 'The Page now exposes instagram_business_account: App Review has granted the Instagram scopes. Mint INSTAGRAM_ACCESS_TOKEN and put it in Remote Config as SERVER_INSTAGRAM_ACCESS_TOKEN.',
    };
  }
  if (present(env, 'INSTAGRAM_BUSINESS_ACCOUNT_ID') && present(env, 'FB_PAGE_ID')) {
    return {
      channel: 'instagram',
      state: AWAITING_EXTERNAL_APPROVAL,
      reason: 'Business account created and linked to the Facebook Page, but the Page token still carries no Instagram scope — Meta App Review for instagram_content_publish has not landed.',
      waitingOn: 'Meta App Review (instagram_content_publish)',
    };
  }
  return {
    channel: 'instagram',
    state: CREDENTIAL_MISSING,
    reason: 'No Instagram Business account id / Page id in the environment — nothing has been submitted to Meta.',
  };
}

/**
 * TikTok — Content Posting API audit.
 *
 * `probe.appLive` comes from a client_credentials token mint, which only
 * succeeds for an app that actually exists and is enabled. It separates
 * "the developer app has not been created" from "the app exists and its audit
 * is queued", which the issue body conflated into one blocked bullet.
 *
 * An unaudited app is not useless: it can post SELF_ONLY. So a channel that
 * has a user token but no audit is `ready` — restricted, but publishing — and
 * the restriction rides in the reason rather than in the state.
 */
export function classifyTikTok({ env = {}, probe = {} } = {}) {
  const hasUserToken = present(env, 'TIKTOK_ACCESS_TOKEN') || (present(env, 'TIKTOK_REFRESH_TOKEN') && present(env, 'TIKTOK_CLIENT_KEY') && present(env, 'TIKTOK_CLIENT_SECRET'));
  if (hasUserToken) {
    const audited = String(env.TIKTOK_PRIVACY_LEVEL ?? '').trim() && String(env.TIKTOK_PRIVACY_LEVEL).trim() !== 'SELF_ONLY';
    return {
      channel: 'tiktok',
      state: READY,
      reason: audited
        ? 'A user token is available and TIKTOK_PRIVACY_LEVEL is set past SELF_ONLY — the app is audited and can post publicly.'
        : 'A user token is available; the app is still unaudited so posts are SELF_ONLY. That is publishing, not blocking.',
    };
  }
  if (probe.appLive) {
    return {
      channel: 'tiktok',
      state: AWAITING_EXTERNAL_APPROVAL,
      reason: 'The developer app exists and mints client-credential tokens, but no user token has been granted yet — run scripts/tiktok-auth.mjs once the audit clears (sandbox posting is available before that).',
      waitingOn: 'TikTok app audit / Content Posting API (2-6 weeks per TikTok docs)',
    };
  }
  if (present(env, 'TIKTOK_CLIENT_KEY')) {
    return {
      channel: 'tiktok',
      state: AWAITING_EXTERNAL_APPROVAL,
      reason: 'A client key is configured but the client-credentials mint did not succeed — the app exists on paper; treat the platform as the blocker until the probe recovers.',
      waitingOn: 'TikTok app audit / Content Posting API',
    };
  }
  return {
    channel: 'tiktok',
    state: CREDENTIAL_MISSING,
    reason: 'No TIKTOK_CLIENT_KEY — no developer app has been created.',
  };
}

/**
 * Reddit — the classic /prefs/apps OAuth path.
 *
 * This is the one channel where "wait for the external answer" is WRONG: the
 * answer arrived. The Data Access Request required by the Responsible Builder
 * Policy (in force since 2025-11-11) was DENIED on 2026-08-24, so no script
 * app can be created and REDDIT_CLIENT_ID/SECRET can never be populated by
 * this route. The replacement is a Devvit app, which goes through Devvit's
 * own, separate, lighter review queue — see docs/REDDIT-POSTING.md.
 */
export const REDDIT_DATA_API_DENIED_ON = '2026-08-24';

export function classifyReddit({ env = {} } = {}) {
  if (present(env, 'REDDIT_CLIENT_ID') && present(env, 'REDDIT_CLIENT_SECRET')) {
    return {
      channel: 'reddit',
      state: READY,
      reason: 'REDDIT_CLIENT_ID/SECRET are present — the Data API path is open after all; re-enable the classic poster.',
    };
  }
  return {
    channel: 'reddit',
    state: PATH_REFUSED,
    reason: `Reddit denied the Data Access Request on ${REDDIT_DATA_API_DENIED_ON}, so the classic OAuth app cannot be created and these two values will never arrive by this route. The replacement path is the Devvit app (its own review queue) — see docs/REDDIT-POSTING.md.`,
  };
}

export function classifyAll({ env = {}, probes = {} } = {}) {
  return [
    classifyInstagram({ env, probe: probes.instagram }),
    classifyTikTok({ env, probe: probes.tiktok }),
    classifyReddit({ env }),
  ];
}

/** Channels that need a human or a follow-up PR now, as opposed to patience. */
export function actionableChannels(verdicts) {
  return verdicts.filter((v) => isActionable(v.state));
}

export function formatVerdictTable(verdicts) {
  const width = Math.max(...verdicts.map((v) => v.channel.length));
  return verdicts
    .map((v) => `${v.channel.padEnd(width)}  ${v.state.padEnd(26)}  ${v.reason}`)
    .join('\n');
}
