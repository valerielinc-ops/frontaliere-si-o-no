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
  /**
   * Sticky manual pin (owner design 2026-07-16): when `true`, `frequency`
   * above is authoritative and `scripts/lib/jobAlertEngagementTier.mjs`
   * never touches this alert's send cadence. When `false`/absent, the
   * engagement engine decides the effective cadence (daily/36h/weekly)
   * from the subscriber's own open/click recency at send time.
   */
  frequencyOverride?: boolean;
  locale: 'it' | 'en' | 'de' | 'fr';
  /**
   * Provenance of a one-tap subscription: the job-detail page the user was on
   * when they subscribed. Optional — only set by `subscribeJobAlertOneTap` (the
   * job-detail prompt). Stored for later funnel analysis (which job / category
   * drives subscriptions), NOT used for matching. `sourceJobSlug` is the URL
   * slug, `sourceJobUrl` the full canonical URL, `sourceJobTitle` the job title.
   */
  sourceJobSlug?: string | null;
  sourceJobUrl?: string | null;
  sourceJobTitle?: string | null;
  /**
   * Job-specific scope ("notify me about THIS job / this employer"). When set,
   * the matcher (services/jobAlertMatching.mjs) HARD-filters to the pinned
   * job id(s) / companyKey, ignoring keyword/location scoring. `specificJobId`
   * accepts the stable job id (e.g. a publisher ad's `pub-…` id);
   * `specificCompanyKey` pins to one employer. Both null = a normal alert.
   */
  specificJobId?: string | null;
  specificCompanyKey?: string | null;
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
export const MAX_ALERTS_PER_USER = 3;

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
    orderBy,
    getDocs,
    serverTimestamp,
  } = await import('firebase/firestore');

  const normalizedEmail = normalizeEmail(email);

  // Enforce per-user limit across all subscriber docs.
  // NOTE: the `orderBy('createdAt', 'desc')` is REQUIRED, not cosmetic — it makes
  // this collectionGroup query reuse the deployed composite index
  // (userId ASC, active ASC, createdAt DESC), identical to getUserAlerts below.
  // Without it the equality-only query needs a separate (userId, active) index
  // that was never deployed (firestore.indexes.json is not applied by CI —
  // deploy-firestore-rules.yml ships `firestore:rules` only), so getDocs threw
  // FAILED_PRECONDITION ("query requires an index") and createAlert aborted
  // before writing — surfacing as the "Non sono riuscito a creare l'alert" toast
  // for every newsletter/autologin user (the exact target of the job-detail prompt).
  const existingQ = query(
    collectionGroup(db, ALERTS_SUBCOLLECTION),
    where('userId', '==', userId),
    where('active', '==', true),
    orderBy('createdAt', 'desc'),
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
    frequencyOverride: config.frequencyOverride === true,
    locale: config.locale || 'it',
    // Provenance (one-tap subscriptions from the job-detail prompt). Only
    // written when provided — Firestore rejects `undefined`, so default to null.
    sourceJobSlug: config.sourceJobSlug ?? null,
    sourceJobUrl: config.sourceJobUrl ?? null,
    sourceJobTitle: config.sourceJobTitle ?? null,
    // Job-specific scope (per-job / per-employer alert). null = normal alert.
    specificJobId: config.specificJobId ?? null,
    specificCompanyKey: config.specificCompanyKey ?? null,
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
    frequencyOverride: config.frequencyOverride === true,
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
      // Legacy alerts (pre-adaptive-frequency) have no `frequencyOverride`
      // field — absent means engine-managed, not manually pinned.
      frequencyOverride: d.frequencyOverride === true,
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
 * Strip emoji / pictographs (and their variation selectors + ZWJ) from a
 * keyword, preserving case and the textual label. Category labels surface as
 * e.g. "💻 Tecnologia"; the emoji must NOT end up in the stored keyword because
 * `matchJobToAlert` (scripts/send-job-alerts.mjs) matches keywords as a
 * substring of the job title/description — and no job text contains "💻", so an
 * emoji-prefixed keyword would match zero jobs and the alert would never fire.
 */
export function stripKeywordEmoji(s: string): string {
  // `\p{Extended_Pictographic}` covers every emoji pictograph (future-proof vs
  // hand-maintained codepoint ranges, which missed e.g. ⭐ U+2B50, ❤️ U+2764) —
  // plus variation selectors (U+FE0F) and the ZWJ (U+200D) that glue compound
  // emoji. A category label gaining a new emoji must never re-introduce the
  // zero-match failure this strip prevents.
  return (s || '')
    .replace(/[\p{Extended_Pictographic}\u{FE00}-\u{FE0F}\u{200D}]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Normalize a free-form keyword/category string for stable comparison.
 * Strips emoji, lowercases, trims, strips combining diacritics (NFD), and
 * collapses internal whitespace to a single space.
 *
 * Emoji stripping keeps comparison consistent with the stored (emoji-free)
 * keyword: dedupe (`findMatchingAlertForCategory`) and the per-category gating
 * key must treat "💻 Tecnologia" and "Tecnologia" as the same category.
 *
 * Used by:
 *  - `findMatchingAlertForCategory` (dedupe across surfaces).
 *  - `jobDetailAlertGating` (per-category cooldown key).
 */
export function normalizeKeyword(s: string): string {
  return stripKeywordEmoji(s)
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
 * Provenance of a one-tap subscription — the job the user was viewing when they
 * tapped "Sì, attiva" on the job-detail prompt. Stored for funnel analysis.
 */
export interface JobAlertSource {
  slug?: string | null;
  url?: string | null;
  title?: string | null;
}

/**
 * 1-tap subscribe helper for the job-detail prompt AND the job-match profile
 * CTA (JobBoard.tsx, issue #3650 — "Avvisami per ruoli come questo").
 *
 * Builds a canonical `JobAlertConfig` (keyword = emoji-stripped category, weekly
 * frequency) and forwards to `createAlert`. The max-3 active-alerts limit
 * enforced by `createAlert` propagates to the caller.
 *
 * The category label carries a leading emoji (e.g. "💻 Tecnologia"); it is
 * stripped via `stripKeywordEmoji` so the stored keyword can actually match job
 * text (see that helper). `source` records which job drove the subscription
 * (omitted by the job-match CTA, which isn't tied to one specific job).
 *
 * `cantonCode` optionally hard-scopes the alert to a canton (validated 2-letter
 * ISO code — see `services/cantonList.ts:CANTON_CODES`) when the caller already
 * has a real canton signal, e.g. the job-match profile's `canton` field
 * (`services/jobMatchProfile.ts`). Omitted/null for the job-detail prompt,
 * which has no canton signal to pre-fill from.
 */
export async function subscribeJobAlertOneTap(
  userId: string,
  email: string,
  category: string,
  locale: 'it' | 'en' | 'de' | 'fr',
  source?: JobAlertSource,
  cantonCode?: string | null,
): Promise<JobAlert> {
  const config: JobAlertConfig = {
    keywords: [stripKeywordEmoji(category)],
    locations: [],
    contractTypes: [],
    sectors: [],
    cantonFilter: cantonCode ? [cantonCode] : null,
    frequency: 'weekly',
    locale,
    sourceJobSlug: source?.slug ?? null,
    sourceJobUrl: source?.url ?? null,
    sourceJobTitle: source?.title ?? null,
  };
  return createAlert(userId, email, config);
}

/**
 * 1-tap subscribe helper for a SPECIFIC job ("Avvisami per questo annuncio").
 *
 * Pins the alert to a single job id via `specificJobId` so the matcher
 * (services/jobAlertMatching.mjs) HARD-filters to that exact job (the `pub-…`
 * id of a publisher / sponsored ad), bypassing keyword/location scoring. No
 * keyword/location/sector filters are set — the pin IS the scope. The max-3
 * active-alerts limit enforced by `createAlert` propagates to the caller.
 *
 * `source` records the job's slug/url/title for funnel provenance (same field
 * set written by `subscribeJobAlertOneTap`).
 */
export async function subscribeJobAlertForJob(
  userId: string,
  email: string,
  jobId: string,
  locale: 'it' | 'en' | 'de' | 'fr',
  source?: JobAlertSource,
): Promise<JobAlert> {
  const config: JobAlertConfig = {
    keywords: [],
    locations: [],
    contractTypes: [],
    sectors: [],
    cantonFilter: null,
    frequency: 'daily',
    locale,
    specificJobId: jobId,
    specificCompanyKey: null,
    sourceJobSlug: source?.slug ?? null,
    sourceJobUrl: source?.url ?? null,
    sourceJobTitle: source?.title ?? null,
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
  // Use `in` so callers can deliberately reset to engine-managed (`false`),
  // not just pin (`true`) — see components/community/JobAlertForm.tsx.
  if ('frequencyOverride' in changes) {
    updateData.frequencyOverride = changes.frequencyOverride === true;
  }
  if (changes.locale) updateData.locale = changes.locale;

  if (Object.keys(updateData).length > 0) {
    const ref = doc(db, SUBSCRIBERS_COLLECTION, normalizeEmail(email), ALERTS_SUBCOLLECTION, alertId);
    await updateDoc(ref, updateData);
  }
}
