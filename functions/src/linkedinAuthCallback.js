/**
 * linkedinAuthCallback — LinkedIn OAuth2 code exchange → Firebase custom token
 *
 * Called by the frontend /auth/linkedin/callback page with the code received
 * from LinkedIn. Exchanges it for an access token, fetches user info via
 * OpenID Connect (/v2/userinfo), creates/updates a Firebase Auth user, and
 * returns a Firebase custom token that the frontend can use with
 * signInWithCustomToken().
 *
 * Returns 503 when LINKEDIN_SIGNIN_CLIENT_ID is not configured in Remote Config.
 */

import admin from 'firebase-admin';
import { ensureAdminApp } from './newsletterResendWebhookCore.js';
import { getRemoteConfigValue } from './remoteConfigSecrets.js';

/**
 * Exchange LinkedIn OAuth code for a Firebase custom token.
 * @param {{ code: string, redirectUri: string }} params
 * @returns {Promise<{ customToken: string }>}
 */
export async function handleLinkedInCallback({ code, redirectUri }) {
  ensureAdminApp();

  const [clientId, clientSecret] = await Promise.all([
    getRemoteConfigValue('LINKEDIN_SIGNIN_CLIENT_ID'),
    getRemoteConfigValue('LINKEDIN_SIGNIN_CLIENT_SECRET'),
  ]);

  if (!clientId || !clientSecret) {
    const err = new Error('LinkedIn Sign-In not configured');
    err.status = 503;
    throw err;
  }

  // ── Exchange authorization code for access token ──────────────────────────
  const tokenRes = await fetch('https://www.linkedin.com/oauth/v2/accessToken', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      client_id: clientId,
      client_secret: clientSecret,
    }).toString(),
  });

  if (!tokenRes.ok) {
    const body = await tokenRes.text().catch(() => '');
    throw new Error(`LinkedIn token exchange failed: ${tokenRes.status} ${body}`);
  }

  const { access_token } = await tokenRes.json();

  // ── Fetch user profile via OpenID Connect userinfo endpoint ───────────────
  const userRes = await fetch('https://api.linkedin.com/v2/userinfo', {
    headers: { Authorization: `Bearer ${access_token}` },
  });

  if (!userRes.ok) {
    throw new Error(`LinkedIn userinfo request failed: ${userRes.status}`);
  }

  const userInfo = await userRes.json();
  // OpenID Connect profile fields: sub, email, email_verified, name,
  // given_name, family_name, picture, locale

  const email = userInfo.email;
  if (!email) {
    throw new Error('LinkedIn did not return an email address — ensure openid+email scopes are granted');
  }

  const displayName = userInfo.name
    || `${userInfo.given_name || ''} ${userInfo.family_name || ''}`.trim()
    || null;
  const photoURL = userInfo.picture || null;

  // ── Create or update Firebase Auth user ───────────────────────────────────
  let uid;
  try {
    const existing = await admin.auth().getUserByEmail(email);
    uid = existing.uid;

    // Backfill displayName / photoURL only if not already set
    const updates = {};
    if (!existing.displayName && displayName) updates.displayName = displayName;
    if (!existing.photoURL && photoURL) updates.photoURL = photoURL;
    if (Object.keys(updates).length > 0) {
      await admin.auth().updateUser(uid, updates);
    }
  } catch (err) {
    if (err.code === 'auth/user-not-found') {
      const created = await admin.auth().createUser({
        email,
        emailVerified: userInfo.email_verified ?? true,
        ...(displayName ? { displayName } : {}),
        ...(photoURL ? { photoURL } : {}),
      });
      uid = created.uid;
    } else {
      throw err;
    }
  }

  // ── Mint Firebase custom token ─────────────────────────────────────────────
  const customToken = await admin.auth().createCustomToken(uid, { linkedIn: true });
  return { customToken };
}
