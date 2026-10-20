/**
 * useUserState — Manages user authentication and profile state extracted from App.tsx
 *
 * Handles:
 * - Firebase auth via useAuth hook
 * - User profile loading from localStorage (deferred to idle)
 * - Profile-to-simulation prefilling (via callback)
 * - Google One Tap (interaction-deferred, sessionStorage-gated)
 * - Admin privilege check
 * - Chatbot auth wrappers (authentication only; newsletter consent is separate)
 */
import { useState, useEffect, useLayoutEffect, useCallback, type Dispatch, type SetStateAction, type MutableRefObject } from 'react';
import { useAuth, getAuthEmail, promptOneTap, cancelOneTap, getUserPhotoURL, getUserDisplayName } from '@/services/authService';
import { claimOneTapPrompt } from '@/services/oneTapPromptGate';
import type { UserProfileData } from '@/components/pages/UserProfile';
import type { ContactPrefill } from '@/components/pages/ContactPage';
import type { SimulationInputs } from '@/types';
import { isSiteAdminUid } from '@/services/adminIdentity';
import { userProfileStorageKey } from '@/services/userProfileStorage';

import { Analytics } from '@/services/analyticsProxy';

export interface UserState {
 authUser: any;
 authLoading: boolean;
 authEmail: string | null;
 isPrivilegedAdmin: boolean;
 userProfile: UserProfileData | null;
 setUserProfile: Dispatch<SetStateAction<UserProfileData | null>>;
 contactPrefill: ContactPrefill | null;
 setContactPrefill: Dispatch<SetStateAction<ContactPrefill | null>>;
 googleSignIn: () => Promise<any>;
 facebookSignIn: () => Promise<any>;
 signInEmail: (email: string, password: string) => Promise<any>;
 chatbotGoogleSignIn: () => Promise<any | null>;
 chatbotFacebookSignIn: () => Promise<any | null>;
 chatbotContinueWithEmail: (email: string) => Promise<boolean>;
}

export function useUserState(
 setInputs: Dispatch<SetStateAction<SimulationInputs>>,
 urlHydrated: MutableRefObject<boolean>,
): UserState {
 const { user: authUser, loading: authLoading, signIn: googleSignIn, signInFacebook: facebookSignIn, signInEmail } = useAuth();
 const [userProfile, setUserProfile] = useState<UserProfileData | null>(null);
 const [contactPrefill, setContactPrefill] = useState<ContactPrefill | null>(null);

 const authEmail = authUser ? getAuthEmail(authUser) : null;
 const isPrivilegedAdmin = isSiteAdminUid(authUser?.uid);

 // Load user profile for prefilling simulator inputs (deferred to idle)
 // Skipped when URL params already hydrated the inputs
 useLayoutEffect(() => {
 setUserProfile(null);
 let cancelled = false;
 let idleRequest: number | null = null;
 let timeoutRequest: ReturnType<typeof setTimeout> | null = null;
 const loadProfile = () => {
 if (cancelled || urlHydrated.current) return;
 import('@/components/pages/UserProfile').then(({ loadUserProfile, profileToSimInputs }) => {
 if (cancelled) return;
 const profile = loadUserProfile(authUser?.uid);
 const hasData = Boolean(profile.familySituation || profile.children || profile.age || profile.frontaliereType);
 setUserProfile(hasData ? profile : null);
 if (hasData) {
 const prefilled = profileToSimInputs(profile);
 if (Object.keys(prefilled).length > 0) {
 setInputs(prev => ({ ...prev, ...prefilled }));
 }
 }
 }).catch(() => {});
 };
 const idleWindow = window as Window & {
 requestIdleCallback?: (callback: () => void, options?: { timeout: number }) => number;
 cancelIdleCallback?: (handle: number) => void;
 };
 if (typeof idleWindow.requestIdleCallback === 'function') {
 idleRequest = idleWindow.requestIdleCallback(loadProfile, { timeout: 4000 });
 } else {
 timeoutRequest = setTimeout(loadProfile, 2000);
 }
 const onStorage = (e: StorageEvent) => {
 if (e.key === userProfileStorageKey(authUser?.uid) && e.newValue) {
 try { setUserProfile(JSON.parse(e.newValue) as UserProfileData); } catch { /* ignore */ }
 }
 };
 window.addEventListener('storage', onStorage);
 return () => {
 cancelled = true;
 if (idleRequest != null) idleWindow.cancelIdleCallback?.(idleRequest);
 if (timeoutRequest != null) clearTimeout(timeoutRequest);
 window.removeEventListener('storage', onStorage);
 };
 }, [authUser?.uid]);

 // Chatbot auth wrappers
 const chatbotGoogleSignIn = useCallback(async (): Promise<any | null> => {
 return googleSignIn();
 }, [googleSignIn]);

 const chatbotFacebookSignIn = useCallback(async (): Promise<any | null> => {
 return facebookSignIn();
 }, [facebookSignIn]);

 const chatbotContinueWithEmail = useCallback(async (email: string): Promise<boolean> => {
 const ok = Boolean(email && email.includes('@'));
 if (ok) {
 Analytics.trackUIInteraction('chatbot', 'auth_gate', 'email_access', 'success');
 } else {
 Analytics.trackUIInteraction('chatbot', 'auth_gate', 'email_access', 'error');
 }
 return ok;
 }, []);

 // Google One Tap: prompt automatically once auth state is resolved.
 // With auto_select: true, returning Google users are signed in silently.
 useEffect(() => {
 if (authUser) {
 cancelOneTap();
 return;
 }
 if (authLoading) return;
 if (!claimOneTapPrompt(window.sessionStorage)) return;
 void Promise.resolve(promptOneTap()).catch(() => {});

 return () => { cancelOneTap(); };
 }, [authLoading, authUser]);

 return {
 authUser, authLoading, authEmail, isPrivilegedAdmin,
 userProfile, setUserProfile,
 contactPrefill, setContactPrefill,
 googleSignIn, facebookSignIn, signInEmail,
 chatbotGoogleSignIn, chatbotFacebookSignIn, chatbotContinueWithEmail,
 };
}
