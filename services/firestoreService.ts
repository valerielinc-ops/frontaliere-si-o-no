/**
 * Firestore Service
 * Cloud persistence for Dashboard simulations and Forum Q&A
 */

import {
  getFirestore,
  collection,
  doc,
  getDocs,
  getDoc,
  addDoc,
  updateDoc,
  deleteDoc,
  query,
  where,
  orderBy,
  limit,
  increment,
  serverTimestamp,
  Timestamp,
  Firestore,
} from 'firebase/firestore';
import { app } from '@/services/firebase';
import { SimulationInputs, SimulationResult } from '@/types';

// ─── Firestore Init ──────────────────────────────────────────

let db: Firestore | null = null;

function getDb(): Firestore {
  if (!db) {
    db = getFirestore(app);
  }
  return db;
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
  const db = getDb();
  const ref = await addDoc(collection(db, 'simulations'), {
    userId,
    date: sim.date,
    label: sim.label,
    inputs: sim.inputs,
    result: sim.result,
    createdAt: serverTimestamp(),
  });
  return ref.id;
}

export async function loadSimulationsFromCloud(userId: string): Promise<CloudSimulation[]> {
  const db = getDb();
  const q = query(
    collection(db, 'simulations'),
    where('userId', '==', userId),
    orderBy('createdAt', 'desc'),
    limit(50)
  );
  const snap = await getDocs(q);
  return snap.docs.map(d => ({ id: d.id, ...d.data() } as CloudSimulation));
}

export async function deleteSimulationFromCloud(simId: string): Promise<void> {
  const db = getDb();
  await deleteDoc(doc(db, 'simulations', simId));
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
  'fiscalita',       // Fisco e Tasse
  'permessi',        // Permessi di Lavoro
  'assicurazioni',   // Assicurazioni (LAMal, Malattia)
  'pensione',        // AVS, LPP, Pensione
  'trasporti',       // Trasporti e Valichi
  'residenza',       // Residenza e Trasloco
  'lavoro',          // Lavoro e Contratti
  'famiglia',        // Famiglia e Figli
  'generale',        // Generale
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
  const db = getDb();
  const ref = await addDoc(collection(db, 'forum_questions'), {
    ...data,
    upvotes: 0,
    upvotedBy: [],
    answerCount: 0,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });
  return ref.id;
}

export async function getQuestions(opts?: {
  category?: ForumCategory;
  sortBy?: 'recent' | 'popular';
  maxResults?: number;
}): Promise<ForumQuestion[]> {
  const db = getDb();
  const constraints: any[] = [];

  if (opts?.category) {
    constraints.push(where('category', '==', opts.category));
  }

  if (opts?.sortBy === 'popular') {
    constraints.push(orderBy('upvotes', 'desc'));
  } else {
    constraints.push(orderBy('createdAt', 'desc'));
  }

  constraints.push(limit(opts?.maxResults || 30));

  const q = query(collection(db, 'forum_questions'), ...constraints);
  const snap = await getDocs(q);
  return snap.docs.map(d => ({ id: d.id, ...d.data() } as ForumQuestion));
}

export async function getQuestion(questionId: string): Promise<ForumQuestion | null> {
  const db = getDb();
  const snap = await getDoc(doc(db, 'forum_questions', questionId));
  if (!snap.exists()) return null;
  return { id: snap.id, ...snap.data() } as ForumQuestion;
}

export async function upvoteQuestion(questionId: string, userId: string): Promise<void> {
  const db = getDb();
  const ref = doc(db, 'forum_questions', questionId);
  const snap = await getDoc(ref);
  if (!snap.exists()) return;

  const data = snap.data();
  const already = (data.upvotedBy || []).includes(userId);

  if (already) {
    // Remove upvote
    await updateDoc(ref, {
      upvotes: increment(-1),
      upvotedBy: (data.upvotedBy || []).filter((id: string) => id !== userId),
    });
  } else {
    // Add upvote
    await updateDoc(ref, {
      upvotes: increment(1),
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
  const db = getDb();
  const ref = await addDoc(collection(db, 'forum_answers'), {
    ...data,
    upvotes: 0,
    upvotedBy: [],
    accepted: false,
    createdAt: serverTimestamp(),
  });

  // Increment answer count on question
  const qRef = doc(db, 'forum_questions', data.questionId);
  await updateDoc(qRef, {
    answerCount: increment(1),
    updatedAt: serverTimestamp(),
  });

  return ref.id;
}

export async function getAnswers(questionId: string): Promise<ForumAnswer[]> {
  const db = getDb();
  const q = query(
    collection(db, 'forum_answers'),
    where('questionId', '==', questionId),
    orderBy('createdAt', 'asc'),
    limit(100)
  );
  const snap = await getDocs(q);
  return snap.docs.map(d => ({ id: d.id, ...d.data() } as ForumAnswer));
}

export async function upvoteAnswer(answerId: string, userId: string): Promise<void> {
  const db = getDb();
  const ref = doc(db, 'forum_answers', answerId);
  const snap = await getDoc(ref);
  if (!snap.exists()) return;

  const data = snap.data();
  const already = (data.upvotedBy || []).includes(userId);

  if (already) {
    await updateDoc(ref, {
      upvotes: increment(-1),
      upvotedBy: (data.upvotedBy || []).filter((id: string) => id !== userId),
    });
  } else {
    await updateDoc(ref, {
      upvotes: increment(1),
      upvotedBy: [...(data.upvotedBy || []), userId],
    });
  }
}

export async function acceptAnswer(answerId: string): Promise<void> {
  const db = getDb();
  await updateDoc(doc(db, 'forum_answers', answerId), { accepted: true });
}
