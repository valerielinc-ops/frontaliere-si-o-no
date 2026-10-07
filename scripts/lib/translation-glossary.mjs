/**
 * Protected terms and protected TOKENS for job translations.
 *
 * Two guards live here, because both must be shared verbatim by the two
 * translation entry points (free-translate.mjs cascade, job-localization-
 * pipeline.mjs local pipeline) and neither may drift between them:
 *
 *   A. PRE-translation masking of gender trigraphs — see
 *      `maskProtectedTokens` / `restoreProtectedTokens` further down.
 *   B. POST-translation protected-term glossary — the original content of this
 *      file, documented immediately below.
 *
 * ── B. Protected-term glossary — POST-translation correction ────────────────
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

import { BORDER_GUARD_SOURCE_ANCHOR } from './article-locale-lexicon.mjs';

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
 * @property {string} [id]  Stable name, used in the veto annotation.
 * @property {RegExp} [veto]  Matched against the SOURCE text. When it matches a
 *           rule that WOULD have fired, the rewrite is skipped and the
 *           co-occurrence is reported — see `applyGlossaryCorrections`.
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
  {
    // Regional IT "Levatrice"/"Levatrici" (midwife, from the verb "levare" = to
    // lift/raise) gets etymology-read instead of profession-read: EN renders it
    // as "Leverage" (a finance term), FR as "Serveur" (waiter), DE as
    // "Hebelwirkung" (leverage/mechanical effect, from "Hebel" = lever) — three
    // completely different professions, not just a wrong-language slip.
    // Word-bounded + singular/plural so it never matches inside an unrelated
    // longer token and still fires on "levatrici".
    trigger: /\blevatric[ei]\b/i,
    fixes: {
      en: [[/\bleverage\b/gi, 'midwife', TITLE_ONLY]],
      de: [[/\bhebelwirkung\b/gi, 'Hebamme', TITLE_ONLY]],
      fr: [[/\bserveur\b/gi, 'sage-femme', TITLE_ONLY]],
    },
  },
  {
    // German "Monteur" (fitter/installer, from `montieren` = to assemble) comes
    // back as Italian "Mostro" (MONSTER). Observed live in a rendered IT title:
    //   "Mostro di servizio elettrico"   ← "Monteur Elektro-Service"
    // The bare-word rule MUST be TITLE_ONLY: "mostro" is also the 1st-person
    // present of `mostrare` ("vi mostro il reparto" = "let me show you the
    // ward"), so running it over a description body would produce
    // "vi montatore il reparto". The compound "mostro di servizio" can only be
    // the mistranslation, so that one is body-safe.
    trigger: /\bmonteur\w*\b/i,
    fixes: {
      it: [
        [/\bmostro\s+di\s+servizio\b/gi, 'montatore di servizio'],
        [/\bmostro\b/gi, 'montatore', TITLE_ONLY],
      ],
      en: [[/\bmonster\b/gi, 'fitter', TITLE_ONLY]],
    },
  },
  {
    // German "Magazin" in a logistics context is a WAREHOUSE/stockroom, not a
    // periodical. Observed live in a rendered IT title:
    //   "Specialista di rivista"   (should be "Specialista di magazzino")
    //
    // The trigger deliberately does NOT fire on a bare "Magazin": German
    // "Magazin" also means a periodical ("Redaktor Magazin"), and rewriting
    // "rivista"→"magazzino" there would invert a CORRECT translation. It fires
    // only on the unambiguous logistics agent-nouns/compounds, or on a bare
    // "Magazin" that co-occurs with a logistics word elsewhere in the source.
    // (`\bmagazin\b` also cannot match inside English "magazine" — the word
    // boundary fails before the "e" — so an EN-source magazine job is safe.)
    //
    // All three fixes are broad single words → TITLE_ONLY. A description body
    // legitimately saying "la nostra rivista aziendale" must survive.
    trigger: /\bmagaziner\w*\b|\bmagazin(?:mitarbeiter|angestellte|leiter|leitung|aushilfe|arbeiter|fachkraft|fachfrau|fachmann|chef|verwalter|dienst|wesen)\w*\b|\b(?:lager|ersatzteil|zentral|material|werkstatt)[-\s]?magazin\w*\b|\bmagazin\b(?=[\s\S]*\b(?:lager|logistik|material|ersatzteil|werkstatt|kommissionier\w*)\b)/i,
    fixes: {
      it: [[/\brivist[ae]\b/gi, 'magazzino', TITLE_ONLY]],
      en: [[/\bmagazines?\b/gi, 'warehouse', TITLE_ONLY]],
      fr: [[/\bmagazines?\b/gi, 'magasin', TITLE_ONLY]],
    },
  },
  {
    // Swiss EFZ qualification "Fachfrau" (female specialist — "Fachfrau
    // Betriebsunterhalt", "Fachfrau Betreuung") is read as "woman" and then as
    // "WIFE". Observed live in a rendered IT title:
    //   "Operazioni professionali/moglie"   ← "Fachmann/Fachfrau …"
    //
    // FR deliberately fixes only "épouse" and NEVER "femme": "Femme de
    // chambre" / "Femme de ménage" are real, correct French job titles, and a
    // rule on "femme" would destroy them.
    // All rules are broad single words → TITLE_ONLY (a description body may
    // legitimately mention a "moglie"/"wife" in a benefits paragraph).
    trigger: /\bfachfrau\w*\b/i,
    fixes: {
      it: [[/\bmogli(?:e)?\b/gi, 'specialista', TITLE_ONLY]],
      en: [[/\bwife\b/gi, 'specialist', TITLE_ONLY]],
      // NB: `\b` is ASCII-only in JS, so "Épouse" at the start of a title has
      // no word boundary before it — Unicode letter lookarounds instead.
      fr: [[/(?<![\p{L}\p{N}])[eé]pouse(?![\p{L}\p{N}])/giu, 'spécialiste', TITLE_ONLY]],
    },
  },
  {
    // "Apfelbaum" is a PROPER NOUN here (Schule Apfelbaum, Zürich), not a
    // botanical term. Observed live in a rendered IT title:
    //   "Cura professionale, scuola mela albero"   ← "… Schule Apfelbaum"
    // The multi-word renderings ("mela albero", "albero di mele", "apple tree",
    // "arbre à pommes") can only be the mistranslated proper noun once the
    // source contains "Apfelbaum", so they are body-safe. The single-word
    // renderings ("melo", "pommier") are real words and stay TITLE_ONLY.
    trigger: /\bapfelbaum\b/i,
    fixes: {
      it: [
        [/\bmel[ao]\s+albero\b/gi, 'Apfelbaum'],
        [/\balbero\s+di\s+mel[ae]\b/gi, 'Apfelbaum'],
        [/\bmelo\b/gi, 'Apfelbaum', TITLE_ONLY],
      ],
      en: [[/\bapple\s*-?\s*tree\b/gi, 'Apfelbaum']],
      fr: [
        [/\barbre\s+[aà]\s+pommes?\b/gi, 'Apfelbaum'],
        [/\bpommier\b/gi, 'Apfelbaum', TITLE_ONLY],
      ],
    },
  },
  {
    // Italian "frontaliere/frontalieri" (cross-border commuter) is a false
    // friend for a border GUARD in every target locale — same failure class
    // documented in FALSE_FRIEND_PATTERNS (article-locale-lexicon.mjs), here
    // fixed at the translation step itself instead of only flagged after the
    // fact. The bad renderings are all multi-word compounds ("border guard(s)",
    // "Grenzwächter", "garde(s)-frontière(s)"), so they are body-safe: no
    // legitimate prose about frontalieri ever contains them.
    //
    // VERIFIED against the real corpus (issue #723, follow-up of #664): unlike
    // the other body-safe entries above, this one's replacement phrases ARE
    // legitimate correct translations when a source genuinely discusses a real
    // border guard, and the trigger fires on nearly every job in the corpus
    // (the whole site is about frontalieri). Scanned all 58 427 crawled records (2026-09-05)
    // (`data/jobs/by-crawler` + `expired`): 172 trigger the rule, ZERO also
    // mention real border-guard/customs vocabulary in the same record — see
    // `tests/translation-glossary.test.ts`, which turns this one-time
    // measurement into a standing regression gate.
    //
    // That scan is a SNAPSHOT, though, and the crawlers add records every day,
    // so the entry does not rely on it: `veto` re-checks the co-occurrence on
    // every single record at translation time. When a source carries both the
    // trigger and real customs-role vocabulary, the rewrite is skipped (the
    // "border guard" rendering is then the CORRECT one) and the record is
    // annotated — turning the one-time measurement into a continuous one.
    // The anchor is the one the article gates already use for the same
    // question (`BORDER_GUARD_SOURCE_ANCHOR`, article-locale-lexicon.mjs), not
    // a second copy: 0 of the 172 records that trigger the rule in the current
    // corpus match it, so the veto costs nothing today and any future cost
    // arrives as a `::warning::` instead of as a silently false sentence.
    id: 'frontalier-border-guard',
    veto: BORDER_GUARD_SOURCE_ANCHOR,
    trigger: /\bfrontalier\w*\b/i,
    fixes: {
      en: [
        [/\bborder\s+guards?\b/gi, 'cross-border commuters'],
        [/\bfrontier\s+guards?\b/gi, 'cross-border commuters'],
      ],
      de: [
        [/\bGrenzw(?:ä|ae)chter\w*/gi, 'Grenzgänger'],
        [/\bGrenzsch(?:ü|ue)tzer\w*/gi, 'Grenzgänger'],
        [/\bGrenzbeamt\w*/gi, 'Grenzgänger'],
      ],
      fr: [[/\bgardes?[-\s]fronti(?:è|e)res?\b/gi, 'travailleurs frontaliers']],
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
    const vetoed = entry.veto ? entry.veto.test(sourceText) : false;
    for (const [pattern, replacement, opts] of rules) {
      if (!isTitle && opts && opts.titleOnly) continue;
      if (vetoed) {
        // The rule WOULD have fired on this record and the source says the
        // subject is a real border guard: the machine rendering is correct
        // here, so leave it and make the collision visible instead.
        if (matchesRule(out, pattern)) reportGlossaryVeto({ entry, pattern, targetLang, fieldType, sourceText });
        continue;
      }
      out = out.replace(pattern, (m) => matchCase(m, replacement));
    }
  }
  return out;
}

