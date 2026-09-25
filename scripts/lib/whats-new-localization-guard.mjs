/**
 * whats-new-localization-guard.mjs — refuse to publish a What's New entry that
 * was never actually translated.
 *
 * The generator has two fallback paths (no LLM key, LLM call failed) that used
 * to copy the raw COMMIT SUBJECT into all four locales:
 *
 *   'whatsNew.v3911.seo-gates.title': 'stop rebuilding dist in cathedral-seo-gates-check,'
 *
 * — written verbatim into `it-core.ts`, `de-core.ts` and `fr-core.ts` for a
 * modal that site visitors read. On a site that lives in four languages, an
 * English fragment of build-system vocabulary in the French modal tells the
 * visitor the site is scaffolding. The fallbacks made that the DEFAULT
 * behaviour whenever the key was missing, and the only thing standing between
 * it and production was a human remembering to re-read a generated diff.
 *
 * This module is the structural net: a property, not a heuristic. Nothing is
 * written unless every locale string is demonstrably not the commit text, and
 * the four locales are not all the same string.
 *
 * It is used twice — by the generator before it writes, and by
 * tests/whats-new-localization-guard.test.ts over the COMMITTED locale files,
 * so a leak that ever lands is caught by the suite rather than by a reader.
 */

export const LOCALES = /** @type {const} */ (['it', 'en', 'de', 'fr']);

/** `feat(scope): thing`, `fix: thing`, … — a commit subject, not a release note. */
const CONVENTIONAL_SUBJECT = /^(?:feat|fix|chore|refactor|ci|docs|test|style|build|perf|revert|wip|improve)\b\s*(?:\([^)]*\))?!?:/i;

/** Normalise for comparison: trim, collapse whitespace, drop a trailing comma. */
function norm(s) {
  return String(s ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[,;]+$/, '');
}

/**
 * True when `value` is the commit text (or a truncation of it) rather than a
 * written release note. The generator's fallbacks emit exactly
 * `description` and `description.slice(0, 50)`, so prefix containment in
 * either direction catches both, plus any future variant that truncates
 * differently.
 * @param {string} value
 * @param {string} description raw commit description this item came from
 */
export function looksLikeCommitText(value, description) {
  const v = norm(value);
  const d = norm(description);
  if (!v || !d) return false;
  if (v === d) return true;
  // A truncation of the commit text, either way round. Require a substantial
  // overlap so a short genuine title that happens to share a first word
  // ("Alerts") is not flagged.
  const shorter = v.length <= d.length ? v : d;
  const longer = v.length <= d.length ? d : v;
  return shorter.length >= 12 && longer.startsWith(shorter);
}

/**
 * Find every reason the given translation set must not be written.
 *
 * @param {object} args
 * @param {Record<string, Record<string, string>>} args.translations  locale → key → value
 * @param {Array<{id: string, description: string, titleKeyBase: string, descKeyBase: string}>} args.items
 * @param {string} args.versionKey  e.g. `v3911`
 * @returns {string[]} human-readable violations; empty means safe to write
 */
export function findLocalizationViolations({ translations, items, versionKey }) {
  const violations = [];
  const t = translations ?? {};

  for (const locale of LOCALES) {
    if (!t[locale] || typeof t[locale] !== 'object') {
      violations.push(`locale "${locale}" has no translations at all`);
    }
  }
  if (violations.length > 0) return violations;

  const keys = [`whatsNew.${versionKey}.title`];
  for (const item of items) keys.push(item.titleKeyBase, item.descKeyBase);

  for (const key of keys) {
    const values = LOCALES.map((l) => t[l]?.[key]);
    if (values.some((v) => typeof v !== 'string' || v.trim() === '')) {
      violations.push(`${key}: missing or empty in ${LOCALES.filter((l, i) => !values[i]).join(', ')}`);
      continue;
    }
    // All four identical = nothing was translated. A real four-language set
    // differs in at least one pair; a single shared proper noun would still
    // differ somewhere in the surrounding sentence.
    if (new Set(values.map(norm)).size === 1) {
      violations.push(`${key}: identical in all four locales (${JSON.stringify(values[0])}) — not translated`);
    }
    for (let i = 0; i < LOCALES.length; i++) {
      if (CONVENTIONAL_SUBJECT.test(String(values[i]))) {
        violations.push(`${key} [${LOCALES[i]}]: is a raw conventional-commit subject (${JSON.stringify(values[i])})`);
      }
    }
  }

  for (const item of items) {
    for (const key of [item.titleKeyBase, item.descKeyBase]) {
      for (const locale of LOCALES) {
        const v = t[locale]?.[key];
        if (typeof v === 'string' && looksLikeCommitText(v, item.description)) {
          violations.push(
            `${key} [${locale}]: is the commit text, not a release note (${JSON.stringify(v)})`,
          );
        }
      }
    }
  }

  return violations;
}

/**
 * Repo-wide audit: the same property applied to already-committed locale files,
 * so a leak that lands is a failing test rather than something a reader has to
 * notice. Only flags the unambiguous signals (all-four-identical, raw commit
 * subject) — it has no access to the originating commit text.
 *
 * @param {Record<string, string>} sourcesByLocale  locale → file contents
 * @returns {string[]} violations
 */
export function scanCommittedLocales(sourcesByLocale) {
  const maps = {};
  for (const locale of LOCALES) {
    const src = sourcesByLocale[locale] ?? '';
    const map = {};
    // `'whatsNew.x.y': '…'` with escaped quotes inside.
    const re = /'(whatsNew\.[^']+)':\s*'((?:[^'\\]|\\.)*)'/g;
    let m;
    while ((m = re.exec(src)) !== null) map[m[1]] = m[2];
    maps[locale] = map;
  }

  const violations = [];
  for (const key of Object.keys(maps.it)) {
    const values = LOCALES.map((l) => maps[l][key]);
    if (values.some((v) => v === undefined)) continue; // partial rollout, not a leak
    if (new Set(values.map(norm)).size === 1) {
      violations.push(`${key}: identical in all four locales (${JSON.stringify(values[0])}) — untranslated`);
    }
    for (let i = 0; i < LOCALES.length; i++) {
      if (CONVENTIONAL_SUBJECT.test(String(values[i]))) {
        violations.push(`${key} [${LOCALES[i]}]: raw conventional-commit subject (${JSON.stringify(values[i])})`);
      }
    }
  }
  return violations;
}
