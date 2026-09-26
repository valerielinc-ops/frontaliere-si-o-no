import { RECORD_APPLICATION_INTENT_URL } from './functionsBase';

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
  authUser?: { uid?: string | null; getIdToken?: () => Promise<string> } | null;
}

function clean(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
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

/** Stable job identity shared by retries, locales and the referral URL. */
export function buildApplicationIntentJobKey(job: ApplicationIntentJob): string {
  const companyKey = clean(job.companyKey) || 'unknown-company';
  const canonicalSlug = clean(job.slugByLocale?.it) || clean(job.slug);
  return canonicalSlug
    ? `${companyKey}:${canonicalSlug}`
    : `${companyKey}:id:${clean(job.id) || 'unknown-job'}`;
}

/**
 * Fire-and-forget from the click handler, but keep the request alive through a
 * same-tab redirect. The server accepts the opaque visitor id when Auth is not
 * available and prefers the verified Firebase uid when a token is present.
 */
export async function recordApplicationIntent({
  job,
  origin,
  surface,
  consentText,
  authUser = null,
}: RecordApplicationIntentInput): Promise<boolean> {
  const payload = {
    jobKey: buildApplicationIntentJobKey(job),
    jobSlug: clean(job.slugByLocale?.it) || clean(job.slug) || clean(job.id),
    companyKey: clean(job.companyKey) || null,
    jobTitle: clean(job.title) || null,
    origin: clean(origin) || '/',
    surface: clean(surface) || 'job_board_apply',
    consentVersion: APPLICATION_INTENT_CONSENT_VERSION,
    consentText: clean(consentText),
    clientIdentifier: visitorIdentifier(),
  };

  try {
    const token = authUser?.getIdToken ? await authUser.getIdToken() : '';
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (token) headers.Authorization = `Bearer ${token}`;
    const response = await fetch(RECORD_APPLICATION_INTENT_URL, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      keepalive: true,
      credentials: 'omit',
    });
    return response.ok;
  } catch {
    // The external hand-off remains available if telemetry is unavailable; the
    // next click/retry is still deduplicated by the deterministic server key.
    return false;
  }
}
