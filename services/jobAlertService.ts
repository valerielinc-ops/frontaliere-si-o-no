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
import { canonicalCompanyProfileSlug } from '../build-plugins/shared/companyProfileSlug.mjs';
import {
  buildJobAlertConsentProof,
  planJobAlertConsentUpgrade,
  type UpgradeSkipReason,
} from './jobAlertConsentUpgrade';

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
  /**
   * Send cadence.
   *
   * `'immediate'` (issue #5012 phase 2) is NOT a third digest interval: it
   * routes the alert to a different sender entirely. `scripts/send-job-alerts.mjs`
   * is a once-a-day cron; `scripts/send-company-alerts.mjs` is event-driven on
   * the commit that publishes a new job. The partition between the two lives in
   * ONE place — `isImmediateCompanyAlert` in scripts/lib/company-alert-routing.mjs
   * — and requires the employer pin, so `immediate` is only ever set by
   * `subscribeCompanyAlert`. It is not offered in the generic alert form.
   */
  frequency: 'daily' | 'weekly' | 'immediate';
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
  /**
   * Desired minimum monthly NET salary (CHF), prefilled from the calculator
   * simulation when the alert is created from the results view (issue #4469 —
   * "avvisami per offerte con netto ≥ X"). Stored as the user's salary
   * expectation criterion and surfaced back in the alert manager. `null`/absent
   * = no salary expectation (default). Kept optional so Firestore reads stay
   * backwards-compatible with alerts created before the field existed.
   */
  minNetMonthlyCHF?: number | null;
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
/**
 * Max active alerts per user.
 *
 * 10, not 3 (#5012): the token-mode Cloud Function
 * (functions/src/newsletterSubscriptionManagement.js) has always enforced 10,
 * so a user who created alerts from the `/preferenze-newsletter/` link could
 * end up with more alerts than the signed-in UI would let them create — the
 * next in-app create then failed with "Maximum 3 active alerts per user."
 * CompanyAlert makes a low cap actively wrong: following four employers is the
 * ordinary case, not an abuse. Keep in sync with MAX_ALERTS_PER_USER in
 * functions/src/newsletterSubscriptionManagement.js and
 * functions/src/jobAlertBackfillCore.js (the functions bundle cannot import
 * outside `functions/`) — parity is pinned by tests/company-alert.test.ts.
 */
export const MAX_ALERTS_PER_USER = 10;

/**
 * Separate budget for company-pinned alerts (#5012).
 *
 * The two kinds of alert compete for attention, not for the same resource: a
 * keyword alert is a saved search, a company follow is "tell me when THIS
 * employer posts". Sharing one cap meant that following ten employers — the
 * ordinary case for the feature, and the one it exists to encourage — silently
 * consumed every slot and made the next keyword alert fail with «Maximum 10
 * active alerts per user», a message that names neither the cause nor the fix.
 *
 * 20, RAISED FROM 10 ONCE GROUPING EXISTED (residuo #5283). The old value was
 * not about how many employers a person may reasonably follow — it was a
 * deliverability brake: scripts/send-company-alerts.mjs mailed ONE email per
 * alert per run, so this budget doubled as the ceiling on how many CompanyAlert
 * messages a single run could drop into one inbox, and 10 at once is already
 * indefensible. That sender now groups by recipient, so the per-inbox ceiling
 * for a run is exactly 1 message no matter what this number says, and the brake
 * has nothing left to brake.
 *
 * 20 and not "unlimited" because the message still has to fit: the email's card
 * budget is COMPANY_ALERT_MAX_TOTAL_CARDS = 20 (services/companyAlertEmail.mjs),
 * and pinning the follow cap to the same 20 buys a property worth having — even
 * the pathological run in which EVERY followed employer publishes inside the
 * same window renders one card each and still fits in ONE email. A larger cap
 * would start deferring sections to the next run as a matter of routine rather
 * than as the rare overflow it is meant to be. If this number moves, move the
 * card budget with it.
 *
 * What grouping did NOT fix, and what a future raise must look at first: this
 * sender has no per-recipient cooldown, so following more employers still means
 * a higher chance that any given run has something to say. That is a frequency
 * argument, not a burst argument, and it is the reason 20 is a doubling rather
 * than an order of magnitude.
 *
 * Mirrored in functions/src/newsletterSubscriptionManagement.js and
 * functions/src/jobAlertBackfillCore.js (the functions bundle cannot import
 * outside `functions/`) — parity pinned by tests/company-alert.test.ts.
 */