/** Non-destructive `pattern.test(text)` — the rule regexes carry /g, whose
 *  `lastIndex` would otherwise leak into the next call on the same rule. */
function matchesRule(text, pattern) {
  const probe = new RegExp(pattern.source, pattern.flags.replace('g', ''));
  return probe.test(text);
}

/**
 * Continuous measurement of the veto collisions.
 *
 * Keyed per entry+locale so a crawler run that hits the same ambiguity a
 * hundred times annotates once; the counts stay readable via
 * `getGlossaryVetoStats()` for whoever wants the exact number.
 */
const glossaryVetoStats = new Map();

function reportGlossaryVeto({ entry, pattern, targetLang, fieldType, sourceText }) {
  const id = entry.id || String(entry.trigger);
  const key = `${id}:${targetLang}`;
  const seen = glossaryVetoStats.get(key);
  if (seen) {
    seen.count += 1;
    return;
  }
  glossaryVetoStats.set(key, { id, targetLang, count: 1, sample: String(sourceText).slice(0, 160) });
  console.warn(
    `::warning::[glossary] rule ${id} (${targetLang}, ${fieldType}) matched ${pattern} but the source ` +
      'also carries real border-guard/customs vocabulary — rewrite skipped, the machine rendering is ' +
      `kept. Review the entry if this recurs. Source: "${String(sourceText).slice(0, 160)}"`,
  );
}

/** Veto collisions seen in this process, per `entry:locale`. */
export function getGlossaryVetoStats() {
  return [...glossaryVetoStats.values()].map((v) => ({ ...v }));
}

/** Test seam: clears the per-process veto tally (and the annotation dedupe). */
export function resetGlossaryVetoStats() {
  glossaryVetoStats.clear();
}

/* ──────────────────────────────────────────────────────────────────────────
 * A. PROTECTED TOKENS — gender trigraphs masked BEFORE translation
 * ──────────────────────────────────────────────────────────────────────────
 *
 * A DACH gender-diversity code — "(m/w/d)" = männlich/weiblich/divers — is a
 * three-letter abbreviation, and a machine translator handed one is free to
 * read the letters as words. It does. Observed live in rendered IT titles:
 *
 *   "Responsabile del Laboratorio Ambientale (lunedì/mercoledì/d)"
 *   "Responsabile Installazioni Nuovi Sistemi (lunedì/meredì)"
 *
 * — m→lunedì (Monday), w→mercoledì (Wednesday): the translator expanded the
 * gender code as WEEKDAY abbreviations. Nothing downstream can recover that,
 * because the output is valid Italian; it is the same failure class as the
 * "Nachtwache → orologio notturno" glossary above, only worse, since the
 * original letters are gone.
 *
 * The fix is to never show a translator the code at all: mask each trigraph
 * with an opaque sentinel before the request, put a LOCALE-APPROPRIATE form
 * back afterwards. The 18-in-179 case where the German "(m/w/d)" simply
 * survived verbatim into an Italian title is fixed by the same restore step.
 *
 * SLUG SAFETY — why localizing the display form is free.
 * `slugify()` and `slugifyLocalizedLabel()` in dedicated-crawler-common.mjs
 * both call `canonicalizeGenderTrigraph()` on their input first, which folds
 * EVERY variant (m/w/d, w/m/d, m/f/d, h/f/d, m/w, M/W/D, bare or bracketed)
 * to the single form "m/w/d" before slugification. Measured on the real
 * exported `slugify`: 14 distinct display variants of the same title produce
 * exactly ONE slug. So the display form and the slug form are independent by
 * construction, and this module deliberately does NOT touch the slug path —
 * canonicalization there is what keeps slugs stable across runs and must stay.
 *
 * The variant inventory below is the one documented at
 * dedicated-crawler-common.mjs:138-158; the two regex sources are copied from
 * `canonicalizeGenderTrigraph` verbatim so mask and canonicalize can never
 * disagree about what a trigraph is. They are kept as SOURCES (not shared
 * RegExp objects) and compiled fresh per call, because a /g regex carries
 * `lastIndex` state across `.test()` calls.
 */

