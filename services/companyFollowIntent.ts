/**
 * Pending CompanyAlert follows for NOT-YET-CONFIRMED visitors (issue #5012
 * phase 2).
 *
 * The gap phase 1 left: `CompanyFollowButton` was gated on `userId && email`,
 * so an anonymous visitor — the majority of job-detail traffic, and the whole
 * point of the feature commercially — could not follow an employer at all.
 *
 * ── WHY A PENDING INTENT AND NOT A DIRECT WRITE ───────────────────────────
 * Double opt-in. The site already has ONE consent mechanism and this reuses it
 * verbatim rather than inventing a second: `upsertNewsletterSubscriber` writes
 * `newsletter_subscribers/{email}` with `status: 'pending'` and fires
 * `newsletterSendConfirmation`; the link in that email carries
 * `?action=confirm_newsletter&email=…&token=<confirm-scoped, dated>` (#5704 —
 * it used to be a bare HMAC over the address that also unsubscribed and opened
 * the preferences API, and never expired); App.tsx's handler
 * confirms the subscriber and signs the user in with the custom token the
 * Cloud Function returns. Only THEN does a `userId` exist, and only then is
 * there recorded consent to email this address.
 *
 * So the follow cannot be written at click time. The authoritative intent is
 * parked on the server-side subscriber document by the capture; this browser
 * queue is a compatibility fallback for clients that started before that
 * path. The confirmation function replays the server intent, so an
 * unconfirmed address never produces an alert document — an un-consented
 * subscription that emails somebody is a GDPR problem, not a conversion
 * optimisation.
 *
 * ── STORAGE ───────────────────────────────────────────────────────────────
 * Storage/TTL/guard mechanics come from `services/pendingIntentStore.ts`, the
 * module that already exists for exactly this problem ("survives the auth
 * round-trip across every sign-in surface, INCLUDING a magic-link email that
 * opens in a brand-new tab") and is already shared by `pendingJobAlert.ts` and
 * `pendingSaveJob.ts`. This module only owns what is specific to CompanyAlert:
 * the payload shape, the per-entry prune, and the replay.
 *
 * The one deviation from those two siblings is deliberate and is why the TTL is
 * passed explicitly: they park a value across a sign-in popup that resolves in
 * seconds, so `DEFAULT_INTENT_TTL_MS` is 15 minutes. A double-opt-in email may
 * sit unread for a day. 15 minutes here would silently drop the follow of every
 * visitor who does not check their inbox immediately — a silent no-op with the
 * UI still saying "controlla la posta".
 *
 * The compatibility queue is localStorage, not a new Firestore
 * `pending_follows` collection: a new collection means a new query shape and
 * index surface. The server-side subscriber document is already part of the
 * confirmation read/write, so a confirmation opened on a DIFFERENT device
 * still replays the follow. If localStorage is unavailable, only the legacy
 * fallback is lost; the authoritative intent remains recoverable server-side.
 */

import type { CompanyFollowConsent, JobAlert } from './jobAlertService';
import { clearIntent, peekIntent, saveIntent } from './pendingIntentStore';

const KEY = 'company_follow_pending';

/** Intents older than this are dropped: a stale click is not consent. */
export const PENDING_FOLLOW_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** Cap so a scripted/looping client cannot grow the entry unbounded. */
const MAX_PENDING = 10;

export interface PendingCompanyFollow {
  /** Employer display name (`job.company`). */
  company: string;
  /** Optional crawler company key (`job.companyKey`). */
  companyKey?: string | null;
  /** Locale the visitor followed in — carried onto the alert. */
  locale: 'it' | 'en' | 'de' | 'fr';
  /** Provenance of the job the follow started from. */
  sourceJobSlug?: string | null;
  sourceJobUrl?: string | null;
  sourceJobTitle?: string | null;
  /** Address the visitor typed. Lowercased. */
  email: string;
  /** ms epoch. */
  savedAt: number;
  /** Purpose-specific proof used by the server confirmation replay. */
  companyFollowConsent?: CompanyFollowConsent | null;
}

