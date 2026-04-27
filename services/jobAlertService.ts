/**
 * Job Alert Service — FRO-331
 *
 * Firestore-backed CRUD for job alerts.
 *
 * Storage layout (mirrors `newsletter_subscribers` pattern):
 *   job_alert_subscribers/{email}                ← root doc, aggregate counters
 *     ├─ alerts/{alertId}                         ← search configurations (this service)
 *     ├─ alert_deliveries/{alertId}               ← per-alert delivery state (ESP webhooks)
 *     └─ events/{auto-id}                         ← raw ESP event log (ESP webhooks)
 *
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

const SUBSCRIBERS_COLLECTION = 'job_alert_subscribers';
const ALERTS_SUBCOLLECTION = 'alerts';
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

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

// ── CRUD ─────────────────────────────────────────────────────

/**
 * Create a new job alert for an authenticated user.
 *
 * Writes:
 *  - `job_alert_subscribers/{email}` — merge: ensures parent doc exists with email + userId
 *  - `job_alert_subscribers/{email}/alerts/{alertId}` — the search configuration
 *
 * Enforces max 3 active alerts per user.
 */
export async function createAlert(
  userId: string,
  email: string,
  config: JobAlertConfig,
): Promise<JobAlert> {
  const db = await getDb();
  const {
    collectionGroup,
    collection,
    addDoc,
    doc,
    setDoc,
    query,
    where,
    getDocs,
    serverTimestamp,
  } = await import('firebase/firestore');

  const normalizedEmail = normalizeEmail(email);

  // Enforce per-user limit across all subscriber docs.
  const existingQ = query(
    collectionGroup(db, ALERTS_SUBCOLLECTION),
    where('userId', '==', userId),
    where('active', '==', true),
  );
  const existing = await getDocs(existingQ);
  if (existing.size >= MAX_ALERTS_PER_USER) {
    throw new Error(`Maximum ${MAX_ALERTS_PER_USER} active alerts per user.`);
  }

  // Ensure the parent subscriber doc exists.
  const subscriberRef = doc(db, SUBSCRIBERS_COLLECTION, normalizedEmail);
  await setDoc(
    subscriberRef,
    {
      email: normalizedEmail,
      userId,
      locale: config.locale || 'it',
      updated_at: serverTimestamp(),
      created_at: serverTimestamp(),
    },
    { merge: true },
  );

  // Write the alert as a subdocument.
  const alertsRef = collection(subscriberRef, ALERTS_SUBCOLLECTION);
  const docData = {
    // Denormalized fields needed for collectionGroup queries + security rules.
    email: normalizedEmail,
    userId,
    // Search config.
    keywords: config.keywords,
    locations: config.locations,
    contractTypes: config.contractTypes,
    sectors: config.sectors,
    frequency: config.frequency,
    locale: config.locale || 'it',
    // State.
    active: true,
    createdAt: serverTimestamp(),
    lastMatchedAt: null,
    matchCount: 0,
  };
  const ref = await addDoc(alertsRef, docData);

  return {
    id: ref.id,
    userId,
    email: normalizedEmail,
    ...config,
    active: true,
    createdAt: new Date(),
    lastMatchedAt: null,
    matchCount: 0,
  };
}

/**
 * Get all active alerts for a user across all subscriber docs.
 * Uses a collectionGroup query — requires a composite index on
 * (userId ASC, active ASC, createdAt DESC) for `alerts`.
 */
export async function getUserAlerts(userId: string): Promise<JobAlert[]> {
  const db = await getDb();
  const { collectionGroup, query, where, getDocs, orderBy } = await import('firebase/firestore');

  const q = query(
    collectionGroup(db, ALERTS_SUBCOLLECTION),
    where('userId', '==', userId),
    where('active', '==', true),
    orderBy('createdAt', 'desc'),
  );

  const snap = await getDocs(q);
  return snap.docs.map((docSnap) => {
    const d = docSnap.data();
    // Parent doc id is the email — use it as fallback if denormalized field is missing.
    const parentEmail = docSnap.ref.parent.parent?.id || '';
    return {
      id: docSnap.id,
      userId: d.userId,
      email: d.email || parentEmail,
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
export async function deleteAlert(email: string, alertId: string): Promise<void> {
  const db = await getDb();
  const { doc, updateDoc, serverTimestamp } = await import('firebase/firestore');
  const ref = doc(db, SUBSCRIBERS_COLLECTION, normalizeEmail(email), ALERTS_SUBCOLLECTION, alertId);
  await updateDoc(ref, {
    active: false,
    unsubscribed_at: serverTimestamp(),
    unsubscribe_source: 'profile_ui',
  });
}

/**
 * Update alert parameters.
 */
export async function updateAlert(
  email: string,
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
    const ref = doc(db, SUBSCRIBERS_COLLECTION, normalizeEmail(email), ALERTS_SUBCOLLECTION, alertId);
    await updateDoc(ref, updateData);
  }
}
