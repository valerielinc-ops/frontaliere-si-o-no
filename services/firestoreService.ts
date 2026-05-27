/**
 * Firestore Service
 * Cloud persistence for Dashboard simulations and Forum Q&A
 */

import type {
 Timestamp,
 Firestore,
} from 'firebase/firestore';
import { SimulationInputs, SimulationResult } from '@/types';
import { reportCaughtError } from '@/services/errorReporter';

// ─── Firestore dynamic lazy-import (keeps firebase/firestore out of the main bundle) ──

let _fs: typeof import('firebase/firestore') | null = null;

async function fs() {
 if (!_fs) _fs = await import('firebase/firestore');
 return _fs;
}

// ─── Firestore Init ──────────────────────────────────────────

let db: Firestore | null = null;
const SOCIAL_PROOF_COUNTED_KEY = 'ft_social_proof_counted_v1';

/**
 * Detect if an error is caused by iOS Safari IndexedDB connection loss.
 * When this happens, the cached Firestore instance is stale and must be
 * discarded so the next call creates a fresh connection.
 */
function isIndexedDbError(error: unknown): boolean {
 const msg = error instanceof Error ? error.message : String(error || '');
 return msg.includes('Indexed Database') || msg.includes('IDBDatabase')
 || msg.includes('IndexedDB') || msg.includes('internal error was encountered');
}

/** Discard the cached Firestore instance to force a fresh connection on next call. */
export function resetFirestoreConnection(): void {
 db = null;
}

async function getDb(): Promise<Firestore> {
 if (!db) {
 const [{ getApp }, { getFirestore }] = await Promise.all([
 import('@/services/firebase'),
 fs(),
 ]);
 db = getFirestore(await getApp());
 }
 return db;
}

// ─── Social proof counter ────────────────────────────────────

/**
 * Registers one "simulator user" for social proof.
 * We count once per browser storage to avoid inflating totals
 * from every automatic recalculation on input changes.
 */
export async function registerSimulationForSocialProof(): Promise<void> {
 if (typeof window === 'undefined') return;

 try {
 if (localStorage.getItem(SOCIAL_PROOF_COUNTED_KEY) === '1') return;
 } catch {
 // If storage is blocked, skip safely.
 return;
 }

 try {
 const [db, f] = await Promise.all([getDb(), fs()]);
 const counterRef = f.doc(db, 'counters', 'simulations');
 await f.setDoc(counterRef, {
 total: f.increment(1),
 updatedAt: f.serverTimestamp(),
 }, { merge: true });
 localStorage.setItem(SOCIAL_PROOF_COUNTED_KEY, '1');
 } catch (e) {
 reportCaughtError(e, 'firestore.socialProofCounter', { apiEndpoint: 'counters/simulations' });
 }
}

// ─── Dashboard: Saved Simulations ────────────────────────────

export interface CloudSimulation {
 id: string;
 userId: string;
 date: string;
 label: string;
 inputs: SimulationInputs;
 result: SimulationResult;
 createdAt?: any;
}

export async function saveSimulationToCloud(
 userId: string,
 sim: { date: string; label: string; inputs: SimulationInputs; result: SimulationResult }
): Promise<string> {
 const [db, f] = await Promise.all([getDb(), fs()]);
 const ref = await f.addDoc(f.collection(db, 'simulations'), {
 userId,
 date: sim.date,
 label: sim.label,
 inputs: sim.inputs,
 result: sim.result,
 createdAt: f.serverTimestamp(),
 });
 return ref.id;
}

export async function loadSimulationsFromCloud(userId: string): Promise<CloudSimulation[]> {
 const [db, f] = await Promise.all([getDb(), fs()]);
 const q = f.query(
 f.collection(db, 'simulations'),
 f.where('userId', '==', userId),
 f.orderBy('createdAt', 'desc'),
 f.limit(50)
 );
 const snap = await f.getDocs(q);
 return snap.docs.map(d => ({ id: d.id, ...d.data() } as CloudSimulation));
}

export async function deleteSimulationFromCloud(simId: string): Promise<void> {
 const [db, f] = await Promise.all([getDb(), fs()]);
 await f.deleteDoc(f.doc(db, 'simulations', simId));
}

// ─── Forum: Questions & Answers ──────────────────────────────

export interface ForumQuestion {
 id: string;
 title: string;
 body: string;
 authorId: string;
 authorName: string;
 authorPhoto: string | null;
 category: string;
 tags: string[];
 upvotes: number;
 upvotedBy: string[];
 answerCount: number;
 createdAt: Timestamp | null;
 updatedAt: Timestamp | null;
}

export interface ForumAnswer {
 id: string;
 questionId: string;
 body: string;
 authorId: string;
 authorName: string;
 authorPhoto: string | null;
 upvotes: number;
 upvotedBy: string[];
 accepted: boolean;
 createdAt: Timestamp | null;
}

