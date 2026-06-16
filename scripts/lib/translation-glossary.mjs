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
 * @typedef {Object} GlossaryEntry
 * @property {RegExp} trigger  Matched against the SOURCE text (German).
 * @property {Record<string, Array<[RegExp, string]>>} fixes  Per target locale:
 *           [badPattern, correctTerm] pairs applied to the translated output.
 */

/** @type {GlossaryEntry[]} */
export const TRANSLATION_GLOSSARY = [
  {
    // Nursing night-shift duty (Pflege "Nachtwache" / "Dauernachtwache").
    // Article-aware rules run first so a preceding "l'"/"les" is absorbed into a
    // grammatical "la guardia"/"la garde" instead of leaving "l'guardia"/"les garde".
    trigger: /nachtwache/i,
    fixes: {
      it: [
        [/\b(?:l['’]|lo|la|il)\s*orolog\w*\s+notturn\w*/gi, 'la guardia notturna'],
        [/orolog\w*\s+notturn\w*/gi, 'guardia notturna'],
      ],
      fr: [
        [/\b(?:les|la|l['’])\s*montres?\s+de\s+nuit/gi, 'la garde de nuit'],
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
        [/\borologio\b/gi, 'a ciclo'],
      ],
      en: [
        [/mechanical\s+clock\s+assembly/gi, 'cycle assembly mechanic'],
        [/\bclock\b/gi, 'cycle'],
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
 * @returns {string} The corrected translation (unchanged when no rule fires).
 */
export function applyGlossaryCorrections({ sourceText, translatedText, targetLang }) {
  let out = String(translatedText || '');
  if (!out || !sourceText || !targetLang) return out;
  for (const entry of TRANSLATION_GLOSSARY) {
    if (!entry.trigger.test(sourceText)) continue;
    const rules = entry.fixes[targetLang];
    if (!rules) continue;
    for (const [pattern, replacement] of rules) {
      out = out.replace(pattern, (m) => matchCase(m, replacement));
    }
  }
  return out;
}
