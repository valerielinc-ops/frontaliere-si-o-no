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
