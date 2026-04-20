/**
 * Firebase Authentication Service
 * Google + Facebook Sign-In per Dashboard e Forum
 * Includes Google One Tap for seamless sign-in
 * Account linking: same email across providers merges automatically
 * 
 * PERFORMANCE: Firebase Auth SDK viene caricato LAZILY al primo uso,
 * simile ad analytics.ts. Questo evita di includere firebase/auth
 * nel bundle critico iniziale.
 */

import { useState, useEffect, useCallback } from 'react';
import { hasActiveSlot } from '@/services/popupQueue';
import { reportCaughtError } from '@/services/errorReporter';

// ─── Resilient Dynamic Import ────────────────────────────────
// After a deploy, old chunk hashes no longer exist on the CDN.
// When the user clicks a button that triggers a dynamic import (e.g.
// LinkedIn sign-in → import firebase), the import fails with
// "TypeError: Importing a module script failed".
// This helper clears caches and retries once before giving up.

function isChunkLoadError(err: unknown): boolean {
 const msg = (err as Error)?.message || '';
 return msg.includes('Importing a module script failed') ||
 msg.includes('Failed to fetch dynamically imported module') ||
 msg.includes('error loading dynamically imported module') ||
 (err as Error)?.name === 'ChunkLoadError';
}

async function resilientImport<T>(factory: () => Promise<T>): Promise<T> {
 try {
 return await factory();
 } catch (err) {
 if (!isChunkLoadError(err)) throw err;
 // Clear all caches so the browser fetches fresh chunks
 if ('caches' in window) {
 const names = await caches.keys();
 await Promise.all(names.map(n => caches.delete(n)));
 }
 // Retry once after cache clear
 try {
 return await factory();
 } catch {
 // Chunk truly gone — reload page to get fresh HTML with new hashes
 const reloadKey = '_authChunkReload';
 if (!sessionStorage.getItem(reloadKey)) {
 sessionStorage.setItem(reloadKey, '1');
 window.location.reload();
 }
 throw err;
 }
 }
}

// ─── Lazy Firebase Auth Loading ────────────────────────────────

let _auth: any = null;
let _authModule: any = null;
let _firebaseAuthLoading: Promise<void> | null = null;
let _eagerAuthRequested = false;

function logAuthDebug(event: string, details?: Record<string, unknown>): void {
 if (typeof window === 'undefined') return;
 try {
 const payload = {
 event,
 path: window.location.pathname + window.location.search,
 ts: new Date().toISOString(),
 ...details,
 };
 console.log('[AuthDebug]', payload);
 } catch (error) {
 console.log('[AuthDebug]', event, details, error);
 }
}

/** Lightweight synchronous check for an existing Firebase Auth session in localStorage. */
function hasPersistedAuthSession(): boolean {
 try {
 for (let i = 0; i < localStorage.length; i++) {
 const key = localStorage.key(i);
 if (key && key.startsWith('firebase:authUser:')) return true;
 }
 } catch { /* localStorage unavailable */ }
 return false;
}

function shouldStartAuthImmediately(): boolean {
 if (_eagerAuthRequested) return true;
 if (typeof window === 'undefined') return false;
 // If there's already a persisted session, start auth immediately so the user
 // appears logged in right away — no interaction required.
 if (hasPersistedAuthSession()) return true;
 const params = new URLSearchParams(window.location.search);
 return (
 window.location.pathname.includes('/gestione-contenuti-xk9mp2q')
 || (params.get('mode') === 'signIn' && Boolean(params.get('oobCode')))
 || params.get('newsletter_autologin') === '1'
 || Boolean(params.get('ac') || params.get('at') || params.get('authToken'))
 || Boolean(params.get('ne'))
 || params.get('action') === 'confirm_newsletter'
 );
}

async function ensureFirebaseAuth(): Promise<void> {
 if (_auth) return;
 if (_firebaseAuthLoading) return _firebaseAuthLoading;
 _firebaseAuthLoading = (async () => {
 try {
 logAuthDebug('ensureFirebaseAuth:start');
 const [firebaseModule, authModule] = await Promise.all([
 import('@/services/firebase'),
 import('firebase/auth'),
 ]);
 _authModule = authModule;
 const appInstance = await firebaseModule.getApp();
 // Use a local variable until fully initialized — assigning to _auth early
 // creates a race condition where concurrent callers hit `if (_auth) return`
 // and call SDK methods (e.g. isSignInWithEmailLink) on a partially-initialized
 // instance, causing Firebase to call extractQuerystring(authDomain) before
 // authDomain is populated, throwing TypeError: Cannot read properties of
 // undefined (reading 'indexOf').
 const authInstance = authModule.getAuth(appInstance);
 // Ensure session survives even if IndexedDB is unavailable
 await authModule.setPersistence(authInstance, authModule.browserLocalPersistence);
 // Wait for Firebase Auth internal initialization to complete.
 // getAuth() returns synchronously but internal config (apiKey, authDomain)
 // may not be ready yet — calling SDK methods before this resolves causes
 // TypeError on internal property access (e.g. indexOf on undefined).
 if (typeof authInstance.authStateReady === 'function') {
 await authInstance.authStateReady();
 }
 // Only expose _auth after full initialization is confirmed.
 _auth = authInstance;
 logAuthDebug('ensureFirebaseAuth:ready', {
 authDomain: appInstance?.options?.authDomain || null,
 hasCurrentUser: Boolean(_auth?.currentUser),
 configReady: Boolean(_auth?.config?.apiKey),
 });
 } catch (error) {
 console.warn('[Auth] Failed to load Firebase Auth', error);
 logAuthDebug('ensureFirebaseAuth:error', {
 message: error instanceof Error ? error.message : String(error),
 });
 reportCaughtError(error, 'auth.loadFirebaseAuth');
 }
 })();
 return _firebaseAuthLoading;
}

function getAuthInstance(): any {
 return _auth;
}

// ─── User Profile Persistence ────────────────────────────────

/**
 * Enrich the newsletter_subscribers/{email} document with auth profile data.
 * Best-effort — sign-in succeeds even if this write fails.
 * Called after successful Google, Facebook, or LinkedIn sign-in.
 */
export async function saveUserProfileToFirestore(user: any, provider: 'google' | 'facebook' | 'linkedin'): Promise<void> {
 try {
 const email = user?.email?.trim().toLowerCase();
 if (!email) return;

 const [{ getApp }, fsModule] = await Promise.all([
 import('@/services/firebase'),
 import('firebase/firestore'),
 ]);

 const db = fsModule.getFirestore(await getApp());
 const subRef = fsModule.doc(db, 'newsletter_subscribers', email);

 const displayName = user.displayName || null;
 const nameParts = displayName ? displayName.split(' ') : [];

 const profileData: Record<string, unknown> = {
 auth_uid: user.uid,
 auth_provider: provider,
 name: displayName,
 firstName: nameParts[0] || null,
 lastName: nameParts.length > 1 ? nameParts.slice(1).join(' ') : null,
 photoURL: user.photoURL || null,
 lastLoginAt: fsModule.serverTimestamp(),
 updatedAt: fsModule.serverTimestamp(),
 };

 await fsModule.setDoc(subRef, profileData, { merge: true });
 } catch (err) {
 // Best-effort: don't break login if Firestore write fails
 console.warn('[Auth] Failed to enrich subscriber profile:', err);
 }
}

