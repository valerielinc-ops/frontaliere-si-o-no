/**
 * Shared contact-PII sanitizer for scraped job descriptions.
 *
 * Dedicated-employer crawlers copy the vacancy body verbatim from the source
 * ATS, and many of those bodies name an individual recruiter contact plus their
 * direct phone number, e.g.:
 *
 *   "Per qualsiasi chiarimento puoi contattare Luca Bianchi (tel. 058 123 45 67)
 *    quando vuoi. Agenzia generale Mario Rossi …"
 *
 * Re-publishing a named person's direct line is personal data we have no basis
 * to mirror (it triggered an erasure request, 2026-06-05). This strips the
 * recruiter name + direct phone while keeping the rest of the description intact,
 * so the listing still funnels candidates to the official application form.
 *
 * Scope: originally built for the insurer crawler where the 2026-06-05 erasure
 * request originated (that crawler has since been removed entirely); now wired
 * into the josef-mueller, holmes-place, swisslog and hirslanden parsers. The
 * helper is employer-agnostic on
 * purpose, so it can later be lifted to the assemble-time chokepoint
 * (`scripts/assemble-jobs-dataset.mjs`) to sanitize every crawler's slices and
 * locale translations by construction, should a corpus-wide policy be adopted.
 *
 * Precision over recall: a capitalized bigram/trigram is treated as a person
 * name ONLY when it is immediately tied to a phone parenthetical `(tel. …)`.
 * That phone anchor avoids stripping ordinary capitalized word pairs (company
 * names, city names, headings). Identified names are then removed from the rest
 * of the same description (e.g. the address block "Agenzia generale <Name>").
 *
 * Idempotent: running it twice yields the same output.
 */

// Swiss phone numbers: landline "058 123 45 67" / "091 123 45 67" and mobile
// "076 123 45 67", with optional "+41" country prefix and any of space / dot /
// slash / hyphen as group separators. The 4-group 0XX-XXX-XX-XX shape (or +41
// equivalent) is specific enough that 4-digit postal codes (6500), years (2026)
// and salary figures (7500) do not match.
const SWISS_PHONE_RX =
  /(?:\+41[\s./-]?|0)\d{1,2}[\s./-]?\d{3}[\s./-]?\d{2}[\s./-]?\d{2}\b/g;

// A person name: 2–3 capitalized tokens. Each token is a single capital letter
// followed by a run of LOWERCASE letters (plus apostrophe/hyphen/dot). Using a
// lowercase-only continuation — disjoint from the capital that starts the NEXT
// token — keeps the match LINEAR: there is no nested unbounded quantifier over
// overlapping character classes, so a long run of Capitalized Words that is NOT
// followed by a phone parenthetical cannot trigger catastrophic backtracking.
// Used only when anchored to a "(tel. …)" parenthetical (steps 1–2).
const NAME = "[A-ZÀ-Þ][a-zà-öø-ÿ'’.-]*(?:\\s+[A-ZÀ-Þ][a-zà-öø-ÿ'’.-]*){1,2}";

// "contattare/contatti/rivolgersi a/chiamare/telefonare a <Name> (tel. …)".
// NOTE: no global `i` flag here — it would make `[A-ZÀ-Þ]` in NAME match
// lowercase too, defeating the "capitalized token only" precision guard (a
// lowercase phrase before "(tel. …)" would be captured as a name and removed
// elsewhere). Case-insensitivity is scoped to the verb's leading letter only,
// so a sentence-initial "Contattare" still matches.
const CONTACT_VERB_RX = new RegExp(
  `\\b([Cc]ontatt\\w+|[Rr]ivolgersi a|[Cc]hiamare|[Tt]elefonare a|[Ss]crivere a)\\s+(${NAME})\\s*\\(\\s*[Tt]el\\.?[^)]{0,40}\\)`,
  'gu',
);

// Bare "<Name> (tel. …)" not preceded by a contact verb. No `i` flag — NAME must
// start uppercase (see CONTACT_VERB_RX note).
const NAME_PHONE_RX = new RegExp(`(${NAME})\\s*\\(\\s*[Tt]el\\.?[^)]{0,40}\\)`, 'gu');

// Any leftover phone parenthetical "(tel. …)" / "(Tel. …)".
const PHONE_PAREN_RX = /\(\s*tel\.?[^)]{0,40}\)/giu;

