/**
 * useUserState — Manages user authentication and profile state extracted from App.tsx
 *
 * Handles:
 * - Firebase auth via useAuth hook
 * - User profile loading from localStorage (deferred to idle)
 * - Profile-to-simulation prefilling (via callback)
 * - Google One Tap (interaction-deferred, sessionStorage-gated)
 * - Chatbot auth wrappers (Google, Facebook, email-only)
 * - Admin privilege check
 * - Auto-subscribe to newsletter on auth sign-in
 */
import { useState, useEffect, useCallback, type Dispatch, type SetStateAction, type MutableRefObject } from 'react';
import { useAuth, getAuthEmail, promptOneTap, cancelOneTap, getUserPhotoURL, getUserDisplayName } from '@/services/authService';
import { reportCaughtError } from '@/services/errorReporter';
import type { UserProfileData } from '@/components/pages/UserProfile';
import type { ContactPrefill } from '@/components/pages/ContactPage';
import type { SimulationInputs } from '@/types';

const ADMIN_EMAIL_WHITELIST = ['luigisag@gmail.com', 'valerielinc@gmail.com'];

// Lazy analytics proxy — fire-and-forget
const Analytics: Record<string, (...a: unknown[]) => void> = new Proxy({} as any, {
  get: (_t, method: string) => (...args: unknown[]) => {
    import('@/services/analytics').then(m => (m.Analytics as any)[method](...args));
  },
});