// ─── Auth Functions ──────────────────────────────────────────

function setAuthRedirectState(provider: 'google' | 'facebook'): void {
 if (typeof window === 'undefined') return;
 const redirectPath = window.location.pathname + window.location.search;
 sessionStorage.setItem('auth_redirect_path', redirectPath);
 sessionStorage.setItem('auth_redirect_provider', provider);
 logAuthDebug('redirect-state:set', { provider, redirectPath });
}

/**
 * Google Sign-In.
 *
 * authDomain: auth.frontaliereticino.ch (custom domain, registered as authorized
 * redirect URI in Google Cloud Console OAuth client, no COOP:same-origin header).
 *
 * Strategy:
 * - Desktop: signInWithPopup (fast, no page reload, no navigation state loss)
 * - Mobile: signInWithRedirect (popups are often blocked on mobile browsers)
 * - Popup fallback: if popup is blocked or closed, silently fall back to redirect
 */
export async function signInWithGoogle(): Promise<any | null> {
 try {
 await ensureFirebaseAuth();
 const authInstance = getAuthInstance();
 if (!authInstance || !_authModule) return null;

 cancelOneTap();

 const { Analytics } = await import('@/services/analytics');
 const googleProvider = new _authModule.GoogleAuthProvider();
 googleProvider.setCustomParameters({ prompt: 'select_account' });

 // Mobile: redirect is more reliable (popups often blocked by browser)
 const isMobile = /Android|iPhone|iPad|iPod|Opera Mini|IEMobile|WPDesktop/i.test(
 navigator.userAgent
 );
 if (isMobile) {
 setAuthRedirectState('google');
 logAuthDebug('google:redirect:start', {
 isMobile,
 authDomain: authInstance?.app?.options?.authDomain || null,
 });
 Analytics.trackUIInteraction('auth', 'google', 'login', 'redirect-start');
 await _authModule.signInWithRedirect(authInstance, googleProvider);
 return null; // page navigates away; result handled by getRedirectResult in useAuth
 }

 // Desktop: popup (instant, no page reload)
 try {
 Analytics.trackUIInteraction('auth', 'google', 'login', 'popup-start');
 const result = await _authModule.signInWithPopup(authInstance, googleProvider);
 Analytics.trackUIInteraction('auth', 'google', 'login', 'success');
 // Best-effort: save user profile to Firestore for personalization
 saveUserProfileToFirestore(result.user, 'google').catch(() => {});
 return result.user;
 } catch (popupError: any) {
 // User closed the popup intentionally — treat as cancellation, no error
 if (popupError?.code === 'auth/popup-closed-by-user') return null;

 // Popup blocked by browser or COOP prevented communication → redirect fallback
 if (
 popupError?.code === 'auth/popup-blocked' ||
 popupError?.code === 'auth/cancelled-popup-request' ||
 popupError?.message?.includes('Cross-Origin-Opener-Policy')
 ) {
 setAuthRedirectState('google');
 logAuthDebug('google:redirect:fallback', {
 code: popupError?.code || null,
 message: popupError?.message || null,
 });
 Analytics.trackUIInteraction('auth', 'google', 'login', 'redirect-fallback');
 await _authModule.signInWithRedirect(authInstance, googleProvider);
 return null;
 }

 throw popupError;
 }
 } catch (error: any) {
 if (error?.code !== 'auth/popup-closed-by-user') {
 console.warn('Google sign-in error:', error);
 logAuthDebug('google:error', {
 code: error?.code || null,
 message: error?.message || null,
 });
 reportCaughtError(error, 'auth.googleSignIn');
 const { Analytics } = await import('@/services/analytics');
 Analytics.trackUIInteraction('auth', 'google', 'login', 'error');
 }
 return null;
 }
}

export async function signOut(): Promise<void> {
 try {
 await ensureFirebaseAuth();
 const authInstance = getAuthInstance();
 if (!authInstance || !_authModule) return;
 await _authModule.signOut(authInstance);
 const { Analytics } = await import('@/services/analytics');
 Analytics.trackUIInteraction('auth', 'general', 'logout', 'success');
 } catch (error) {
 reportCaughtError(error, 'auth.signOut');
 }
}

export async function signInWithEmailPassword(email: string, password: string): Promise<any | null> {
 try {
 await ensureFirebaseAuth();
 const authInstance = getAuthInstance();
 if (!authInstance || !_authModule) return null;
 const result = await _authModule.signInWithEmailAndPassword(authInstance, email.trim(), password);
 const { Analytics } = await import('@/services/analytics');
 Analytics.trackUIInteraction('auth', 'email', 'login', 'success');
 return result.user;
 } catch (error: any) {
 console.warn('Email sign-in error:', error);
 reportCaughtError(error, 'auth.emailSignIn');
 const { Analytics } = await import('@/services/analytics');
 Analytics.trackUIInteraction('auth', 'email', 'login', 'error');
 return null;
 }
}

export async function isEmailLinkSignIn(url?: string): Promise<boolean> {
 try {
 if (typeof window === 'undefined') return false;
 const href = url || window.location.href;
 if (!href || typeof href !== 'string' || !href.includes('oobCode')) return false;
 await ensureFirebaseAuth();
 if (!_authModule || !_auth) return false;
 if (typeof _authModule.isSignInWithEmailLink !== 'function') return false;
 // Verify Auth is fully initialized — config.apiKey must be present,
 // otherwise Firebase internals throw TypeError on property access.
 if (!_auth.config?.apiKey) {
 logAuthDebug('isEmailLinkSignIn:config-not-ready', {
 hasConfig: Boolean(_auth.config),
 });
 return false;
 }
 return Boolean(_authModule.isSignInWithEmailLink(_auth, String(href)));
 } catch (error) {
 reportCaughtError(error, 'auth.isEmailLinkSignIn');
 return false;
 }
}

export async function signInWithNewsletterEmailLink(email: string, href?: string): Promise<any | null> {
 try {
 const link = href || (typeof window !== 'undefined' ? window.location.href : '');
 if (!link || typeof link !== 'string') return null;

 await ensureFirebaseAuth();
 const authInstance = getAuthInstance();
 if (!authInstance || !_authModule) return null;

 const normalizedEmail = String(email || '').trim().toLowerCase();
 if (!normalizedEmail || !normalizedEmail.includes('@')) return null;

 const currentUserEmail = getAuthEmail(authInstance.currentUser);
 if (currentUserEmail && currentUserEmail.toLowerCase() === normalizedEmail) {
 return authInstance.currentUser;
 }

 const result = await _authModule.signInWithEmailLink(authInstance, normalizedEmail, link);
 const { Analytics } = await import('@/services/analytics');
 Analytics.trackUIInteraction('auth', 'newsletter', 'login', 'email-link-success');
 return result?.user || null;
 } catch (error) {
 reportCaughtError(error, 'auth.newsletterEmailLinkSignIn');
 const { Analytics } = await import('@/services/analytics');
 Analytics.trackUIInteraction('auth', 'newsletter', 'login', 'email-link-error');
 return null;
 }
}

