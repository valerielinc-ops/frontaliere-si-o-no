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

const REGISTRATION_TERMS_VERSION = '2026-09-16.1';
const REGISTRATION_TERMS_TEXT = 'Registrandomi accetto le condizioni e mi iscrivo alle comunicazioni di Frontaliere Ticino. Condizioni (v. 2026-09-15.1).';

/**
 * Fetch basic profile data from LinkedIn /v2/me endpoint.
 * Requires `r_basicprofile` scope. Returns headline (typically "Job Title at Company")
 * and vanityName (public profile slug). Best-effort — returns nulls on failure.
 *
 * @param {string} accessToken - LinkedIn OAuth access token
 * @returns {Promise<{headline: string|null, vanityName: string|null}>}
 */
async function fetchLinkedInBasicProfile(accessToken) {
 try {
 const res = await fetch(
 'https://api.linkedin.com/v2/me?projection=(id,localizedHeadline,vanityName)',
 { headers: { Authorization: `Bearer ${accessToken}` } },
 );
 if (!res.ok) return { headline: null, vanityName: null };
 const data = await res.json();
 return {
 headline: data.localizedHeadline || null,
 vanityName: data.vanityName || null,
 };
 } catch {
 return { headline: null, vanityName: null };
 }
}

/**
 * Enrich newsletter_subscribers/{email} with LinkedIn profile data.
 * Best-effort — login succeeds even if Firestore write fails.
 * Merges into the central subscriber doc; only writes non-null fields. A
 * LinkedIn registration is covered by the same terms-based base relationship
 * as every other authentication provider, so a missing row is created with
 * newsletter + job-alert membership. Existing suppression/opt-out state is
 * preserved and never resurrected by login.
 *
 * @param {string} email - User email (document key)
 * @param {object} profileData - LinkedIn profile fields
 */
async function enrichSubscriberProfile(email, profileData) {
 try {
 const db = admin.firestore();
 const normalizedEmail = email.trim().toLowerCase();
 const subRef = db.collection('newsletter_subscribers').doc(normalizedEmail);
 const existingSubscriber = await subRef.get();
 const existing = existingSubscriber.exists ? existingSubscriber.data() || {} : null;

 const updateData = {
 email: normalizedEmail,
 updatedAt: admin.firestore.FieldValue.serverTimestamp(),
 lastLoginAt: admin.firestore.FieldValue.serverTimestamp(),
 };
 if (!existing) {
  Object.assign(updateData, {
   status: 'confirmed',
   isActive: true,
   active: true,
   preferences: { exchangeRate: true, traffic: true, taxUpdates: true, tips: false, jobs: true },
   interests: ['jobs'],
   source: 'auth_linkedin',
   source_channel: 'auth_linkedin',
   consent_given: true,
   consent_given_at: admin.firestore.FieldValue.serverTimestamp(),
   consent_advertising: true,
   consent_advertising_at: admin.firestore.FieldValue.serverTimestamp(),
   consent_advertising_updated_at: admin.firestore.FieldValue.serverTimestamp(),
   consent_basis: 'registration_terms',
   registration_terms_accepted: true,
   registration_terms_version: REGISTRATION_TERMS_VERSION,
   registration_terms_text: REGISTRATION_TERMS_TEXT,
   registration_terms_accepted_at: admin.firestore.FieldValue.serverTimestamp(),
   consent_text: REGISTRATION_TERMS_TEXT,
   consent_text_version: REGISTRATION_TERMS_VERSION,
   consent_text_displayed: true,
   consent_act: 'registration_terms_acceptance',
   consent_method: 'terms_and_conditions',
   consent_purpose: 'unified_email_channels',
   confirmed_at: admin.firestore.FieldValue.serverTimestamp(),
   confirmedAt: admin.firestore.FieldValue.serverTimestamp(),
   created_at: admin.firestore.FieldValue.serverTimestamp(),
  });
 } else if (existing.registration_terms_accepted !== true) {
  // Preserve the existing status and opt-out stamps; this only records the
  // current terms basis that applies to the authenticated account.
  Object.assign(updateData, {
   consent_given: true,
   consent_given_at: existing.consent_given_at || admin.firestore.FieldValue.serverTimestamp(),
   consent_basis: 'registration_terms',
   registration_terms_accepted: true,
   registration_terms_version: REGISTRATION_TERMS_VERSION,
   registration_terms_text: REGISTRATION_TERMS_TEXT,
   registration_terms_accepted_at: existing.registration_terms_accepted_at || admin.firestore.FieldValue.serverTimestamp(),
   consent_text: existing.consent_text || REGISTRATION_TERMS_TEXT,
   consent_text_version: existing.consent_text_version || REGISTRATION_TERMS_VERSION,
   consent_text_displayed: true,
   consent_act: existing.consent_act || 'registration_terms_acceptance',
   consent_method: existing.consent_method || 'terms_and_conditions',
   consent_purpose: existing.consent_purpose || 'unified_email_channels',
  });
 }
 if (existing && existing.advertising_opt_out !== true && existing.consent_advertising !== true) {
  Object.assign(updateData, {
   consent_advertising: true,
   consent_advertising_at: existing.consent_advertising_at || admin.firestore.FieldValue.serverTimestamp(),
   consent_advertising_updated_at: admin.firestore.FieldValue.serverTimestamp(),
  });
 }
 for (const [key, value] of Object.entries(profileData)) {
 if (value != null) {
 updateData[key] = value;
 }
 }

 await subRef.set(updateData, { merge: true });
 } catch (err) {
 // Best-effort: don't break login if Firestore write fails
 console.error('[linkedinAuthCallback] Failed to enrich subscriber profile:', err.message);
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
 // Fail-closed: only an explicit `true` from LinkedIn counts as verified.
 // Missing/null/undefined must never be treated as verified.
 const emailVerified = userInfo.email_verified === true;
 const linkedInSub = userInfo.sub || null;

 // ── Attempt to fetch basic profile (headline, vanityName) via r_basicprofile ─
 const basicProfile = await fetchLinkedInBasicProfile(access_token);

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
 emailVerified,
 ...(displayName ? { displayName } : {}),
 ...(photoURL ? { photoURL } : {}),
 });
 uid = created.uid;
 isNewUser = true;
 } else {
 throw err;
 }
 }

 // ── Enrich newsletter_subscribers/{email} with LinkedIn profile data ───────
 await enrichSubscriberProfile(email, {
 auth_uid: uid,
 auth_provider: 'linkedin',
 name: displayName,
 firstName,
 lastName,
 photoURL,
 linkedInSub,
 headline: basicProfile.headline,
 vanityName: basicProfile.vanityName,
 emailVerified,
 auth_locale: locale,
 });

 // ── Mint Firebase custom token ─────────────────────────────────────────────
 const customToken = await admin.auth().createCustomToken(uid, { linkedIn: true });
 return { customToken };
}