const GENDER_TRIGRAPH_BRACKETED_SRC =
  String.raw`[([]\s*([mwfhlp])\s*\/\s*([mwfhlp])(?:\s*\/\s*([dxg]))?\s*[)\]]`;
// The BARE form is deliberately stricter than `canonicalizeGenderTrigraph`'s,
// on the two-letter case only. Its `[mwfhlp]/[mwfhlp]` pair also matches unit
// notation that occurs in description bodies — "100 l/h" (litres per hour),
// "CHF 25 p/h" — and rewriting one of those into a gender code would be new
// damage in the DISPLAY path. So an unbracketed bigraph must be one of the six
// pairs actually documented in the inventory (m/w, w/m, m/f, f/m, h/f, f/h);
// the three-letter form keeps the full permissive class, because a trailing
// d/x/g makes it unambiguous. The bracketed form is byte-identical to
// canonicalize's, since brackets already disambiguate.
const GENDER_TRIGRAPH_BARE_SRC =
  String.raw`(?<=^|[\s\-–—|,./])(?:([mwfhlp])\s*\/\s*([mwfhlp])\s*\/\s*([dxg])`
  + String.raw`|m\s*\/\s*w|w\s*\/\s*m|m\s*\/\s*f|f\s*\/\s*m|h\s*\/\s*f|f\s*\/\s*h)(?=$|[\s\-–—|,./])`;

const bracketedTrigraphRe = () => new RegExp(GENDER_TRIGRAPH_BRACKETED_SRC, 'gi');
const bareTrigraphRe = () => new RegExp(GENDER_TRIGRAPH_BARE_SRC, 'gi');

/**
 * The gender pair to DISPLAY per locale. `d`/`x` (divers / non-binary) is
 * locale-independent and carried over from the source.
 *   de  männlich / weiblich   → m/w
 *   fr  homme / femme         → h/f
 *   it  maschio / femmina     → m/f
 *   en  male / female         → m/f
 */
export const GENDER_TRIGRAPH_PAIR_BY_LOCALE = {
  de: ['m', 'w'],
  fr: ['h', 'f'],
  it: ['m', 'f'],
  en: ['m', 'f'],
};

/** Sentinel shape: `ZQX<n>XQZ`. Alphanumeric (survives tokenizers), and a
 *  letter run no natural language produces. */
const TOKEN_SEP = String.raw`[\s._·•\-]*`;
const protectedTokenRe = () =>
  new RegExp(`z${TOKEN_SEP}q${TOKEN_SEP}x${TOKEN_SEP}(\\d{1,3})${TOKEN_SEP}x${TOKEN_SEP}q${TOKEN_SEP}z`, 'gi');
/** Last-resort scrub for a sentinel the translator mangled past recognition
 *  (e.g. "ZQXOXQZ" — digit read as a letter). Never leave debris in a title. */
const protectedTokenScrubRe = () =>
  new RegExp(`z${TOKEN_SEP}q${TOKEN_SEP}x.{0,6}?x${TOKEN_SEP}q${TOKEN_SEP}z`, 'gi');
// Some engines turn the numbered sentinel into a percentage-like fragment
// instead of preserving its XQZ envelope (for example `ZQ ①000%`). Keep this
// matcher intentionally narrow: it requires the sentinel's ZQ prefix and a
// circled/ASCII marker ending in `%`, so ordinary prose containing “ZQ” stays.
const mangledProtectedTokenScrubRe = () =>
  new RegExp(`z${TOKEN_SEP}q${TOKEN_SEP}(?:[①-⑳][\\s\\S]{0,8}?%|x${TOKEN_SEP}[0-9oOxX][\\s\\S]{0,8}?%)`, 'giu');

const PROTECTED_TOKEN_COMPARISON_PLACEHOLDER = '\u0000protected-token\u0000';
const PROTECTED_TOKEN_COMPARISON_NUL_ESCAPE = '\u0000\u0000';

/**
 * Normalize every known protected-token shape to one comparison marker.
 *
 * A provider can echo the masked source while changing the sentinel — for
 * example `ZQX0XQZ` → `ZQ ①000%`. That output is still a passthrough, but the
 * finalizer must not be the first place that sees the mangled form: it would
 * scrub the sentinel and publish the source text without the protected token.
 * Valid sentinels are replaced first so the broad last-resort scrubber cannot
 * mistake them for mangled debris.
 */
export function normalizeProtectedTokenSentinels(text = '') {
  const input = String(text ?? '');
  if (!input) return input;
  return input
    // The comparison marker contains NUL bytes. Escape raw NULs first so a
    // provider output cannot collide with a marker inserted for a protected
    // token during passthrough comparison.
    .replace(/\u0000/g, PROTECTED_TOKEN_COMPARISON_NUL_ESCAPE)
    .replace(protectedTokenRe(), PROTECTED_TOKEN_COMPARISON_PLACEHOLDER)
    .replace(protectedTokenScrubRe(), PROTECTED_TOKEN_COMPARISON_PLACEHOLDER)
    .replace(mangledProtectedTokenScrubRe(), PROTECTED_TOKEN_COMPARISON_PLACEHOLDER);
}

/**
 * Collapse the Swiss German inclusive compound `…frau:mann` to the masculine
 * lexical form before a translator sees it. The colon form is common in newly
 * crawled Coop titles and otherwise gets copied or rendered as a literal
 * gender suffix by local MT. Standalone `Frau:mann` is handled separately;
 * compounds retain their stem (`Fachfrau:mann` → `Fachmann`).
 */
export function normalizeGermanGenderForms(text = '') {
  return String(text ?? '')
    .replace(/\bfrau\s*:\s*mann\b/giu, 'mann')
    .replace(/\b(\p{L}[\p{L}-]*)frau\s*:\s*mann\b/giu, '$1mann');
}

