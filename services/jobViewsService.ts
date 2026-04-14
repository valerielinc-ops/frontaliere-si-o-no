/**
 * Job Page View Tracking — Firestore-backed view counter
 *
 * Same pattern as article_views in BlogArticles.tsx.
 * Collection: `job_views`, document key: job slug.
 * Debounced: max 1 increment per session per slug via sessionStorage.
 */

import type { Firestore } from 'firebase/firestore';

let _db: Firestore | null = null;
let _dbInit = false;

/**
 * Track a view for a job page. Non-blocking, fire-and-forget.
 * Debounces via sessionStorage so each slug counts once per session.
 */
export async function trackJobView(slug: string): Promise<void> {
 if (!slug) return;

 // Session debounce — one view per slug per browser session
 const key = `jv_${slug}`;
 try {
 if (sessionStorage.getItem(key)) return;
 sessionStorage.setItem(key, '1');
 } catch {
 // sessionStorage unavailable — proceed anyway (no debounce)
 }

 try {
 if (!_dbInit) {
 _dbInit = true;
 const { getFirestore } = await import('firebase/firestore');
 const { app } = await import('@/services/firebase');
 _db = getFirestore(app);
 }
 if (!_db) return;

 const { doc, setDoc, increment } = await import('firebase/firestore');
 await setDoc(
 doc(_db, 'job_views', slug),
 { views: increment(1), lastViewed: new Date() },
 { merge: true },
 );
 } catch {
 // Non-blocking — never break job page loading
 }
}