export async function signInWithCustomAuthToken(token: string): Promise<any | null> {
 try {
 await ensureFirebaseAuth();
 const authInstance = getAuthInstance();
 if (!authInstance || !_authModule) return null;
 const result = await _authModule.signInWithCustomToken(authInstance, token);
 return result?.user || null;
 } catch (error) {
 reportCaughtError(error, 'auth.signInWithCustomToken');
 return null;
 }
}


// ─── Facebook Sign-In ────────────────────────────────────────

/**
 * Handle account-exists-with-different-credential error.
 * When a user signs in with Facebook but the email is already linked to Google,
 * Firebase throws this error. We link the new credential to the existing account.
 */
async function handleAccountLinking(error: any): Promise<any | null> {
 try {
 const email = error?.customData?.email;
 if (!email || !_authModule) return null;

 const authInstance = getAuthInstance();
 if (!authInstance) return null;

 // Get the pending Facebook credential from the error
 const pendingCredential = _authModule.OAuthProvider.credentialFromError(error);
 if (!pendingCredential) return null;

 // Find which sign-in methods exist for this email
 const methods = await _authModule.fetchSignInMethodsForEmail(authInstance, email);
 
 if (methods.includes('google.com')) {
 // User must sign in with Google first, then we link the Facebook credential
 const googleProvider = new _authModule.GoogleAuthProvider();
 googleProvider.setCustomParameters({ login_hint: email });
 
 const result = await _authModule.signInWithPopup(authInstance, googleProvider);
 // Link Facebook credential to the Google account
 await _authModule.linkWithCredential(result.user, pendingCredential);
 
 const { Analytics } = await import('@/services/analytics');
 Analytics.trackUIInteraction('auth', 'facebook', 'link_to_google', 'success');
 return result.user;
 }
 
 return null;
 } catch (linkError) {
 reportCaughtError(linkError, 'auth.accountLinking');
 return null;
 }
}

const FACEBOOK_APP_ID = '891036063797338';

// ─── Facebook Data Helpers ───────────────────────────────────

/**
 * Extract Facebook OAuth access token from sign-in result.
 * Tries the official SDK method first, then falls back to the undocumented
 * _tokenResponse.oauthAccessToken which works on subsequent logins too
 * (credentialFromResult returns null after the first login).
 */
function getFacebookAccessToken(result: any): string | null {
 try {
 const credential = _authModule?.FacebookAuthProvider?.credentialFromResult?.(result);
 if (credential?.accessToken) return credential.accessToken;
 } catch (e) {
 console.warn('[Auth] credentialFromResult failed:', e);
 reportCaughtError(e, 'auth.credentialFromResult');
 }
 // Fallback: _tokenResponse is undocumented but widely used and reliable
 if (result?._tokenResponse?.oauthAccessToken) {
 return result._tokenResponse.oauthAccessToken;
 }
 return null;
}

const FB_DATA_CACHE_KEY = 'frontaliere_fb_auth_cache';

/**
 * Detect placeholder Facebook photo URLs that show a silhouette.
 * Firebase stores graph.facebook.com/{id}/picture which requires an access token
 * to return the real photo — without it, you get the default silhouette.
 * CDN URLs (platform-lookaside.fbsbx.com, scontent.xx.fbcdn.net, etc.) are real.
 */
function isPlaceholderPhotoURL(url: string | null | undefined): boolean {
 if (!url) return true;
 // graph.facebook.com/{id}/picture URLs are broken without access token
 return /graph\.facebook\.com\/\d+\/picture/i.test(url);
}

/**
 * Cache Facebook auth data (email, photo, displayName) in localStorage
 * so subsequent logins (where Graph API token may be unavailable) still show them.
 */
function cacheFacebookAuthData(uid: string, data: { email?: string; photoURL?: string; displayName?: string }): void {
 try {
 const payload = { uid, ts: Date.now(), ...data };
 localStorage.setItem(FB_DATA_CACHE_KEY, JSON.stringify(payload));
 } catch { /* localStorage unavailable */ }
}

/**
 * Read cached Facebook auth data for a given uid.
 * Returns null if cache is missing, expired (>30 days), or for a different user.
 */
function getCachedFacebookAuthData(uid: string): { email?: string; photoURL?: string; displayName?: string } | null {
 try {
 const raw = localStorage.getItem(FB_DATA_CACHE_KEY);
 if (!raw) return null;
 const data = JSON.parse(raw);
 if (data.uid !== uid) return null;
 if (Date.now() - (data.ts || 0) > 30 * 24 * 60 * 60 * 1000) return null;
 return { email: data.email, photoURL: data.photoURL, displayName: data.displayName };
 } catch { return null; }
}

/**
 * Extract best available email from a Firebase user, checking providerData too.
 * Facebook sign-in may not populate user.email, but providerData often has it.
 */
export function getAuthEmail(user: any): string | null {
 if (user?.email) return user.email;
 if (user?.providerData?.length) {
 for (const p of user.providerData) {
 if (p.email) return p.email;
 }
 }
 return null;
}

/**
 * Calculate age bracket from Facebook birthday string (MM/DD/YYYY).
 * Returns our profile age bracket string, or '' if parsing fails.
 */
function calculateAgeBracketFromBirthday(birthday: string | undefined): string {
 if (!birthday) return '';
 const parts = birthday.split('/');
 if (parts.length !== 3) return '';
 const [mm, dd, yyyy] = parts.map(Number);
 if (!yyyy || !mm || !dd) return '';
 const today = new Date();
 let age = today.getFullYear() - yyyy;
 const monthDiff = today.getMonth() + 1 - mm;
 if (monthDiff < 0 || (monthDiff === 0 && today.getDate() < dd)) age--;
 if (age < 18) return '18-25';
 if (age <= 25) return '18-25';
 if (age <= 35) return '26-35';
 if (age <= 45) return '36-45';
 if (age <= 55) return '46-55';
 if (age <= 65) return '56-65';
 return '65+';
}

const FB_PROFILE_PREFILL_KEY = 'frontaliere_fb_profile_data';

/**
 * Prefill user profile from Facebook Graph API data.
 * Saves age bracket (from birthday) to localStorage so UserProfile can merge it.
 * Only sets fields that the user hasn't already filled in.
 */
function prefillProfileFromFacebook(fbData: any): void {
 try {
 if (!fbData) return;

 const fbProfile: Record<string, string> = {};

 // Map birthday → age bracket
 if (fbData.birthday) {
 const bracket = calculateAgeBracketFromBirthday(fbData.birthday);
 if (bracket) fbProfile.age = bracket;
 }

 if (Object.keys(fbProfile).length === 0) return;

 // Save FB profile data separately — UserProfile component will merge on mount
 localStorage.setItem(FB_PROFILE_PREFILL_KEY, JSON.stringify(fbProfile));
 } catch (e) {
 console.warn('[Auth] prefillProfileFromFacebook failed:', e);
 reportCaughtError(e, 'auth.prefillProfileFromFacebook');
 }
}

