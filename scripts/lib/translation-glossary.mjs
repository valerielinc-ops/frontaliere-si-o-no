/**
 * Protected-term glossary for job translations — POST-translation correction.
 *
 * Fixes a class of literal machine-translation errors where a German compound
 * noun is pivot-translated through English into the wrong romance word. The
 * canonical case: "Nachtwache" (a nursing night-shift duty; German "Wache" =
 * guard/duty, NOT "Uhr"=clock) gets rendered as a TIMEPIECE —
 *   IT  "orologio notturno"  (night clock)
 *   FR  "montre de nuit"     (night wristwatch)
 * because the pivot English "night watch" collapses "watch (duty)" into
 * "watch (timepiece)" when re-translated to Italian/French.
 *
 * Why a dedicated layer: the output ("orologio notturno") is VALID Italian, so
 * every language-detection gate (mark-mistranslated-jobs.mjs,
 * job-locale-consistency.test) passes it — they only catch wrong-LANGUAGE text,
 * never meaning-inverted text. This glossary is the only guard for that class.
 *
 * Mechanism: gated on the SOURCE text containing a trigger term, it rewrites the
 * known mistranslated token in the machine OUTPUT to the correct target term.
 * Source-gating keeps it surgical — it never touches legitimate watch-industry
 * titles (Richemont "montre mécanique", OMEGA "Watch Technician") because their
 * source has no Nachtwache/Taktmontage trigger.
 *
 * Shared by both translation entry points (free-translate.mjs cascade and
 * job-localization-pipeline.mjs local pipeline) so the fix cannot drift between
 * them.
 */

// Mirror the leading-letter case of `sample` onto `replacement` so a corrected
// title keeps its capitalization ("Orologio notturno" → "Guardia notturna").
function matchCase(sample, replacement) {
  if (!sample) return replacement;
  const first = sample[0];
  if (first === first.toUpperCase() && first !== first.toLowerCase()) {
    return replacement.charAt(0).toUpperCase() + replacement.slice(1);
  }
  return replacement;
}

/**
 * @typedef {[RegExp, string]} BodySafeRule  A narrow [badPattern, correctTerm]
 *           pair that only ever matches the specific mistranslated COMPOUND
 *           (e.g. "orologio notturno"), so it is safe to apply to description
 *           bodies as well as titles.
 * @typedef {[RegExp, string, { titleOnly: true }]} TitleOnlyRule  A broad
 *           single-word fallback (e.g. /\borologio\b/) that must NOT run over
 *           description bodies — a legitimate "nel nostro orologio" in prose
 *           would be corrupted into "nel nostro a ciclo". Applied to titles only.
 * @typedef {BodySafeRule | TitleOnlyRule} GlossaryRule
 *
 * @typedef {Object} GlossaryEntry
 * @property {RegExp} trigger  Matched against the SOURCE text (German).
 * @property {Record<string, GlossaryRule[]>} fixes  Per target locale: rules
 *           applied to the translated output, in order.
 */

/** Marks a rule as title-only (skipped on description-body fields). */
const TITLE_ONLY = { titleOnly: true };

/** @type {GlossaryEntry[]} */
export const TRANSLATION_GLOSSARY = [
  {
    // Nursing night-shift duty (Pflege "Nachtwache" / "Dauernachtwache").
    // Article-aware rules run first so a preceding article / contracted
    // preposition ("l'"/"dell'"/"nell'"/"les"/"du") is absorbed into a
    // grammatical "la guardia"/"la garde" instead of leaving "dell'guardia".
    trigger: /nachtwache/i,
    fixes: {
      it: [
        // Contracted prepositions (dell'/nell'/all'/sull'/dall') + articles
        // (l'/lo/la/il) + "col"/"con il". The whole preposition+timepiece span
        // collapses to the canonical "la guardia notturna" (grammatical regardless
        // of the original contraction) instead of leaving a dangling apostrophe.
        [/\b(?:dell['’]|nell['’]|all['’]|sull['’]|dall['’]|l['’]|lo|la|il|con\s+il|col)\s*orolog\w*\s+notturn\w*/gi, 'la guardia notturna'],
        [/orolog\w*\s+notturn\w*/gi, 'guardia notturna'],
      ],
      fr: [
        // Articles (les/la/l') + contracted prepositions (du/des/aux) before the
        // mistranslated "montre de nuit".
        [/\b(?:les|la|l['’]|du|des|aux)\s*montres?\s+de\s+nuit/gi, 'la garde de nuit'],
        [/montres?\s+de\s+nuit/gi, 'garde de nuit'],
      ],
    },
  },
  {
    // Takt (cycle/line) assembly — "Taktmontage" mis-read as a clock.
    trigger: /taktmontage/i,
    fixes: {
      it: [
        [/montaggio\s+meccanico\s+orologio/gi, 'meccanico montaggio a ciclo'],
        // Bare-word fallback: title-only. In a description body "il nostro
        // orologio" (a legit timepiece reference) must not become "a ciclo".
        [/\borologio\b/gi, 'a ciclo', TITLE_ONLY],
      ],
      en: [
        [/mechanical\s+clock\s+assembly/gi, 'cycle assembly mechanic'],
        // Bare-word fallback: title-only (same body-corruption risk as IT).
        [/\bclock\b/gi, 'cycle', TITLE_ONLY],
      ],
      fr: [[/montage\s+m[eé]canique\s+de\s+l['’\s]?horloge/gi, 'montage à la chaîne']],
    },
  },
  {
    // Continuous-observation ward ("Dauerwachstation" / "Dauernachtwache-Station"
    // / "Wachstation") — the "Wach" (watch/observation) again surfacing as a
    // timepiece in Italian.
    trigger: /wachstation|dauerwach|dauernachtwache|wache[-\s]*station/i,
    fixes: {
      it: [
        [/stazione\s+di\s+orologio\s+permanente/gi, 'stazione di sorveglianza permanente'],
        [/orologio\s+permanente/gi, 'sorveglianza permanente'],
      ],
    },
  },
];

/**
 * Apply protected-term corrections to a single translated string.
 *
 * @param {Object} args
 * @param {string} args.sourceText      The original (source-language) text.
 * @param {string} args.translatedText  The machine-translated output to correct.
 * @param {string} args.targetLang      Target locale (it/en/de/fr).
 * @param {('title'|'description')} [args.fieldType='title']  Which field is being
 *           corrected. Defaults to 'title' so existing title call sites are
 *           unchanged. For 'description', broad single-word fallback rules
 *           (flagged `titleOnly`) are skipped so legitimate prose containing the
 *           target word (e.g. "il nostro orologio") is never rewritten — only the
 *           narrow compound rules, which can only match the mistranslated phrase,
 *           run on bodies.
 * @returns {string} The corrected translation (unchanged when no rule fires).
 */
export function applyGlossaryCorrections({ sourceText, translatedText, targetLang, fieldType = 'title' }) {
  let out = String(translatedText || '');
  if (!out || !sourceText || !targetLang) return out;
  const isTitle = fieldType === 'title';
  for (const entry of TRANSLATION_GLOSSARY) {
    if (!entry.trigger.test(sourceText)) continue;
    const rules = entry.fixes[targetLang];
    if (!rules) continue;
    for (const [pattern, replacement, opts] of rules) {
      if (!isTitle && opts && opts.titleOnly) continue;
      out = out.replace(pattern, (m) => matchCase(m, replacement));
    }
  }
  return out;
}
