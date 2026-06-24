/**
 * stop-reply-handler.js — Cloudflare Email Routing Worker for inbound cold-email
 * replies (follow-up #2620, item 2).
 *
 * Cloudflare Email Routing forwards every @frontaliereticino.ch message; this
 * Worker is bound (Email Routing → custom address → "Send to a Worker") to the
 * outreach reply address (the cold-email `From`, e.g. valerie@frontaliereticino.ch
 * via OUTREACH_FROM_ADDRESS). On each inbound message it:
 *   1. Parses the From header + subject + a bounded prefix of the text body.
 *   2. If it expresses a STOP / UNSUBSCRIBE intent, POSTs { from, subject, body }
 *      to the outreachStopReply Cloud Function (secret-gated via STOP_SECRET),
 *      which reverse-maps the sender → companyKey and writes
 *      employer_outreach_suppression/{companyKey} — the SAME suppression
 *      send-cold-emails.mjs honours.
 *   3. ALWAYS forwards the original message to the human inbox (FORWARD_TO) so no
 *      reply is ever swallowed — STOP handling is additive, not a replacement for
 *      reading replies.
 *
 * Detection MIRRORS scripts/lib/stop-reply-detect.mjs (single source) — kept in
 * lockstep (AGENTS.md Non-Negotiable #6); both are unit-tested.
 *
 * Bindings (wrangler.email.toml / dashboard):
 *   vars:    STOP_REPLY_FN_URL  (https://europe-west6-frontaliere-ticino.cloudfunctions.net/outreachStopReply)
 *            REPLY_TRACK_FN_URL (https://europe-west6-frontaliere-ticino.cloudfunctions.net/outreachReplyTrack)
 *            FORWARD_TO         (the human inbox to forward every reply to)
 *   secret:  STOP_SECRET        (== NEWSLETTER_SECRET; `wrangler secret put STOP_SECRET`)
 *
 * NOTE: binding the Worker to the inbound address in Cloudflare Email Routing is a
 * manual dashboard/API step (declared in the PR's ## Non implementato) — the code
 * here is the handler that step points at.
 */

// MIRROR of scripts/lib/stop-reply-detect.mjs STOP_INTENT_PATTERNS. Keep in sync.
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

function isStopReply(subject, body) {
  const haystack = `${subject || ''}\n${body || ''}`;
  if (!haystack.trim()) return false;
  return STOP_INTENT_PATTERNS.some((re) => re.test(haystack));
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

export default {
  /**
   * Cloudflare Email Routing entrypoint.
   * @param {EmailMessage} message
   * @param {Record<string, string>} env
   * @param {ExecutionContext} ctx
   */
  async email(message, env, ctx) {
    const from = message.from || '';
    const subject = (message.headers && message.headers.get && message.headers.get('subject')) || '';

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

    // Detect on subject first (cheap); read the body only if needed.
    let body = '';
    if (!isStopReply(subject, '')) {
      body = await readBodyPrefix(message.raw);
    }

    if (isStopReply(subject, body) && env.STOP_REPLY_FN_URL && env.STOP_SECRET) {
      // Fire-and-forget the suppression POST; never block forwarding on it.
      const suppress = fetch(env.STOP_REPLY_FN_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-stop-secret': env.STOP_SECRET },
        body: JSON.stringify({ from, subject, body: body.slice(0, 2000) }),
      }).catch(() => { /* best-effort; the cron processor is the safety net */ });
      ctx.waitUntil(suppress);
    }

    // ALWAYS forward to the human inbox so no reply is lost.
    if (env.FORWARD_TO) {
      try { await message.forward(env.FORWARD_TO); } catch { /* recipient may be unverified; ignore */ }
    }
  },
};