/** 
 * Read and consume Facebook profile prefill data.
 * Called by UserProfile component on mount to merge FB data into profile.
 * Returns null if no data available. Clears the data after reading.
 */
export function consumeFacebookProfilePrefill(): { age?: string } | null {
 try {
 const raw = localStorage.getItem(FB_PROFILE_PREFILL_KEY);
 if (!raw) return null;
 localStorage.removeItem(FB_PROFILE_PREFILL_KEY);
 return JSON.parse(raw);
 } catch {
 return null;
 }
}

/**
 * Patch all Facebook user data in one pass — email, displayName, photoURL.
 * Tries multiple sources with fallbacks, caches successful results in localStorage,
 * and falls back to cached data when Facebook Graph API token is unavailable
 * (common on subsequent logins where credentialFromResult returns null).
 */
async function patchFacebookData(result: any): Promise<void> {
 try {
 if (!result?.user || !_authModule) return;

 const user = result.user;
 const needsEmail = !user.email;
 const needsDisplayName = !user.displayName;
 // Treat graph.facebook.com placeholder URLs as "needs photo" — they show silhouette
 const needsPhoto = !user.photoURL || isPlaceholderPhotoURL(user.photoURL);

 if (!needsEmail && !needsDisplayName && !needsPhoto) return;

 let fbEmail: string | undefined;
 let fbDisplayName: string | undefined;
 let fbPhotoURL: string | undefined;

 // Source 1: providerData (Facebook provider entry)
 if (user.providerData?.length) {
 const fbProvider = user.providerData.find(
 (p: any) => p.providerId === 'facebook.com'
 );
 if (fbProvider) {
 if (needsEmail && fbProvider.email) fbEmail = fbProvider.email;
 if (needsDisplayName && fbProvider.displayName) fbDisplayName = fbProvider.displayName;
 // Only use providerData photo if it's a real CDN URL, not a placeholder
 if (needsPhoto && fbProvider.photoURL && !isPlaceholderPhotoURL(fbProvider.photoURL)) {
 fbPhotoURL = fbProvider.photoURL;
 }
 }
 }

 // Source 2: additionalUserInfo (available on first login, null on subsequent)
 if (!fbEmail || !fbDisplayName || !fbPhotoURL) {
 try {
 const info = _authModule.getAdditionalUserInfo(result);
 if (info?.profile) {
 if (!fbEmail && needsEmail && info.profile.email) fbEmail = info.profile.email;
 if (!fbDisplayName && needsDisplayName && info.profile.name) fbDisplayName = info.profile.name;
 if (!fbPhotoURL && needsPhoto && info.profile.picture?.data?.url) {
 fbPhotoURL = info.profile.picture.data.url;
 }
 }
 } catch (e) {
 console.warn('[Auth] getAdditionalUserInfo failed:', e);
 reportCaughtError(e, 'auth.getAdditionalUserInfo');
 }
 }

 // Source 3: Facebook Graph API (single merged request for all data)
 if (!fbEmail || !fbDisplayName || !fbPhotoURL) {
 const accessToken = getFacebookAccessToken(result);
 if (accessToken) {
 try {
 const resp = await fetch(
 `https://graph.facebook.com/me?fields=email,name,picture.width(200).height(200),birthday&access_token=${encodeURIComponent(accessToken)}`
 );
 if (resp.ok) {
 const data = await resp.json();
 console.log('[Auth] Graph API response fields:', {
 hasEmail: !!data.email,
 hasName: !!data.name,
 hasPicture: !!data.picture?.data?.url,
 isSilhouette: data.picture?.data?.is_silhouette,
 });
 if (!fbEmail && needsEmail && data.email) fbEmail = data.email;
 if (!fbDisplayName && needsDisplayName && data.name) fbDisplayName = data.name;
 // Always prefer Graph API CDN photo over placeholder
 if (needsPhoto && data.picture?.data?.url && !data.picture.data.is_silhouette) {
 fbPhotoURL = data.picture.data.url;
 }
 // Extended profile prefill (age, gender, hometown → UserProfile)
 prefillProfileFromFacebook(data);
 } else {
 console.warn('[Auth] Graph API returned status', resp.status);
 }
 } catch (e) {
 reportCaughtError(e, 'auth.graphApiFetch', { apiEndpoint: 'graph.facebook.com' });
 }
 } else {
 console.warn('[Auth] No Facebook access token available (subsequent login?)');
 }
 }

 // Source 4: localStorage cache (fallback for subsequent logins without token)
 if ((!fbEmail && needsEmail) || (!fbPhotoURL && needsPhoto) || (!fbDisplayName && needsDisplayName)) {
 const cached = getCachedFacebookAuthData(user.uid);
 if (cached) {
 if (!fbEmail && needsEmail && cached.email) fbEmail = cached.email;
 // Only use cached photo if it's a real CDN URL
 if (!fbPhotoURL && needsPhoto && cached.photoURL && !isPlaceholderPhotoURL(cached.photoURL)) {
 fbPhotoURL = cached.photoURL;
 }
 if (!fbDisplayName && needsDisplayName && cached.displayName) fbDisplayName = cached.displayName;
 console.log('[Auth] Using cached Facebook data for uid', user.uid);
 }
 }

 // Cache whatever we found for future logins — prefer CDN URLs over placeholders
 const dataToCache: { email?: string; photoURL?: string; displayName?: string } = {};
 if (fbEmail || user.email) dataToCache.email = fbEmail || user.email;
 // Prefer the fetched CDN URL over the broken graph.facebook.com placeholder
 if (fbPhotoURL) {
 dataToCache.photoURL = fbPhotoURL;
 } else if (user.photoURL && !isPlaceholderPhotoURL(user.photoURL)) {
 dataToCache.photoURL = user.photoURL;
 }
 if (fbDisplayName || user.displayName) dataToCache.displayName = fbDisplayName || user.displayName;
 if (Object.keys(dataToCache).length > 0) {
 cacheFacebookAuthData(user.uid, dataToCache);
 }

 let updated = false;

 // Update email on Firebase user
 if (fbEmail && needsEmail) {
 try {
 await _authModule.updateEmail(user, fbEmail);
 updated = true;
 } catch (updateErr: any) {
 console.warn('[Auth] updateEmail failed:', updateErr?.code || updateErr);
 reportCaughtError(updateErr, 'auth.updateEmail');
 try {
 if (typeof _authModule.verifyBeforeUpdateEmail === 'function') {
 await _authModule.verifyBeforeUpdateEmail(user, fbEmail);
 }
 } catch (e) {
 reportCaughtError(e, 'auth.verifyBeforeUpdateEmail');
 }
 }
 }

 // Update profile (displayName + photoURL)
 const profileUpdate: { displayName?: string; photoURL?: string } = {};
 if (fbDisplayName && needsDisplayName) profileUpdate.displayName = fbDisplayName;
 if (fbPhotoURL && needsPhoto) profileUpdate.photoURL = fbPhotoURL;
 if (Object.keys(profileUpdate).length > 0) {
 await _authModule.updateProfile(user, profileUpdate);
 updated = true;
 }

 // Reload user once to persist all changes
 if (updated) {
 await user.reload();
 }
 } catch (e) {
 reportCaughtError(e, 'auth.patchFacebookData');
 }
}

