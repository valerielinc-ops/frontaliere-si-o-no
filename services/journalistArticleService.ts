/**
 * Journalist publishing portal — client-side Firestore/Storage access.
 *
 * Mirrors services/publisherAnalyticsService.ts's lazy dynamic-import pattern
 * (keeps `firebase/firestore` / `firebase/storage` out of the main bundle).
 * All writes go through firestore.rules' `journalist_articles` guard —
 * a journalist may only ever write status 'draft' or 'queued'; the
 * transition to 'published'/'failed' is Admin-SDK-only (see
 * scripts/publish-journalist-article.mjs).
 */

import type { Firestore } from 'firebase/firestore';
import type { FirebaseStorage } from 'firebase/storage';
import type { JournalistArticle, JournalistArticleLocaleContent, JournalistArticleCategory } from '@/services/journalistTypes';

let _db: Firestore | null = null;
let _storage: FirebaseStorage | null = null;

async function db(): Promise<Firestore> {
  if (!_db) {
    const { getFirestore } = await import('firebase/firestore');
    const { getApp } = await import('@/services/firebase');
    _db = getFirestore(await getApp());
  }
  return _db;
}

async function storage(): Promise<FirebaseStorage> {
  if (!_storage) {
    const { getStorage } = await import('firebase/storage');
    const { getApp } = await import('@/services/firebase');
    _storage = getStorage(await getApp());
  }
  return _storage;
}

/** Kebab-case slug from a title, matching the pipeline's article-id convention. */
export function slugifyArticleTitle(title: string): string {
  return title
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 80)
    .replace(/-+$/, '');
}

export interface NewDraftInput {
  id: string;
  authorUid: string;
  authorName: string;
  authorEmail: string;
  category: JournalistArticleCategory;
  imageAlt: string;
  content: JournalistArticleLocaleContent;
}

/** Creates a new draft. Throws if an article with this id already exists (checked client-side; the pipeline re-checks server-side before publish). */
export async function createDraft(input: NewDraftInput): Promise<void> {
  const { doc, getDoc, setDoc } = await import('firebase/firestore');
  const database = await db();
  const ref = doc(database, 'journalist_articles', input.id);
  const existing = await getDoc(ref);
  if (existing.exists()) {
    throw new Error(`article-id-taken:${input.id}`);
  }
  const now = new Date().toISOString();
  const article: JournalistArticle = {
    id: input.id,
    authorUid: input.authorUid,
    authorName: input.authorName,
    authorEmail: input.authorEmail,
    category: input.category,
    image: '',
    imageAlt: input.imageAlt,
    content: { it: input.content },
    status: 'draft',
    createdAt: now,
    updatedAt: now,
  };
  await setDoc(ref, article);
}

/** Updates an existing draft/failed article's editable fields. Does not change status. */
export async function saveDraft(
  id: string,
  patch: Partial<Pick<JournalistArticle, 'category' | 'image' | 'imageAlt'>> & {
    content?: JournalistArticleLocaleContent;
  },
): Promise<void> {
  const { doc, updateDoc } = await import('firebase/firestore');
  const database = await db();
  const update: Record<string, unknown> = { ...patch, updatedAt: new Date().toISOString() };
  if (patch.content) {
    update.content = { it: patch.content };
    delete update['content.it'];
  }
  await updateDoc(doc(database, 'journalist_articles', id), update);
}

/** Submits a draft (or a previously-failed article) for publishing: status -> 'queued'. Picked up by the scheduled publish-journalist-article.mjs run. */
export async function submitForPublish(id: string): Promise<void> {
  const { doc, updateDoc } = await import('firebase/firestore');
  const database = await db();
  await updateDoc(doc(database, 'journalist_articles', id), {
    status: 'queued',
    submittedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    errorMessage: null,
  });
}

/** Deletes a never-submitted draft. */
export async function deleteDraft(id: string): Promise<void> {
  const { doc, deleteDoc } = await import('firebase/firestore');
  const database = await db();
  await deleteDoc(doc(database, 'journalist_articles', id));
}

/** Lists all articles authored by this uid, newest first. */
export async function listMyArticles(uid: string): Promise<JournalistArticle[]> {
  const { collection, query, where, orderBy, getDocs } = await import('firebase/firestore');
  const database = await db();
  const snap = await getDocs(
    query(collection(database, 'journalist_articles'), where('authorUid', '==', uid), orderBy('updatedAt', 'desc')),
  );
  return snap.docs.map((d) => d.data() as JournalistArticle);
}

export async function getArticle(id: string): Promise<JournalistArticle | null> {
  const { doc, getDoc } = await import('firebase/firestore');
  const database = await db();
  const snap = await getDoc(doc(database, 'journalist_articles', id));
  return snap.exists() ? (snap.data() as JournalistArticle) : null;
}

/** Uploads (or replaces) the hero image for a draft and returns its download URL. Caller still needs to persist it via saveDraft(). */
export async function uploadArticleImage(uid: string, articleId: string, file: File): Promise<string> {
  const { ref, uploadBytes, getDownloadURL } = await import('firebase/storage');
  const store = await storage();
  const ext = (file.name.split('.').pop() || 'jpg').toLowerCase();
  const path = `journalist-uploads/${uid}/${articleId}/image.${ext}`;
  const fileRef = ref(store, path);
  await uploadBytes(fileRef, file, { contentType: file.type || 'image/jpeg' });
  return getDownloadURL(fileRef);
}
