/**
 * Shared Firestore access to `newsletter_subscribers/{email}` for the
 * `UserProfileData` fields. Extracted so `components/pages/UserProfile.tsx`
 * (full profile form) and `components/community/ProfileEnrichmentPrompt.tsx`
 * (single-field progressive prompt) don't each carry their own copy of the
 * lazy-Firestore-init + merge-write boilerplate.
 */

import { reportCaughtError } from '@/services/errorReporter';

let firestoreDb: unknown = null;

async function initFirestore(): Promise<unknown> {
  if (firestoreDb) return firestoreDb;
  try {
    const { getFirestore } = await import('firebase/firestore');
    const { app } = await import('@/services/firebase');
    firestoreDb = getFirestore(app);
    return firestoreDb;
  } catch {
    return null;
  }
}

/**
 * Merge-write partial profile fields onto an existing shared subscriber doc.
 * Authentication/profile enrichment must not create an email relationship;
 * the explicit subscription form or gate owns that create. Swallows/reports
 * errors — never throws.
 */
export async function savePartialProfile(email: string, partial: Record<string, unknown>): Promise<void> {
 try {
  const db = await initFirestore();
  if (!db) return;
    const { doc, getDoc, setDoc } = await import('firebase/firestore');
    const key = email.trim().toLowerCase();
    const subscriberRef = doc(db as never, 'newsletter_subscribers', key);
    const existingSubscriber = await getDoc(subscriberRef);
    if (!existingSubscriber.exists()) return;
    await setDoc(
      subscriberRef,
      { ...partial, updatedAt: new Date().toISOString() },
      { merge: true },
    );
  } catch (e) {
    console.warn('[profileFirestore] savePartialProfile failed:', e);
    reportCaughtError(e, 'profileFirestore.savePartialProfile', { type: 'api_error' });
  }
}

/** The subset of `UserProfileData` the enrichment-gating engine reads. */
export interface EnrichmentProfileFields {
  municipality: string;
  frontaliereType: string;
  workPosition: string;
  grossSalary: string;
}

const EMPTY_FIELDS: EnrichmentProfileFields = {
  municipality: '',
  frontaliereType: '',
  workPosition: '',
  grossSalary: '',
};

/** Reads only the fields `pickNextQuestion` needs — not the full `UserProfileData` shape. Returns empty strings on any failure. */
export async function loadEnrichmentProfileFields(email: string): Promise<EnrichmentProfileFields> {
  try {
    const db = await initFirestore();
    if (!db) return { ...EMPTY_FIELDS };
    const { doc, getDoc } = await import('firebase/firestore');
    const key = email.trim().toLowerCase();
    const snap = await getDoc(doc(db as never, 'newsletter_subscribers', key));
    if (!snap.exists()) return { ...EMPTY_FIELDS };
    const data = snap.data() as Record<string, unknown>;
    return {
      municipality: typeof data.municipality === 'string' ? data.municipality : '',
      frontaliereType: typeof data.frontaliereType === 'string' ? data.frontaliereType : '',
      workPosition: typeof data.workPosition === 'string' ? data.workPosition : '',
      grossSalary: typeof data.grossSalary === 'string' ? data.grossSalary : '',
    };
  } catch {
    return { ...EMPTY_FIELDS };
  }
}

export interface UserCvProfileRecord {
  userId: string;
  status: 'processing' | 'ready' | 'needs_review' | string;
  cvDocument?: {
    fileName?: string;
    sourceType?: string;
    sourceId?: string;
    uploadedAt?: unknown;
    detectedType?: string | null;
    extractedTextAvailable?: boolean;
  };
  profile?: {
    fullName?: string;
    email?: string;
    phone?: string;
    headline?: string;
    workPosition?: string;
    workplace?: string;
    preferredLanguage?: string;
    skills?: string[];
    languages?: string[];
    experienceSummary?: string[];
  };
  updatedAt?: unknown;
}

/** Owner-only CV projection; the original file and extracted text stay server-side. */
export async function loadUserCvProfile(uid: string): Promise<UserCvProfileRecord | null> {
  if (!uid) return null;
  try {
    const db = await initFirestore();
    if (!db) return null;
    const { doc, getDoc } = await import('firebase/firestore');
    const snapshot = await getDoc(doc(db as never, 'user_cv_profiles', uid));
    if (!snapshot.exists()) return null;
    return { userId: uid, ...(snapshot.data() as Omit<UserCvProfileRecord, 'userId'>) };
  } catch (error) {
    reportCaughtError(error, 'profileFirestore.loadUserCvProfile', { type: 'api_error' });
    return null;
  }
}
