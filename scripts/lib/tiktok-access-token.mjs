import { readFirebaseServiceAccountCredentials } from './firebase-service-account-credentials.mjs';
import { RC_SERVER_NAMESPACE, setRcParamWithEtag } from './remote-config-admin.mjs';
import { TIKTOK_API } from './tiktok-publish.mjs';

const TIKTOK_REFRESH_TOKEN_RC_PARAM = 'SERVER_TIKTOK_REFRESH_TOKEN';

/** Persist TikTok's rotated refresh token with Remote Config ETag protection. */
export async function persistTikTokRefreshToken(refreshToken, {
  env = process.env,
  setRemoteConfigParam = setRcParamWithEtag,
} = {}) {
  const value = String(refreshToken || '').trim();
  if (!value) throw new Error('TikTok returned an empty refresh token');
  const credentials = readFirebaseServiceAccountCredentials(env, {
    purpose: 'persist the rotated TikTok refresh token',
  });
  if (!credentials) {
    throw new Error('Firebase service-account credentials are unavailable; cannot persist the rotated TikTok refresh token');
  }
  const result = await setRemoteConfigParam({
    credentials,
    name: TIKTOK_REFRESH_TOKEN_RC_PARAM,
    value,
    namespace: RC_SERVER_NAMESPACE,
    description: 'TikTok user refresh token; replaced when TikTok rotates it.',
    versionDescription: 'persist rotated TikTok user refresh token',
  });
  if (!result?.ok) {
    throw new Error(`Could not persist the rotated TikTok refresh token to Remote Config (${result?.detail || 'write failed'})`);
  }
  return true;
}

/** Resolve a TikTok user token without ever logging token values. */
export async function getTikTokAccessToken({
  env = process.env,
  fetchImpl = fetch,
  log = () => {},
  persistRefreshToken = persistTikTokRefreshToken,
} = {}) {
  const refreshToken = String(env.TIKTOK_REFRESH_TOKEN || '').trim();
  const clientKey = String(env.TIKTOK_CLIENT_KEY || '').trim();
  const clientSecret = String(env.TIKTOK_CLIENT_SECRET || '').trim();
  const staticToken = String(env.TIKTOK_ACCESS_TOKEN || '').trim() || null;

  if (refreshToken && clientKey && clientSecret) {
    let response;
    let payload;
    try {
      response = await fetchImpl(`${TIKTOK_API}/oauth/token/`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: refreshToken,
          client_key: clientKey,
          client_secret: clientSecret,
        }),
      });
      payload = await response.json().catch(() => ({}));
    } catch (error) {
      log(`TikTok token refresh unavailable (${String(error?.name || 'network error')}); using configured access token if present`);
      return staticToken;
    }
    if (payload?.access_token) {
      const nextRefreshToken = String(payload.refresh_token || '').trim();
      if (nextRefreshToken && nextRefreshToken !== refreshToken) {
        await persistRefreshToken(nextRefreshToken, { env });
        log('TikTok refresh token rotated and persisted to Remote Config');
      }
      log(`TikTok access token refreshed (expires in ${Number(payload.expires_in) || 'unknown'}s)`);
      return payload.access_token;
    }
    log(`TikTok token refresh unavailable (HTTP ${response.status}); using configured access token if present`);
  }
  return staticToken;
}
