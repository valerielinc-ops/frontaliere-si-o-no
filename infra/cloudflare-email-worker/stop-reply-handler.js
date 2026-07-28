/**
 * stop-reply-handler.js — Cloudflare Email Routing Worker for inbound
 * STOP/UNSUBSCRIBE replies (follow-up #2620, item 2; extended for the
 * newsletter mailbox — Apple Mail's `List-Unsubscribe` mailto: fallback lands
 * here as a plain email, e.g. "Please unsubscribe x@y.ch from Frontaliere
 * Weekly").
 *
 * Cloudflare Email Routing forwards every @frontaliereticino.ch message; this
 * Worker is bound (Email Routing → custom address → "Send to a Worker") to the
 * addresses in scripts/cf-email-worker-setup.mjs's ROUTING_RULES, all routed to
 * the SAME worker and branched on the recipient (`message.to`):
 *   - the cold-email outreach reply address (env.OUTREACH_ADDRESS,
 *     valerie@…) → handleOutreachReply
 *   - the newsletter mailbox (env.NEWSLETTER_ADDRESS, newsletter@…) →
 *     handleNewsletterUnsubscribe
 *   - every other bound address (alerts@, abuse@, …, i.e. the addresses our
 *     outbound mail is sent FROM, where autoresponders reply) → no
 *     classification at all, forward only
 *
 * Before ANY of that, an inbound message that is an automatic response
 * (out-of-office, autoresponder — RFC 3834) is dropped: see isAutoReply.
 *
 * handleOutreachReply, on a STOP/UNSUBSCRIBE intent, POSTs { from, subject,
 * body } to the outreachStopReply Cloud Function (secret-gated via
 * STOP_SECRET), which reverse-maps the sender → companyKey and writes
 * employer_outreach_suppression/{companyKey} — the SAME suppression
 * send-cold-emails.mjs honours.
 *
 * handleNewsletterUnsubscribe, on a STRICTER intent match
 * (NEWSLETTER_STOP_INTENT_PATTERNS below — explicit opt-out vocabulary only,
 * since this path writes an ACTUAL Firestore unsubscribe for a real
 * subscriber, not just a suppression flag), HMAC-signs the sender address
 * (Web Crypto — no node:crypto in Workers) with STOP_SECRET (==
 * NEWSLETTER_SECRET) and calls the SAME one-click endpoint the newsletter's
 * own unsubscribe link/List-Unsubscribe header uses
 * (services/newsletterUrls.mjs:makeOneClickUnsubscribeUrl →
 * newsletterManageSubscription Cloud Function) — no new suppression path, no
 * new secret.
 *
 * Either way the Worker ALWAYS forwards the original message to the human
 * inbox (FORWARD_TO) so no reply is ever swallowed — STOP handling is
 * additive, not a replacement for reading replies. The ONE exception is an
 * automatic response (isAutoReply), which is accepted and discarded.
 *
 * STOP-intent detection MIRRORS scripts/lib/stop-reply-detect.mjs (single
 * source) — kept in lockstep (AGENTS.md Non-Negotiable #6); both are
 * unit-tested (tests/stop-reply-detect.test.ts, tests/cf-email-worker-stop-reply-handler.test.ts).
 *
 * Deploy + config are AUTOMATED by .github/workflows/deploy-email-worker.yml
 * (wrangler deploy + scripts/cf-email-worker-setup.mjs). Bindings:
 *   vars (wrangler.toml): STOP_REPLY_FN_URL, REPLY_TRACK_FN_URL,
 *                          NEWSLETTER_UNSUB_URL, NEWSLETTER_ADDRESS,
 *                          OUTREACH_ADDRESS
 *   secrets (CF API, set by the setup script): STOP_SECRET (== NEWSLETTER_SECRET),
 *            FORWARD_TO (the human inbox; resolved from the zone catch-all target)
 *
 * The inbound bindings (both addresses → "send to worker") are also set by the
 * setup script via the Email Routing API — no manual dashboard step.
 */

// MIRROR of scripts/lib/stop-reply-detect.mjs STOP_INTENT_PATTERNS. Keep in
// sync. Outreach-reply path only — a suppression flag on a company-owned
// mailbox, so the loose conversational forms ("stop", "remove me") are an
// acceptable false-positive rate.
const STOP_INTENT_PATTERNS = [
  /\bstop\b/i,
  /\bunsubscribe\b/i,
  /\bunsub\b/i,
  /\bdisiscriv\w*/i,
  /\brimuovet?em?i\b/i,
  /\bcancellat?em?i\b/i,
  /\bcancellate(?:mi|ci)?\b/i,
  /\bremove\s+me\b/i,
  /\bopt[\s-]?out\b/i,
  /non\s+(?:mi\s+)?(?:scriv|contatt|invi|mandat?)\w*\s+pi[uù]/i,
  /annull\w*\s+l\W?iscrizione/i,
];