/** Describe one matched trigraph: arity, third marker, and letter case. */
function parseGenderTrigraph(raw = '') {
  const s = String(raw || '');
  const letters = s.replace(/[^a-z]/gi, '');
  const third = letters.length >= 3 ? letters[2].toLowerCase() : '';
  return {
    hasThird: letters.length >= 3,
    // 'x' (non-binary) is meaningful and locale-independent, so it is kept.
    // Everything else in the documented inventory ('d', and the corrupted 'g'
    // of "(m/p/g)") normalizes to the standard 'd' = divers.
    thirdMarker: third === 'x' ? 'x' : 'd',
    upper: /[A-Z]/.test(s) && !/[a-z]/.test(s),
    bracketed: /^[([]/.test(s.trim()),
  };
}

/**
 * Render the locale-appropriate display form of a gender trigraph.
 *
 * @param {string} locale  it/en/de/fr (unknown locales fall back to m/f).
 * @param {{hasThird?: boolean, thirdMarker?: string, upper?: boolean,
 *          bracketed?: boolean}} [shape]  Arity/case/brackets of the ORIGINAL,
 *          so "(m/w)" stays a bigraph and "M/W/D" stays uppercase.
 */
export function genderTrigraphForLocale(locale = '', shape = {}) {
  const pair = GENDER_TRIGRAPH_PAIR_BY_LOCALE[String(locale || '').toLowerCase()]
    || GENDER_TRIGRAPH_PAIR_BY_LOCALE.en;
  const parts = [...pair];
  if (shape.hasThird !== false) parts.push(shape.thirdMarker || 'd');
  let body = parts.join('/');
  if (shape.upper) body = body.toUpperCase();
  return shape.bracketed === false ? body : `(${body})`;
}

/** True when `text` still carries a gender trigraph in any documented form. */
export function hasGenderTrigraph(text = '') {
  const s = String(text || '');
  return bracketedTrigraphRe().test(s) || bareTrigraphRe().test(s);
}

/**
 * Rewrite every gender trigraph already present in `text` into the
 * locale-appropriate display form. Idempotent.
 *
 * Applied to translator OUTPUT: it catches the German "(m/w/d)" that a
 * translator copied through verbatim, and any trigraph in a memoized
 * translation written before the masking guard existed. It is deliberately not
 * source-gated — a "m/w/d"-shaped token in a job title is a gender code by
 * construction, which is the same premise `canonicalizeGenderTrigraph` relies
 * on in the slug path.
 */
export function localizeGenderTrigraphs(text = '', locale = '') {
  const s = String(text ?? '');
  if (!s) return s;
  return s
    .replace(bracketedTrigraphRe(), (m) => genderTrigraphForLocale(locale, { ...parseGenderTrigraph(m), bracketed: true }))
    .replace(bareTrigraphRe(), (m) => genderTrigraphForLocale(locale, { ...parseGenderTrigraph(m), bracketed: false }));
}

/**
 * Replace every gender trigraph with an opaque sentinel BEFORE translation.
 *
 * @param {string} text
 * @returns {{ text: string, tokens: Array<{placeholder: string, raw: string,
 *            hasThird: boolean, thirdMarker: string, upper: boolean,
 *            bracketed: boolean}> }}
 *   `tokens` is empty (and `text` is returned byte-identical) when there is
 *   nothing to protect — the overwhelmingly common case, so the cascade sends
 *   unmodified text unless a trigraph is actually present.
 */
export function maskProtectedTokens(text = '') {
  const input = String(text ?? '');
  if (!input) return { text: input, tokens: [] };
  const tokens = [];
  const capture = (raw, bracketed) => {
    const placeholder = `ZQX${tokens.length}XQZ`;
    tokens.push({ placeholder, raw, ...parseGenderTrigraph(raw), bracketed });
    return placeholder;
  };
  // Bracketed first — the sentinel contains no "/", so the bare pass cannot
  // re-match what the bracketed pass already replaced.
  const masked = input
    .replace(bracketedTrigraphRe(), (m) => capture(m, true))
    .replace(bareTrigraphRe(), (m) => capture(m, false));
  return { text: masked, tokens };
}

/**
 * Put the protected tokens back, in the target locale's display form.
 *
 * Robustness ladder, in order:
 *   1. Sentinels that came back are replaced by index (tolerant to case
 *      changes and to punctuation/spaces the translator inserted inside them).
 *   2. Mangled sentinel debris is scrubbed, never emitted.
 *   3. Any RAW trigraph in the output — one the translator invented, or one
 *      that was never masked (memoized pre-guard translations) — is localized.
 *   4. A sentinel the translator DROPPED is re-appended, for titles only, and
 *      only when the output does not already carry a trigraph. Re-appending to
 *      a description body would land the code in the middle of prose, so a
 *      dropped token is simply omitted there.
 *
 * @param {string} text
 * @param {Array} tokens        The `tokens` array from `maskProtectedTokens`.
 * @param {string} targetLang   it/en/de/fr.
 * @param {{fieldType?: ('title'|'description')}} [opts]
 */
export function restoreProtectedTokens(text = '', tokens = [], targetLang = '', opts = {}) {
  const fieldType = opts.fieldType || 'title';
  let out = String(text ?? '');
  if (!out) return out;
  const list = Array.isArray(tokens) ? tokens : [];
  const seen = new Set();

  if (list.length) {
    const before = out;
    out = out.replace(protectedTokenRe(), (_m, idx) => {
      const i = Number(idx);
      const token = list[i];
      if (!token) return ''; // sentinel index the translator invented
      seen.add(i);
      return genderTrigraphForLocale(targetLang, token);
    });
    out = out.replace(protectedTokenScrubRe(), '');
    out = out.replace(mangledProtectedTokenScrubRe(), '');
    // Only tidy when a sentinel was actually swapped out, so the guard never
    // reflows the indentation of a description that had nothing to protect
    // (nested markdown bullets rely on their leading double spaces).
    if (out !== before) out = tidySpacing(out);
  }

  out = localizeGenderTrigraphs(out, targetLang);

  if (list.length) {
    const dropped = list.filter((_t, i) => !seen.has(i));
    if (dropped.length && fieldType === 'title' && out && !hasGenderTrigraph(out)) {
      out = `${out} ${genderTrigraphForLocale(targetLang, { ...dropped[0], bracketed: true })}`.trim();
    }
  }
  return out;
}

/* ──────────────────────────────────────────────────────────────────────────
 * PLACEHOLDER GUARD — a template token must never reach a published title
 * ──────────────────────────────────────────────────────────────────────────
 *
 * Observed live: a rendered job title that was literally "(ORGANIZZAZIONE)".
 * That is a prompt/template placeholder the model echoed instead of filling.
 *
 * DESIGN NOTE — why a vocabulary and not "ALL-CAPS in parentheses".
 * A bare ALL-CAPS parenthetical is indistinguishable from real information in
 * this corpus: "(KSA)", "(EFZ)", "(CFC)", "(MIGROS)", "(SPITEX ZOFINGEN)" are
 * all legitimate and load-bearing, and a length heuristic would delete them.
 * So round brackets are gated on a closed placeholder VOCABULARY (matched
 * case-sensitively, ALL-CAPS only, so prose "(azienda)" is untouched), while
 * template-delimiter shapes — {COMPANY}, {{company}}, ${company}, %COMPANY%,
 * __COMPANY__, [[company]] — are stripped unconditionally, because no job
 * title or description legitimately contains one.
 *
 * STRIP, not reject: the rest of the title is normally correct, and rejecting
 * the translation would push the caller onto the source-language fallback —
 * i.e. a German title in the Italian slot, the very defect this PR series is
 * fixing. Only when stripping leaves nothing with a letter or digit in it does
 * `finalizeTranslatedText` treat the result as a failure and return ''.
 */
const PLACEHOLDER_WORD =
  '(?:COMPANY|ORGANI[SZ]ATION|ORGANIZZAZIONE|AZIENDA|IMPRESA|DITTA|SOCIET[AÀ]|SOCI[EÉ]T[EÉ]'
  + '|UNTERNEHMEN|FIRMA|ARBEITGEBER|ENTREPRISE|EMPLOYER|EMPLOYEUR|CLIENT|CLIENTE|KUNDE|CUSTOMER'
  + '|LOCATION|LUOGO|ORT|LIEU|CITY|CITT[AÀ]|STADT|VILLE|POSITION|POSIZIONE|TITLE|TITOLO|TITEL'
  + '|TITRE|JOB|NAME|NOME|NOM|PLACEHOLDER|SEGNAPOSTO|PLATZHALTER|TBD|TODO|XXX+)';
const placeholderVocabRe = () => new RegExp(
  `[([{<]{1,2}\\s*${PLACEHOLDER_WORD}(?:[ _\\-/]{1,2}${PLACEHOLDER_WORD}){0,2}\\s*[)\\]}>]{1,2}`,
  'g',
);
const templatePlaceholderRe = () => new RegExp(
  [
    String.raw`\{\{\s*[\w. -]{1,40}\s*\}\}`,
    String.raw`\$\{\s*[\w. -]{1,40}\s*\}`,
    String.raw`\[\[\s*[\w. -]{1,40}\s*\]\]`,
    String.raw`\{[A-Z][A-Z0-9_ ]{1,39}\}`,
    // `%C3%A9` is two percent-encoded bytes, not a `%C3%` token: a name of
    // exactly two hex digits followed by another hex pair is URL encoding
    // wherever it stands, also where no URL syntax can be recognised
    // (`docs/Perch%C3%A9.html`, the tail of a URL cut short by a stray `)`).
    String.raw`%(?![0-9A-F]{2}%[0-9A-Fa-f]{2})[A-Z][A-Z0-9_]{1,39}%`,
    String.raw`__[A-Z][A-Z0-9_]{1,39}__`,
  ].join('|'),
  'g',
);

/** Collapse the whitespace/punctuation hole left by a removed token. */
function tidySpacing(value = '') {
  return String(value ?? '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\(\s*\)|\[\s*\]|\{\s*\}/g, '')
    // Emptied brackets leave their blanks side by side: collapse them before
    // the punctuation pass, whose `[ \t]+` would otherwise retry a long run
    // from each of its characters (quadratic on `[] [] [] …`).
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/[ \t]+([,;:.!?])/g, '$1')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/(^|[ \t])[-–—|,/]+[ \t]*$/gm, '$1')
    .replace(/[ \t]+$/gm, '')
    .trim();
}

// A URL or a Markdown link target is opaque to the placeholder strip. A pair of
// percent-encoded bytes reads exactly like a `%TOKEN%` placeholder —
// `Perch%C3%A9` carries `%C3%`, `l%E2%80%99UE` carries `%E2%` — and stripping
// it rewrote the link (`Perch A9`, `l 80%99UE`) in every translated text that
// cites such a URL: a 404 behind a source line that looked untouched.
//
// Two defences, because a scanner can only protect the syntax it recognises:
// the placeholder pattern itself never reads a chain of percent-encoded bytes
// as a token (see `templatePlaceholderRe`), and the scanner below keeps every
// other placeholder shape out of URLs and link targets.
//
// This is deliberately a scanner, rather than an enumeration of URL syntaxes.
//
// Two properties hold together, and neither is bought with the other:
//
// 1. A failed scan never makes the caller skip text. One malformed construct
//    (a link title whose quote never closes, a `<` of prose followed by a
//    letter) must not leave the URLs after it exposed: the cursor moves one
//    character and what follows is examined normally. The same holds for a
//    token that is read but not protected (a relative path without encoded
//    bytes): an absolute URL glued to it is still found.
// 2. The scan is linear in the text for a fixed cap. No construct spans a line
//    break; a destination, a title or a tag is capped in length; and each line
//    knows where its last `)`, `>` and quotes are, so a search that cannot
//    succeed is refused before it starts instead of being repeated from every
//    later character.
//
// Naked relative paths use a conservative policy: only a token that starts at a
// lexical boundary with `/` and contains at least one `%XX` byte is opaque.
// Thus `/wiki/Perch%C3%A9` is protected while `e/o`, `km/h`, and `24/7` remain
// ordinary prose.

/**
 * Longest destination, title or HTML tag scanned as one construct. The cap is
 * what bounds the shapes no per-line memory can answer in advance: openers and
 * closers that never balance from any starting point, attributes that never
 * reach their `>` (worst case: the line length times this cap). A construct
 * longer than the cap is not lost: its absolute URLs are still read as bare
 * URLs; only the `](` … `)` or `<` … `>` wrapping stops being part of the scan.
 */
const MAX_LINK_PART_LENGTH = 512;
const NOT_PROBED = -2;

function isAsciiLetter(character = '') {
  const code = character.charCodeAt(0);
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
}

function isAsciiDigit(character = '') {
  const code = character.charCodeAt(0);
  return code >= 48 && code <= 57;
}

function isHexDigit(character = '') {
  const code = character.charCodeAt(0);
  return (code >= 48 && code <= 57)
    || (code >= 65 && code <= 70)
    || (code >= 97 && code <= 102);
}

function isHorizontalWhitespace(character = '') {
  return character === ' ' || character === '\t';
}

function isLineBreak(character = '') {
  return character === '\r' || character === '\n';
}

function skipHorizontalWhitespace(text, index, limit = text.length) {
  while (index < limit && isHorizontalWhitespace(text[index])) index += 1;
  return index;
}

function startsWithIgnoreCase(text, index, value) {
  return text.slice(index, index + value.length).toLowerCase() === value;
}

function isTokenBoundary(text, index) {
  if (index === 0) return true;
  const previous = text[index - 1];
  return !isAsciiLetter(previous)
    && !isAsciiDigit(previous)
    && previous !== '_'
    && previous !== '-';
}

/** What the scans know about the line the cursor is on. */
function createLineContext(text) {
  return {
    text,
    lineStart: 0,
    lineEnd: -1,
    // Index of the last such character on the line, -1 when there is none.
    lastOnLine: { ')': NOT_PROBED, '>': NOT_PROBED, '"': NOT_PROBED, "'": NOT_PROBED },
  };
}

function enterLine(context, index) {
  if (index <= context.lineEnd) return;
  const { text } = context;
  let end = index;
  while (end < text.length && !isLineBreak(text[end])) end += 1;
  // The cursor crosses a line break one character at a time (no construct
  // spans one), so the first index seen past the old end is the line start.
  context.lineStart = index;
  context.lineEnd = end;
  const last = context.lastOnLine;
  last[')'] = NOT_PROBED;
  last['>'] = NOT_PROBED;
  last['"'] = NOT_PROBED;
  last["'"] = NOT_PROBED;
}

/**
 * Index of the last `marker` on the current line, or -1. One backward pass per
 * line and marker answers every later "can this still close?" exactly, from
 * any position, so the question costs nothing to ask again.
 */
function lastOnLine(context, marker) {
  const known = context.lastOnLine[marker];
  if (known !== NOT_PROBED) return known;
  const { text, lineStart, lineEnd } = context;
  let cursor = lineEnd - 1;
  while (cursor >= lineStart && text[cursor] !== marker) cursor -= 1;
  const found = cursor >= lineStart ? cursor : -1;
  context.lastOnLine[marker] = found;
  return found;
}

/** Index after the closing quote, or -1. Backslash escapes the next character. */
function scanQuotedSpan(context, start, quote) {
  if (lastOnLine(context, quote) <= start) return -1;
  const { text, lineEnd } = context;
  const limit = Math.min(lineEnd, start + 1 + MAX_LINK_PART_LENGTH);
  let index = start + 1;
  while (index < limit) {
    if (text[index] === '\\' && index + 1 < limit) {
      index += 2;
      continue;
    }
    if (text[index] === quote) return index + 1;
    index += 1;
  }
  return -1;
}

/** Index after the balanced `)`, or -1. */
function scanParenthesizedSpan(context, start) {
  if (lastOnLine(context, ')') <= start) return -1;
  const { text, lineEnd } = context;
  const limit = Math.min(lineEnd, start + 1 + MAX_LINK_PART_LENGTH);
  let depth = 0;
  let index = start;
  while (index < limit) {
    const character = text[index];
    if (character === '\\' && index + 1 < limit) {
      index += 2;
      continue;
    }
    if (character === '(') {
      depth += 1;
    } else if (character === ')') {
      depth -= 1;
      if (depth === 0) return index + 1;
    }
    index += 1;
  }
  return -1;
}

/** Index after the closing `>` of a `<destination>`, or -1. */
function scanAngleDestination(context, start) {
  if (lastOnLine(context, '>') <= start) return -1;
  const { text, lineEnd } = context;
  const limit = Math.min(lineEnd, start + 1 + MAX_LINK_PART_LENGTH);
  let index = start + 1;
  while (index < limit) {
    if (text[index] === '\\' && index + 1 < limit) {
      index += 2;
      continue;
    }
    if (text[index] === '>') return index + 1;
    index += 1;
  }
  return -1;
}

/**
 * Scan a Markdown link/image beginning at its `](` delimiter; index after the
 * closing `)`, or -1.
 *
 * A final matched `)` can be the outer link close even when the destination
 * contains a lone `(`; this keeps the previous permissive behavior for URL
 * paths such as `a(b/slug`.
 */
function scanMarkdownLink(context, start) {
  if (lastOnLine(context, ')') < start + 2) return -1;
  const { text, lineEnd } = context;
  let cursor = skipHorizontalWhitespace(text, start + 2);
  if (cursor >= lineEnd) return -1;
  const destinationStart = cursor;
  let depth = 0;
  let lastClose = -1;

  if (text[cursor] === '<') {
    const destinationEnd = scanAngleDestination(context, cursor);
    if (destinationEnd < 0) return -1;
    cursor = destinationEnd;
  } else {
    const limit = Math.min(lineEnd, cursor + MAX_LINK_PART_LENGTH);
    while (cursor < limit) {
      const character = text[cursor];
      if (isHorizontalWhitespace(character)) break;
      // A backslash escapes a delimiter, never a blank: the destination still
      // ends at the next space.
      if (character === '\\' && cursor + 1 < limit && !isHorizontalWhitespace(text[cursor + 1])) {
        cursor += 2;
        continue;
      }
      if (character === '(') {
        depth += 1;
        cursor += 1;
        continue;
      }
      if (character === ')') {
        if (depth === 0) return cursor + 1;
        depth -= 1;
        lastClose = cursor;
        cursor += 1;
        continue;
      }
      if (character === '<') return -1;
      cursor += 1;
    }
    if (cursor >= limit && limit < lineEnd) return -1;
  }

  cursor = skipHorizontalWhitespace(text, cursor);
  if (cursor < lineEnd) {
    const character = text[cursor];
    if (character === '"' || character === "'" || character === '(') {
      const titleEnd = character === '('
        ? scanParenthesizedSpan(context, cursor)
        : scanQuotedSpan(context, cursor, character);
      if (titleEnd < 0) return -1;
      cursor = skipHorizontalWhitespace(text, titleEnd);
      return cursor < lineEnd && text[cursor] === ')' ? cursor + 1 : -1;
    }
    if (character === ')') return cursor + 1;
  }

  // Keep the old permissive handling of a lone `(` in a Markdown destination:
  // if the balanced scan consumed the only `)`, treat that close as the link's
  // outer delimiter when no title or explicit close follows it.
  if (lastClose >= 0 && depth === 0) {
    const afterLastClose = skipHorizontalWhitespace(text, lastClose + 1);
    if (afterLastClose >= lineEnd || text[afterLastClose] !== '(') {
      // That `)` was balanced inside the destination: when a URL of the
      // destination runs past it (`](https://h/a_(b)/c`), the span must not
      // end before the URL does, or its tail would be left to the strip.
      return Math.max(lastClose + 1, lastOpaqueUrlEnd(text, destinationStart, lastClose + 1));
    }
  }
  return -1;
}

/**
 * The destination of a reference definition is the whole run up to the next
 * blank: after `[id]:` nothing else can be meant. Parentheses are not weighed —
 * stopping at a stray or backslash-escaped `)` would protect only the head of
 * the URL and leave its tail to the strip.
 */
function scanReferenceDestination(text, start, lineEnd) {
  let index = start;
  while (index < lineEnd) {
    if (isHorizontalWhitespace(text[index])) break;
    // A backslash escapes a delimiter, never a blank: the destination still
    // ends at the next space.
    if (text[index] === '\\' && index + 1 < lineEnd && !isHorizontalWhitespace(text[index + 1])) {
      index += 2;
      continue;
    }
    index += 1;
  }
  return index > start ? index : -1;
}

/**
 * `[id]: destination "title"` at the start of the current line: the span of the
 * destination (and title), plus the end of the label, which the caller still
 * reads for URLs — recognising the definition must not hide what the label
 * holds.
 */
function scanReferenceDefinition(context, start) {
  const { text, lineEnd } = context;
  let cursor = start + 1;
  while (cursor < lineEnd && text[cursor] !== ']') cursor += 1;
  if (cursor >= lineEnd) return null;
  const labelEnd = cursor;
  cursor = skipHorizontalWhitespace(text, cursor + 1);
  if (text[cursor] !== ':') return null;
  cursor = skipHorizontalWhitespace(text, cursor + 1);
  if (cursor >= lineEnd) return null;

  const spanStart = cursor;
  const destinationEnd = text[cursor] === '<'
    ? scanAngleDestination(context, cursor)
    : scanReferenceDestination(text, cursor, lineEnd);
  if (destinationEnd < 0) return null;

  cursor = skipHorizontalWhitespace(text, destinationEnd);
  let spanEnd = destinationEnd;
  if (cursor < lineEnd && (text[cursor] === '"' || text[cursor] === "'")) {
    const titleEnd = scanQuotedSpan(context, cursor, text[cursor]);
    if (titleEnd > 0) spanEnd = titleEnd;
  } else if (cursor < lineEnd && text[cursor] === '(') {
    const titleEnd = scanParenthesizedSpan(context, cursor);
    if (titleEnd > 0) spanEnd = titleEnd;
  }
  return { start: spanStart, end: spanEnd, labelEnd };
}

function isHtmlAttributeCharacter(character = '') {
  return isAsciiLetter(character)
    || isAsciiDigit(character)
    || character === ':'
    || character === '-'
    || character === '_';
}

/**
 * A real HTML tag on the current line: `<name attribute…>`, where every
 * attribute is a well-formed name or `name=value`. Anything else is prose
 * (`soglia <CHF 3.000`, `se x <y allora [link](…) e z> w`) and returns null:
 * treating it as a tag would swallow the links between the `<` and a later
 * `>`. On success, the spans are the `href`/`src` values and the URLs found
 * inside every other attribute value (`title`, `data-url`, …), whose
 * remaining text stays open to the strip.
 */
function scanHtmlTag(context, start) {
  if (lastOnLine(context, '>') <= start) return null;
  const { text } = context;
  const limit = Math.min(context.lineEnd, start + 1 + MAX_LINK_PART_LENGTH);
  let cursor = start + 1;
  if (text[cursor] === '/') cursor += 1;
  if (cursor >= limit || !isAsciiLetter(text[cursor])) return null;
  while (cursor < limit && (isAsciiLetter(text[cursor]) || isAsciiDigit(text[cursor]) || text[cursor] === '-')) {
    cursor += 1;
  }

  const spans = [];
  while (cursor < limit) {
    const separatorStart = cursor;
    cursor = skipHorizontalWhitespace(text, cursor, limit);
    if (cursor >= limit) return null;
    if (text[cursor] === '>') return { end: cursor + 1, spans };
    if (text[cursor] === '/' && text[cursor + 1] === '>') return { end: cursor + 2, spans };
    if (cursor === separatorStart) return null;

    const nameStart = cursor;
    while (cursor < limit && isHtmlAttributeCharacter(text[cursor])) cursor += 1;
    if (cursor === nameStart) return null;
    const nameLength = cursor - nameStart;
    const isLinkAttribute = (nameLength === 4 && startsWithIgnoreCase(text, nameStart, 'href'))
      || (nameLength === 3 && startsWithIgnoreCase(text, nameStart, 'src'));

    let valueStart = skipHorizontalWhitespace(text, cursor, limit);
    if (valueStart >= limit || text[valueStart] !== '=') continue;
    valueStart = skipHorizontalWhitespace(text, valueStart + 1, limit);
    if (valueStart >= limit) return null;

    let valueEnd;
    const quote = text[valueStart];
    if (quote === '"' || quote === "'") {
      // HTML has no backslash escape: the value ends at the next same quote.
      if (lastOnLine(context, quote) <= valueStart) return null;
      valueStart += 1;
      valueEnd = valueStart;
      while (valueEnd < limit && text[valueEnd] !== quote) valueEnd += 1;
      if (valueEnd >= limit) return null;
      cursor = valueEnd + 1;
    } else {
      valueEnd = valueStart;
      while (valueEnd < limit && !isHorizontalWhitespace(text[valueEnd]) && text[valueEnd] !== '>') valueEnd += 1;
      cursor = valueEnd;
    }
    if (valueEnd === valueStart) continue;
    if (isLinkAttribute) {
      spans.push({ start: valueStart, end: valueEnd });
    } else {
      collectBareUrlSpans(text, valueStart, valueEnd, spans);
    }
  }
  return null;
}

/** `<scheme:…>` on the current line; index after the `>`, or -1. */
function scanAutolink(context, start) {
  if (lastOnLine(context, '>') <= start) return -1;
  const { text, lineEnd } = context;
  let cursor = start + 1;
  if (cursor >= lineEnd || !isAsciiLetter(text[cursor])) return -1;
  cursor += 1;
  while (cursor < lineEnd) {
    const character = text[cursor];
    if (isAsciiLetter(character) || isAsciiDigit(character) || character === '+' || character === '-' || character === '.') {
      cursor += 1;
      continue;
    }
    break;
  }
  if (cursor >= lineEnd || text[cursor] !== ':') return -1;
  cursor += 1;
  while (cursor < lineEnd) {
    const character = text[cursor];
    if (isHorizontalWhitespace(character) || character === '<') return -1;
    if (character === '>') return cursor + 1;
    cursor += 1;
  }
  return -1;
}

function scanUrlToken(text, start) {
  let cursor = start;
  let parenthesisDepth = 0;
  while (cursor < text.length) {
    const character = text[cursor];
    if (isHorizontalWhitespace(character) || isLineBreak(character)
      || character === '<' || character === '>' || character === '"'
      || character === "'" || character === ']') break;
    if (character === '(') {
      parenthesisDepth += 1;
    } else if (character === ')') {
      if (parenthesisDepth === 0) break;
      parenthesisDepth -= 1;
    }
    cursor += 1;
  }
  return cursor;
}

function hasPercentEncodedByte(text, start, end) {
  for (let index = start; index + 2 < end; index += 1) {
    if (text[index] === '%' && isHexDigit(text[index + 1]) && isHexDigit(text[index + 2])) return true;
  }
  return false;
}

/**
 * A bare URL beginning at `start`, or null. `relativeScannedUntil` is the end
 * of the last relative token found to carry no encoded byte: a path nested in
 * it cannot carry one either, so it is not scanned again.
 */
function scanBareUrl(text, start, relativeScannedUntil = -1) {
  // Asked at every character of the text: the first one decides almost always.
  const first = text[start];
  let kind = '';
  if (first === '/') {
    const next = text[start + 1];
    if (next === '/') {
      if (text[start + 2] && text[start + 2] !== '/') kind = 'protocol-relative';
    } else if (next && next !== '>' && !isHorizontalWhitespace(next)) {
      kind = 'relative';
    }
  } else if (first === 'h' || first === 'H') {
    if (startsWithIgnoreCase(text, start, 'https://') || startsWithIgnoreCase(text, start, 'http://')) kind = 'absolute';
  } else if (first === 'w' || first === 'W') {
    if (startsWithIgnoreCase(text, start, 'www.')) kind = 'www';
  }
  if (!kind || !isTokenBoundary(text, start)) return null;

  if (kind === 'relative' && start < relativeScannedUntil) return null;
  const end = scanUrlToken(text, start);
  if (end <= start + (kind === 'relative' ? 1 : 0)) return null;
  if (kind === 'relative' && !hasPercentEncodedByte(text, start, end)) {
    return { end, opaque: false };
  }
  return { end, opaque: true };
}

/** End of the last opaque bare URL beginning in `[start, end)`, or -1. */
function lastOpaqueUrlEnd(text, start, end) {
  let last = -1;
  let relativeScannedUntil = -1;
  let index = start;
  while (index < end) {
    const url = scanBareUrl(text, index, relativeScannedUntil);
    if (url?.opaque) {
      last = url.end;
      index = url.end;
      continue;
    }
    if (url) relativeScannedUntil = url.end;
    index += 1;
  }
  return last;
}

/** The opaque bare URLs inside `[start, end)`, appended to `spans` in order. */
function collectBareUrlSpans(text, start, end, spans) {
  let index = start;
  let relativeScannedUntil = -1;
  while (index < end) {
    const url = scanBareUrl(text, index, relativeScannedUntil);
    if (url?.opaque) {
      const urlEnd = Math.min(url.end, end);
      spans.push({ start: index, end: urlEnd });
      index = urlEnd;
      continue;
    }
    if (url) relativeScannedUntil = url.end;
    index += 1;
  }
}

function findOpaqueSpans(text) {
  const spans = [];
  const context = createLineContext(text);
  let relativeScannedUntil = -1;
  let index = 0;
  while (index < text.length) {
    enterLine(context, index);
    const character = text[index];

    if (character === '[' && index === context.lineStart) {
      const reference = scanReferenceDefinition(context, index);
      if (reference) {
        collectBareUrlSpans(text, index + 1, reference.labelEnd, spans);
        spans.push({ start: reference.start, end: reference.end });
        index = reference.end;
        continue;
      }
    }

    if (character === ']' && text[index + 1] === '(') {
      const end = scanMarkdownLink(context, index);
      if (end > 0) {
        spans.push({ start: index, end });
        index = end;
        continue;
      }
    } else if (character === '<') {
      const autolinkEnd = scanAutolink(context, index);
      if (autolinkEnd > 0) {
        spans.push({ start: index, end: autolinkEnd });
        index = autolinkEnd;
        continue;
      }
      const tag = scanHtmlTag(context, index);
      if (tag) {
        spans.push(...tag.spans);
        index = tag.end;
        continue;
      }
    } else {
      const url = scanBareUrl(text, index, relativeScannedUntil);
      if (url?.opaque) {
        spans.push({ start: index, end: url.end });
        index = url.end;
        continue;
      }
      // A relative path without an encoded byte is prose: it is read on, one
      // character at a time, so a URL glued to it (`/go?u=https://…`) is found.
      if (url) relativeScannedUntil = url.end;
    }
    // A failed scan skips nothing: the next character is examined on its own.
    index += 1;
  }
  return spans;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function createOpaqueSlotPrefix(input) {
  const base = '\u0001translation-glossary-slot-';
  let prefix = base;
  let suffix = 0;
  while (input.includes(prefix)) {
    suffix += 1;
    prefix = `${base}${suffix}-`;
  }
  return prefix;
}

function maskOpaqueSpans(input, spans) {
  if (!spans.length) return { masked: input, slots: [], prefix: '' };
  const prefix = createOpaqueSlotPrefix(input);
  const slots = [];
  let cursor = 0;
  let masked = '';
  for (const span of spans) {
    if (span.start < cursor) continue;
    masked += input.slice(cursor, span.start);
    const marker = `${prefix}${slots.length}\u0001`;
    slots.push(input.slice(span.start, span.end));
    masked += marker;
    cursor = span.end;
  }
  return { masked: masked + input.slice(cursor), slots, prefix };
}

function restoreOpaqueSlots(value, slots, prefix) {
  if (!slots.length) return value;
  const slotRe = new RegExp(`${escapeRegExp(prefix)}(\\d+)\\u0001`, 'g');
  return value.replace(slotRe, (_match, index) => slots[Number(index)] ?? '');
}

/** Remove template/placeholder tokens (see the design note above). */
export function stripPlaceholderTokens(text = '') {
  const input = String(text ?? '');
  if (!input) return input;
  const maskedSpans = maskOpaqueSpans(input, findOpaqueSpans(input));
  const out = maskedSpans.masked
    .replace(templatePlaceholderRe(), ' ')
    .replace(placeholderVocabRe(), ' ');
  if (out === maskedSpans.masked) return input;
  return restoreOpaqueSlots(tidySpacing(out), maskedSpans.slots, maskedSpans.prefix);
}

/** True when the string still carries at least one letter or digit. */
function hasMeaningfulText(value = '') {
  return /[\p{L}\p{N}]/u.test(String(value ?? ''));
}

/**
 * The single exit transform for BOTH translation entry points: restore
 * protected tokens, apply the protected-term glossary, strip placeholder
 * debris. Kept as one exported function so the two callers cannot drift.
 *
 * @param {Object} args
 * @param {string} args.sourceText       Original source-language text (the
 *          glossary triggers are matched against this, UNMASKED).
 * @param {string} args.translatedText   Raw translator output.
 * @param {string} args.targetLang       it/en/de/fr.
 * @param {('title'|'description')} [args.fieldType='title']
 * @param {Array} [args.protectedTokens=[]]  From `maskProtectedTokens`.
 * @returns {string} Corrected text, or '' when nothing meaningful survives.
 */
export function finalizeTranslatedText({
  sourceText,
  translatedText,
  targetLang,
  fieldType = 'title',
  protectedTokens = [],
}) {
  const restored = restoreProtectedTokens(translatedText, protectedTokens, targetLang, { fieldType });
  const corrected = applyGlossaryCorrections({
    sourceText,
    translatedText: restored,
    targetLang,
    fieldType,
  });
  const cleaned = stripPlaceholderTokens(corrected);
  return hasMeaningfulText(cleaned) ? cleaned : '';
}