export async function signInWithFacebook(): Promise<any | null> {
 try {
 await ensureFirebaseAuth();
 const authInstance = getAuthInstance();
 if (!authInstance || !_authModule) return null;

 const { Analytics } = await import('@/services/analytics');
 const facebookProvider = new _authModule.FacebookAuthProvider();
 facebookProvider.addScope('email');
 facebookProvider.addScope('public_profile');
 facebookProvider.addScope('user_birthday');
 facebookProvider.setCustomParameters({ display: 'popup' });

 // Mobile browsers: use redirect
 const isMobile = /Android|iPhone|iPad|iPod|Opera Mini|IEMobile|WPDesktop/i.test(navigator.userAgent);
 
 if (isMobile) {
 sessionStorage.setItem('auth_redirect_path', window.location.pathname + window.location.search);
 sessionStorage.setItem('auth_redirect_provider', 'facebook');
 await _authModule.signInWithRedirect(authInstance, facebookProvider);
 return null;
 }

 // Desktop: try popup
 try {
 const result = await _authModule.signInWithPopup(authInstance, facebookProvider);
 await patchFacebookData(result);
 Analytics.trackUIInteraction('auth', 'facebook', 'login', 'success');
 // Best-effort: save user profile to Firestore for personalization
 saveUserProfileToFirestore(result.user, 'facebook').catch(() => {});
 return result.user;
 } catch (popupError: any) {
 // Account exists with different credential — link accounts
 if (popupError?.code === 'auth/account-exists-with-different-credential') {
 const user = await handleAccountLinking(popupError);
 if (user) return user;
 // If linking failed, inform the user
 console.warn('[Auth] Please sign in with Google instead (same email).');
 return null;
 }
 if (
 popupError?.code === 'auth/popup-blocked' ||
 popupError?.code === 'auth/popup-closed-by-user' ||
 popupError?.message?.includes('Cross-Origin-Opener-Policy')
 ) {
 sessionStorage.setItem('auth_redirect_path', window.location.pathname + window.location.search);
 sessionStorage.setItem('auth_redirect_provider', 'facebook');
 await _authModule.signInWithRedirect(authInstance, facebookProvider);
 return null;
 }
 throw popupError;
 }
 } catch (error: any) {
 if (error?.code !== 'auth/popup-closed-by-user') {
 console.warn('Facebook sign-in error:', error);
 reportCaughtError(error, 'auth.facebookSignIn');
 const { Analytics } = await import('@/services/analytics');
 Analytics.trackUIInteraction('auth', 'facebook', 'login', 'error');
 }
 return null;
 }
}

/**
 * Re-authenticate with Facebook, requesting email permission again.
 * Uses `auth_type: 'rerequest'` to force Facebook to show the consent dialog,
 * even if the user previously declined the email scope.
 */
export async function reAuthFacebook(): Promise<any | null> {
 try {
 await ensureFirebaseAuth();
 const authInstance = getAuthInstance();
 if (!authInstance || !_authModule) return null;

 const facebookProvider = new _authModule.FacebookAuthProvider();
 facebookProvider.addScope('email');
 facebookProvider.addScope('public_profile');
 facebookProvider.addScope('user_birthday');
 facebookProvider.setCustomParameters({ display: 'popup', auth_type: 'rerequest' });

 const isMobile = /Android|iPhone|iPad|iPod|Opera Mini|IEMobile|WPDesktop/i.test(navigator.userAgent);

 if (isMobile) {
 sessionStorage.setItem('auth_redirect_path', window.location.pathname + window.location.search);
 sessionStorage.setItem('auth_redirect_provider', 'facebook');
 await _authModule.signInWithRedirect(authInstance, facebookProvider);
 return null;
 }

 try {
 const result = await _authModule.signInWithPopup(authInstance, facebookProvider);
 await patchFacebookData(result);
 const { Analytics } = await import('@/services/analytics');
 Analytics.trackUIInteraction('auth', 'facebook', 'reauth', 'success');
 return result.user;
 } catch (popupError: any) {
 if (
 popupError?.code === 'auth/popup-blocked' ||
 popupError?.code === 'auth/popup-closed-by-user' ||
 popupError?.message?.includes('Cross-Origin-Opener-Policy')
 ) {
 sessionStorage.setItem('auth_redirect_path', window.location.pathname + window.location.search);
 sessionStorage.setItem('auth_redirect_provider', 'facebook');
 await _authModule.signInWithRedirect(authInstance, facebookProvider);
 return null;
 }
 throw popupError;
 }
 } catch (error: any) {
 if (error?.code !== 'auth/popup-closed-by-user') {
 console.warn('Facebook re-auth error:', error);
 reportCaughtError(error, 'auth.facebookReAuth');
 }
 return null;
 }
}

/**
 * Get the provider IDs linked to the current user's account
 */
export function getLinkedProviders(user: any): string[] {
 if (!user?.providerData) return [];
 return user.providerData.map((p: any) => p.providerId);
}

// ─── LinkedIn Sign-In ─────────────────────────────────────────────────────

const LINKEDIN_CF_BASE = 'https://europe-west6-frontaliere-ticino.cloudfunctions.net';

/**
 * Returns true when LINKEDIN_SIGNIN_CLIENT_ID is configured in Remote Config.
 * Use to conditionally render the LinkedIn Sign-In button — no button if empty.
 */
export async function isLinkedInSignInAvailable(): Promise<boolean> {
 try {
 const { getConfigValue } = await import('@/services/firebase');
 const clientId = await getConfigValue('LINKEDIN_SIGNIN_CLIENT_ID');
 return Boolean(clientId && clientId.trim().length > 0);
 } catch {
 return false;
 }
}

// ─── Auth Job Context (persists job metadata across OAuth redirects) ──────

const AUTH_JOB_CONTEXT_KEY = 'auth_job_context';

export interface AuthJobContext {
 slug?: string | null;
 company?: string | null;
 location?: string | null;
 category?: string | null;
}

/** Save job context before an OAuth redirect so the callback can enrich the newsletter subscription. */
export function saveAuthJobContext(ctx: AuthJobContext): void {
 try {
 sessionStorage.setItem(AUTH_JOB_CONTEXT_KEY, JSON.stringify(ctx));
 } catch { /* quota or private browsing */ }
}

