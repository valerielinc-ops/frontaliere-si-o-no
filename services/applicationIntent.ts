import { RECORD_APPLICATION_INTENT_URL } from './functionsBase';
import { buildApplicationIntentJobKey } from './applicationIntentRanking.mjs';
import { hydrateFromFirestore, syncToFirestore, trackApplicationIntent } from './behaviorTracker';

export { buildApplicationIntentJobKey };

/** Wire version shared with functions/src/applicationIntentCore.js. */
export const APPLICATION_INTENT_CONSENT_VERSION = 'application-intent-v1';

const VISITOR_ID_STORAGE_KEY = 'frontaliere_application_intent_visitor_v1';
const VISITOR_ID_RE = /^[A-Za-z0-9_-]{16,128}$/;

export interface ApplicationIntentJob {
  id: string;
  slug?: string | null;
  slugByLocale?: Partial<Record<string, string | null>> | null;
  companyKey?: string | null;
  title?: string | null;
}

export interface RecordApplicationIntentInput {
  job: ApplicationIntentJob;
  origin: string;
  surface: string;
  consentText: string;
  authEmail?: string | null;
  authUser?: {
    uid?: string | null;
    email?: string | null;
    providerData?: Array<{ email?: string | null }> | null;
    getIdToken?: () => Promise<string>;
  } | null;
}

function clean(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function authenticatedUserEmail(user: RecordApplicationIntentInput['authUser']): string {
  const direct = clean(user?.email);
  if (direct) return direct;
  for (const provider of user?.providerData || []) {
    const email = clean(provider?.email);
    if (email) return email;
  }
  return '';
}

function randomVisitorId(): string {
  try {
    if (typeof globalThis.crypto?.randomUUID === 'function') {
      return `visitor-${globalThis.crypto.randomUUID()}`;
    }
  } catch {
    // Private browsing or an older browser can deny crypto access.
  }
  return `visitor-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 16)}`;
}

function visitorIdentifier(): string {
  if (typeof window === 'undefined') return randomVisitorId();
  try {
    const existing = clean(window.localStorage.getItem(VISITOR_ID_STORAGE_KEY));
    if (VISITOR_ID_RE.test(existing)) return existing;
    const generated = randomVisitorId();
    window.localStorage.setItem(VISITOR_ID_STORAGE_KEY, generated);
    return generated;
  } catch {
    return randomVisitorId();
  }
}

/**
 * The click handler can continue immediately, while authenticated same-tab
 * redirects await the private profile write. The consent record stays
 * keepalive; the server prefers verified Firebase Auth when a token is present.
 */
export async function recordApplicationIntent({
  job,
  origin,
  surface,
  consentText,
  authEmail = null,
  authUser = null,
}: RecordApplicationIntentInput): Promise<boolean> {
  const jobKey = buildApplicationIntentJobKey(job);
  const email = clean(authEmail || authenticatedUserEmail(authUser)).toLowerCase();
  const hasAuthenticatedUser = Boolean(clean(authUser?.uid));
  const hasAuthenticatedProfile = hasAuthenticatedUser && Boolean(email);
  // Read the authenticated profile first so a remote opt-out is merged locally
  // before this click can add a ranking key or write the profile back. If the
  // account has no usable email, fail closed because its opt-out cannot be read.
  const profileReady = hasAuthenticatedUser
    ? hasAuthenticatedProfile && await hydrateFromFirestore(email)
    : true;
  const recorded = profileReady && trackApplicationIntent(jobKey);

  const payload = {
    jobKey,
    jobSlug: clean(job.slugByLocale?.it) || clean(job.slug) || clean(job.id),
    companyKey: clean(job.companyKey) || null,
    jobTitle: clean(job.title) || null,
    origin: clean(origin) || '/',
    surface: clean(surface) || 'job_board_apply',
    consentVersion: APPLICATION_INTENT_CONSENT_VERSION,
    consentText: clean(consentText),
    clientIdentifier: visitorIdentifier(),
  };

  // Start the consented server record independently; the same-tab hand-off
  // waits only for the authenticated personalization write below.
  void (async () => {
    try {
      const token = authUser?.getIdToken ? await authUser.getIdToken() : '';
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (token) headers.Authorization = `Bearer ${token}`;
      await fetch(RECORD_APPLICATION_INTENT_URL, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
        keepalive: true,
        credentials: 'omit',
      });
    } catch {
      // The external hand-off remains available if the consent record is unavailable.
    }
  })();

  if (!recorded) return false;
  if (!hasAuthenticatedProfile) return true;
  // setDoc resolves after the private personalization profile is persisted;
  // callers that navigate in the same tab can await this promise first.
  return syncToFirestore(email);
}