export const MAX_COMPANY_ALERTS_PER_USER = 20;

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
  // Two budgets, counted apart — see MAX_COMPANY_ALERTS_PER_USER. The read is
  // the same one document set either way, so this costs nothing extra.
  const isCompanyPin = Boolean(config.specificCompanyKey);
  const sameKind = existing.docs.filter(
    (d) => Boolean((d.data() as { specificCompanyKey?: string | null }).specificCompanyKey) === isCompanyPin,
  ).length;
  const kindCap = isCompanyPin ? MAX_COMPANY_ALERTS_PER_USER : MAX_ALERTS_PER_USER;
  if (sameKind >= kindCap) {
    throw new Error(
      isCompanyPin
        ? `Maximum ${kindCap} followed companies per user.`
        : `Maximum ${kindCap} active alerts per user.`,
    );
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
    // Canonicalised on the ONE write path (#5012) so no caller can persist a
    // raw company name the matcher would never match.
    specificCompanyKey: config.specificCompanyKey
      ? companyAlertKey(config.specificCompanyKey)
      : null,
    // Salary expectation prefilled from the calculator (issue #4469).
    minNetMonthlyCHF: normalizeMinNet(config.minNetMonthlyCHF),
    // State.
    active: true,
    createdAt: serverTimestamp(),
    lastMatchedAt: null,
    matchCount: 0,
  };
  const ref = await addDoc(alertsRef, docData);

  // GA4 user-scoped `is_job_alert_subscriber` custom dimension (analytics
  // Stage 1, revenue-per-user segmentation). Fired on every genuine new
  // job-alert write — createAlert is the single write path shared by
  // JobAlertForm, subscribeJobAlertOneTap, and subscribeJobAlertForJob.
  import('@/services/analytics').then(({ Analytics }) => {
    Analytics.setUserSegmentFlags({ isJobAlertSubscriber: true });
  }).catch(() => {});

  return {
    id: ref.id,
    userId,
    email: normalizedEmail,
    ...config,
    cantonFilter,
    frequencyOverride: config.frequencyOverride === true,
    minNetMonthlyCHF: normalizeMinNet(config.minNetMonthlyCHF),
    active: true,
    createdAt: new Date(),
    lastMatchedAt: null,
    matchCount: 0,
  };
}

/**
 * Normalise a desired minimum monthly net salary (issue #4469): a positive,
 * finite number is rounded to a whole CHF; anything else (null, 0, negative,
 * NaN) collapses to `null` so Firestore never stores a junk expectation and
 * downstream consumers can treat the field as a single optional gate.
 */