const unlockAchievement = (id: string) => {
  import('@/services/gamificationService').then(m => m.unlockAchievement(id));
};

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
  upsertNewsletterSubscriber: (email: string, source: 'signup' | 'chatbot_google' | 'chatbot_facebook' | 'chatbot_email', displayName?: string | null) => Promise<boolean>,
  setInputs: Dispatch<SetStateAction<SimulationInputs>>,
  urlHydrated: MutableRefObject<boolean>,
): UserState {
  const { user: authUser, loading: authLoading, signIn: googleSignIn, signInFacebook: facebookSignIn, signInEmail } = useAuth();
  const [userProfile, setUserProfile] = useState<UserProfileData | null>(null);
  const [contactPrefill, setContactPrefill] = useState<ContactPrefill | null>(null);

  const authEmail = authUser ? getAuthEmail(authUser) : null;
  const isPrivilegedAdmin = ADMIN_EMAIL_WHITELIST.includes(authEmail?.toLowerCase() ?? '');

  // Auto-subscribe to newsletter on auth sign-in
  useEffect(() => {
    if (!authEmail) return;
    if (localStorage.getItem('newsletter_subscribed') === 'true') return;
    upsertNewsletterSubscriber(authEmail, 'signup', authUser?.displayName || null).catch((e) => reportCaughtError(e, 'user.autoNewsletterSubscribe'));
  }, [authEmail]);

  // Load user profile for prefilling simulator inputs (deferred to idle)
  // Skipped when URL params already hydrated the inputs
  useEffect(() => {
    const loadProfile = () => {
      if (urlHydrated.current) return;
      import('@/components/pages/UserProfile').then(({ loadUserProfile, profileToSimInputs }) => {
        const profile = loadUserProfile();
        const hasData = profile.familySituation || profile.children !== '0' || profile.age || profile.frontaliereType;
        if (hasData) {
          setUserProfile(profile);
          const prefilled = profileToSimInputs(profile);
          if (Object.keys(prefilled).length > 0) {
            setInputs(prev => ({ ...prev, ...prefilled }));
          }
        }
      });
    };
    if ('requestIdleCallback' in window) {
      requestIdleCallback(loadProfile, { timeout: 4000 });
    } else {
      setTimeout(loadProfile, 2000);
    }
    const onStorage = (e: StorageEvent) => {
      if (e.key === 'frontaliere_user_profile' && e.newValue) {
        try { setUserProfile(JSON.parse(e.newValue) as UserProfileData); } catch { /* ignore */ }
      }
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  // Chatbot auth wrappers
  const chatbotGoogleSignIn = useCallback(async (): Promise<any | null> => {
    const user = await googleSignIn();
    const email = getAuthEmail(user);
    if (email) {
      try {
        await upsertNewsletterSubscriber(email, 'chatbot_google', user?.displayName || null);
      } catch (e) {
        console.warn('[Chatbot] newsletter upsert (google) failed:', e);
        reportCaughtError(e, 'user.chatbotGoogleNewsletter');
      }
    }
    return user;
  }, [googleSignIn, upsertNewsletterSubscriber]);

  const chatbotFacebookSignIn = useCallback(async (): Promise<any | null> => {
    const user = await facebookSignIn();
    const email = getAuthEmail(user);
    if (email) {
      try {
        await upsertNewsletterSubscriber(email, 'chatbot_facebook', user?.displayName || null);
      } catch (e) {
        console.warn('[Chatbot] newsletter upsert (facebook) failed:', e);
        reportCaughtError(e, 'user.chatbotFacebookNewsletter');
      }
    }
    return user;
  }, [facebookSignIn, upsertNewsletterSubscriber]);

  const chatbotContinueWithEmail = useCallback(async (email: string): Promise<boolean> => {
    const ok = await upsertNewsletterSubscriber(email, 'chatbot_email', null);
    if (ok) {
      Analytics.trackNewsletter('subscribe', email.split('@')[1] || 'unknown');
      unlockAchievement('newsletter_sub');
      Analytics.trackUIInteraction('chatbot', 'auth_gate', 'newsletter_email_subscribe', 'success');
    } else {
      Analytics.trackUIInteraction('chatbot', 'auth_gate', 'newsletter_email_subscribe', 'error');
    }
    return ok;
  }, [upsertNewsletterSubscriber]);

  // Google One Tap: prompt on first user interaction when not signed in
  useEffect(() => {
    if (authUser) {
      sessionStorage.removeItem('onetap_pending');
      cancelOneTap();
      return;
    }
    if (sessionStorage.getItem('onetap_prompted')) return;

    let queued = false;
    let promptTimeout: ReturnType<typeof setTimeout> | null = null;
    const trigger = () => {
      if (queued || sessionStorage.getItem('onetap_prompted')) return;
      queued = true;
      for (const e of ['pointerdown', 'keydown', 'touchstart'] as const)
        window.removeEventListener(e, trigger, { capture: true });
      promptTimeout = setTimeout(() => {
        if (authUser) return;
        if (authLoading) {
          sessionStorage.setItem('onetap_pending', '1');
          return;
        }
        sessionStorage.setItem('onetap_prompted', '1');
        sessionStorage.removeItem('onetap_pending');
        promptOneTap();
      }, 2000);
    };

    for (const e of ['pointerdown', 'keydown', 'touchstart'] as const)
      window.addEventListener(e, trigger, { capture: true, passive: true } as AddEventListenerOptions);

    return () => {
      if (promptTimeout) clearTimeout(promptTimeout);
      for (const e of ['pointerdown', 'keydown', 'touchstart'] as const)
        window.removeEventListener(e, trigger, { capture: true });
      cancelOneTap();
    };
  }, [authLoading, authUser]);

  // Handle deferred One Tap prompt after auth loading resolves
  useEffect(() => {
    if (authLoading || authUser) return;
    if (sessionStorage.getItem('onetap_prompted')) return;
    if (sessionStorage.getItem('onetap_pending') !== '1') return;
    sessionStorage.setItem('onetap_prompted', '1');
    sessionStorage.removeItem('onetap_pending');
    promptOneTap();
  }, [authLoading, authUser]);

  return {
    authUser, authLoading, authEmail, isPrivilegedAdmin,
    userProfile, setUserProfile,
    contactPrefill, setContactPrefill,
    googleSignIn, facebookSignIn, signInEmail,
    chatbotGoogleSignIn, chatbotFacebookSignIn, chatbotContinueWithEmail,
  };
}