// Newsletter-mailbox path only. Its trigger writes an ACTUAL Firestore
// unsubscribe for a real subscriber (stronger than the outreach path's
// suppression flag), so it matches ONLY explicit opt-out vocabulary — no
// standalone "stop" or "remove me", which show up in ordinary reader replies
// ("will this stop working next month?", "please remove me from your
// spreadsheet, not the newsletter") and would opt someone out by mistake.
const NEWSLETTER_STOP_INTENT_PATTERNS = [
  /\bunsubscribe\b/i,
  /\bunsub\b/i,
  /\bdisiscriv\w*/i,
  /\bopt[\s-]?out\b/i,
  /annull\w*\s+l\W?iscrizione/i,
];

// MIRROR of scripts/lib/stop-reply-detect.mjs AUTO_REPLY_SUBJECT_MARKER /
// AUTO_REPLY_SUBJECT_PATTERNS (the queue-side processor needs the same subject
// rules). Kept byte-identical by an assertion in
// tests/cf-email-worker-stop-reply-handler.test.ts — drift fails CI.
//
// Subject shapes autoresponders use when they omit the RFC 3834 headers below.
// Anchored at the start (after any Re:/AW:/R: prefix chain) or bracketed at the
// end — the two forms real out-of-office subjects take ("Out of office Re: …",
// "Automatic reply: …", "… [Out of Office]"). Never a bare substring match, so
// a human writing "Re: our out of office policy" is not dropped.
const AUTO_REPLY_SUBJECT_MARKER =
  'out\\s+of\\s+(?:the\\s+)?office|automatic(?:al)?\\s+repl(?:y|ies)|auto[\\s-]?repl(?:y|ies)|automatische\\s+antwort|abwesenheits?notiz|risposta\\s+automatica|assente\\s+dall\\W?ufficio|fuori\\s+sede|r[ée]ponse\\s+automatique|absence\\s+du\\s+bureau|respuesta\\s+autom[áa]tica';
const AUTO_REPLY_SUBJECT_PATTERNS = [
  new RegExp(`^\\s*(?:(?:re|r|aw|antw|rif|tr|fwd?)\\s*:\\s*)*(?:${AUTO_REPLY_SUBJECT_MARKER})`, 'i'),
  new RegExp(`[[(]\\s*(?:${AUTO_REPLY_SUBJECT_MARKER})\\s*[\\])]\\s*$`, 'i'),
];

/**
 * RFC 3834 (+ de-facto vendor headers) automatic-response detection.
 *
 * An out-of-office / autoresponder is NOT a human reply, and treating it as one
 * is wrong three separate ways:
 *   1. it is forwarded to the human inbox as pure noise (the incident that
 *      started this: a vacation responder answering a job-alert send landed in
 *      the owner's inbox via the zone catch-all);
 *   2. handleOutreachReply records it through outreachReplyTrack, so the admin
 *      dashboard shows "this company replied" when nobody did;
 *   3. the STOP/unsubscribe intent patterns run over its body — and a corporate
 *      auto-reply footer routinely carries the word "unsubscribe", which on the
 *      newsletter path writes a REAL Firestore unsubscribe for a subscriber who
 *      never asked for one.
 *
 * So a detected auto-reply is accepted and discarded: not classified, not
 * tracked, not forwarded.
 *
 * @param {{ get?: (name: string) => string | null | undefined } | null | undefined} headers
 * @param {string} [subject]
 * @returns {boolean}
 */
