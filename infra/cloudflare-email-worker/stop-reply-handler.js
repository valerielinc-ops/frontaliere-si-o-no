/**
 * stop-reply-handler.js — Cloudflare Email Routing Worker for inbound
 * STOP/UNSUBSCRIBE replies (follow-up #2620, item 2; extended for the
 * newsletter mailbox — Apple Mail's `List-Unsubscribe` mailto: fallback lands
 * here as a plain email, e.g. "Please unsubscribe x@y.ch from Frontaliere
 * Weekly").
 *
 * Cloudflare Email Routing forwards every @frontaliereticino.ch message; this
 * Worker is bound (Email Routing → custom address → "Send to a Worker") to TWO
 * addresses, both routed to the SAME worker, branched on the recipient
 * (`message.to`):
 *   - the cold-email outreach reply address (e.g.
 *     valerie@frontaliereticino.ch — anything not matching NEWSLETTER_ADDRESS
 *     below) → handleOutreachReply
 *   - the newsletter mailbox (env.NEWSLETTER_ADDRESS, newsletter@…) →
 *     handleNewsletterUnsubscribe
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
 * additive, not a replacement for reading replies.
 *
 * STOP-intent detection MIRRORS scripts/lib/stop-reply-detect.mjs (single
 * source) — kept in lockstep (AGENTS.md Non-Negotiable #6); both are
 * unit-tested (tests/stop-reply-detect.test.ts, tests/cf-email-worker-stop-reply-handler.test.ts).
 *
 * Deploy + config are AUTOMATED by .github/workflows/deploy-email-worker.yml
 * (wrangler deploy + scripts/cf-email-worker-setup.mjs). Bindings:
 *   vars (wrangler.toml): STOP_REPLY_FN_URL, REPLY_TRACK_FN_URL,
 *                          NEWSLETTER_UNSUB_URL, NEWSLETTER_ADDRESS
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
// (services/newsletterUrls.mjs:signedEmailToken), which the Worker runtime
// cannot call directly (no node:crypto).
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
    const from = message.from || '';
    const to = String(message.to || '').trim().toLowerCase();
    const subject = (message.headers && message.headers.get && message.headers.get('subject')) || '';

    const isNewsletterAddress = !!env.NEWSLETTER_ADDRESS && to === env.NEWSLETTER_ADDRESS.toLowerCase();
    if (isNewsletterAddress) {
      await handleNewsletterUnsubscribe({ from, subject, message, env, ctx });
    } else {
      await handleOutreachReply({ from, subject, message, env, ctx });
    }

    // ALWAYS forward to the human inbox so no reply is ever lost.
    if (env.FORWARD_TO) {
      try { await message.forward(env.FORWARD_TO); } catch { /* recipient may be unverified; ignore */ }
    }
  },
};
