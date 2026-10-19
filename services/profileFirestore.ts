/** Owner-scoped persistence for profile fields, plus legacy newsletter reads. */

import { reportCaughtError } from '@/services/errorReporter';
import { CV_PROFILE_PARSER_VERSION } from '@/functions/src/candidateCvProfileContract.js';

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
 * Saves a partial profile only when the current authenticated account matches
 * the supplied email. Profile details stay under the owner's UID, separate
 * from the publicly readable newsletter lookup document.
 */
export async function savePartialProfile(email: string, partial: Record<string, unknown>): Promise<void> {
 try {
    const uid = await authenticatedUidForEmail(email);
    if (uid) await saveUserProfileFields(uid, partial);
  } catch (e) {
    console.warn('[profileFirestore] savePartialProfile failed:', e);
    reportCaughtError(e, 'profileFirestore.savePartialProfile', { type: 'api_error' });
  }
}

async function authenticatedUidForEmail(email: string): Promise<string | null> {
  const expectedEmail = email.trim().toLowerCase();
  if (!expectedEmail) return null;
  try {
    const [{ getAuth }, { getApp }] = await Promise.all([
      import('firebase/auth'),
      import('@/services/firebase'),
    ]);
    const user = getAuth(await getApp()).currentUser;
    return user?.email?.trim().toLowerCase() === expectedEmail ? user.uid : null;
  } catch {
    return null;
  }
}

async function saveUserProfileFields(uid: string, partial: Record<string, unknown>): Promise<boolean> {
  if (!uid || !Object.keys(partial).length) return false;
  const db = await initFirestore();
  if (!db) return false;
  const { doc, serverTimestamp, setDoc } = await import('firebase/firestore');
  await setDoc(
    doc(db as never, 'users', uid),
    { profile: partial, profileUpdatedAt: serverTimestamp() },
    { merge: true },
  );
  return true;
}

/** Saves the signed-in owner's complete profile under their UID. */
export async function saveUserProfile(uid: string, profile: Record<string, unknown>): Promise<boolean> {
  try {
    return await saveUserProfileFields(uid, profile);
  } catch (error) {
    console.warn('[profileFirestore] saveUserProfile failed:', error);
    reportCaughtError(error, 'profileFirestore.saveUserProfile', { type: 'api_error' });
    return false;
  }
}

export interface UserProfileReadResult {
  success: boolean;
  exists: boolean;
  profile: Record<string, unknown> | null;
}

/** Loads profile fields and distinguishes a missing document from a read failure. */
export async function loadUserProfileWithStatus(uid: string): Promise<UserProfileReadResult> {
  if (!uid) return { success: false, exists: false, profile: null };
  try {
    const db = await initFirestore();
    if (!db) return { success: false, exists: false, profile: null };
    const { doc, getDoc } = await import('firebase/firestore');
    const snapshot = await getDoc(doc(db as never, 'users', uid));
    if (!snapshot.exists()) return { success: true, exists: false, profile: null };
    const profile = snapshot.data()?.profile;
    return {
      success: true,
      exists: true,
      profile: profile && typeof profile === 'object' && !Array.isArray(profile)
        ? profile as Record<string, unknown>
        : null,
    };
  } catch (error) {
    reportCaughtError(error, 'profileFirestore.loadUserProfile', { type: 'api_error' });
    return { success: false, exists: false, profile: null };
  }
}

/** Loads profile fields from the authenticated owner's private user document. */
export async function loadUserProfile(uid: string): Promise<Record<string, unknown> | null> {
  const result = await loadUserProfileWithStatus(uid);
  return result.success ? result.profile : null;
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
    const uid = await authenticatedUidForEmail(email);
    const privateProfile = uid ? await loadUserProfile(uid) : null;
    const db = await initFirestore();
    if (!db) return profileFieldsFrom(privateProfile);
    const { doc, getDoc } = await import('firebase/firestore');
    const key = email.trim().toLowerCase();
    const snap = await getDoc(doc(db as never, 'newsletter_subscribers', key));
    const legacyProfile = snap.exists() ? snap.data() as Record<string, unknown> : null;
    return {
      municipality: preferredProfileValue(privateProfile, legacyProfile, 'municipality'),
      frontaliereType: preferredProfileValue(privateProfile, legacyProfile, 'frontaliereType'),
      workPosition: preferredProfileValue(privateProfile, legacyProfile, 'workPosition'),
      grossSalary: preferredProfileValue(privateProfile, legacyProfile, 'grossSalary'),
    };
  } catch {
    return { ...EMPTY_FIELDS };
  }
}

function preferredProfileValue(
  privateProfile: Record<string, unknown> | null,
  legacyProfile: Record<string, unknown> | null,
  key: keyof EnrichmentProfileFields,
): string {
  const privateValue = privateProfile?.[key];
  if (privateProfile && Object.hasOwn(privateProfile, key) && typeof privateValue === 'string') return privateValue;
  const legacyValue = legacyProfile?.[key];
  return typeof legacyValue === 'string' ? legacyValue : '';
}

function profileFieldsFrom(profile: Record<string, unknown> | null): EnrichmentProfileFields {
  return {
    municipality: typeof profile?.municipality === 'string' ? profile.municipality : '',
    frontaliereType: typeof profile?.frontaliereType === 'string' ? profile.frontaliereType : '',
    workPosition: typeof profile?.workPosition === 'string' ? profile.workPosition : '',
    grossSalary: typeof profile?.grossSalary === 'string' ? profile.grossSalary : '',
  };
}

export interface UserCvProfileRecord {
  userId: string;
  status: 'processing' | 'ready' | 'needs_review' | string;
  parserVersion?: number;
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
    age?: string;
    gender?: string;
    familySituation?: string;
    frontaliereType?: string;
    municipality?: string;
    children?: string;
    familyMembers?: string;
    familyMembersList?: Array<{
      id: string;
      relationship: 'spouse' | 'child' | 'parent' | 'sibling' | 'other';
      birthYear?: string;
      liveTogether: boolean;
      dependent: boolean;
    }>;
    preferredDogana?: string;
    preferredLanguage?: string;
    grossSalary?: string;
    permitExpiry?: string;
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
    let record = { ...(snapshot.data() as Omit<UserCvProfileRecord, 'userId'>), userId: uid };
    // Existing owner-only projections were parsed before explicit profile-field
    // extraction was added. Refresh them once on the server, then read back only
    // the safe projection; no CV bytes or extracted text enter the browser.
    const parserVersion = Number(record.parserVersion);
    if ((!Number.isFinite(parserVersion) || parserVersion < CV_PROFILE_PARSER_VERSION) && record.status !== 'processing') {
      try {
        const [{ getAuth }, { getFunctions, httpsCallable }, { getApp }] = await Promise.all([
          import('firebase/auth'),
          import('firebase/functions'),
          import('@/services/firebase'),
        ]);
        const app = await getApp();
        if (getAuth(app).currentUser?.uid === uid) {
          const refresh = httpsCallable(getFunctions(app, 'europe-west6'), 'refreshCandidateCvProfile');
          await refresh({});
          const refreshed = await getDoc(doc(db as never, 'user_cv_profiles', uid));
          if (refreshed.exists()) {
            record = { ...(refreshed.data() as Omit<UserCvProfileRecord, 'userId'>), userId: uid };
          }
        }
      } catch (error) {
        reportCaughtError(error, 'profileFirestore.refreshUserCvProfile', { type: 'api_error' });
      }
    }
    return record;
  } catch (error) {
    reportCaughtError(error, 'profileFirestore.loadUserCvProfile', { type: 'api_error' });
    return null;
  }
}
