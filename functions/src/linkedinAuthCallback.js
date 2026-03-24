/**
 * linkedinAuthCallback — LinkedIn OAuth2 code exchange → Firebase custom token
 *
 * Called by the frontend /auth/linkedin/callback page with the code received
 * from LinkedIn. Exchanges it for an access token, fetches user info via
 * OpenID Connect (/v2/userinfo), creates/updates a Firebase Auth user, and
 * returns a Firebase custom token that the frontend can use with
 * signInWithCustomToken().
 *
 * Additionally stores an enriched user profile in Firestore `users/{uid}`
 * for JobAlert personalization and future features.
 *
 * Returns 503 when LINKEDIN_SIGNIN_CLIENT_ID is not configured in Remote Config.
 */

import admin from 'firebase-admin';
import { ensureAdminApp } from './newsletterResendWebhookCore.js';
import { getRemoteConfigValue } from './remoteConfigSecrets.js';

/**
 * Attempt to fetch professional profile data from LinkedIn API.
 * The `openid profile email` scopes do NOT grant access to the LinkedIn
 * Profile API (r_liteprofile / r_basicprofile are deprecated; the new
 * Community Management API requires separate product approval).
 * This function is best-effort and returns null fields on failure.
 *
 * NOTE: With current scopes (openid, profile, email), only the /v2/userinfo
 * endpoint is available. Professional data (jobTitle, company, industry)
 * would require the "Sign In with LinkedIn using OpenID Connect" product
 * AND additional scopes such as `r_organization_social` or partner-level
 * access. This function is kept as a placeholder for when those scopes
 * become available.
 *
 * @param {string} _accessToken - LinkedIn OAuth access token
 * @returns {Promise<{jobTitle: string|null, company: string|null, industry: string|null, location: string|null}>}
 */
async function fetchLinkedInProfessionalData(_accessToken) {
  // LinkedIn's v2 API for profile/position data requires scopes beyond
  // openid+profile+email. With current scopes, this data is not accessible.
  // Return nulls — the profile will be enriched if/when additional scopes
  // are configured.
  return {
    jobTitle: null,
    company: null,
    industry: null,
    location: null,
  };
}

/**
 * Save or update user profile in Firestore `users/{uid}`.
 * Best-effort — login succeeds even if Firestore write fails.
 *
 * @param {string} uid - Firebase Auth UID
 * @param {object} profileData - User profile fields
 * @param {boolean} isNewUser - Whether this is a newly created user
 */
async function saveUserProfile(uid, profileData, isNewUser) {
  try {
    const db = admin.firestore();
    const userRef = db.collection('users').doc(uid);

    if (isNewUser) {
      await userRef.set({
        ...profileData,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        lastLoginAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    } else {
      // Merge: update lastLoginAt and any new fields, but don't overwrite
      // existing data with nulls
      const updateData = { lastLoginAt: admin.firestore.FieldValue.serverTimestamp() };
      for (const [key, value] of Object.entries(profileData)) {
        if (value != null) {
          updateData[key] = value;
        }
      }
      await userRef.set(updateData, { merge: true });
    }
  } catch (err) {
    // Best-effort: don't break login if Firestore write fails
    console.error('[linkedinAuthCallback] Failed to save user profile:', err.message);
  }
}

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

  // ── Extract all available OpenID Connect fields ───────────────────────────
  const firstName = userInfo.given_name || null;
  const lastName = userInfo.family_name || null;
  const locale = userInfo.locale
    ? (typeof userInfo.locale === 'object' ? userInfo.locale.language : String(userInfo.locale))
    : null;
  const emailVerified = userInfo.email_verified ?? null;
  const linkedInSub = userInfo.sub || null;

  // ── Attempt to fetch professional data (best-effort) ─────────────────────
  const professionalData = await fetchLinkedInProfessionalData(access_token);

  // ── Create or update Firebase Auth user ───────────────────────────────────
  let uid;
  let isNewUser = false;
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
        emailVerified: emailVerified ?? true,
        ...(displayName ? { displayName } : {}),
        ...(photoURL ? { photoURL } : {}),
      });
      uid = created.uid;
      isNewUser = true;
    } else {
      throw err;
    }
  }

  // ── Save enriched profile to Firestore ────────────────────────────────────
  await saveUserProfile(uid, {
    uid,
    email,
    displayName,
    firstName,
    lastName,
    photoURL,
    locale,
    emailVerified,
    provider: 'linkedin',
    linkedInSub,
    jobTitle: professionalData.jobTitle,
    company: professionalData.company,
    industry: professionalData.industry,
    location: professionalData.location,
    dataSource: 'linkedin_openid',
  }, isNewUser);

  // ── Mint Firebase custom token ─────────────────────────────────────────────
  const customToken = await admin.auth().createCustomToken(uid, { linkedIn: true });
  return { customToken };
}
