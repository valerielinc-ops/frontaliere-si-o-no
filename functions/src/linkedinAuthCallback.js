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
import { buildSignupAttributionFields, sanitizeSignupPath } from './lib/signupAttribution.js';
import { isNewsletterOptOutBinding } from './lib/newsletterOptOut.js';
import { isAddressSuppressed } from './lib/emailSuppression.js';
import {
 CONFIRMATION_METHODS,
 hasSubscriberCreationStamp,
} from './lib/subscriberConsent.js';
import {
 REGISTRATION_TERMS_VERSION,
 registrationTermsTextFor,
} from './lib/registrationTermsText.js';

const CONSENT_LOCALES = new Set(['it', 'en', 'de', 'fr']);
const SURFACE_RE = /^[a-z0-9_]{1,40}$/;
// The register entry every sign-in surface renders (services/consentTexts.ts).
const REGISTRATION_NOTICE_KEY = 'communicationsOptIn';
// An experiment arm tag as the browser builds it (`jobgate-v3:<arm>`).
const EXPERIMENT_VARIANT_RE = /^[a-z0-9][a-z0-9-]{0,39}:[a-z0-9_]{1,40}$/;

/**
 * The jobgate-v3 arm of a login started from the JobBoard gate of an enrolled
 * visitor (`jobGateSubscriberVariantFor` in services/authService.ts), carried
 * in `attribution.consent.variant`. Shape-checked only: it is a join key for
 * the readout, not a claim about consent.
 *
 * @param {unknown} attribution
 * @returns {string|null}
 */
export function resolveLinkedInExperimentVariant(attribution) {
 const raw = attribution && typeof attribution === 'object' && !Array.isArray(attribution)
  ? attribution.consent?.variant
  : null;
 return typeof raw === 'string' && EXPERIMENT_VARIANT_RE.test(raw) ? raw : null;
}

/**
 * The consent record of this LinkedIn login. The browser forwards the surface
 * and the visitor's locale inside `attribution.consent`
 * (services/authService.ts → exchangeLinkedInCode); everything else is fixed
 * here: the current registration sentence for that locale and its version
 * (registrationTermsText.js, pinned to the register by a test), recorded as
 * displayed — owner decision of 2026-09-25: a sign-in is the registration act
 * under the terms, on every surface. Untrusted input, so only the surface
 * token and the locale are read from it.
 *
 * Without a record (a tab still running an older bundle): surface
 * `auth_linkedin`, Italian.
 *
 * @param {unknown} attribution - `req.body.attribution`
 * @returns {{ surface: string, displayed: boolean, key: string, locale: string, text: string, version: string }}
 */
export function resolveLinkedInConsentRecord(attribution) {
 const raw = attribution && typeof attribution === 'object' && !Array.isArray(attribution)
  ? attribution.consent
  : null;
 const valid = raw && typeof raw === 'object' && !Array.isArray(raw);
 const surface = valid && typeof raw.surface === 'string' && SURFACE_RE.test(raw.surface) ? raw.surface : 'auth_linkedin';
 const locale = valid && typeof raw.locale === 'string' && CONSENT_LOCALES.has(raw.locale) ? raw.locale : 'it';
 return {
  surface,
  displayed: true,
  key: REGISTRATION_NOTICE_KEY,
  locale,
  text: registrationTermsTextFor(locale),
  version: REGISTRATION_TERMS_VERSION,
 };
}

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
 * as every other authentication provider, so a missing row — or a row that
 * holds only profile fields — is registered with newsletter + job-alert
 * membership. Existing suppression/opt-out state is preserved and never
 * resurrected by login.
 *
 * The consent record (see resolveLinkedInConsentRecord) carries the surface
 * the login came from, the current registration sentence and version in the
 * visitor's locale, and — by the owner decision of 2026-09-25 — the notice as
 * displayed. The same block goes, append-only, into the `events`
 * subcollection.
 *
 * @param {string} email - User email (document key)
 * @param {object} profileData - LinkedIn profile fields
 * @param {unknown} [attribution] - surface that started the login (untrusted,
 *   sanitized by buildSignupAttributionFields; never touches source/source_channel)
 */
