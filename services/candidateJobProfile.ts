import type { UserCvProfileRecord } from '@/services/profileFirestore';

const MAX_PROFILE_CV_BYTES = 5 * 1024 * 1024;
const CV_CONTENT_TYPES: Record<string, string> = {
  pdf: 'application/pdf',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
};
const skillSaveQueues = new Map<string, Promise<void>>();

async function appForOwner(uid: string) {
  const [{ getApp }, { getAuth }] = await Promise.all([
    import('@/services/firebase'),
    import('firebase/auth'),
  ]);
  const app = await getApp();
  if (getAuth(app).currentUser?.uid !== uid) throw new Error('candidate_profile_owner_mismatch');
  return app;
}

async function callProfileFunction<T>(uid: string, name: string, data: Record<string, unknown>): Promise<T> {
  const { getFunctions, httpsCallable } = await import('firebase/functions');
  const app = await appForOwner(uid);
  const callable = httpsCallable<Record<string, unknown>, T>(getFunctions(app, 'europe-west6'), name);
  const response = await callable(data);
  return response.data;
}

/** `null` means no saved list exists; an empty array is an intentional blank list. */
export async function loadCandidateJobSkills(uid: string): Promise<string[] | null> {
  if (!uid) return null;
  try {
    const { doc, getDoc, getFirestore } = await import('firebase/firestore');
    const app = await appForOwner(uid);
    const snapshot = await getDoc(doc(getFirestore(app), 'candidate_job_profiles', uid));
    if (!snapshot.exists()) return null;
    const values = snapshot.data()?.skills;
    return Array.isArray(values)
      ? values.filter((value): value is string => typeof value === 'string').map((value) => value.trim()).filter(Boolean).slice(0, 40)
      : null;
  } catch {
    return null;
  }
}

export async function saveCandidateJobSkills(uid: string, skills: string[]): Promise<void> {
  const previous = skillSaveQueues.get(uid) || Promise.resolve();
  const next = previous
    .catch(() => undefined)
    .then(async () => {
      await callProfileFunction<{ saved: boolean }>(uid, 'saveCandidateJobProfileSkills', { skills });
    });
  skillSaveQueues.set(uid, next);
  const clearQueue = () => {
    if (skillSaveQueues.get(uid) === next) skillSaveQueues.delete(uid);
  };
  next.then(clearQueue, clearQueue);
  await next;
}

export async function uploadCandidateProfileCv(uid: string, file: File): Promise<{ status: string }> {
  const extension = file.name.split('.').pop()?.trim().toLowerCase() || '';
  const contentType = CV_CONTENT_TYPES[extension];
  if (!contentType) throw new Error('candidate_cv_unsupported_type');
  if (file.size <= 0 || file.size > MAX_PROFILE_CV_BYTES) throw new Error('candidate_cv_file_too_large');
  const app = await appForOwner(uid);
  const [{ getStorage, ref, uploadBytes }, { getFunctions, httpsCallable }] = await Promise.all([
    import('firebase/storage'),
    import('firebase/functions'),
  ]);
  const sourceId = globalThis.crypto?.randomUUID?.();
  if (!sourceId) throw new Error('candidate_cv_upload_unavailable');
  const storageKey = `candidate-cv-profiles/${uid}/${sourceId}`;
  await uploadBytes(ref(getStorage(app), storageKey), file, { contentType });
  const callable = httpsCallable<
    { storageKey: string; sourceId: string; fileName: string },
    { status: string }
  >(getFunctions(app, 'europe-west6'), 'processCandidateCvProfileUpload');
  try {
    const response = await callable({ storageKey, sourceId, fileName: file.name });
    return response.data;
  } catch (error) {
    try {
      const discard = httpsCallable<{ sourceId: string }, { deleted: boolean }>(
        getFunctions(app, 'europe-west6'),
        'discardCandidateCvProfileUpload',
      );
      await discard({ sourceId });
    } catch {
      // The callable also removes rejected objects; this retry covers a lost finalize response.
    }
    throw error;
  }
}

export async function setCandidateCvJobAlertPersonalization(uid: string, enabled: boolean): Promise<void> {
  await callProfileFunction<{ enabled: boolean }>(uid, 'setCandidateCvJobAlertPersonalization', { enabled });
}

export async function deleteCandidateProfileCv(uid: string): Promise<void> {
  const result = await callProfileFunction<{ deleted: boolean }>(uid, 'deleteCandidateCvProfile', {});
  if (!result.deleted) throw new Error('candidate_cv_delete_unavailable');
}

export function cvSkillsFromProfile(profile: UserCvProfileRecord | null): string[] {
  const parsed = profile?.profile;
  const skills = Array.isArray(parsed?.skills) ? parsed.skills : [];
  const languages = Array.isArray(parsed?.languages) ? parsed.languages : [];
  return [...skills, ...languages]
    .filter((skill): skill is string => typeof skill === 'string' && Boolean(skill.trim()))
    .map((skill) => skill.trim())
    .filter((skill, index, list) => list.findIndex((candidate) => candidate.toLocaleLowerCase() === skill.toLocaleLowerCase()) === index)
    .slice(0, 40);
}