export const FORUM_CATEGORIES = [
 'fiscalita', // Fisco e Tasse
 'permessi', // Permessi di Lavoro
 'assicurazioni', // Assicurazioni (LAMal, Malattia)
 'pensione', // AVS, LPP, Pensione
 'trasporti', // Trasporti e Valichi
 'residenza', // Residenza e Trasloco
 'lavoro', // Lavoro e Contratti
 'famiglia', // Famiglia e Figli
 'generale', // Generale
] as const;

export type ForumCategory = typeof FORUM_CATEGORIES[number];

// ─── Forum: Question CRUD ────────────────────────────────────

export async function createQuestion(data: {
 title: string;
 body: string;
 authorId: string;
 authorName: string;
 authorPhoto: string | null;
 category: ForumCategory;
 tags: string[];
}): Promise<string> {
 const [db, f] = await Promise.all([getDb(), fs()]);
 const ref = await f.addDoc(f.collection(db, 'forum_questions'), {
 ...data,
 upvotes: 0,
 upvotedBy: [],
 answerCount: 0,
 createdAt: f.serverTimestamp(),
 updatedAt: f.serverTimestamp(),
 });
 return ref.id;
}

export async function getQuestions(opts?: {
 category?: ForumCategory;
 sortBy?: 'recent' | 'popular';
 maxResults?: number;
}): Promise<ForumQuestion[]> {
 const [db, f] = await Promise.all([getDb(), fs()]);
 const constraints: any[] = [];

 if (opts?.category) {
 constraints.push(f.where('category', '==', opts.category));
 }

 if (opts?.sortBy === 'popular') {
 constraints.push(f.orderBy('upvotes', 'desc'));
 } else {
 constraints.push(f.orderBy('createdAt', 'desc'));
 }

 constraints.push(f.limit(opts?.maxResults || 30));

 const q = f.query(f.collection(db, 'forum_questions'), ...constraints);
 const snap = await f.getDocs(q);
 return snap.docs.map(d => ({ id: d.id, ...d.data() } as ForumQuestion));
}

export async function getQuestion(questionId: string): Promise<ForumQuestion | null> {
 const [db, f] = await Promise.all([getDb(), fs()]);
 const snap = await f.getDoc(f.doc(db, 'forum_questions', questionId));
 if (!snap.exists()) return null;
 return { id: snap.id, ...snap.data() } as ForumQuestion;
}

export async function upvoteQuestion(questionId: string, userId: string): Promise<void> {
 const [db, f] = await Promise.all([getDb(), fs()]);
 const ref = f.doc(db, 'forum_questions', questionId);
 const snap = await f.getDoc(ref);
 if (!snap.exists()) return;

 const data = snap.data();
 const already = (data.upvotedBy || []).includes(userId);

 if (already) {
 // Remove upvote
 await f.updateDoc(ref, {
 upvotes: f.increment(-1),
 upvotedBy: (data.upvotedBy || []).filter((id: string) => id !== userId),
 });
 } else {
 // Add upvote
 await f.updateDoc(ref, {
 upvotes: f.increment(1),
 upvotedBy: [...(data.upvotedBy || []), userId],
 });
 }
}

// ─── Forum: Answer CRUD ──────────────────────────────────────

export async function createAnswer(data: {
 questionId: string;
 body: string;
 authorId: string;
 authorName: string;
 authorPhoto: string | null;
}): Promise<string> {
 const [db, f] = await Promise.all([getDb(), fs()]);
 const ref = await f.addDoc(f.collection(db, 'forum_answers'), {
 ...data,
 upvotes: 0,
 upvotedBy: [],
 accepted: false,
 createdAt: f.serverTimestamp(),
 });

 // Increment answer count on question
 const qRef = f.doc(db, 'forum_questions', data.questionId);
 await f.updateDoc(qRef, {
 answerCount: f.increment(1),
 updatedAt: f.serverTimestamp(),
 });

 return ref.id;
}

export async function getAnswers(questionId: string): Promise<ForumAnswer[]> {
 const [db, f] = await Promise.all([getDb(), fs()]);
 const q = f.query(
 f.collection(db, 'forum_answers'),
 f.where('questionId', '==', questionId),
 f.orderBy('createdAt', 'asc'),
 f.limit(100)
 );
 const snap = await f.getDocs(q);
 return snap.docs.map(d => ({ id: d.id, ...d.data() } as ForumAnswer));
}

export async function upvoteAnswer(answerId: string, userId: string): Promise<void> {
 const [db, f] = await Promise.all([getDb(), fs()]);
 const ref = f.doc(db, 'forum_answers', answerId);
 const snap = await f.getDoc(ref);
 if (!snap.exists()) return;

 const data = snap.data();
 const already = (data.upvotedBy || []).includes(userId);

 if (already) {
 await f.updateDoc(ref, {
 upvotes: f.increment(-1),
 upvotedBy: (data.upvotedBy || []).filter((id: string) => id !== userId),
 });
 } else {
 await f.updateDoc(ref, {
 upvotes: f.increment(1),
 upvotedBy: [...(data.upvotedBy || []), userId],
 });
 }
}

export async function acceptAnswer(answerId: string): Promise<void> {
 const [db, f] = await Promise.all([getDb(), fs()]);
 await f.updateDoc(f.doc(db, 'forum_answers', answerId), { accepted: true });
}