export function normalizeMinNet(input: number | null | undefined): number | null {
  const n = Number(input);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.round(n);
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
      // Legacy alerts (pre-#4469) have no salary expectation — normalise absent
      // / junk values to null so consumers treat the field as one optional gate.
      minNetMonthlyCHF: normalizeMinNet(d.minNetMonthlyCHF),
      locale: d.locale || 'it',
      // Pinned scope round-trip (#5012). The matcher has hard-filtered on these
      // two fields since day one, but NOTHING read them back — a company- or
      // job-pinned alert reached the client looking like an unfiltered alert,
      // so the user could neither see what they had followed nor unfollow it
      // (a GDPR problem before it is a UX one). Normalised to `null` so legacy
      // alerts written before the fields existed stay one optional gate.
      specificJobId: typeof d.specificJobId === 'string' && d.specificJobId ? d.specificJobId : null,
      specificCompanyKey: typeof d.specificCompanyKey === 'string' && d.specificCompanyKey
        ? d.specificCompanyKey
        : null,
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
 * Record the consent proof on this person's TRAVASO alerts, because they just
 * pressed a button that says "attiva alert" (#5876).
 *
 * WHY IT IS A SEPARATE CALL AND NOT A LINE INSIDE `createAlert`
 * ------------------------------------------------------------
 * What gets stored is the sentence that was ON SCREEN, and only the call site
 * knows whether it rendered one. Making this an explicit call keeps the pairing
 * mechanical and greppable — a file calls this function IF AND ONLY IF it
 * renders `<ConsentNotice consentKey="communicationsOptIn">`, which
 * `tests/job-alert-consent-upgrade.test.ts` asserts per file. Folding it into
 * `createAlert` would have made every present and future caller of the write
 * path claim a disclosure it may never have made, which is the exact
 * fabrication `displayed` was invented to prevent (#5712).
 *
 * WHY IT ENUMERATES BY EMAIL AND NOT VIA `getUserAlerts`
 * -----------------------------------------------------
 * `getUserAlerts` queries `where('userId','==',uid)`, and **not one** of the
 * 6.295 travaso alerts on production carries a `userId` — `buildAlertPayload`
 * writes `userId: data?.user_id || null` and the newsletter documents it was
 * built from had no `user_id` (measured 2026-08-14: 0 of 6.295). Those alerts
 * are therefore invisible to every userId-scoped query in this file. The path
 * `job_alert_subscribers/{email}/alerts` reaches them, and `firestore.rules`
 * grants both the read and the update on the caller's own email.
 *
 * NEVER THROWS INTO A CTA. It returns a tally instead: a proof that failed to
 * land must not turn a successful subscription into an error toast. The tally
 * is what a caller can log.
 */
export async function upgradeBackfilledAlertConsent(
  email: string,
  locale?: string | null,
  opts?: { sourceUrl?: string | null },
): Promise<{ upgraded: number; skipped: Partial<Record<UpgradeSkipReason, number>>; failed: number }> {
  const skipped: Partial<Record<UpgradeSkipReason, number>> = {};
  let upgraded = 0;
  let failed = 0;

  const normalizedEmail = normalizeEmail(email);
  if (!normalizedEmail) return { upgraded, skipped, failed };

  const db = await getDb();
  const { collection, doc, getDoc, getDocs, updateDoc, serverTimestamp } =
    await import('firebase/firestore');

  const subscriberRef = doc(db, SUBSCRIBERS_COLLECTION, normalizedEmail);
  // The parent document carries the account-level opt-out; a read failure must
  // NOT be read as "no opt-out recorded", so it aborts instead of defaulting.
  let subscriber: Record<string, unknown> | null = null;
  try {
    const subSnap = await getDoc(subscriberRef);
    subscriber = subSnap.exists() ? (subSnap.data() as Record<string, unknown>) : null;
  } catch {
    return { upgraded, skipped, failed: 1 };
  }

  const proof = buildJobAlertConsentProof({
    locale,
    sourceUrl:
      opts?.sourceUrl
      ?? (typeof window !== 'undefined' && window.location ? window.location.href : null),
    stampedAt: serverTimestamp(),
  });

  let alerts;
  try {
    alerts = await getDocs(collection(subscriberRef, ALERTS_SUBCOLLECTION));
  } catch {
    return { upgraded, skipped, failed: 1 };
  }

  for (const alertDoc of alerts.docs) {
    const decision = planJobAlertConsentUpgrade({
      alert: alertDoc.data() as Record<string, unknown>,
      subscriber,
      proof,
    });
    if (decision.write !== true) {
      const reason = decision.reason;
      skipped[reason] = (skipped[reason] || 0) + 1;
      continue;
    }
    try {
      // A field-level update: `status`, `active` and every counter are left
      // exactly as they are. Nothing here can make anybody contactable who was
      // not already — see the header of services/jobAlertConsentUpgrade.ts.
      await updateDoc(alertDoc.ref, { ...decision.payload });
      upgraded += 1;
    } catch {
      failed += 1;
    }
  }

  return { upgraded, skipped, failed };
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
 * Build the canonical `JobAlertConfig` for a salary alert created from the
 * calculator results view (issue #4469 — "avvisami per offerte con netto ≥ X").
 *
 * Prefilled from the simulation: an optional profession keyword, the region as a
 * canton geo-scope (validated 2-letter ISO code, e.g. `'TI'`), and the desired
 * minimum monthly net salary. Weekly cadence, engine-managed (no
 * `frequencyOverride`) like the other one-tap presets. Shared by the authed
 * one-tap path and the anonymous pending-replay path so both persist identical
 * criteria. Empty `profession` ⇒ no keyword (canton + salary expectation still
 * scope the alert).
 */
export function buildSalaryAlertConfig(opts: {
  profession?: string | null;
  cantonCode?: string | null;
  minNetMonthlyCHF?: number | null;
  locale: 'it' | 'en' | 'de' | 'fr';
}): JobAlertConfig {
  const keyword = stripKeywordEmoji(String(opts.profession || '')).trim();
  const canton = opts.cantonCode ? String(opts.cantonCode).trim().toUpperCase() : null;
  return {
    keywords: keyword ? [keyword] : [],
    locations: [],
    contractTypes: [],
    sectors: [],
    cantonFilter: canton ? [canton] : null,
    frequency: 'weekly',
    locale: opts.locale,
    minNetMonthlyCHF: normalizeMinNet(opts.minNetMonthlyCHF),
  };
}

/**
 * 1-tap subscribe helper for a salary alert from the calculator (issue #4469).
 * Delegates to `createAlert` (the single write path that also fires the GA4
 * subscriber segment). The max-3 active-alerts limit propagates to the caller.
 */
export async function subscribeSalaryAlert(
  userId: string,
  email: string,
  opts: {
    profession?: string | null;
    cantonCode?: string | null;
    minNetMonthlyCHF?: number | null;
    locale: 'it' | 'en' | 'de' | 'fr';
  },
): Promise<JobAlert> {
  return createAlert(userId, email, buildSalaryAlertConfig(opts));
}

/**
 * Canonical persisted token for a CompanyAlert (issue #5012).
 *
 * ONE normalisation, deliberately the slug of the public employer page
 * `/aziende/<slug>/` (`canonicalCompanyProfileSlug`), so what the user follows
 * and what the site shows them under that URL are the same entity — including
 * the brand-alias fold, which collapses "Migros Ticino" and "Gruppo Migros"
 * onto `migros` instead of creating two alerts that each see half the jobs.
 *
 * The matcher's `normalizeCompanyToken` (services/jobAlertMatching.mjs) is now
 * DERIVED from the same slug, so the write side and the read side cannot drift.
 * Before #5012 the repo held four independent copies of this normalisation;
 * an alert saved with one and matched with another simply never fires, and the
 * user is never told.
 */
export function companyAlertKey(company: string, companyKey?: string): string {
  return canonicalCompanyProfileSlug(company, companyKey);
}

/**
 * 1-tap subscribe helper for a whole EMPLOYER ("Segui questa azienda").
 *
 * Pins the alert to one company via `specificCompanyKey`, which the matcher
 * (services/jobAlertMatching.mjs) already treats as a HARD filter that bypasses
 * keyword/geo/sector scoring — the pin IS the scope, exactly like
 * `subscribeJobAlertForJob`. No new Firestore query shape is introduced: the
 * write goes through `createAlert`, which reuses the SAME
 * (userId, active, createdAt desc) collectionGroup index that is already
 * deployed. That is deliberate — `firestore.indexes.json` is NOT applied by CI
 * (deploy-firestore-rules.yml ships `firestore:rules` only), so a feature that
 * needed a new index would go live broken with a FAILED_PRECONDITION, which is
 * exactly how createAlert broke once before.
 *
 * The max-active-alerts limit enforced by `createAlert` propagates to the
 * caller.
 */
export async function subscribeCompanyAlert(
  userId: string,
  email: string,
  company: { name: string; companyKey?: string | null },
  locale: 'it' | 'en' | 'de' | 'fr',
  source?: JobAlertSource,
): Promise<JobAlert> {
  const key = companyAlertKey(company.name, company.companyKey || undefined);
  if (!key) throw new Error('subscribeCompanyAlert: empty company name.');
  const config: JobAlertConfig = {
    keywords: [],
    locations: [],
    contractTypes: [],
    sectors: [],
    cantonFilter: null,
    // IMMEDIATE, not daily (#5012 phase 2). The issue specifies `immediate` for
    // phase 1, and it is the whole value of following an employer: a digest
    // slot 24h later, mixed in with unrelated matches, is a different product.
    // `frequencyOverride: true` pins it so the adaptive-cadence engine
    // (scripts/lib/jobAlertEngagementTier.mjs) never quietly demotes a
    // followed employer to weekly because the user hasn't opened lately.
    frequency: 'immediate',
    frequencyOverride: true,
    locale,
    specificJobId: null,
    specificCompanyKey: key,
    sourceJobSlug: source?.slug ?? null,
    sourceJobUrl: source?.url ?? null,
    sourceJobTitle: source?.title ?? null,
  };
  return createAlert(userId, email, config);
}

/**
 * Every employer the user currently follows (issue #5012 phase 2) — the data
 * behind the "Le mie aziende seguite" page.
 *
 * Reuses `getUserAlerts` and filters in memory: no second query, therefore no
 * second Firestore index. `firestore.indexes.json` is NOT applied by CI, so a
 * surface that needed a new composite index would merge green and then fail in
 * production with FAILED_PRECONDITION on its first real use.
 */
export async function listFollowedCompanies(userId: string): Promise<JobAlert[]> {
  const alerts = await getUserAlerts(userId);
  return alerts.filter((a) => Boolean(a.specificCompanyKey));
}

/**
 * Find the user's active alert for a given company, if any. Reuses
 * `getUserAlerts` (no extra query, no extra index) so the follow button can
 * render its "already following" state.
 */
export async function findCompanyAlert(
  userId: string,
  company: { name: string; companyKey?: string | null },
): Promise<JobAlert | null> {
  const key = companyAlertKey(company.name, company.companyKey || undefined);
  if (!key) return null;
  const alerts = await getUserAlerts(userId);
  return alerts.find((a) => a.specificCompanyKey === key) || null;
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
  // Use `in` so callers can clear the salary expectation (pass `null`/0).
  if ('minNetMonthlyCHF' in changes) {
    updateData.minNetMonthlyCHF = normalizeMinNet(changes.minNetMonthlyCHF);
  }
  if (changes.locale) updateData.locale = changes.locale;
  // Use `in` so a caller can deliberately CLEAR a pin (pass `null`) and turn a
  // company/job alert back into a normal one — the counterpart of the
  // read-back above (#5012). A non-empty company key is re-canonicalised on
  // write so an alert can never be stored under a stale normalisation.
  if ('specificCompanyKey' in changes) {
    updateData.specificCompanyKey = changes.specificCompanyKey
      ? companyAlertKey(changes.specificCompanyKey)
      : null;
  }
  if ('specificJobId' in changes) {
    updateData.specificJobId = changes.specificJobId || null;
  }

  if (Object.keys(updateData).length > 0) {
    const ref = doc(db, SUBSCRIBERS_COLLECTION, normalizeEmail(email), ALERTS_SUBCOLLECTION, alertId);
    await updateDoc(ref, updateData);
  }
}