function readRaw(): PendingCompanyFollow[] {
  // The store's own TTL governs the LIST (refreshed on every write); the
  // per-entry prune below governs each follow, because one list can accumulate
  // entries from several visits.
  const stored = peekIntent<PendingCompanyFollow[]>(KEY, PENDING_FOLLOW_TTL_MS);
  return Array.isArray(stored) ? stored : [];
}

function writeRaw(entries: PendingCompanyFollow[]): void {
  if (entries.length === 0) clearIntent(KEY);
  else saveIntent(KEY, entries);
}

/**
 * Drop expired entries. Exported and pure so the TTL is testable without
 * touching localStorage or the clock.
 */
export function pruneExpired(
  entries: PendingCompanyFollow[],
  nowMs: number,
  ttlMs: number = PENDING_FOLLOW_TTL_MS,
): PendingCompanyFollow[] {
  return (entries || []).filter(
    (e) => e && typeof e.savedAt === 'number' && nowMs - e.savedAt < ttlMs,
  );
}

/** Park a follow until the visitor confirms their address. */
export function savePendingCompanyFollow(intent: Omit<PendingCompanyFollow, 'savedAt'>): void {
  const now = Date.now();
  const email = String(intent.email || '').trim().toLowerCase();
  if (!email || !intent.company) return;
  const existing = pruneExpired(readRaw(), now)
    // De-dup on (email, company): tapping twice must not create two alerts.
    .filter((e) => !(e.email === email && e.company === intent.company));
  writeRaw([...existing, { ...intent, email, savedAt: now }].slice(-MAX_PENDING));
}

/** Non-expired parked follows. */
export function readPendingCompanyFollows(nowMs: number = Date.now()): PendingCompanyFollow[] {
  return pruneExpired(readRaw(), nowMs);
}

export function clearPendingCompanyFollows(): void {
  clearIntent(KEY);
}

/**
 * Replay every parked follow for `email` now that the address is confirmed and
 * a `userId` exists. Called from App.tsx's `confirm_newsletter` handler, right
 * after `signInWithCustomAuthToken`.
 *
 * Best-effort by contract: a failure here must never break the confirmation
 * flow (the subscriber IS confirmed, which is the important half). Successful
 * entries are cleared; failed entries stay recoverable for the next signed-in
 * replay. The confirmation endpoint is authoritative and persists the intent
 * server-side, so this browser queue is only a compatibility fallback for
 * already-parked clients.
 *
 * @param subscribe Injected for tests; defaults to the real write path.
 * @returns the alerts actually created.
 */
export async function flushPendingCompanyFollows(
  userId: string,
  email: string,
  subscribe?: (
    userId: string,
    email: string,
    company: { name: string; companyKey?: string | null },
    locale: 'it' | 'en' | 'de' | 'fr',
    source?: { slug?: string | null; url?: string | null; title?: string | null; companyFollowConsent?: CompanyFollowConsent | null },
  ) => Promise<JobAlert>,
): Promise<JobAlert[]> {
  const normalized = String(email || '').trim().toLowerCase();
  if (!userId || !normalized) return [];
  const all = readPendingCompanyFollows();
  const mine = all.filter((e) => e.email === normalized);
  if (mine.length === 0) return [];

  const write = subscribe
    || (await import('./jobAlertService')).subscribeCompanyAlert;

  const created: JobAlert[] = [];
  const completed = new Set<PendingCompanyFollow>();
  for (const intent of mine) {
    try {
      created.push(
        await write(
          userId,
          normalized,
          { name: intent.company, companyKey: intent.companyKey ?? null },
          intent.locale,
          {
            slug: intent.sourceJobSlug ?? null,
            url: intent.sourceJobUrl ?? null,
            title: intent.sourceJobTitle ?? null,
            companyFollowConsent: intent.companyFollowConsent ?? null,
          },
        ),
      );
      completed.add(intent);
    } catch {
      // Swallowed on purpose — see the docblock. The loop continues so one bad
      // intent cannot block the others.
    }
  }
  // The server-side intent is now the primary path. This local replay remains a
  // best-effort fallback, but a failed write must stay recoverable rather than
  // being erased on the next App.tsx confirmation effect.
  writeRaw(all.filter((e) => e.email !== normalized || !completed.has(e)));
  return created;
}