export function isAutoReply(headers, subject = '') {
  const header = (name) => {
    try { return String(headers?.get?.(name) ?? '').trim().toLowerCase(); }
    catch { return ''; }
  };

  // RFC 3834 §5: any value other than the explicit "no" marks an automatically
  // generated message (auto-replied / auto-generated / auto-notified).
  const autoSubmitted = header('auto-submitted');
  if (autoSubmitted && autoSubmitted !== 'no') return true;

  // De-facto vendor markers (Gmail vacation responder, Exchange, cPanel,
  // Zimbra, older Sendmail-era autoresponders).
  if (['yes', 'true', '1'].includes(header('x-autoreply'))) return true;
  if (header('x-autorespond')) return true;
  if (header('x-autoreply-from')) return true;

  const precedence = header('precedence');
  if (precedence === 'auto_reply' || precedence === 'auto-reply') return true;
  // `Precedence: bulk|list|junk` alone is ambiguous — plenty of human-sent mail
  // from mailing lists carries it — so it only counts alongside a second
  // automated signal (Exchange stamps X-Auto-Response-Suppress on its own
  // generated mail).
  if (['bulk', 'list', 'junk'].includes(precedence) && header('x-auto-response-suppress')) return true;

  return AUTO_REPLY_SUBJECT_PATTERNS.some((re) => re.test(String(subject || '')));
}

export function isStopReply(subject, body, patterns = STOP_INTENT_PATTERNS) {
  const haystack = `${subject || ''}\n${body || ''}`;
  if (!haystack.trim()) return false;
  return patterns.some((re) => re.test(haystack));
}

// MIRROR of scripts/lib/stop-reply-detect.mjs extractSenderEmail. Keep in sync.
export function extractSenderEmail(fromHeader) {
  const raw = String(fromHeader || '').trim();
  if (!raw) return '';
  const angle = raw.match(/<([^>]+)>/);
  const candidate = (angle ? angle[1] : raw).trim();
  const m = candidate.match(/[^\s<>"']+@[^\s<>"']+\.[^\s<>"']+/);
  return m ? m[0].toLowerCase().replace(/[).,;]+$/, '') : '';
}

// Web Crypto HMAC-SHA256 hex digest — byte-identical to Node's
// createHmac('sha256', secret).update(message).digest('hex')
// (functions/src/lib/newsletterUrls.js:signedEmailToken, re-exported for
// scripts/ callers via services/newsletterUrls.mjs), which the Worker
// runtime cannot call directly (no node:crypto).
export async function hmacHex(secret, message) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(message));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// Read a bounded prefix of the raw email stream as text. We only need the first
// few KB — a STOP intent in a reply lives at the top, and reading the whole MIME
// body (attachments etc.) would waste Worker CPU/memory.
async function readBodyPrefix(stream, maxBytes = 8192) {
  if (!stream) return '';
  const reader = stream.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (total < maxBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      total += value.length;
    }
  } catch {
    // best-effort: partial read is enough for STOP detection
  } finally {
    try { reader.releaseLock(); } catch { /* noop */ }
  }
  const merged = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { merged.set(c.subarray(0, Math.min(c.length, maxBytes - off)), off); off += c.length; if (off >= maxBytes) break; }
  return new TextDecoder('utf-8', { fatal: false }).decode(merged.subarray(0, maxBytes));
}

// Detect on subject first (cheap); read the body only if needed. Shared by
// both the outreach and newsletter paths so the "read body lazily" behavior
// can't drift between them.
async function classifyStopIntent(subject, message, patterns) {
  if (isStopReply(subject, '', patterns)) return { stop: true, body: '' };
  const body = await readBodyPrefix(message.raw);
  return { stop: isStopReply(subject, body, patterns), body };
}

async function handleOutreachReply({ from, subject, message, env, ctx }) {
  // Track EVERY inbound reply (best-effort) so the admin dashboard can show
  // whether a company replied. Only from+subject are needed (no body read),
  // so this runs cheaply on every message. Additive to STOP suppression below.
  if (env.REPLY_TRACK_FN_URL && env.STOP_SECRET) {
    const track = fetch(env.REPLY_TRACK_FN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-stop-secret': env.STOP_SECRET },
      body: JSON.stringify({ from, subject }),
    }).catch(() => { /* best-effort telemetry; never block forwarding */ });
    ctx.waitUntil(track);
  }

  const { stop, body } = await classifyStopIntent(subject, message);

  if (stop && env.STOP_REPLY_FN_URL && env.STOP_SECRET) {
    // Fire-and-forget the suppression POST; never block forwarding on it.
    const suppress = fetch(env.STOP_REPLY_FN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-stop-secret': env.STOP_SECRET },
      body: JSON.stringify({ from, subject, body: body.slice(0, 2000) }),
    }).catch(() => { /* best-effort; the cron processor is the safety net */ });
    ctx.waitUntil(suppress);
  }
}

