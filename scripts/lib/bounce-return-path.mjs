/**
 * bounce-return-path.mjs — the address our outbound mail carries as envelope
 * sender, and therefore the address every delivery report (RFC 3464 bounce)
 * comes back to.
 *
 * One module rather than two literals, because the two sides must agree or the
 * bounces stop being recorded: `scripts/cf-email-worker-setup.mjs` binds this
 * address to the Email Routing worker, and `scripts/set-maileroo-return-path.mjs`
 * sets it as the Maileroo `return_path`. A report arriving at an address that
 * is NOT bound falls into the zone catch-all, which forwards to the human inbox
 * WITHOUT running the worker — the exact silent hole that
 * functions/src/inboundBounceReport.js exists to close.
 *
 * Today the field still reads `abuse` (measured 2026-08-21), which works —
 * abuse@ is bound — but conflates delivery reports with the RFC 2142 mailbox
 * for complaints. Moving it here separates the two without changing behaviour.
 */

export const MAIL_DOMAIN = 'frontaliereticino.ch';

/** Local part only: this is what Maileroo's `return_path` field stores. */
export const BOUNCE_LOCAL_PART = 'bounce';

export const BOUNCE_ADDRESS = `${BOUNCE_LOCAL_PART}@${MAIL_DOMAIN}`;

/** The Email Routing worker every bound address is routed to. */
export const EMAIL_WORKER_NAME = 'frontaliere-stop-reply-handler';
