import {
  hasInstagramLoginPublishScopes,
  INSTAGRAM_LOGIN_REQUIRED_PUBLISH_SCOPES,
} from './instagram-publisher-credentials.mjs';

/**
 * social-readiness.mjs — is a social publishing channel actually able to post,
 * and if not, WHICH KIND of "not" is it?
 *
 * ── The distinction this file exists to make ────────────────────────────────
 *
 * Three channels (Instagram, TikTok, Reddit) have distinct readiness states.
 * Instagram and TikTok may use the browser publishing routes selected by the
 * owner, independently of their API permissions; Reddit REFUSED the Data
 * Access Request on 2026-08-24, so the classic OAuth path needs a replacement.
 *
 * Those three states need different handling and had none of them: they were
 * all "parked". So this module gives each channel one of five verdicts:
 *
 *   ready                       Page link, publisher identity, and publish
 *                               permission are verified for the target account.
 *   awaiting-external-approval  a platform grant or confirmation of an
 *                               eligible use case is required before delivery.
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
export const ACTION_REQUIRED = 'action-required';
export const AWAITING_EXTERNAL_APPROVAL = 'awaiting-external-approval';
export const PATH_REFUSED = 'path-refused';
export const CREDENTIAL_MISSING = 'credential-missing';

export const CHANNELS = ['instagram', 'tiktok', 'reddit'];

/** A state that means "someone else's clock is running" — track, don't work. */
export function isExternalWait(state) {
  return state === AWAITING_EXTERNAL_APPROVAL;
}

/** A state that needs owner action now instead of passive external waiting. */
export function isActionable(state) {
  return state === READY
    || state === ACTION_REQUIRED
    || state === CREDENTIAL_MISSING
    || state === PATH_REFUSED;
}

function present(env, name) {
  return String(env?.[name] ?? '').trim().length > 0;
}

