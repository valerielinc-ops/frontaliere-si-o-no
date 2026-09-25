/**
 * Reads the caller's own `journalists/{uid}` grant doc (see firestore.rules)
 * to decide whether to render the journalist publishing dashboard. Mirrors
 * the `isPrivilegedAdmin` gate pattern (hooks/useUserState.ts) but is
 * Firestore-doc-backed rather than a hardcoded email allowlist, since
 * journalist grants are managed at runtime via the manageJournalistRole
 * Cloud Function (see components/pages/AdminPanel.tsx's "Giornalisti" section).
 */
import { useEffect, useState } from 'react';
import type { User } from 'firebase/auth';

export interface JournalistRoleState {
  isJournalist: boolean;
  loading: boolean;
}

export function useJournalistRole(user: User | null | undefined): JournalistRoleState {
  const [isJournalist, setIsJournalist] = useState(false);
  const [loading, setLoading] = useState(!!user);

  useEffect(() => {
    let cancelled = false;
    if (!user) {
      setIsJournalist(false);
      setLoading(false);
      return;
    }
    setLoading(true);
    (async () => {
      try {
        const { doc, getDoc, getFirestore } = await import('firebase/firestore');
        const { getApp } = await import('@/services/firebase');
        const database = getFirestore(await getApp());
        const snap = await getDoc(doc(database, 'journalists', user.uid));
        if (cancelled) return;
        setIsJournalist(snap.exists() && snap.data()?.active === true);
      } catch {
        if (!cancelled) setIsJournalist(false);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [user]);

  return { isJournalist, loading };
}