/** Read and clear the saved job context (one-shot). Returns null if none was saved. */
export function consumeAuthJobContext(): AuthJobContext | null {
 try {
 const raw = sessionStorage.getItem(AUTH_JOB_CONTEXT_KEY);
 sessionStorage.removeItem(AUTH_JOB_CONTEXT_KEY);
 if (!raw) return null;
 return JSON.parse(raw) as AuthJobContext;
 } catch {
 return null;
 }
}

/**
 * Redirect the user to LinkedIn's OAuth2 authorization endpoint.
 * After authorization LinkedIn redirects to /auth/linkedin/callback.
 * The original path is preserved via the `state` query parameter.
 */
export async function signInWithLinkedIn(redirectPath?: string): Promise<void> {
 try {
 const { getConfigValue } = await resilientImport(() => import('@/services/firebase'));
 const { Analytics } = await resilientImport(() => import('@/services/analytics'));

 const clientId = await getConfigValue('LINKEDIN_SIGNIN_CLIENT_ID');
 if (!clientId) {
 console.warn('[Auth] LinkedIn Sign-In not configured — client ID empty');
 return;
 }

 const origin = typeof window !== 'undefined' ? window.location.origin : 'https://frontaliereticino.ch';
 const callbackUri = `${origin}/auth/linkedin/callback`;
 const state = encodeURIComponent(redirectPath || (typeof window !== 'undefined' ? window.location.pathname + window.location.search : '/'));

 Analytics.trackUIInteraction('auth', 'linkedin', 'login', 'button');

 const params = new URLSearchParams({
 response_type: 'code',
 client_id: clientId,
 redirect_uri: callbackUri,
 scope: 'openid profile email r_basicprofile',
 state,
 });

 window.location.href = `https://www.linkedin.com/oauth/v2/authorization?${params.toString()}`;
 } catch (error) {
 reportCaughtError(error, 'auth.signInWithLinkedIn');
 }
}

/**
 * Exchange a LinkedIn authorization code for a Firebase custom token.
 * Called by the /auth/linkedin/callback SPA page.
 */
export async function exchangeLinkedInCode(code: string): Promise<string | null> {
 try {
 const origin = typeof window !== 'undefined' ? window.location.origin : 'https://frontaliereticino.ch';
 const redirectUri = `${origin}/auth/linkedin/callback`;

 const res = await fetch(`${LINKEDIN_CF_BASE}/linkedinAuthCallback`, {
 method: 'POST',
 headers: { 'Content-Type': 'application/json' },
 body: JSON.stringify({ code, redirectUri }),
 });

 if (!res.ok) {
 const body = await res.json().catch(() => ({}));
 console.warn('[Auth] LinkedIn CF error:', res.status, body?.error);
 return null;
 }

 const data = await res.json();
 return data?.customToken || null;
 } catch (error) {
 reportCaughtError(error, 'auth.exchangeLinkedInCode');
 return null;
 }
}

// ─── Auth Hook ───────────────────────────────────────────────

export interface AuthState {
 user: any | null;
 loading: boolean;
}

export function useAuth(): AuthState & {
 signIn: () => Promise<any | null>;
 signInFacebook: () => Promise<any | null>;
 signInEmail: (email: string, password: string) => Promise<any | null>;
 logout: () => Promise<void>;
} {
 const [user, setUser] = useState<any | null>(null);
 const [loading, setLoading] = useState(() => {
 // Only block UI rendering for flows that REQUIRE auth before showing content.
 // All other cases (authToken, confirm_newsletter) run auth in background.
 if (sessionStorage.getItem('auth_redirect_provider')) return true;
 if (typeof window !== 'undefined') {
 if (window.location.pathname.includes('/gestione-contenuti-xk9mp2q')) return true;
 const p = new URLSearchParams(window.location.search);
 if (p.get('mode') === 'signIn' && p.get('oobCode')) return true;
 }
 return false;
 });

 useEffect(() => {
 let unsubscribe: (() => void) | null = null;
 let authQueued = false;
 
 // Defer Firebase Auth loading to reduce initial bundle impact on Lighthouse.
 // Auth check happens after the browser goes idle, so it doesn't block LCP/FCP.
 const startAuth = () => {
 if (authQueued) return;
 authQueued = true;
 logAuthDebug('useAuth:startAuth', {
 redirectProvider: sessionStorage.getItem('auth_redirect_provider'),
 redirectPath: sessionStorage.getItem('auth_redirect_path'),
 shouldStartImmediately: shouldStartAuthImmediately(),
 });
 ensureFirebaseAuth().then(async () => {
 const authInstance = getAuthInstance();
 if (!authInstance || !_authModule) {
 logAuthDebug('useAuth:no-auth-instance');
 setLoading(false);
 return;
 }
 
 // Handle redirect result (from signInWithRedirect on mobile / fallback)
 _authModule.getRedirectResult(authInstance).then(async (result: any) => {
 logAuthDebug('useAuth:getRedirectResult:resolved', {
 hasResult: Boolean(result),
 hasUser: Boolean(result?.user),
 providerId: result?.providerId || null,
 operationType: result?.operationType || null,
 currentUserUid: authInstance?.currentUser?.uid || null,
 });
 if (result?.user) {
 const provider = sessionStorage.getItem('auth_redirect_provider') || 'google';
 sessionStorage.removeItem('auth_redirect_provider');
 // Mirror the redirect result into local hook state immediately.
 // On some mobile Google redirect returns, Firebase restores the session
 // but onAuthStateChanged does not emit a second event after the initial
 // null snapshot, leaving pages that rely on App-level auth stuck logged out.
 setUser(Object.create(result.user));
 // Patch Facebook email and profile on redirect flow too
 if (provider === 'facebook') {
 await patchFacebookData(result);
 // Force UI refresh again after profile patching mutates the user object.
 setUser(Object.create(result.user));
 }
 import('@/services/analytics').then(({ Analytics }) => {
 Analytics.trackUIInteraction('auth', provider, 'login', 'success-redirect');
 });
 // Best-effort: save user profile to Firestore for personalization
 saveUserProfileToFirestore(result.user, provider as 'google' | 'facebook').catch(() => {});
 // Restore the path the user was on before the redirect
 const savedPath = sessionStorage.getItem('auth_redirect_path');
 logAuthDebug('useAuth:redirect-success', {
 provider,
 savedPath,
 resultUid: result?.user?.uid || null,
 resultEmail: result?.user?.email || null,
 });
 if (savedPath && savedPath !== '/' && window.location.pathname !== savedPath) {
 sessionStorage.removeItem('auth_redirect_path');
 window.history.replaceState(null, '', savedPath);
 // Trigger route parsing so the SPA shows the correct tab
 window.dispatchEvent(new PopStateEvent('popstate'));
 } else {
 sessionStorage.removeItem('auth_redirect_path');
 }
 }
 }).catch((error: any) => {
 logAuthDebug('useAuth:getRedirectResult:error', {
 code: error?.code || null,
 message: error?.message || null,
 });
 });

 unsubscribe = _authModule.onAuthStateChanged(authInstance, (u: any) => {
 logAuthDebug('useAuth:onAuthStateChanged', {
 hasUser: Boolean(u),
 uid: u?.uid || null,
 email: u?.email || null,
 providerIds: Array.isArray(u?.providerData)
 ? u.providerData.map((p: any) => p?.providerId).filter(Boolean)
 : [],
 });
 setUser(u);
 setLoading(false);
 });
 }).catch((e) => {
 logAuthDebug('useAuth:startAuth:error', {
 message: e instanceof Error ? e.message : String(e),
 });
 reportCaughtError(e, 'auth.initAuthListener');
 setLoading(false);
 });
 };

 // If there's a pending auth redirect, load immediately to complete the flow.
 // Otherwise, defer to first user interaction to avoid loading firebase/auth
 // during Lighthouse's observation window (~100KB saved from unused-js).
 if (sessionStorage.getItem('auth_redirect_provider') || shouldStartAuthImmediately()) {
 startAuth();
 return () => { if (unsubscribe) unsubscribe(); };
 } else {
 const triggerAuth = () => {
 if (authQueued) return;
 for (const evt of ['pointerdown', 'keydown', 'scroll', 'touchstart'] as const) {
 window.removeEventListener(evt, triggerAuth, { capture: true });
 }
 setTimeout(startAuth, 100);
 };
 for (const evt of ['pointerdown', 'keydown', 'scroll', 'touchstart'] as const) {
 window.addEventListener(evt, triggerAuth, { capture: true, passive: true } as AddEventListenerOptions);
 }
 // Allow other components to force-start auth immediately
 const onEager = () => triggerAuth();
 window.addEventListener('auth:eager', onEager);
 // Fallback: load auth after 20s even without interaction
 const fallback = setTimeout(() => {
 if (!authQueued) {
 for (const evt of ['pointerdown', 'keydown', 'scroll', 'touchstart'] as const) {
 window.removeEventListener(evt, triggerAuth, { capture: true });
 }
 startAuth();
 }
 }, 20000);
 return () => {
 clearTimeout(fallback);
 window.removeEventListener('auth:eager', onEager);
 for (const evt of ['pointerdown', 'keydown', 'scroll', 'touchstart'] as const) {
 window.removeEventListener(evt, triggerAuth, { capture: true });
 }
 if (unsubscribe) unsubscribe();
 };
 }
 }, []);

 const signIn = useCallback(async () => {
 // Desktop: signInWithGoogle uses popup — returns user immediately.
 // Mobile/fallback: uses redirect — returns null (page navigates away),
 // user is set by getRedirectResult + onAuthStateChanged on return.
 const googleUser = await signInWithGoogle();
 if (googleUser) setUser(Object.create(googleUser));
 return googleUser;
 }, []);

 const signInFb = useCallback(async () => {
 const fbUser = await signInWithFacebook();
 // Force UI refresh to pick up patched Facebook data (email, photo, displayName)
 if (fbUser) setUser(Object.create(fbUser));
 return fbUser;
 }, []);

 const signInEmail = useCallback(async (email: string, password: string) => {
 const emailUser = await signInWithEmailPassword(email, password);
 if (emailUser) setUser(Object.create(emailUser));
 return emailUser;
 }, []);

 const logout = useCallback(async () => {
 return signOut();
 }, []);

 return { user, loading, signIn, signInFacebook: signInFb, signInEmail, logout };
}

