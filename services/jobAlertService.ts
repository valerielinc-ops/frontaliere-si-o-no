/**
 * Job Alert Service — FRO-331
 *
 * Firestore-backed CRUD for job alerts.
 * Collection: `job_alerts/{alertId}`
 * Max 3 alerts per user to prevent spam.
 */

import type { Firestore } from 'firebase/firestore';

// ── Types ────────────────────────────────────────────────────

export interface JobAlertConfig {
  keywords: string[];
  locations: string[];
  contractTypes: string[];
  sectors: string[];
  frequency: 'daily' | 'weekly';
  locale: 'it' | 'en' | 'de' | 'fr';
}

export interface JobAlert extends JobAlertConfig {
  id: string;
  userId: string;
  email: string;
  active: boolean;
  createdAt: Date;
  lastMatchedAt: Date | null;
  matchCount: number;
}

// ── Constants ────────────────────────────────────────────────

const COLLECTION = 'job_alerts';
const MAX_ALERTS_PER_USER = 3;

// ── Lazy Firestore init ──────────────────────────────────────

let _db: Firestore | null = null;

async function getDb(): Promise<Firestore> {
  if (_db) return _db;
  const { getFirestore } = await import('firebase/firestore');
  const { getApp } = await import('./firebase');
  const app = await getApp();
  _db = getFirestore(app);
  return _db;
}

// ── CRUD ─────────────────────────────────────────────────────

/**
 * Create a new job alert for an authenticated user.
 * Enforces max 3 alerts per user.
 */
export async function createAlert(
  userId: string,
  email: string,
  config: JobAlertConfig,
): Promise<JobAlert> {
  const db = await getDb();
  const {
    collection,
    addDoc,
    query,
    where,
    getDocs,
    serverTimestamp,
  } = await import('firebase/firestore');

  // Enforce per-user limit
  const existingQ = query(
    collection(db, COLLECTION),
    where('userId', '==', userId),
    where('active', '==', true),
  );
  const existing = await getDocs(existingQ);
  if (existing.size >= MAX_ALERTS_PER_USER) {
    throw new Error(`Maximum ${MAX_ALERTS_PER_USER} active alerts per user.`);
  }

  const docData = {
    userId,
    email,
    keywords: config.keywords,
    locations: config.locations,
    contractTypes: config.contractTypes,
    sectors: config.sectors,
    frequency: config.frequency,
    locale: config.locale || 'it',
    active: true,
    createdAt: serverTimestamp(),
    lastMatchedAt: null,
    matchCount: 0,
  };

  const ref = await addDoc(collection(db, COLLECTION), docData);

  return {
    id: ref.id,
    userId,
    email,
    ...config,
    active: true,
    createdAt: new Date(),
    lastMatchedAt: null,
    matchCount: 0,
  };
}

/**
 * Get all active alerts for a user.
 */
export async function getUserAlerts(userId: string): Promise<JobAlert[]> {
  const db = await getDb();
  const { collection, query, where, getDocs, orderBy } = await import('firebase/firestore');

  const q = query(
    collection(db, COLLECTION),
    where('userId', '==', userId),
    where('active', '==', true),
    orderBy('createdAt', 'desc'),
  );

  const snap = await getDocs(q);
  return snap.docs.map((doc) => {
    const d = doc.data();
    return {
      id: doc.id,
      userId: d.userId,
      email: d.email,
      keywords: d.keywords || [],
      locations: d.locations || [],
      contractTypes: d.contractTypes || [],
      sectors: d.sectors || [],
      frequency: d.frequency || 'daily',
      locale: d.locale || 'it',
      active: d.active,
      createdAt: d.createdAt?.toDate?.() || new Date(d.createdAt),
      lastMatchedAt: d.lastMatchedAt?.toDate?.() || null,
      matchCount: d.matchCount || 0,
    } as JobAlert;
  });
}

/**
 * Soft-delete an alert (set active=false).
 * Only the owning user can delete their alerts — enforced by security rules.
 */
export async function deleteAlert(alertId: string): Promise<void> {
  const db = await getDb();
  const { doc, updateDoc } = await import('firebase/firestore');
  await updateDoc(doc(db, COLLECTION, alertId), { active: false });
}

/**
 * Update alert parameters.
 */
export async function updateAlert(
  alertId: string,
  changes: Partial<JobAlertConfig>,
): Promise<void> {
  const db = await getDb();
  const { doc, updateDoc } = await import('firebase/firestore');

  const updateData: Record<string, unknown> = {};
  if (changes.keywords) updateData.keywords = changes.keywords;
  if (changes.locations) updateData.locations = changes.locations;
  if (changes.contractTypes) updateData.contractTypes = changes.contractTypes;
  if (changes.sectors) updateData.sectors = changes.sectors;
  if (changes.frequency) updateData.frequency = changes.frequency;
  if (changes.locale) updateData.locale = changes.locale;

  if (Object.keys(updateData).length > 0) {
    await updateDoc(doc(db, COLLECTION, alertId), updateData);
  }
}
