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
 * Canonical home for this parser is here (functions/src/lib) — Cloud
 * Functions ships without a bundler, so anything it imports must live inside
 * functions/. scripts/lib/parseEmailField.mjs re-exports from this file.
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
    // The inner token can still be a non-address (e.g. "<a@x,b@y>" — the regex
    // allows commas) — don't trust it unvalidated, or it seeds a bogus key.
    if (!isBareAddress(email)) return { email: '', displayName: null };
    // A "name" that is itself an address (or empty) is not a human name.
    return { email, displayName: name && !name.includes('@') ? name : null };
  }

  // Bare-address fallback. Degenerate forms the angle branch rejected ("Name
  // <a@x, b@y>", an address with an internal space) and name-only strings reach
  // here; a plain toLowerCase() would return a truthy NON-address that becomes a
  // bogus subscriber key downstream (subscriberFromFirestoreRow only guards on a
  // falsy email). Validate the shape and emit an empty (falsy) address instead.
  const bare = str.toLowerCase();
  return isBareAddress(bare) ? { email: bare, displayName: null } : { email: '', displayName: null };
}

/**
 * Whether a string is a single usable bare address: exactly one `@` with no
 * whitespace, angle brackets, or commas on either side. Rejects name-only
 * strings, multi-address lists, and degenerate wrapped forms so they never
 * become a (truthy) subscriber key. Intentionally permissive on the local/
 * domain charset — full RFC5322 validation is out of scope; the goal is only to
 * reject the clearly-not-an-address fallbacks the parser would otherwise pass
 * through.
 * @param {string} s
 * @returns {boolean}
 */
function isBareAddress(s) {
  return /^[^\s<>,@]+@[^\s<>,@]+$/.test(s);
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