/**
 * Get current user display info — checks providerData for Facebook users
 * whose displayName may only be in their provider entry.
 */
export function getUserDisplayName(user: any | null): string {
 if (!user) return '';
 if (user.displayName) return user.displayName;
 // Fallback: check providerData (Facebook may not populate top-level displayName)
 if (user.providerData?.length) {
 for (const p of user.providerData) {
 if (p.displayName) return p.displayName;
 }
 }
 const email = getAuthEmail(user);
 return email?.split('@')[0] || 'Utente';
}

/**
 * Get user photo URL — checks providerData for Facebook users
 * whose photoURL may only be in their provider entry.
 * For Facebook photos, appends a larger size parameter.
 */
export function getUserPhotoURL(user: any | null, uid?: string): string | null {
 // For Facebook users, check localStorage cache first — it has the real CDN URL
 // while Firebase reverts to the broken graph.facebook.com placeholder after reload
 if (uid) {
 const cached = getCachedFacebookAuthData(uid);
 if (cached?.photoURL && !isPlaceholderPhotoURL(cached.photoURL)) {
 return cached.photoURL;
 }
 }
 // Check user.photoURL but skip Facebook placeholder URLs
 if (user?.photoURL && !isPlaceholderPhotoURL(user.photoURL)) return user.photoURL;
 if (user?.providerData?.length) {
 for (const p of user.providerData) {
 if (p.photoURL && !isPlaceholderPhotoURL(p.photoURL)) {
 return p.photoURL;
 }
 }
 }
 return null;
}

// ─── Google One Tap ──────────────────────────────────────────

declare global {
 interface Window {
 google?: {
 accounts: {
 id: {
 initialize: (config: OneTapConfig) => void;
 prompt: (callback?: (notification: OneTapNotification) => void) => void;
 cancel: () => void;
 renderButton: (parent: HTMLElement, options: OneTapButtonOptions) => void;
 };
 };
 };
 }
}

interface OneTapConfig {
 client_id: string;
 callback: (response: OneTapResponse) => void;
 auto_select?: boolean;
 cancel_on_tap_outside?: boolean;
 context?: 'signin' | 'signup' | 'use';
 use_fedcm_for_prompt?: boolean;
 itp_support?: boolean;
 intermediate_iframe_close_callback?: () => void;
}

interface OneTapResponse {
 credential: string;
 select_by?: string;
 clientId?: string;
}

interface OneTapNotification {
 isNotDisplayed: () => boolean;
 isSkippedMoment: () => boolean;
 isDismissedMoment: () => boolean;
 getNotDisplayedReason?: () => string;
 getSkippedReason?: () => string;
 getDismissedReason?: () => string;
}

interface OneTapButtonOptions {
 type?: 'standard' | 'icon';
 theme?: 'outline' | 'filled_blue' | 'filled_black';
 size?: 'large' | 'medium' | 'small';
 text?: 'signin_with' | 'signup_with' | 'continue_with' | 'signin';
 shape?: 'rectangular' | 'pill' | 'circle' | 'square';
 logo_alignment?: 'left' | 'center';
 width?: number;
 locale?: string;
}

let oneTapInitialized = false;
let oneTapInitPromise: Promise<boolean> | null = null;
let clientId: string | null = null;

function isMobileBrowserContext(): boolean {
 if (typeof window === 'undefined') return false;

 try {
 if (window.matchMedia?.('(max-width: 768px)').matches) return true;
 } catch {
 // Ignore matchMedia errors and fall back to user agent detection.
 }

 const ua = window.navigator?.userAgent || '';
 return /Android|iPhone|iPad|iPod|Mobile|Opera Mini|IEMobile/i.test(ua);
}

/**
 * Load Google Identity Services script
 */
