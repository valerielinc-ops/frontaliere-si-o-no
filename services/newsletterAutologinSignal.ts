/**
 * Newsletter autologin in-flight signal.
 *
 * A user arriving from a newsletter link carries an autologin code
 * (`ac`/`at`/`authToken` + recipient email). App.tsx exchanges it for a Firebase
 * session asynchronously (Cloud Function round-trip). During that window we must
 * NOT surface any sign-in affordance — Google One Tap, the job/chatbot auth gate
 * — because the user is about to be signed in: prompting is redundant noise and
 * delays the content the newsletter linked to.
 *
 * Consumers read {@link isNewsletterAutologinInFlight} and subscribe via
 * {@link subscribeNewsletterAutologin} to re-evaluate once it settles. The signal
 * is computed synchronously at module load (before App.tsx strips the params).
 *
 * Kept in its own dependency-free module (no Firebase) so the detection logic is
 * unit-testable without the heavy authService import graph.
 */

export interface NewsletterAutologin {
 /** `ac` — HMAC autologin code (never expires, exchanged for a fresh token). */
 code: string | null;
 /** `at` / `authToken` — legacy Firebase custom token (expires in 1h). */
 legacyToken: string | null;
 /** Raw recipient email (`ne` / `newsletter_email` / `email`), not normalized. */
 email: string;
 /** `action` param, if any (unsubscribe / resubscribe / confirm_newsletter / …). */
 action: string | null;
 /**
 * True when the URL carries an autologin credential + recipient email and is
 * not an unsubscribe/resubscribe action — i.e. App.tsx's autologin effect will
 * attempt a sign-in. `confirm_newsletter` naturally yields `false` (it carries
 * a `token`, not `ac`/`at`).
 */
 isAutologin: boolean;
}

/**
 * Single source of truth for "is this URL a newsletter autologin link, and what
 * does it carry". Consumed by both this signal (module-load detection) and the
 * App.tsx autologin effect, so the credential/email param names live in ONE
 * place — adding a future code param (e.g. a `v2`) updates both by construction.
 */
export function parseNewsletterAutologin(search: string | URLSearchParams): NewsletterAutologin {
 const p = typeof search === 'string' ? new URLSearchParams(search) : search;
 const action = p.get('action');
 const code = p.get('ac');
 const legacyToken = p.get('at') || p.get('authToken');
 const email = p.get('ne') || p.get('newsletter_email') || p.get('email') || '';
 const isExcludedAction = action === 'unsubscribe' || action === 'resubscribe';
 const isAutologin = !isExcludedAction && Boolean(code || legacyToken) && Boolean(email);
 return { code, legacyToken, email, action, isAutologin };
}

let inFlight = ((): boolean => {
 if (typeof window === 'undefined') return false;
 try {
 return parseNewsletterAutologin(window.location.search).isAutologin;
 } catch {
 return false;
 }
})();

// Captured once at module load and never reset (unlike `inFlight`, which
// settles after the exchange). True for the whole SPA session when the user
// arrived on a newsletter autologin link. Lets late-running consumers — e.g.
// the job-alert prompt — distinguish "this visitor came from a newsletter but
// is still anonymous" (autologin never completed) from organic anonymous
// traffic, without emitting telemetry for every anonymous page view.
const attemptedAtLoad = inFlight;

type NewsletterAutologinAttempt = {
 key: string;
 promise: Promise<unknown>;
};

// React StrictMode (and a few static-to-live remount paths) can run the App
// effect more than once for the same URL. Keep the exchange and its telemetry
// terminal state single-flight for that URL. A different credential-bearing
// link is refused for the lifetime of this SPA page; a full reload re-arms the
// module-level in-flight signal with the new URL and avoids cross-link races.
let activeAutologinAttempt: NewsletterAutologinAttempt | null = null;

export function newsletterAutologinAttemptKey(search: string | URLSearchParams): string | null {
 const params = typeof search === 'string' ? new URLSearchParams(search) : search;
 const parsed = parseNewsletterAutologin(params);
 if (!parsed.isAutologin) return null;
 return [
  parsed.code ? 'hmac_code' : 'legacy_token',
  parsed.code || parsed.legacyToken || '',
  parsed.email.trim().toLowerCase(),
  params.get('assisted_application_order_id') || '',
  params.get('application_concierge_service_id') || '',
 ].join('|');
}

export function claimNewsletterAutologinAttempt(
 key: string,
 factory: () => Promise<unknown>,
): { promise: Promise<unknown>; owner: boolean; accepted: boolean } {
 if (activeAutologinAttempt?.key === key) {
  return {
   promise: activeAutologinAttempt.promise,
   owner: false,
   accepted: true,
  };
 }

 if (activeAutologinAttempt) {
  return {
   promise: Promise.resolve(null),
   owner: false,
   accepted: false,
  };
 }

 // Defer the factory to the next microtask so the owner can emit the attempt
 // marker before the network/auth exchange starts.
 const promise = Promise.resolve().then(factory);
 activeAutologinAttempt = { key, promise };
 return { promise, owner: true, accepted: true };
}

const subscribers = new Set<() => void>();

export function isNewsletterAutologinInFlight(): boolean {
 return inFlight;
}

/** True if this SPA session began on a newsletter autologin link. Never resets. */
export function wasNewsletterAutologinAttempted(): boolean {
 return attemptedAtLoad;
}

/** Subscribe to the moment newsletter autologin settles. No-op if already settled. */
export function subscribeNewsletterAutologin(cb: () => void): () => void {
 if (!inFlight) return () => {};
 subscribers.add(cb);
 return () => { subscribers.delete(cb); };
}

/** Mark newsletter autologin settled (success or failure) and notify subscribers. Idempotent. */
export function settleNewsletterAutologin(): void {
 if (!inFlight) return;
 inFlight = false;
 for (const cb of Array.from(subscribers)) {
 try { cb(); } catch { /* a listener error must not block settle */ }
 }
 subscribers.clear();
}

// Safety backstop: never suppress sign-in affordances indefinitely if the
// exchange hangs or the owning handler never settles.
if (inFlight && typeof window !== 'undefined') {
 window.setTimeout(settleNewsletterAutologin, 8000);
}
