/**
 * stop-reply-detect.mjs — SINGLE SOURCE of the "is this inbound reply an opt-out?"
 * detection used by BOTH the inbound CF Email Worker
 * (infra/cloudflare-email-worker/stop-reply-handler.js) AND the cron/poll
 * processor (scripts/process-stop-replies.mjs).
 *
 * Keeping one copy means the webhook and the batch processor classify replies
 * identically — no drift (AGENTS.md Non-Negotiable #6). Pure ESM, no node
 * imports, so the Cloudflare Worker runtime can import it too.
 *
 * A reply counts as an opt-out when its subject OR body contains a standalone
 * STOP / UNSUBSCRIBE intent token. We match on word boundaries so a STOP inside
 * an unrelated word ("nonstop", "stopover", "unsubscribed already, thanks") does
 * not over-suppress, while the common real-world forms DO match:
 *   "STOP", "stop", "Stop.", "UNSUBSCRIBE", "annullare l'iscrizione",
 *   "rimuovetemi", "cancellatemi", "non scrivetemi più", "remove me".
 */

// Intent tokens, matched case-insensitively on word boundaries. Italian +
// English (the two languages the cold-email footer and recipients use). Ordered
// roughly by frequency; the regex is anchored with \b so substrings inside
// larger words never match.
export const STOP_INTENT_PATTERNS = [
  /\bstop\b/i,
  /\bunsubscribe\b/i,
  /\bunsub\b/i,
  /\bdisiscriv\w*/i, // disiscrivere / disiscrivetemi / disiscrizione
  /\brimuovet?em?i\b/i, // rimuovetemi / rimuovimi / rimuoveteci
  /\bcancellat?em?i\b/i, // cancellatemi / cancellami
  /\bcancellate(?:mi|ci)?\b/i,
  /\bremove\s+me\b/i,
  /\bopt[\s-]?out\b/i,
  /non\s+(?:mi\s+)?(?:scriv|contatt|invi|mandat?)\w*\s+pi[uù]/i, // "non scrivetemi più" / "non contattatemi più"
  /annull\w*\s+l\W?iscrizione/i, // "annullare l'iscrizione"
];

/**
 * True if the given subject/body text expresses an opt-out / STOP intent.
 * Either field may be empty; we concatenate and test once.
 *
 * @param {{subject?: string, body?: string, text?: string}} parts
 * @returns {boolean}
 */
export function isStopReply({ subject = '', body = '', text = '' } = {}) {
  const haystack = `${subject || ''}\n${body || text || ''}`;
  if (!haystack.trim()) return false;
  return STOP_INTENT_PATTERNS.some((re) => re.test(haystack));
}

// Subject shapes an autoresponder uses. MIRRORED verbatim in
// infra/cloudflare-email-worker/stop-reply-handler.js (the Worker keeps its own
// copy rather than importing across the wrangler bundle boundary, same as
// STOP_INTENT_PATTERNS above); tests/cf-email-worker-stop-reply-handler.test.ts
// asserts the two sources are byte-identical, so drift fails CI instead of
// relying on this comment.
//
// Anchored at the start (after any Re:/AW:/R: prefix chain) or bracketed at the
// end — the two forms real out-of-office subjects take ("Out of office Re: …",
// "Automatic reply: …", "… [Out of Office]"). Never a bare substring match, so
// a human writing "Re: our out of office policy" is not dropped.
export const AUTO_REPLY_SUBJECT_MARKER =
  'out\\s+of\\s+(?:the\\s+)?office|automatic(?:al)?\\s+repl(?:y|ies)|auto[\\s-]?repl(?:y|ies)|automatische\\s+antwort|abwesenheits?notiz|risposta\\s+automatica|assente\\s+dall\\W?ufficio|fuori\\s+sede|r[ée]ponse\\s+automatique|absence\\s+du\\s+bureau|respuesta\\s+autom[áa]tica';
export const AUTO_REPLY_SUBJECT_PATTERNS = [
  new RegExp(`^\\s*(?:(?:re|r|aw|antw|rif|tr|fwd?)\\s*:\\s*)*(?:${AUTO_REPLY_SUBJECT_MARKER})`, 'i'),
  new RegExp(`[[(]\\s*(?:${AUTO_REPLY_SUBJECT_MARKER})\\s*[\\])]\\s*$`, 'i'),
];

/**
 * True when a queued reply looks like an automatic response rather than a human
 * one, judged on the subject alone.
 *
 * The Worker (stop-reply-handler.js:isAutoReply) decides this from the RFC 3834
 * headers first and only falls back to the subject. A queue entry is
 * `{ from, subject, body }` with the headers already stripped, so the subject is
 * all this side has — which is why the patterns stay conservative.
 *
 * Without this gate an out-of-office whose footer happens to carry the word
 * "unsubscribe" is classified as a real STOP and suppresses a company that
 * never asked to be removed.
 *
 * Deliberately SUBJECT-ONLY, and not extended to the body: the two sides fail
 * in opposite directions. Dropping a real auto-reply costs nothing, but
 * skipping a genuine STOP means we keep emailing someone who asked us to stop —
 * a CAN-SPAM/nDSG problem, not a nuisance. A body mention of "out of office" is
 * ambiguous ("I'll be out of office next week, but unsubscribe me anyway"),
 * while an "Out of office Re: …" SUBJECT is unambiguously machine-generated. So
 * the queue side stays narrow on purpose; the Worker, which has the RFC 3834
 * headers, is where broad detection belongs.
 *
 * @param {{subject?: string}} parts
 * @returns {boolean}
 */
export function isAutoReplySubject({ subject = '' } = {}) {
  return AUTO_REPLY_SUBJECT_PATTERNS.some((re) => re.test(String(subject || '')));
}

/**
 * Extract a bare email address from a raw From/Sender header value, e.g.
 *   "Denise Rossi <denise@casale.ch>"  → "denise@casale.ch"
 *   "denise@casale.ch"                 → "denise@casale.ch"
 * Returns '' if no address is found. Lower-cased for stable matching against the
 * contacts registry.
 *
 * @param {string} fromHeader
 * @returns {string}
 */
export function extractSenderEmail(fromHeader) {
  const raw = String(fromHeader || '').trim();
  if (!raw) return '';
  const angle = raw.match(/<([^>]+)>/);
  const candidate = (angle ? angle[1] : raw).trim();
  const m = candidate.match(/[^\s<>"']+@[^\s<>"']+\.[^\s<>"']+/);
  return m ? m[0].toLowerCase().replace(/[).,;]+$/, '') : '';
}