async function loadGISScript(): Promise<void> {
 if (typeof window === 'undefined') return;
 if (document.querySelector('script[src*="accounts.google.com/gsi/client"]')) return;
 
 return new Promise((resolve, reject) => {
 const script = document.createElement('script');
 script.src = 'https://accounts.google.com/gsi/client';
 script.async = true;
 script.defer = true;
 script.crossOrigin = 'anonymous';
 script.onload = () => resolve();
 script.onerror = () => reject(new Error('Failed to load Google Identity Services'));
 document.head.appendChild(script);
 });
}

/**
 * Initialize Google One Tap
 * Must be called once before prompting or rendering buttons
 */
export async function initOneTap(): Promise<boolean> {
 if (oneTapInitialized) return true;
 if (oneTapInitPromise) return oneTapInitPromise;

 oneTapInitPromise = (async () => {
 try {
 // Get client ID from Remote Config
 if (!clientId) {
 const { getConfigValue } = await import('@/services/firebase');
 clientId = await getConfigValue('GOOGLE_OAUTH_CLIENT_ID');
 if (!clientId) {
 console.warn('⚠️ GOOGLE_OAUTH_CLIENT_ID not found in Remote Config');
 return false;
 }
 }

 // Load GIS script
 await loadGISScript();

 if (!window.google?.accounts?.id) {
 console.warn('⚠️ Google Identity Services not available');
 return false;
 }

 window.google.accounts.id.initialize({
 client_id: clientId,
 callback: handleOneTapResponse,
 auto_select: true,
 cancel_on_tap_outside: true,
 context: 'signin',
 use_fedcm_for_prompt: false,
 itp_support: true,
 intermediate_iframe_close_callback: () => {
 // Safari ITP: intermediate iframe closed after user authenticated.
 // One Tap will call the main callback with the credential.
 },
 });

 oneTapInitialized = true;
 console.log('✅ Google One Tap initialized');
 return true;
 } catch (error) {
 console.warn('⚠️ Failed to initialize One Tap:', error);
 reportCaughtError(error, 'auth.initOneTap');
 return false;
 } finally {
 if (!oneTapInitialized) oneTapInitPromise = null;
 }
 })();

 return oneTapInitPromise;
}

/**
 * Handle One Tap credential response
 */
async function handleOneTapResponse(response: OneTapResponse): Promise<void> {
 try {
 await ensureFirebaseAuth();
 const authInstance = getAuthInstance();
 if (!authInstance || !_authModule) return;
 const credential = _authModule.GoogleAuthProvider.credential(response.credential);
 const result = await _authModule.signInWithCredential(authInstance, credential);
 const { Analytics } = await import('@/services/analytics');
 Analytics.trackUIInteraction('auth', 'google', 'login', 'onetap');
 console.log('✅ One Tap sign-in successful:', result.user.email);

 // Redirect to saved path if present (e.g., expired/bridge job → listing)
 const savedPath = sessionStorage.getItem('auth_redirect_path');
 sessionStorage.removeItem('auth_redirect_path');
 if (savedPath && savedPath !== '/' && window.location.pathname !== savedPath) {
 window.history.replaceState(null, '', savedPath);
 window.dispatchEvent(new PopStateEvent('popstate'));
 }
 } catch (error) {
 console.warn('⚠️ One Tap credential error:', error);
 reportCaughtError(error, 'auth.oneTapCredential');
 const { Analytics } = await import('@/services/analytics');
 Analytics.trackUIInteraction('auth', 'google', 'login', 'onetap-error');
 }
}

/**
 * Show Google One Tap prompt
 * Call this when the user arrives at a sign-in page
 */
export async function promptOneTap(): Promise<void> {
 await ensureFirebaseAuth();
 const authInstance = getAuthInstance();
 if (authInstance?.currentUser) return;
 // Keep UX clean: never stack browser One Tap over an existing in-app popup/banner.
 if (hasActiveSlot()) return;

 if (!oneTapInitialized) {
 const initialized = await initOneTap();
 if (!initialized) return;
 }
 
 window.google?.accounts?.id.prompt((notification) => {
 if (notification.isNotDisplayed()) {
 console.log('[OneTap] Not displayed:', notification.getNotDisplayedReason?.());
 } else if (notification.isSkippedMoment()) {
 console.log('[OneTap] Skipped:', notification.getSkippedReason?.());
 }
 });
}

/**
 * Render a Google Sign-In button in a container
 */
export async function renderGoogleButton(
 container: HTMLElement,
 options?: Partial<OneTapButtonOptions>
): Promise<void> {
 if (!oneTapInitialized) {
 const initialized = await initOneTap();
 if (!initialized) return;
 }
 
 window.google?.accounts?.id.renderButton(container, {
 type: 'standard',
 theme: 'outline',
 size: 'large',
 text: 'signin_with',
 shape: 'rectangular',
 logo_alignment: 'left',
 ...options,
 });
}

export async function renderGoogleButtonWithReadiness(
 container: HTMLElement | null,
 options?: Partial<OneTapButtonOptions>,
 readinessDelayMs = 450,
): Promise<boolean> {
 if (!container) return false;
 container.innerHTML = '';
 await renderGoogleButton(container, options);
 if (container.children.length > 0) return true;
 await new Promise((resolve) => window.setTimeout(resolve, readinessDelayMs));
 return container.children.length > 0;
}

/**
 * Cancel One Tap prompt
 */
/** Trigger immediate Firebase Auth initialization (skips interaction deferral). */
export function eagerAuth(): void {
 _eagerAuthRequested = true;
 window.dispatchEvent(new Event('auth:eager'));
}

export function cancelOneTap(): void {
 window.google?.accounts?.id.cancel();
}

/**
 * Delete the current user's account from Firebase Auth.
 * Caller is responsible for cleaning up Firestore data before calling this.
 * Re-authenticates via the appropriate provider (Google or Facebook) if a recent login is required.
 */
export async function deleteCurrentUser(): Promise<boolean> {
 try {
 await ensureFirebaseAuth();
 const authInstance = getAuthInstance();
 if (!authInstance?.currentUser || !_authModule) return false;
 try {
 await _authModule.deleteUser(authInstance.currentUser);
 } catch (err: any) {
 if (err?.code === 'auth/requires-recent-login') {
 // Determine which provider to use for re-auth
 const providers = getLinkedProviders(authInstance.currentUser);
 let provider;
 if (providers.includes('facebook.com')) {
 provider = new _authModule.FacebookAuthProvider();
 } else {
 provider = new _authModule.GoogleAuthProvider();
 }
 await _authModule.reauthenticateWithPopup(authInstance.currentUser, provider);
 await _authModule.deleteUser(authInstance.currentUser);
 } else {
 throw err;
 }
 }
 const { Analytics } = await import('@/services/analytics');
 Analytics.trackUIInteraction('auth', 'account', 'delete', 'success');
 return true;
 } catch (error) {
 console.warn('Account deletion error:', error);
 reportCaughtError(error, 'auth.deleteUser');
 return false;
 }
}