export async function enrichSubscriberProfile(email, profileData, attribution = null) {
 try {
 const db = admin.firestore();
 const ts = () => admin.firestore.FieldValue.serverTimestamp();
 const normalizedEmail = email.trim().toLowerCase();
 const subRef = db.collection('newsletter_subscribers').doc(normalizedEmail);
 const existingSubscriber = await subRef.get();
 const existing = existingSubscriber.exists ? existingSubscriber.data() || {} : null;
 const consent = resolveLinkedInConsentRecord(attribution);
 const experimentVariant = resolveLinkedInExperimentVariant(attribution);
 const confirmationMethod = profileData?.emailVerified === true
  ? CONFIRMATION_METHODS.PROVIDER_VERIFIED_EMAIL
  : CONFIRMATION_METHODS.NONE;

 const updateData = {
 email: normalizedEmail,
 updatedAt: admin.firestore.FieldValue.serverTimestamp(),
 lastLoginAt: admin.firestore.FieldValue.serverTimestamp(),
 };
 const consentBlock = {
  consent_given: true,
  consent_given_at: ts(),
  consent_basis: 'registration_terms',
  registration_terms_accepted: true,
  registration_terms_version: consent.version,
  registration_terms_text: consent.text,
  registration_terms_accepted_at: ts(),
  consent_text: consent.text,
  consent_text_version: consent.version,
  consent_text_displayed: consent.displayed,
  consent_act: 'registration_terms_acceptance',
  consent_method: 'terms_and_conditions',
  consent_purpose: 'unified_email_channels',
  consent_origin: consent.surface,
 };
 // A row that only carries profile/login fields (no subscription status, no
 // opt-out, no address suppression) is registered by this login exactly like
 // a missing one — otherwise it would keep the profile-only shape the senders
 // exclude, now with a terms record on it and no status.
 const unregistered = Boolean(existing)
  && !String(existing.status || '').trim()
  && !isNewsletterOptOutBinding(existing)
  && !isAddressSuppressed(existing.status);
 let recordedAct = null;
 if (!existing || unregistered) {
  recordedAct = existing ? 'promoted' : 'created';
  Object.assign(updateData, {
   status: 'confirmed',
   isActive: true,
   active: true,
   preferences: { exchangeRate: true, traffic: true, taxUpdates: true, tips: false, jobs: true },
   interests: ['jobs'],
   source: (existing && existing.source) || 'auth_linkedin',
   source_channel: (existing && existing.source_channel) || 'auth_linkedin',
   ...consentBlock,
   consent_advertising: existing?.advertising_opt_out !== true,
   consent_advertising_at: ts(),
   consent_advertising_updated_at: ts(),
   confirmed_at: ts(),
   confirmedAt: ts(),
   confirmation_method: confirmationMethod,
   confirmed_via_surface: consent.surface,
   ...(hasSubscriberCreationStamp(existing) ? {} : { created_at: ts() }),
   // The arm that produced this relationship, written with its creation and
   // never over an earlier capture's (same rule as the browser writer).
   ...(experimentVariant && !(existing && existing.variant) ? { variant: experimentVariant } : {}),
  });
 } else if (existing.registration_terms_accepted !== true && !isNewsletterOptOutBinding(existing)) {
  recordedAct = 'terms';
  // Preserve the existing status; this only records the current terms basis
  // that applies to the authenticated account. A binding opt-out is left
  // alone, as the browser writer does: a login is not a re-opt-in. An
  // earlier consent text is the record of an earlier act and stays as it
  // is, displayed flag included: it is not this login's to rewrite.
  Object.assign(updateData, existing.consent_text
   ? {
    consent_given: true,
    consent_given_at: existing.consent_given_at || ts(),
    consent_basis: 'registration_terms',
    registration_terms_accepted: true,
    registration_terms_version: consent.version,
    registration_terms_text: consent.text,
    registration_terms_accepted_at: existing.registration_terms_accepted_at || ts(),
   }
   : {
    ...consentBlock,
    consent_given_at: existing.consent_given_at || ts(),
    registration_terms_accepted_at: existing.registration_terms_accepted_at || ts(),
   });
 }
 if (existing && !unregistered && existing.advertising_opt_out !== true && existing.consent_advertising !== true) {
  Object.assign(updateData, {
   consent_advertising: true,
   consent_advertising_at: existing.consent_advertising_at || ts(),
   consent_advertising_updated_at: ts(),
  });
 }
 for (const [key, value] of Object.entries(profileData)) {
 if (value != null) {
 updateData[key] = value;
 }
 }
 // Origin page / CTA / component of the login. The callback page is
 // /auth/linkedin/callback or `/`, so this is the only place they survive.
 const attributionFields = buildSignupAttributionFields(attribution, existing);
 Object.assign(updateData, attributionFields);

 await subRef.set(updateData, { merge: true });

 if (recordedAct) {
  try {
   await subRef.collection('events').add({
    email: normalizedEmail,
    user_id: profileData?.auth_uid || null,
    event_type: recordedAct === 'terms' ? 'subscribe_completed' : 'confirm',
    source_channel: 'auth_linkedin',
    variant: experimentVariant,
    source_page: attributionFields.source_page || sanitizeSignupPath(attribution?.page) || null,
    metadata: {
     status: updateData.status || existing?.status || null,
     source: updateData.source || existing?.source || 'auth_linkedin',
     consent: {
      trigger: 'sign_in',
      provider: 'linkedin',
      act: 'registration_terms_acceptance',
      method: 'terms_and_conditions',
      basis: 'registration_terms',
      purpose: 'unified_email_channels',
      origin: consent.surface,
      text_version: consent.version,
      text_displayed: updateData.consent_text_displayed ?? existing?.consent_text_displayed ?? null,
      text_locale: consent.locale,
      page: attributionFields.source_page || sanitizeSignupPath(attribution?.page) || null,
      registration_method: 'authenticated',
      confirmation_method: recordedAct === 'terms' ? null : confirmationMethod,
      confirmed_via_surface: recordedAct === 'terms' ? null : consent.surface,
     },
    },
    timestamp: ts(),
    occurred_at: new Date().toISOString(),
   });
  } catch (eventErr) {
   console.error('[linkedinAuthCallback] Failed to record the consent event:', eventErr.message);
  }
 }
 } catch (err) {
 // Best-effort: don't break login if Firestore write fails
 console.error('[linkedinAuthCallback] Failed to enrich subscriber profile:', err.message);
 }
}

/**
 * Exchange LinkedIn OAuth code for a Firebase custom token.
 * @param {{ code: string, redirectUri: string, attribution?: unknown }} params
 * @returns {Promise<{ customToken: string }>}
 */
export async function handleLinkedInCallback({ code, redirectUri, attribution = null }) {
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
 }, attribution);

 // ── Mint Firebase custom token ─────────────────────────────────────────────
 const customToken = await admin.auth().createCustomToken(uid, { linkedIn: true });
 return { customToken };
}