// Italian street-prefix words that open the address line right after the agency
// designation (the locale-translated variant collapses newlines to spaces, so
// the street prefix is the only structural marker left).
const STREET_PREFIX = 'Piazza|Piazzale|Via|Viale|Corso|Strada|Stradone|Vicolo|Largo|Salita|Contrada|Lungolago|Galleria|Stabile';

// The agency designation that may embed the agent's name, across the four
// locales the crawler emits (the IT source plus EN/DE/FR translations):
//   IT "Agenzia generale" · EN "General Agency" · DE "Allgemeine Agentur"
//   · FR "Agence générale". (DE occasionally leaves the EN form untranslated.)
const AGENCY_DESIGNATION = 'Agenzia generale|General Agency|Allgemeine Agentur|Agence générale';

// "<Agency designation> <First> <Last>" address line → "<Agency designation>".
// The agent's name occupies its own address line; it is followed EITHER by a
// newline / end-of-text (the `description` field keeps line breaks) OR by an
// Italian street prefix (the single-line locale variants, where the street name
// stays Italian). Both anchors discriminate a two-token person name from a
// single-word city/region designation ("Agenzia generale Bellinzona Piazza…",
// "…Sopraceneri\n…"): those have ONE token before the anchor, so the mandatory
// second token makes them non-matching and preserved. One capital + lowercase
// run per token → linear, no catastrophic backtracking.
const AGENCY_PERSON_RX = new RegExp(
  `(${AGENCY_DESIGNATION})\\s+[A-ZÀ-Þ][a-zà-öø-ÿ'’-]+\\s+[A-ZÀ-Þ][a-zà-öø-ÿ'’-]+` +
    `(?=[ \\t]*(?:\\n|$)|\\s+(?:${STREET_PREFIX})\\b)`,
  'gu',
);

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Remove recruiter-contact PII (name + direct phone) from a description string.
 *
 * @param {string} text
 * @returns {string}
 */
export function stripContactPII(text) {
  if (typeof text !== 'string' || !text) return text;

  const names = new Set();
  let out = text;
  let removed = false;

  // 1. "contattare <Name> (tel. …)" → keep the sentence, drop name + phone.
  out = out.replace(CONTACT_VERB_RX, (_m, verb, name) => {
    names.add(name.trim());
    removed = true;
    return `${verb} l'agenzia`;
  });

  // 2. Bare "<Name> (tel. …)" → drop name + phone.
  out = out.replace(NAME_PHONE_RX, (_m, name) => {
    names.add(name.trim());
    removed = true;
    return "l'agenzia";
  });

  // 3. Any remaining "(tel. …)" parenthetical (phone without a captured name).
  out = out.replace(PHONE_PAREN_RX, () => {
    removed = true;
    return '';
  });

  // 4. Standalone Swiss phone numbers anywhere in the body.
  out = out.replace(SWISS_PHONE_RX, () => {
    removed = true;
    return '';
  });

  // 4b. Agency designation that embeds a person's name, e.g.
  //     "Agenzia generale Mario Rossi" → "Agenzia generale". Requires
  //     exactly two capitalized First+Last tokens, so single-token city/region
  //     designations ("Agenzia generale Bellinzona/Sopraceneri/Lugano/Coira")
  //     are preserved. The trailing lookahead stops before the street address.
  out = out.replace(AGENCY_PERSON_RX, (_m, designation) => {
    removed = true;
    return designation;
  });

  // Nothing matched → return the ORIGINAL untouched. This guard is essential:
  // without it the tidy step below would re-flow whitespace/punctuation on every
  // description in the corpus (e.g. the French typographic space before ":"),
  // producing massive churn unrelated to any PII removal.
  if (!removed) return text;

  // 5. Remove the identified recruiter name(s) elsewhere (e.g. the address block
  //    "Agenzia generale Mario Rossi" → "Agenzia generale").
  for (const name of names) {
    out = out.replace(new RegExp(`\\s*${escapeRegExp(name)}`, 'gu'), '');
  }

  // 6. Tidy ONLY the artifacts the removals can create — no global punctuation
  //    normalization. Stripping a number from a "(Name, 056 …)" list leaves a
  //    dangling ", )" / "( )"; deletions leave double spaces.
  out = out
    .replace(/,\s*\)/g, ')')
    .replace(/\(\s*\)/g, '')
    .replace(/[ \t]{2,}/g, ' ')
    // Only period/comma — NOT ":"/";" which carry a legitimate French
    // typographic space before them in the localized descriptions.
    .replace(/ +([.,])/g, '$1')
    .trim();

  return out;
}

export default stripContactPII;