/** Instagram — require the Page link, publisher token identity, and publish grant to be verified. */
export function classifyInstagram({ env = {}, probe = {} } = {}) {
  if (env.SOCIAL_ROBOT_INSTAGRAM_BROWSER_PUBLISHING_OWNER_APPROVED === 'true'
    || env.META_INSTAGRAM_BROWSER_PUBLISHING_APPROVED === 'true') {
    return {
      channel: 'instagram',
      state: READY,
      reason: 'The owner has selected the existing Instagram browser publisher; this authorization is separate from Meta API permission and the scheduled post ledger remains authoritative.',
    };
  }
  const authMode = String(env?.INSTAGRAM_PUBLISHING_AUTH_MODE || '').trim();
  if (authMode && !['facebook_login', 'instagram_login'].includes(authMode)) {
    return {
      channel: 'instagram',
      state: ACTION_REQUIRED,
      reason: 'INSTAGRAM_PUBLISHING_AUTH_MODE is invalid; choose the verified Facebook Login or Instagram Login route before publishing.',
    };
  }
  if (authMode === 'instagram_login') {
    const hasToken = present(env, 'INSTAGRAM_LOGIN_ACCESS_TOKEN');
    const hasUserId = present(env, 'INSTAGRAM_LOGIN_USER_ID');
    const accountStatus = String(probe?.loginPublisherStatus || 'unavailable');
    if (!hasToken || !hasUserId) {
      return {
        channel: 'instagram',
        state: CREDENTIAL_MISSING,
        reason: 'Instagram Login is selected but its separate IG user token or account ID is missing; complete the Instagram OAuth setup before publishing.',
      };
    }
    if (!hasInstagramLoginPublishScopes(env.INSTAGRAM_LOGIN_GRANTED_SCOPES)) {
      return {
        channel: 'instagram',
        state: ACTION_REQUIRED,
        reason: `The Instagram Login token lacks a recorded grant for all required scopes (${INSTAGRAM_LOGIN_REQUIRED_PUBLISH_SCOPES.join(', ')}); reconnect and grant publishing access before delivery.`,
      };
    }
    if (accountStatus === 'mismatch' || accountStatus === 'not-professional') {
      return {
        channel: 'instagram',
        state: ACTION_REQUIRED,
        reason: 'Instagram Login does not resolve to the configured Business or Creator account; reconnect the intended handle before publishing.',
      };
    }
    if (accountStatus === 'missing-publish-scope') {
      return {
        channel: 'instagram',
        state: ACTION_REQUIRED,
        reason: `The Instagram Login token did not return all required publishing scopes (${INSTAGRAM_LOGIN_REQUIRED_PUBLISH_SCOPES.join(', ')}) as granted; reconnect and grant publishing access before delivery.`,
      };
    }
    if (accountStatus === 'matched') {
      return {
        channel: 'instagram',
        state: READY,
        reason: 'The Instagram Login token resolves to the configured professional account and its basic and content-publishing scopes were granted; verify the next scheduled native post ID.',
      };
    }
    return {
      channel: 'instagram',
      state: ACTION_REQUIRED,
      reason: accountStatus === 'expired'
        ? 'The Instagram Login token has expired or lacks an expiry record; refresh or reconnect before publishing.'
        : 'The Instagram Login token could not be verified against the configured professional account; check token validity and account identity before publishing.',
    };
  }

  const hasInstagramAccountId = present(env, 'INSTAGRAM_BUSINESS_ACCOUNT_ID');
  const hasInstagramToken = present(env, 'INSTAGRAM_ACCESS_TOKEN');
  const pageLinkStatus = String(probe?.pageLinkStatus || 'unavailable');
  const publisherTokenStatus = String(probe?.publisherTokenStatus || 'unavailable');
  const publisherTokenSourceStatus = String(probe?.publisherTokenSourceStatus || 'unavailable');
  const pageTaskStatus = String(probe?.pageTaskStatus || 'unavailable');
  const publishPermissionStatus = String(probe?.publishPermissionStatus || 'unavailable');

  if (pageLinkStatus === 'mismatch') {
    return {
      channel: 'instagram',
      state: ACTION_REQUIRED,
      reason: 'Meta returned an Instagram account that does not match INSTAGRAM_BUSINESS_ACCOUNT_ID. Correct the Page link or publisher token before publishing.',
    };
  }
  if (publisherTokenStatus === 'mismatch') {
    return {
      channel: 'instagram',
      state: ACTION_REQUIRED,
      reason: 'The configured publisher token resolves to a different Instagram account than the configured target.',
    };
  }
  if (publisherTokenSourceStatus === 'mismatch') {
    return {
      channel: 'instagram',
      state: ACTION_REQUIRED,
      reason: 'INSTAGRAM_ACCESS_TOKEN does not match the Page access token returned for the same Page and user token; refresh the publisher token from that authorized Page before enabling delivery.',
    };
  }
  if (hasInstagramToken && !hasInstagramAccountId) {
    return {
      channel: 'instagram',
      state: ACTION_REQUIRED,
      reason: 'INSTAGRAM_ACCESS_TOKEN is present but INSTAGRAM_BUSINESS_ACCOUNT_ID is missing; configure the target professional account before publishing.',
    };
  }
  if (hasInstagramToken && hasInstagramAccountId
    && pageLinkStatus === 'matched'
    && publisherTokenStatus === 'matched'
    && publisherTokenSourceStatus === 'matched'
    && pageTaskStatus === 'granted'
    && publishPermissionStatus === 'granted') {
    return {
      channel: 'instagram',
      state: READY,
      reason: 'The Page link, content-creation task, publisher token source and identity, and instagram_content_publish grant are verified; confirm the next scheduled delivery and native post ID.',
    };
  }

  if (!hasInstagramAccountId) {
    return {
      channel: 'instagram',
      state: CREDENTIAL_MISSING,
      reason: 'INSTAGRAM_BUSINESS_ACCOUNT_ID is missing; configure the intended professional account and its publishing credential before delivery.',
    };
  }

  if (pageLinkStatus !== 'matched') {
    return {
      channel: 'instagram',
      state: ACTION_REQUIRED,
      reason: 'The configured Instagram account cannot be verified against the Facebook Page; configure FB_USER_ACCESS_TOKEN with the required Page tasks and confirm the exact Page link.',
    };
  }

  if (publishPermissionStatus === 'missing') {
    return {
      channel: 'instagram',
      state: ACTION_REQUIRED,
      reason: 'Meta does not report the instagram_content_publish permission as granted; submit or complete App Review, then refresh the user token before enabling publishing.',
    };
  }

  if (publishPermissionStatus !== 'granted') {
    return {
      channel: 'instagram',
      state: ACTION_REQUIRED,
      reason: 'The publishing permission could not be verified from the Facebook user token; refresh the token with granted permissions and rerun the read-only readiness check.',
    };
  }

  if (pageTaskStatus === 'missing') {
    return {
      channel: 'instagram',
      state: ACTION_REQUIRED,
      reason: 'The Facebook user lacks a Page content-creation task (CREATE_CONTENT or PROFILE_PLUS_CREATE_CONTENT); grant the required Page role before enabling delivery.',
    };
  }
  if (pageTaskStatus !== 'granted') {
    return {
      channel: 'instagram',
      state: ACTION_REQUIRED,
      reason: 'The Page content-creation task could not be verified; refresh the user token and confirm the Page role before enabling delivery.',
    };
  }

  if (!hasInstagramToken) {
    return {
      channel: 'instagram',
      state: CREDENTIAL_MISSING,
      reason: 'Meta grants instagram_content_publish, but INSTAGRAM_ACCESS_TOKEN is missing; configure the Page publisher token in Remote Config.',
    };
  }

  if (publisherTokenSourceStatus !== 'matched') {
    return {
      channel: 'instagram',
      state: ACTION_REQUIRED,
      reason: 'The publisher token could not be tied to the Page token returned for the same Page and user token; refresh the publisher token from that authorized Page before enabling delivery.',
    };
  }

  return {
    channel: 'instagram',
    state: ACTION_REQUIRED,
    reason: 'The configured publisher token could not be verified against the intended Instagram account; check token validity, Page tasks, and the configured account ID before enabling delivery.',
  };
}

