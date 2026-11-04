import { readFirebaseServiceAccountCredentials } from './firebase-service-account-credentials.mjs';
import { RC_SERVER_NAMESPACE, setRcParamWithEtag } from './remote-config-admin.mjs';

const LINKEDIN_MEMBER_REFRESH_TOKEN_RC_PARAM = 'SERVER_LINKEDIN_MEMBER_REFRESH_TOKEN';

/** Persist a replacement member refresh token without logging its value. */
export async function persistLinkedInMemberRefreshToken(refreshToken, {
  env = process.env,
  setRemoteConfigParam = setRcParamWithEtag,
} = {}) {
  const value = String(refreshToken || '').trim();
  if (!value) throw new Error('LinkedIn returned an empty member refresh token');
  const credentials = readFirebaseServiceAccountCredentials(env, {
    purpose: 'persist the rotated LinkedIn member refresh token',
  });
  if (!credentials) {
    throw new Error('Firebase service-account credentials are unavailable; cannot persist the rotated LinkedIn member refresh token');
  }
  const result = await setRemoteConfigParam({
    credentials,
    name: LINKEDIN_MEMBER_REFRESH_TOKEN_RC_PARAM,
    value,
    namespace: RC_SERVER_NAMESPACE,
    description: 'LinkedIn member refresh token; replaced when LinkedIn rotates it.',
    versionDescription: 'persist rotated LinkedIn member refresh token',
  });
  if (!result?.ok) {
    throw new Error(`Could not persist the rotated LinkedIn member refresh token to Remote Config (${result?.detail || 'write failed'})`);
  }
  return true;
}

/** Resolve the LinkedIn member token without logging access or refresh tokens. */
export async function getLinkedInMemberAccessToken({
  env = process.env,
  fetchImpl = fetch,
  log = () => {},
  persistRefreshToken = persistLinkedInMemberRefreshToken,
} = {}) {
  const refreshToken = String(env.LINKEDIN_MEMBER_REFRESH_TOKEN || '').trim();
  const clientId = String(env.LINKEDIN_MEMBER_CLIENT_ID || '').trim();
  const clientSecret = String(env.LINKEDIN_MEMBER_CLIENT_SECRET || '').trim();
  const staticToken = String(env.LINKEDIN_MEMBER_ACCESS_TOKEN || '').trim() || null;

  if (refreshToken && clientId && clientSecret) {
    let response;
    let payload;
    try {
      response = await fetchImpl('https://www.linkedin.com/oauth/v2/accessToken', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: refreshToken,
          client_id: clientId,
          client_secret: clientSecret,
        }),
      });
      payload = await response.json().catch(() => ({}));
    } catch (error) {
      log(`LinkedIn member token refresh unavailable (${String(error?.name || 'network error')})`);
      return staticToken;
    }
    if (payload?.access_token) {
      const nextRefreshToken = String(payload.refresh_token || '').trim();
      if (nextRefreshToken && nextRefreshToken !== refreshToken) {
        await persistRefreshToken(nextRefreshToken, { env });
        log('LinkedIn member refresh token rotated and persisted to Remote Config');
      }
      log(`LinkedIn member token refreshed (expires in ${Number(payload.expires_in) || 'unknown'}s)`);
      return payload.access_token;
    }
    log(`LinkedIn member token refresh unavailable (HTTP ${response.status}); using configured access token if present`);
  }
  return staticToken;
}
