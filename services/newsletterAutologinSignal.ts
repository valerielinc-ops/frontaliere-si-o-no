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

let inFlight = ((): boolean => {
 if (typeof window === 'undefined') return false;
 try {
 const p = new URLSearchParams(window.location.search);
 const action = p.get('action');
 if (action === 'unsubscribe' || action === 'resubscribe') return false;
 const hasCode = Boolean(p.get('ac') || p.get('at') || p.get('authToken'));
 const hasEmail = Boolean(p.get('ne') || p.get('newsletter_email') || p.get('email'));
 return hasCode && hasEmail;
 } catch {
 return false;
 }
})();

const subscribers = new Set<() => void>();

export function isNewsletterAutologinInFlight(): boolean {
 return inFlight;
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
