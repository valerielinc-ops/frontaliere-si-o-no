/**
 * Firebase Authentication Service
 * Google Sign-In per Dashboard e Forum
 */

import { useState, useEffect, useCallback } from 'react';
import {
  getAuth,
  GoogleAuthProvider,
  signInWithPopup,
  signOut as firebaseSignOut,
  onAuthStateChanged,
  User,
  Auth,
} from 'firebase/auth';
import { app } from '@/services/firebase';
import { Analytics } from '@/services/analytics';

// ─── Firebase Auth Init ──────────────────────────────────────

let auth: Auth | null = null;

function getAuthInstance(): Auth {
  if (!auth) {
    auth = getAuth(app);
  }
  return auth;
}

const googleProvider = new GoogleAuthProvider();
googleProvider.setCustomParameters({ prompt: 'select_account' });

// ─── Auth Functions ──────────────────────────────────────────

export async function signInWithGoogle(): Promise<User | null> {
  try {
    const authInstance = getAuthInstance();
    const result = await signInWithPopup(authInstance, googleProvider);
    Analytics.trackUIInteraction('auth', 'google', 'login', 'success');
    return result.user;
  } catch (error: any) {
    // User closed popup or other error
    if (error?.code !== 'auth/popup-closed-by-user') {
      console.warn('Google sign-in error:', error);
      Analytics.trackUIInteraction('auth', 'google', 'login', 'error');
    }
    return null;
  }
}

export async function signOut(): Promise<void> {
  try {
    const authInstance = getAuthInstance();
    await firebaseSignOut(authInstance);
    Analytics.trackUIInteraction('auth', 'google', 'logout', 'success');
  } catch (error) {
    console.warn('Sign-out error:', error);
  }
}

// ─── Auth Hook ───────────────────────────────────────────────

export interface AuthState {
  user: User | null;
  loading: boolean;
}

export function useAuth(): AuthState & {
  signIn: () => Promise<User | null>;
  logout: () => Promise<void>;
} {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const authInstance = getAuthInstance();
    const unsubscribe = onAuthStateChanged(authInstance, (u) => {
      setUser(u);
      setLoading(false);
    });
    return unsubscribe;
  }, []);

  const signIn = useCallback(async () => {
    return signInWithGoogle();
  }, []);

  const logout = useCallback(async () => {
    return signOut();
  }, []);

  return { user, loading, signIn, logout };
}

/**
 * Get current user display info
 */
export function getUserDisplayName(user: User | null): string {
  if (!user) return '';
  return user.displayName || user.email?.split('@')[0] || 'Utente';
}

export function getUserPhotoURL(user: User | null): string | null {
  return user?.photoURL || null;
}