async function handleNewsletterUnsubscribe({ from, subject, message, env, ctx }) {
  const { stop } = await classifyStopIntent(subject, message, NEWSLETTER_STOP_INTENT_PATTERNS);
  if (!stop) return;

  const senderEmail = extractSenderEmail(from);
  if (!senderEmail || !env.STOP_SECRET || !env.NEWSLETTER_UNSUB_URL) return;

  const unsub = (async () => {
    const token = await hmacHex(env.STOP_SECRET, senderEmail);
    const url = `${env.NEWSLETTER_UNSUB_URL}?action=unsubscribe&email=${encodeURIComponent(senderEmail)}&token=${token}&format=json`;
    return fetch(url);
  })().catch(() => { /* best-effort; the recipient still reaches the human inbox below */ });
  ctx.waitUntil(unsub);
}

export default {
  /**
   * Cloudflare Email Routing entrypoint.
   * @param {EmailMessage} message
   * @param {Record<string, string>} env
   * @param {ExecutionContext} ctx
   */
  async email(message, env, ctx) {
    // Everything that reads off `message` before the forward must be
    // throw-proof: a throw here escapes the handler, Email Routing treats the
    // message as failed and the sender gets a bounce — the exact opposite of
    // the "no reply is ever lost" guarantee below. `headers.get` on a malformed
    // or duplicated header is the realistic way that happens.
    let from = '';
    let to = '';
    let subject = '';
    let auto = false;
    // Whether the reads below ALL completed. A partial failure must fail
    // CLOSED: if `headers.get('subject')` throws after `to` already resolved,
    // `auto` keeps its `false` default, so isAutoReply never actually ran — and
    // classifying anyway would send an unexamined message down the STOP path
    // with `subject: ''`, where classifyStopIntent still reads the body. An
    // out-of-office footer carrying the word "unsubscribe" would then suppress
    // a company that never opted out: exactly the bug this filter exists to
    // prevent, re-entered through a partial-read path. Unreadable headers mean
    // we cannot know whether this is an automatic response, so we do not guess
    // — forward only.
    let readOk = false;
    try {
      from = message.from || '';
      // `message.to` is the SMTP envelope-to (RFC 5321 RCPT TO), not the `To:`
      // header (RFC 5322) — envelope addresses are bare per spec, so a
      // display-name wrapper ("Frontaliere Newsletter" <newsletter@…>) should
      // never reach here. Normalized defensively anyway via the same bare-address
      // extraction used for `from` below, in case an upstream relay is
      // non-conformant.
      to = extractSenderEmail(message.to);
      subject = (message.headers && message.headers.get && message.headers.get('subject')) || '';
      auto = isAutoReply(message.headers, subject);
      readOk = true;
    } catch {
      // Unreadable envelope/headers: fall through with the empty defaults and
      // let the forward below still happen. Never classified, never dropped.
    }

    // An automatic response is not a reply: drop it before any classification,
    // tracking or forwarding happens (see isAutoReply for why all three).
    if (auto) return;

    const newsletterAddress = (env.NEWSLETTER_ADDRESS || '').trim().toLowerCase();
    const outreachAddress = (env.OUTREACH_ADDRESS || '').trim().toLowerCase();
    const isNewsletterAddress = !!newsletterAddress && to === newsletterAddress;
    // Only valerie@ + newsletter@ used to be bound here, so "not the newsletter
    // mailbox" was a safe proxy for "the outreach mailbox". Now that the
    // addresses our outbound mail is sent FROM (alerts@, abuse@, …) are bound
    // too, the outreach paths must fire ONLY for the outreach mailbox —
    // otherwise a message to alerts@ would be logged as a company reply and run
    // through STOP suppression. The fallback keeps the pre-OUTREACH_ADDRESS
    // behavior if the var is not deployed yet.
    const isOutreachAddress = outreachAddress ? to === outreachAddress : !isNewsletterAddress;

    try {
      if (!readOk) {
        // Fail closed — see readOk above. Forward untouched, classify nothing.
      } else if (isNewsletterAddress) {
        await handleNewsletterUnsubscribe({ from, subject, message, env, ctx });
      } else if (isOutreachAddress) {
        await handleOutreachReply({ from, subject, message, env, ctx });
      }
    } catch {
      // Classification is best-effort: a throw here must never cost us the
      // forward below (a rejected message would bounce back to the sender).
    }

    // ALWAYS forward to the human inbox so no reply is ever lost.
    if (env.FORWARD_TO) {
      try { await message.forward(env.FORWARD_TO); } catch { /* recipient may be unverified; ignore */ }
    }
  },
};
