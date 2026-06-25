/**
 * parseEmailField — robustly split a stored email field that may be a bare
 * address ("mario.rossi@example.com") OR an RFC822 display form ("Mario Rossi
 * <mario.rossi@example.com>" / "\"Mario Rossi\" <mario.rossi@example.com>").
 *
 * Some subscriber records were written with the full display string in the
 * `email` field instead of a separate `name`. Left raw, that string leaks into
 * the To: header and unsubscribe links (verified live 2026-06-25: a subscriber
 * whose `email` held "Name <addr>" received To: that exact string and a
 * polluted List-Unsubscribe param), and the human name sitting inside it never
 * reaches the greeting.
 *
 * Returns the bare lowercased address (what To:/unsubscribe/doc-lookups want)
 * plus the ORIGINAL-case display name (null when absent) so the newsletter can
 * fall back to it as a greeting-name source.
 *
 * @param {unknown} raw
 * @returns {{ email: string, displayName: string | null }}
 */
export function parseEmailField(raw) {
  const str = String(raw || '').trim();
  if (!str) return { email: '', displayName: null };

  // "Display Name <addr@host>" (optionally quoted display name).
  const angle = str.match(/^(.*?)<\s*([^<>\s]+)\s*>\s*$/);
  if (angle) {
    const name = angle[1].trim().replace(/^"(.*)"$/, '$1').trim();
    const email = angle[2].trim().toLowerCase();
    // A "name" that is itself an address (or empty) is not a human name.
    return { email, displayName: name && !name.includes('@') ? name : null };
  }

  return { email: str.toLowerCase(), displayName: null };
}

/**
 * Bare lowercased address from an email field, stripping any display name.
 * Drop-in replacement for the old `trim().toLowerCase()` normalizer that also
 * handles the "Name <addr>" form.
 * @param {unknown} raw
 * @returns {string}
 */
export function normalizeEmailAddress(raw) {
  return parseEmailField(raw).email;
}