/** The owner may select the existing browser uploader independently of API status. */
export function classifyTikTok({ env = {} } = {}) {
  if (env.SOCIAL_ROBOT_TIKTOK_BROWSER_PUBLISHING_OWNER_APPROVED === 'true') {
    return {
      channel: 'tiktok',
      state: READY,
      reason: 'The owner has selected the existing TikTok browser uploader; this authorization does not claim Content Posting API approval.',
    };
  }
  return {
    channel: 'tiktok',
    state: AWAITING_EXTERNAL_APPROVAL,
    reason: 'TikTok Content Posting API use for this team-managed account is awaiting external confirmation; credentials or an API audit do not clear that API route. The browser uploader is controlled separately by the owner flag.',
    waitingOn: 'TikTok confirmation for the Content Posting API route',
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

/** Reddit API credentials do not prove that Reddit approved the Data API use case. */
export function isRedditDataApiApproved(env = {}) {
  return String(env?.REDDIT_DATA_API_APPROVED ?? '').trim() === 'true';
}

export function classifyReddit({ env = {} } = {}) {
  const hasCredentials = present(env, 'REDDIT_CLIENT_ID') && present(env, 'REDDIT_CLIENT_SECRET');
  const approved = isRedditDataApiApproved(env);
  if (approved && hasCredentials) {
    return {
      channel: 'reddit',
      state: READY,
      reason: 'REDDIT_DATA_API_APPROVED is true and client credentials are present — the explicitly approved Data API path can publish.',
    };
  }
  if (approved) {
    return {
      channel: 'reddit',
      state: CREDENTIAL_MISSING,
      reason: 'The Data API approval marker is present, but Reddit client credentials are missing.',
    };
  }
  return {
    channel: 'reddit',
    state: PATH_REFUSED,
    reason: `Reddit denied the Data Access Request on ${REDDIT_DATA_API_DENIED_ON}; client credentials alone do not authorize API access. Keep the classic publisher disabled until explicit Reddit approval is recorded as REDDIT_DATA_API_APPROVED=true. The replacement path is the Devvit app — see docs/REDDIT-POSTING.md.`,
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

/** Instagram setup states that should open or keep its owner-action issue open. */
export function instagramSetupActionChannels(verdicts) {
  return verdicts.filter((v) => v.channel === 'instagram'
    && (v.state === ACTION_REQUIRED || v.state === CREDENTIAL_MISSING));
}

/**
 * A ready channel still needs the activation alert until its scheduled
 * publisher has written a recent, confirmed row to its posted ledger. The
 * readiness monitor runs before the daily publishers; 48 hours covers the
 * weekly Monday slot and a delayed confirmation without turning a healthy
 * daily publisher into a recurring issue.
 */
export const READY_POST_MAX_AGE_HOURS = 48;

function timestampMs(value) {
  if (value instanceof Date) {
    const ms = value.getTime();
    return Number.isFinite(ms) ? ms : null;
  }
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string' || !value.trim()) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

/** The posted-ledger contract records the confirmation time in `ts`. */
export function latestConfirmedPostMs(ledger) {
  if (!Array.isArray(ledger?.posted)) return null;
  let latest = null;
  for (const entry of ledger.posted) {
    const at = timestampMs(entry?.ts);
    if (at !== null && (latest === null || at > latest)) latest = at;
  }
  return latest;
}

/**
 * Ready channels whose activation is not backed by a recent confirmed post.
 * Missing or timestamp-less ledger rows deliberately do not count as proof.
 */
export function readyChannelsNeedingActivation(
  verdicts,
  ledgers = {},
  { now = Date.now(), maxAgeHours = READY_POST_MAX_AGE_HOURS } = {},
) {
  const nowMs = timestampMs(now);
  const ageHours = Number(maxAgeHours);
  if (nowMs === null || !Number.isFinite(ageHours) || ageHours < 0) {
    throw new TypeError('ready activation check needs a valid clock and non-negative age window');
  }
  const cutoff = nowMs - ageHours * 60 * 60 * 1000;
  return (Array.isArray(verdicts) ? verdicts : []).filter((verdict) => {
    if (verdict?.state !== READY) return false;
    const latest = latestConfirmedPostMs(ledgers?.[verdict.channel]);
    return latest === null || latest < cutoff || latest > nowMs;
  });
}

export function formatVerdictTable(verdicts) {
  const width = Math.max(...verdicts.map((v) => v.channel.length));
  return verdicts
    .map((v) => `${v.channel.padEnd(width)}  ${v.state.padEnd(26)}  ${v.reason}`)
    .join('\n');
}
