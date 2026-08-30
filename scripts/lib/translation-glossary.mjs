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
    for (const [pattern, replacement, opts] of rules) {
      if (!isTitle && opts && opts.titleOnly) continue;
      out = out.replace(pattern, (m) => matchCase(m, replacement));
    }
  }
  return out;
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
    String.raw`%[A-Z][A-Z0-9_]{1,39}%`,
    String.raw`__[A-Z][A-Z0-9_]{1,39}__`,
  ].join('|'),
  'g',
);

/** Collapse the whitespace/punctuation hole left by a removed token. */
function tidySpacing(value = '') {
  return String(value ?? '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\(\s*\)|\[\s*\]|\{\s*\}/g, '')
    .replace(/[ \t]+([,;:.!?])/g, '$1')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/(^|[ \t])[-–—|,/]+[ \t]*$/gm, '$1')
    .replace(/[ \t]+$/gm, '')
    .trim();
}

/** Remove template/placeholder tokens (see the design note above). */
export function stripPlaceholderTokens(text = '') {
  const input = String(text ?? '');
  if (!input) return input;
  const out = input
    .replace(templatePlaceholderRe(), ' ')
    .replace(placeholderVocabRe(), ' ');
  return out === input ? input : tidySpacing(out);
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
