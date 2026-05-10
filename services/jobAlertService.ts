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
  /**
   * Optional 2-letter Swiss canton ISO codes to scope the alert geographically
   * (e.g. `['TI']`, `['TI', 'GE']`). `null` or empty array = no geo filter
   * (default behaviour: alert across all 26 cantons). Cathedral CH-wide
   * expansion follow-up — see docs/CATHEDRAL-STATUS.md #12.
   */
  cantonFilter?: string[] | null;
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

/**
 * Normalise the canton filter for Firestore storage and matching:
 *  - `null` / `undefined` / empty array → `null` (= "all cantons").
 *  - Otherwise: uppercase, dedupe, drop blanks, sort for deterministic writes.
 *
 * Returning `null` keeps Firestore reads backwards-compatible with subscribers
 * created before the field existed.
 */
export function normalizeCantonFilter(
  input: string[] | null | undefined,
): string[] | null {
  if (!input || input.length === 0) return null;
  const cleaned = Array.from(
    new Set(
      input
        .map((c) => (typeof c === 'string' ? c.trim().toUpperCase() : ''))
        .filter((c) => c.length > 0),
    ),
  ).sort();
  return cleaned.length === 0 ? null : cleaned;
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
  const cantonFilter = normalizeCantonFilter(config.cantonFilter);
  const docData = {
    // Denormalized fields needed for collectionGroup queries + security rules.
    email: normalizedEmail,
    userId,
    // Search config.
    keywords: config.keywords,
    locations: config.locations,
    contractTypes: config.contractTypes,
    sectors: config.sectors,
    // Cathedral CH-wide geo scoping. `null` = no filter (covers all 26 cantons),
    // preserving legacy subscriber semantics.
    cantonFilter,
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
    cantonFilter,
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
      // Legacy subscribers (pre-cathedral) have no `cantonFilter` field;
      // surface them as `null` = "all cantons" so downstream consumers can
      // treat the field as a single optional gate.
      cantonFilter: normalizeCantonFilter(d.cantonFilter),
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
 * Normalize a free-form keyword/category string for stable comparison.
 * Lowercases, trims, strips combining diacritics (NFD), and collapses
 * internal whitespace to a single space.
 *
 * Used by:
 *  - `findMatchingAlertForCategory` (dedupe across surfaces).
 *  - `jobDetailAlertGating` (per-category cooldown key).
 */
export function normalizeKeyword(s: string): string {
  return (s || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim()
    .replace(/\s+/g, ' ');
}

/**
 * Find the first active alert whose `keywords[]` already covers the given
 * category. Comparison is case- and accent-insensitive (`normalizeKeyword`).
 * Returns `null` if no alert currently subscribes to the category.
 */
export function findMatchingAlertForCategory(
  alerts: JobAlert[],
  category: string,
): JobAlert | null {
  const target = normalizeKeyword(category);
  if (!target) return null;
  for (const alert of alerts) {
    if (!alert.active) continue;
    for (const kw of alert.keywords || []) {
      if (normalizeKeyword(kw) === target) return alert;
    }
  }
  return null;
}

/**
 * 1-tap subscribe helper for the job-detail prompt.
 *
 * Builds a canonical `JobAlertConfig` (keyword = localized category, weekly
 * frequency, no other filters) and forwards to `createAlert`. The max-3
 * active-alerts limit enforced by `createAlert` propagates to the caller.
 */
export async function subscribeJobAlertOneTap(
  userId: string,
  email: string,
  category: string,
  locale: 'it' | 'en' | 'de' | 'fr',
): Promise<JobAlert> {
  const config: JobAlertConfig = {
    keywords: [category.trim()],
    locations: [],
    contractTypes: [],
    sectors: [],
    cantonFilter: null,
    frequency: 'weekly',
    locale,
  };
  return createAlert(userId, email, config);
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
  // Use `in` so callers can deliberately clear the filter by passing
  // `cantonFilter: null` or `[]` (both normalise to `null`).
  if ('cantonFilter' in changes) {
    updateData.cantonFilter = normalizeCantonFilter(changes.cantonFilter);
  }
  if (changes.frequency) updateData.frequency = changes.frequency;
  if (changes.locale) updateData.locale = changes.locale;

  if (Object.keys(updateData).length > 0) {
    const ref = doc(db, SUBSCRIBERS_COLLECTION, normalizeEmail(email), ALERTS_SUBCOLLECTION, alertId);
    await updateDoc(ref, updateData);
  }
}
