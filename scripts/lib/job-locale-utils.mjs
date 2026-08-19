import { detectLanguageWithConfidence } from './detect-language.mjs';
import { escapeRegExpLiteral } from './escape-regexp.mjs';

export const DEFAULT_JOB_LOCALES = ['it', 'en', 'de', 'fr'];

const TITLE_HINTS = {
  en: [
    /\b(engineer|specialist|manager|coordinator|developer|scientist|designer|analyst|quality|project|customer|backend|frontend|software|full[\s-]?stack|intern|internship|associate|banking|all[\s-]?rounder|technician|process|operations?|sales|marketing|support|advisor|consultant|lead|head|product|application|supply chain|research|fellowship|student|position|coach|allocator|librarian|paid media|seo|life science)\b/gi,
    // Note: "jr"/"sr" removed from EN-only hints — they are used across IT/EN/DE/FR job titles
  ],
  de: [
    /\b(mitarbeiter|fachspezialist|fachfrau|fachmann|oberarzt|arzt|pflege|leiter|logistik|spital|praktikant|qualitat|qualität|ingenieur|techniker|verantwortliche|verantwortlicher|diatkoch|diätkoch|apotheker|systemgastronomie|systemgastronomiefachfrau|systemgastronomiefachmann|sekretär|sekretärin|onkologie|hämatologie|rayonleiter|metzger|detailhandelsfachfrau|detailhandelsfachmann|medizinische|berufsbildner|assistenzarzt|pflegefach|chefarzt|altersmedizin|kardiologie|herzchirurgie)\b/gi,
    /\b[a-zäöüß]+:in\b/gi,
    /\b[a-zäöüß]+:mann\b/gi,
    /\befz\b/gi,
    // Swiss health/hospital vocational + institutional vocabulary: German builds
    // these as single fused compound words (no space), so a bare word-boundary
    // alternative in the group above can't reach the stem inside e.g.
    // "Pflegefachperson" or "Poliklinik" (\b requires a non-word char right after
    // the match). Each gets its own \w*-padded stem regex instead of enumerating
    // every inflection/compound by hand. Bug: "Fachperson Gesundheit Universitäre
    // Klinik für Altersmedizin" shipped untranslated into an IT-locale slot —
    // none of fachperson/gesundheit/universitäre/klinik/altersmedizin had
    // word-hint support, so detection fell through to the char-hint-only tier
    // (0.45), under the 0.55 needsRetranslation threshold.
    // universität/universitär require the literal "ä" (no plain-"a" fallback,
    // unlike qualitat/qualität above) — "universit[aä][tr]" would also match
    // Italian "universitario/universitari(a)", which has no umlaut.
    /\b\w*fachperson\w*\b/gi,
    /\bgesundheit\w*\b/gi,
    /\b\w*klinik\w*\b/gi,
    /\b(universität|universitär)\w*\b/gi,
    /\b\w*geriatrie\w*\b/gi,
    /\bhauswirtschaft\w*\b/gi,
  ],
  it: [
    /\b(responsabile|medico|infermiere|impiegato|tecnico|cuoco|apprendista|apprendiste|candidato|collaboratore|ingegnere|caporeparto|fisioterapista|servizio civile|radiologia|ginecologia|ostetricia|ristorazione|operatore|segretario|segretaria|assistente|ricercatrice|ricercatore|architetture|sistemi|cucina|dietista|educatore|educatrice)\b/gi,
    /\b[a-z]+\/a\b/gi,
    /\b[a-z]+\/i\b/gi,
    /\b[a-z]+\/trice\b/gi,
  ],
  fr: [
    /\b(ingénieur|spécialiste|responsable|gestionnaire|employé|stagiaire|cuisinier|pharmacien|secrétaire|médical|technicien|qualité|radiologie|assistant|anesthésie|hématologie|oncologie)\b/gi,
  ],
};

const TITLE_CHAR_HINTS = {
  de: /[äöüß]/i,
  // 'ü' excluded: not a French letter — including it caused DE/FR score
  // ties on German titles (e.g. "Früh-/Spätdienst"), downgrading detection
  // confidence below the threshold needed to catch untranslated titles.
  fr: /[àâçéèêëîïôùûœ]/i,
};

/**
 * Confidence at which a caller may read `detectJobTitleLocaleDetails` as a
 * language *verdict* on a title. Every gate in the repo hardcodes this number;
 * it is exported so the ceiling/threshold relationship below is checkable
 * instead of implicit.
 */
export const TITLE_LANG_DECISION_CONFIDENCE = 0.55;

/**
 * Confidence reported by the `char-hint-only` tier — a single diacritic and
 * zero dictionary support.
 *
 * D1a (2026-08-10): this tier used to share one `Math.min(0.55, …)` cap with
 * `title-hints-soft`, and because a lone char hint contributes exactly +2 it
 * was pinned at 0.45 forever — i.e. **structurally incapable** of clearing the
 * 0.55 bar `titleLooksUntranslatedFromSource` compared it against. The fix is
 * NOT to raise it: a bare 'ü' from a toponym ("Zürich") is indistinguishable
 * from a German title at this tier, so raising it manufactures false
 * positives. The fix is to (a) stop pretending it is a graded score, (b) mark
 * it `advisory`, and (c) give the word-supported tier its own ceiling so that
 * one *can* reach the decision band. The invariant
 * `TITLE_LANG_ADVISORY_CONFIDENCE < TITLE_LANG_DECISION_CONFIDENCE <= TITLE_HINT_SOFT_CEILING`
 * is asserted in tests/job-title-locale-utils.test.ts.
 *
 * Value kept at 0.45 deliberately: `maybeRehomeLocalizedValue`
 * (dedicated-crawler-common.mjs:940) runs this detector against
 * `minConfidence = 0.35`, so lowering it would silently switch that path off.
 */
export const TITLE_LANG_ADVISORY_CONFIDENCE = 0.45;

/** Ceiling of the `title-hints-soft` tier — it has dictionary support, so it
 *  must be able to reach TITLE_LANG_DECISION_CONFIDENCE and beyond. */
const TITLE_HINT_SOFT_CEILING = 0.6;

/**
 * Below this, `detectLanguageWithConfidence` output on a *title* is noise, not
 * a weak signal. Measured on 300 live titles (2026-08-10): 41.3% of correct
 * titles score under 0.30, the detector false-alarms on 32.7% of correct
 * Italian titles and misses 55.0% of broken ones, and the 100%-German
 * "Sanitär-/Heizungsinstallateur/in (100%)" comes back `it @ 0.57`. Titles are
 * median 46 chars — below the strong-marker path in detect-language.mjs — and
 * carry almost no function words, which is what the trigram profiles need.
 * Hence: confidence is *reported* by titleLooksUntranslated() and never
 * *decides* anything there.
 */
export const TITLE_LANG_CONFIDENCE_FLOOR = 0.3;

function countMatches(text, regex) {
  if (!regex) return 0;
  const matches = text.match(regex);
  return matches ? matches.length : 0;
}

export function detectTextLocale(value = '', fallback = 'it') {
  const clean = String(value || '').trim();
  if (!clean) return { lang: fallback, confidence: 0, scores: {} };
  return detectLanguageWithConfidence(clean, fallback);
}

export function detectJobTitleLocaleDetails(title = '', fallback = 'it') {
  const clean = String(title || '').trim();
  if (!clean) {
    return { lang: fallback, confidence: 0, method: 'empty', scores: {} };
  }

  const wordScores = Object.fromEntries(
    DEFAULT_JOB_LOCALES.map((locale) => [locale, 0])
  );
  const scores = Object.fromEntries(
    DEFAULT_JOB_LOCALES.map((locale) => [locale, 0])
  );

  for (const locale of DEFAULT_JOB_LOCALES) {
    const rules = TITLE_HINTS[locale] || [];
    for (const rule of rules) {
      wordScores[locale] += countMatches(clean, rule) * 2;
    }
    scores[locale] = wordScores[locale];
    if (TITLE_CHAR_HINTS[locale]?.test(clean)) {
      scores[locale] += 2;
    }
  }

  const ranked = Object.entries(scores).sort((a, b) => b[1] - a[1]);
  const [bestLocale = fallback, bestScore = 0] = ranked[0] || [];
  const secondScore = ranked[1]?.[1] || 0;
  const detected = detectTextLocale(clean, fallback);
  // A bare diacritic (e.g. the 'ü' in a "Zürich" place name embedded in an
  // otherwise-correctly-translated title) must not alone be enough to declare
  // the whole title untranslated — require at least one dictionary word-hint
  // match before trusting the confident tiers below.
  const bestHasWordSupport = (wordScores[bestLocale] || 0) > 0;

  if (bestHasWordSupport && bestScore >= 3 && bestScore >= secondScore + 2) {
    return { lang: bestLocale, confidence: 0.85, method: 'title-hints-strong', scores };
  }
  if (bestHasWordSupport && bestScore >= 2 && bestScore > secondScore) {
    return { lang: bestLocale, confidence: 0.7, method: 'title-hints', scores };
  }
  if (detected.confidence >= 0.4) {
    return { ...detected, method: 'content-detector' };
  }
  if (bestScore > 0) {
    if (bestHasWordSupport) {
      // Dictionary evidence, just short of the margin the confident tiers want.
      // Own ceiling (0.6) so this tier can actually reach — and exceed — the
      // decision band; the shared 0.55 cap made "clears the bar" reachable in
      // exactly one arithmetic case. Values below bestScore 5 are unchanged.
      return {
        lang: bestLocale,
        confidence: Math.min(TITLE_HINT_SOFT_CEILING, 0.35 + bestScore * 0.05),
        method: 'title-hints-soft',
        scores,
      };
    }
    // A diacritic and nothing else. Not a verdict, by construction below
    // TITLE_LANG_DECISION_CONFIDENCE: see the constant's doc block.
    return {
      lang: bestLocale,
      confidence: TITLE_LANG_ADVISORY_CONFIDENCE,
      method: 'char-hint-only',
      advisory: true,
      scores,
    };
  }
  // D1c: the trigram detector routinely returns 0.05–0.15 on a 46-char title.
  // That is *absence of evidence*, and callers must not read it as "clean" —
  // titleLooksUntranslated() therefore never clears a title on confidence.
  return { ...detected, method: 'fallback', advisory: detected.confidence < TITLE_LANG_CONFIDENCE_FLOOR };
}

export function detectJobTitleLang(title = '', fallback = 'it') {
  return detectJobTitleLocaleDetails(title, fallback).lang;
}

// ─────────────────────────────────────────────────────────────────────────────
// Wrong-language job titles: exact lexical markers
//
// Why lexical and not statistical. Measured on 179 labelled live title slots
// and 300 raw ones (2026-08-10): every probabilistic route fails on this input.
// The trigram detector false-alarms on 32.7% of correct Italian titles and
// misses 55.0% of broken ones (see TITLE_LANG_CONFIDENCE_FLOOR). Content-token
// overlap against the source title has no usable operating point either —
// whole-title copies are only 3.1% of real failures, and at overlap ≥ 0.90 you
// buy 2.3% false positives for 7.6% recall. The dominant failure is PARTIAL:
// one or two German words left inside an otherwise-Italian title, e.g.
// "Responsabile di progetto Lüftung 80 - 100%", which scores 0.33 against its
// German source.
//
// What does work is an exact test for source-language *evidence* in the title,
// with the employer/location names removed first — no threshold, no confidence,
// deterministic. Overlap survives as a secondary signal because it is exact
// where it applies (it catches the whole-copy 3.1% outright).
// ─────────────────────────────────────────────────────────────────────────────

/** Overlap at which a slot is a near-copy of its source title. Secondary
 *  signal only: it is precise but has almost no recall on its own. */
export const DEFAULT_TITLE_OVERLAP_THRESHOLD = 0.85;

/**
 * Minimum content tokens on BOTH sides before the overlap ratio is allowed to
 * decide anything. |A n B| / min(|A|,|B|) has no resolution below ~4 tokens:
 * at min=2 a single shared token already scores 0.50 and two score 1.00. Both
 * measured overlap false positives were of exactly this shape — the correct
 * French "2nd Level Support Ingénieur" against its German "…Ingenieur", where
 * the only content tokens are an English phrase and a near-homograph. Exact
 * string equality (source-copy) is not gated: it needs no statistics.
 */
export const MIN_OVERLAP_TOKENS = 4;

const escapeRe = escapeRegExpLiteral;

const foldText = (value) =>
  String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '');

/**
 * Swiss toponyms, cantons, countries and employer/brand words that carry German
 * orthography while being perfectly at home in an Italian, French or English
 * title. THE trap for a naive "contains ä/ö/ü ⇒ German" rule: "Consulente
 * clienti Individual Zürich", "Grüze Park Winterthur", "Stazione di Ricerca
 * Früebüel" are all correct. Stored folded (diacritics stripped).
 *
 * This list is a backstop, not the main defence — passing `company` and
 * `location` to titleLooksUntranslated() removes the employer name outright and
 * is what the measurement was run with.
 */
const PROPER_NOUN_ALLOWLIST = new Set([
  // cantons / regions / countries
  'zurich', 'zurcher', 'graubunden', 'bundner', 'schwyz', 'schaffhausen',
  'thurgau', 'aargau', 'solothurn', 'luzern', 'basel', 'bern', 'genf', 'wallis',
  'tessin', 'ticino', 'waadt', 'jura', 'glarus', 'appenzell', 'uri', 'obwalden',
  'nidwalden', 'freiburg', 'neuenburg', 'schweiz', 'schweizer', 'schweizerische',
  'deutschland', 'osterreich', 'liechtenstein', 'suisse', 'svizzera',
  // frequent umlaut/cluster-bearing localities
  'kusnacht', 'kussnacht', 'wadenswil', 'dubendorf', 'rumlang', 'munchenstein',
  'munsingen', 'mohlin', 'harkingen', 'daniken', 'kolliken', 'buhler', 'stafa',
  'schonenwerd', 'ruschlikon', 'bulach', 'monchaltorf', 'gruningen', 'ruti',
  'pfaffikon', 'emmenbrucke', 'schlieren', 'schoftland', 'schafisheim',
  'winterthur', 'gruze', 'fruebuel', 'zurichsee', 'buchs', 'gossau', 'wil',
  // `Ober-` + a geographic element is a Swiss place name, NOT the German
  // intensifier prefix DE_PREFIX_RE looks for ("Oberarzt", "Oberpsychologin").
  // Measured 2026-08-10: ~110 flags across the dataset came from Oberland /
  // Oberwallis / Oberaargau / Oberwil / Oberhofen / Oberglatt sitting in a
  // correctly-translated it/en/fr title. The list is observation-based, like
  // the rest of this set — an unseen Ober-toponym still slips through, which is
  // the weakness the corpus fixture already documents under knownWeaknesses.
  'oberland', 'oberwallis', 'oberaargau', 'oberwil', 'oberhofen', 'oberglatt',
  'chur', 'davos', 'brig', 'visp', 'thun', 'olten', 'aarau', 'baden', 'brugg',
  'wettingen', 'spreitenbach', 'safenwil', 'dietikon', 'wetzikon', 'horgen',
  'thalwil', 'kilchberg', 'adliswil', 'opfikon', 'wallisellen', 'kloten',
  'volketswil', 'rapperswil', 'einsiedeln', 'altdorf', 'stans', 'sarnen',
  'engelberg', 'kriens', 'sursee', 'willisau', 'hochdorf', 'frauenfeld',
  'romanshorn', 'burgdorf', 'langenthal', 'zofingen', 'interlaken', 'spiez',
  'zermatt', 'martigny', 'sierre', 'sion', 'montreux', 'gstaad', 'klosters',
  // employer/brand words seen in the sample
  'migros', 'coop', 'swisscom', 'kuhne', 'nagel', 'buhrle', 'zurzach', 'spital',
  'kantonsspital', 'universitatsspital', 'unispital', 'genossenschaft',
]);

/**
 * Ordinary English and French words that trip the GERMAN morphology rules
 * below. Not proper nouns, so they are kept apart from PROPER_NOUN_ALLOWLIST,
 * but skipped at the same point and for the same reason: the token is evidence
 * of nothing.
 *
 * These exist because DE_CLUSTER_RE reasons about letter sequences, and three
 * of its clusters are perfectly ordinary in English: `tz` ends "Switzerland",
 * and `chm`/`chg`/`chs`/`dt` sit inside the `-ch` roots switch/watch/bench/
 * tech/match/attach/detach/sandwich. Measured over all 79,754 non-source title
 * slots (2026-08-10): ~127 flags, of which "Switzerland" alone was 88 — and
 * "Region German-speaking Switzerland" is about as unambiguously English as a
 * job title gets.
 *
 * Whole-token, folded, and deliberately NOT a substring test: a substring rule
 * on "tech" would also exempt "Gebäudetechnik", and exempting real German
 * compounds is the one thing this must not do. Entries are the tokens actually
 * observed in the dataset plus their regular inflections; every entry here
 * verifiably trips a rule, so nothing in the list is decoration ("coaches" and
 * "sandwiches" were dropped for that reason — only the French plurals
 * "coachs"/"sandwichs" produce the `chs` cluster).
 *
 * The alternative was to delete `tz` from DE_CLUSTER_RE outright. Measured on
 * the same sweep: that removes only 44 more flags than this list does, and all
 * 44 are German ("Metzger" alone is 292 flags, "Spritzguss", "Nutzfahrzeuge",
 * "Netzelektriker"). Allowlisting the English roots is strictly better.
 */
const NON_SOURCE_HOMOGRAPHS = new Set([
  'switzerland', 'switchgear', 'switchgears', 'switchboard', 'switchboards',
  'watchmaker', 'watchmakers', 'watchmaking', 'benchmark', 'benchmarks',
  'benchmarking', 'attachment', 'attachments', 'detachment', 'detachments',
  'coachs', 'sandwichs', 'techsupport', 'medtech', 'handtherapy',
  'matchmaker', 'matchmaking',
]);

/**
 * German nominal morphemes with no counterpart inside Italian / French /
 * English job vocabulary. Substring match on the folded token, one hit is
 * enough — that is what beats the incumbent `_hasWrongLangWords`, a ~100-word
 * whole-word denylist that needs TWO hits of words longer than 5 characters and
 * therefore reads "Fachperson Gesundheit Universitäre Klinik" as clean.
 *
 * English/French homographs are deliberately absent (monteur, disposition,
 * organisation, region, interesse, koch, still): including them trades away
 * more precision on correct EN/IT titles than the recall is worth.
 */
const DE_STEMS = [
  'anlagen', 'apotheke', 'arbeit', 'aushilf', 'ausbild',
  'bahnbau', 'berater', 'beratung', 'bereich', 'betreu', 'betrieb', 'buchhalt',
  'dienst', 'einkauf', 'empfang', 'entwicklung', 'erzieh',
  'fach', 'fahrzeug', 'fertigung', 'forschung', 'frisch', 'fuhrung',
  'gebaude', 'gesundheit', 'herren', 'haustechnik', 'hauswirtschaft', 'heizung',
  'instandhalt', 'kauffrau', 'kaufmann', 'konfektion', 'kunden',
  // `lehrstell` covers Lehrstelle/Lehrstellen: 197 slots carry the word and 33
  // of them had no other marker at all. It is added here to pay back the one
  // recall loss the `installateur` deletion causes —
  // "Lehrstelle Installateur/trice électricien/ne EFZ" is a French slot with a
  // German noun still in it, and `installateur` was the only rule reaching it.
  // No Italian/French/English word contains the sequence.
  'kuche', 'lager', 'lehrling', 'lehrstell', 'leiter', 'leitung', 'luftung', 'magaziner',
  'markt', 'maschinen', 'mechanik', 'mechatronik', 'pflege',
  'planung', 'polydesign', 'praktik', 'projekt', 'pruf', 'reinigung',
  'schlosser', 'schreiner', 'servicemonteur', 'sicherung', 'spengler',
  'stoffwechsel', 'talentpool', 'technik', 'umwelt', 'verantwort', 'verkauf',
  'versicherung', 'vertrieb', 'verwaltung', 'wartung', 'werkstatt', 'werkstud',
  'wesen', 'wirtschaft',
];
const DE_STEM_RE = new RegExp(`(?:${DE_STEMS.join('|')})`);
/**
 * German words whose *stem* is shared with a correct Italian or French word, so
 * they may only match as a whole token. `sanitar` would hit Italian
 * "Socio-Sanitario", `assistenz` hits "assistenza", and `physiotherapeut` hits
 * the correct French "Physiothérapeute" — all measured false positives.
 *
 * `installateur` was removed on 2026-08-10: it is spelled identically in
 * French, and because MARKER_SETS.de is scanned against every non-German slot
 * it fired on 279 slots of which 277 were correct FRENCH titles
 * ("Installateur sanitaire CFC", "Installateur-électricien"). It bought 2 true
 * positives. The German compounds are still reachable — `sanitarinstallateur`
 * is listed here in full and "Heizungsinstallateur" is caught by the `heizung`
 * stem — so the deletion costs no German recall at all.
 */
const DE_EXACT_TOKENS = new Set([
  'physiotherapeut', 'physiotherapeutin', 'assistenz', 'assistenzarzt',
  'assistenzarztin', 'sanitar', 'sanitarinstallateur',
]);
/** German nominal suffixes at token end (folded), plus the compound linker.
 *  Applied from 7 characters up: at 5 it swallows English "young". */
const DE_SUFFIX_RE = /(?:ung|ungen|heit|heiten|keit|keiten|schaft|schaften|bau)$|ungs/;
/** Token-initial German intensifier prefixes ("Oberarzt", "Oberpsychologin"). */
const DE_PREFIX_RE = /^(?:ober|stellvertret|zwischen)/;
/**
 * Letter sequences Italian orthography does not produce. "sch" is excluded
 * before e/i/h/o precisely because Italian *does* ("schema", "maschile") and so
 * does English ("school"). "pf" was dropped after it fired on English
 * "shopfloor" and "helpful".
 */
const DE_CLUSTER_RE = /chs|chb|chf|chg|chm|chw|tsch|sch(?![eiho])|tz|dt/;

const MARKER_SETS = {
  de: {
    // "in" is absent on purpose: it is a word in all four languages.
    //
    // "des" was removed on 2026-08-10 for the same reason, and it was the
    // single largest false-positive family in the whole detector: 2,209 flags
    // over the dataset, 2,192 of them on a CORRECT French title, because "des"
    // is the everyday French partitive article ("Directeur des ventes",
    // "spécialiste des restaurants"). That is 8.2% of every flag the detector
    // raised, all of it stealing capacity from the quota-limited repair queue.
    //
    // Reclassifying it as a FRENCH marker instead of deleting it looks tidier —
    // ALWAYS_SCANNED_MARKER_LANGS never scans a marker set against its own
    // locale, so it would stop firing on FR slots by construction. Measured, it
    // is worse: the fr set IS scanned against `de` slots, and 78 correct German
    // titles sitting in a non-source `de` slot carry the genitive "des"
    // ("Leiter des Referats …"), against 3 extra true positives. Swapping 2,192
    // French false positives for 78 German ones is not a fix, so "des" is gone.
    functionWords:
      /\b(?:mit|und|fuer|bei|beim|oder|von|vom|zur|zum|im|der|den|dem|das|ein|eine|einen|einem|einer|aus|auf|nach|ueber|unter|sowie|als|zwischen|waehrend|stv|inkl|gesucht)\b/,
    minFunctionWordHits: 1,
    // Case-insensitive AND an explicit uppercase-ß alternative: the `i` flag
    // folds Ä/Ö/Ü to äöü, but ß has no case-fold pair in this engine (its
    // uppercase form ẞ is a distinct codepoint JS regex `i` does not map back
    // to ß), so an all-caps title like "GRUPPENLEITER STRASSENUNTERHALT" would
    // otherwise slip past this signal entirely.
    orthography: /[äöüßẞ]/i,
    lexical: (folded) =>
      DE_EXACT_TOKENS.has(folded) ||
      (folded.length >= 5 && DE_STEM_RE.test(folded)) ||
      (folded.length >= 7 && (DE_SUFFIX_RE.test(folded) || DE_PREFIX_RE.test(folded))) ||
      (folded.length >= 6 && DE_CLUSTER_RE.test(folded)),
  },
  fr: {
    // "sous" was removed on 2026-08-10: in a job TITLE it is never the French
    // preposition, it is the kitchen-brigade rank "Sous Chef", which Italian,
    // English and German job ads all write verbatim. 19 flags over the whole
    // dataset, 19 of them "Sous Chef" / "Sous-Chef" in a correct it/en/de slot,
    // 0 true positives. Same call as the English/French homographs already kept
    // out of DE_STEMS.
    functionWords:
      /\b(?:avec|pour|dans|chez|ainsi|selon|aupres|notre|votre|entre)\b/,
    minFunctionWordHits: 1,
    orthography: null, // é/è/à also occur in correct Italian titles (qualità)
    lexical: (folded) =>
      folded.length >= 5 &&
      /^(?:collaborateur|collaboratrice|caissier|caissiere|caisse|etudiant|etudiante|diplome|diplomee|vendeur|vendeuse|apprenti|apprentie|cuisinier|cuisiniere|serveur|serveuse|magasinier|soignant|soignante|infirmier|infirmiere|gestionnaire|stagiaire|responsabilites|competences|physiotherapeute)$/.test(folded),
  },
  it: {
    functionWords:
      /\b(?:della|delle|degli|dello|nella|nelle|nello|presso|oppure|anche|tramite|sulla|sulle|senza)\b/,
    minFunctionWordHits: 1,
    orthography: null,
    lexical: () => false,
  },
  en: {
    // English borrowings are normal inside Italian job titles ("Project
    // Manager", "Store Manager"), so EN needs two independent hits.
    functionWords: /\b(?:with|and|for|the|your|our|within|including)\b/,
    minFunctionWordHits: 2,
    orthography: null,
    lexical: () => false,
  },
};

/**
 * Marker sets scanned against every non-source title, whatever `sourceLang`
 * claims. A DE-source job whose IT slot carries French residue is broken too,
 * and `sourceLang` is frequently inferred (canton language zone) rather than
 * known. EN/IT sets stay opt-in via `sourceLang` — see MARKER_SETS.en.
 *
 * This list is deliberately unchanged by the 2026-08-10 false-positive pass,
 * and the reasoning is the whole point of the fix. Scanning German markers
 * against a French slot is CORRECT: a German title really can land there, and
 * `sourceLang` is not trustworthy enough to decide otherwise. What was wrong
 * was the contents of MARKER_SETS.de — "des" and "installateur" are not German-
 * exclusive evidence, so scanning them cross-language turned every correct
 * French title carrying one into a repair-queue entry.
 *
 * The invariant a marker must satisfy to live in a set scanned this way:
 * **the token must be evidence of that language and of no other of the four.**
 * Narrowing the scan instead would have hidden the bad entries rather than
 * removed them, and would have cost the cross-language recall this list exists
 * for — French residue in an IT slot is 199 real flags in the same sweep.
 */
const ALWAYS_SCANNED_MARKER_LANGS = ['de', 'fr'];

/**
 * German inclusive-gender orthography.
 *
 * The separator must be glued to the PRECEDING word — that is what separates
 * "Consulente di vendita: in cosmetici" (German "Verkäufer:in", machine-
 * translated word by word, colon left behind) from ordinary punctuation, which
 * in a title is followed by a space on both sides or none at all. One optional
 * space AFTER the separator is allowed because the translators insert it: this
 * space-separated form is the single largest failure family in the corpus
 * (10 of 15 misses before it was added), and it is invisible to a rule that
 * only looks for the glued `:in`.
 *
 * `/in` additionally needs the trailing word boundary so that the correct
 * English "Physiotherapist/inpatient" does not match. The optional hyphen
 * before `in` catches the alternate translator artifact "Dipendente/-in"
 * (source "Mitarbeiter/-in"), where the slash-hyphen is carried over as one
 * glued unit instead of the plain slash form. The third alternative —
 * a colon glued between two words — catches the form where the translator
 * also translated the suffix ("Konstrukteur:in" -> "Conduttore:nella"),
 * which no amount of German vocabulary would find.
 */
const BINNEN_I_RE = /\p{L}{3,}[:*_] ?in(?:nen)?\b|\p{L}{4,}\/-?in\b|\p{L}{3,}:\p{L}{2,}/iu;
/** ":r"/"*r"/"_r" is one letter and far weaker — see the corroboration rule in
 *  scanSourceMarkers(). */
const GENDER_R_RE = /(\p{L}{4,})[:*_] ?r\b/giu;
/** (m/w/d), (w/m/d), (m/w/x) — German gender codes. `(f/m)`, `(m/f/d)` are not. */
const GENDER_CODE_RE = /\(\s*([mwfdxahn])\s*[/|]\s*([mwfdxahn])(?:\s*[/|]\s*([mwfdxahn]))?\s*\)/gi;

/** Split off the " — Employer" suffix and erase the company/location names. */
function stripEntityNames(text, company = '', location = '') {
  let out = String(text || '').split(/\s+[—–]\s+/)[0];
  for (const raw of [company, location]) {
    const value = String(raw || '').trim();
    if (value.length < 2) continue;
    out = out.replace(new RegExp(escapeRe(value), 'gi'), ' ');
    for (const word of value.split(/[^\p{L}\p{N}]+/u)) {
      if (word.length >= 3) out = out.replace(new RegExp(`\\b${escapeRe(word)}\\b`, 'giu'), ' ');
    }
  }
  return out;
}

const contentTokens = (text) =>
  String(text || '')
    .split(/[^\p{L}]+/u)
    .filter(Boolean);

/** Tokens used for the overlap signal: folded, letters only, ≥ 4 characters. */
function overlapTokens(text, company, location) {
  return new Set(
    contentTokens(foldText(stripEntityNames(text, company, location))).filter((t) => t.length >= 4)
  );
}

function tokenOverlap(a, b) {
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const token of a) if (b.has(token)) shared += 1;
  return shared / Math.min(a.size, b.size);
}

/**
 * Case- and punctuation-insensitive, but diacritic-SENSITIVE on purpose: the
 * only difference between the German "CSV Requirements Ingenieur" and its
 * correct French slot "CSV Requirements Ingénieur" is the accent, and folding
 * it away turned a real (if minimal) translation into a "source-copy".
 */
const normalizeForCompare = (value) =>
  String(value || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

function hasGermanGenderCode(body) {
  GENDER_CODE_RE.lastIndex = 0;
  let match;
  while ((match = GENDER_CODE_RE.exec(body))) {
    const letters = match.slice(1).filter(Boolean).map((l) => l.toLowerCase());
    if (letters.includes('w')) return true;
  }
  return false;
}

/**
 * @returns {{reason: string, evidence: string}|null} first marker family that
 *   fires for `markerLang` inside `body`, or null.
 */
function scanSourceMarkers(body, markerLang, sourceTokens) {
  const set = MARKER_SETS[markerLang];
  if (!set) return null;
  const folded = foldText(body);

  const fnHits = set.functionWords ? countMatches(folded, new RegExp(set.functionWords.source, 'g')) : 0;
  if (fnHits >= (set.minFunctionWordHits || 1)) {
    const hit = folded.match(new RegExp(set.functionWords.source));
    return { reason: 'source-function-word', evidence: hit ? hit[0] : String(fnHits) };
  }

  const tokens = contentTokens(body);
  for (const token of tokens) {
    const key = foldText(token);
    if (PROPER_NOUN_ALLOWLIST.has(key) || NON_SOURCE_HOMOGRAPHS.has(key)) continue;
    if (set.orthography && set.orthography.test(token)) {
      return { reason: 'source-orthography', evidence: token };
    }
    if (set.lexical && set.lexical(key)) {
      return { reason: 'compound-residue', evidence: token };
    }
  }

  if (markerLang === 'de') {
    if (BINNEN_I_RE.test(body)) {
      return { reason: 'binnen-i', evidence: body.match(BINNEN_I_RE)[0] };
    }
    // ":r" alone is a single letter and appears in slots a translator merely
    // reformatted ("Regional:r VET managers:r" — correct English). It only
    // counts when the token carrying it survived verbatim from the source
    // title, i.e. when it is genuinely residue.
    GENDER_R_RE.lastIndex = 0;
    let match;
    while ((match = GENDER_R_RE.exec(body))) {
      if (sourceTokens && sourceTokens.has(foldText(match[1]))) {
        return { reason: 'binnen-i', evidence: match[0] };
      }
    }
  }
  return null;
}

/**
 * Does the `targetLocale` slot of a job still read as another language?
 *
 * PRIMARY signal: exact source-language markers inside the title once the
 * employer and location names are removed — function words, German
 * orthography, inclusive-gender artefacts, German compound morphology.
 * SECONDARY signal: content-token overlap with `sourceTitle`, which catches the
 * whole-copy case outright but on its own has no usable operating point.
 *
 * German gender codes ((m/w/d) in an Italian title) are reported in `markers`
 * and via `genderCode`, but do NOT set `untranslated` unless `flagGenderCode`
 * is passed: they are a locale inconsistency, not a wrong-language title, and
 * folding them into the verdict inflates the false-positive rate against
 * otherwise-correct titles.
 *
 * Every field is optional at the type level because the function guards all
 * of them: a caller that hands over a half-populated record gets
 * `untranslated:false`, never a throw. `title`, `sourceLang` and
 * `targetLocale` are nonetheless required for a meaningful verdict.
 *
 * @param {object}  [args]
 * @param {string} [args.title]           text in the target slot
 * @param {string} [args.sourceTitle]     titleByLocale[sourceLang]; optional —
 *                                        without it only the marker signal runs
 * @param {string} [args.sourceLang]
 * @param {string} [args.targetLocale]
 * @param {string} [args.company]         stripped before comparison — mandatory
 *                                        in practice, see PROPER_NOUN_ALLOWLIST
 * @param {string} [args.location]        stripped before comparison
 * @param {number} [args.overlapThreshold]
 * @param {boolean}[args.flagGenderCode]
 * @returns {{untranslated: boolean, reason: string, overlap: number,
 *            detected: {lang: string, confidence: number},
 *            markers: string[], evidence: string, genderCode: boolean}}
 *   reason ∈ 'source-copy' | 'source-function-word' | 'source-orthography' |
 *            'binnen-i' | 'compound-residue' | 'gender-code' |
 *            'source-overlap' | 'ok'
 */
export function titleLooksUntranslated({
  title,
  sourceTitle = '',
  sourceLang,
  targetLocale,
  company = '',
  location = '',
  overlapThreshold = DEFAULT_TITLE_OVERLAP_THRESHOLD,
  flagGenderCode = false,
} = {}) {
  const clean = String(title || '').trim();
  const target = String(targetLocale || '').trim().toLowerCase();
  const source = String(sourceLang || '').trim().toLowerCase();
  const idle = {
    untranslated: false,
    reason: 'ok',
    overlap: 0,
    detected: { lang: target || 'it', confidence: 0 },
    markers: [],
    evidence: '',
    genderCode: false,
  };
  if (!clean || !target || source === target) return idle;

  const body = stripEntityNames(clean, company, location);
  const srcClean = String(sourceTitle || '').trim();
  const detectedRaw = detectJobTitleLocaleDetails(body || clean, target);
  const detected = { lang: detectedRaw.lang, confidence: detectedRaw.confidence };

  const targetTokens = overlapTokens(clean, company, location);
  const sourceTokens = srcClean ? overlapTokens(srcClean, company, location) : null;
  const overlap = sourceTokens ? tokenOverlap(targetTokens, sourceTokens) : 0;

  const markers = [];
  const genderCode = hasGermanGenderCode(body) && target !== 'de';
  if (genderCode) markers.push('gender-code');

  const verdict = (reason, evidence = '') => ({
    untranslated: true, reason, overlap, detected, markers, evidence, genderCode,
  });

  if (srcClean && normalizeForCompare(clean) === normalizeForCompare(srcClean)) {
    markers.unshift('source-copy');
    return verdict('source-copy', srcClean);
  }

  const scanLangs = [];
  if (source && source !== target) scanLangs.push(source);
  for (const lang of ALWAYS_SCANNED_MARKER_LANGS) {
    if (lang !== target && !scanLangs.includes(lang)) scanLangs.push(lang);
  }
  let first = null;
  for (const lang of scanLangs) {
    const hit = scanSourceMarkers(body, lang, sourceTokens);
    if (!hit) continue;
    markers.unshift(hit.reason);
    if (!first) first = hit;
  }
  if (first) return verdict(first.reason, first.evidence);

  const overlapUsable =
    !!sourceTokens && targetTokens.size >= MIN_OVERLAP_TOKENS && sourceTokens.size >= MIN_OVERLAP_TOKENS;
  if (overlapUsable && overlap >= overlapThreshold) {
    markers.unshift('source-overlap');
    return verdict('source-overlap', [...targetTokens].join(' '));
  }
  if (genderCode && flagGenderCode) return verdict('gender-code');

  return { ...idle, overlap, detected, markers, genderCode };
}

/**
 * Generic "this slot is not in `targetLocale`" check — the 3-argument form kept
 * for the call sites in dedicated-crawler-common.mjs.
 *
 * It now delegates to titleLooksUntranslated(). The old implementation asked
 * "does this still read as the SOURCE language, with confidence ≥ 0.55?", which
 * fails twice over (D1): the question is inverted — translating three function
 * words flips the answer while the domain nouns stay German — and the tier a
 * German title actually lands in is capped below 0.55, so a 100%-untranslated
 * title returned false. Without `sourceTitle` here, only the marker signal runs.
 *
 * @param {string} title        text currently stored in `targetLocale`'s slot
 * @param {string} sourceLang   the job's actual source language
 * @param {string} targetLocale the locale slot being checked
 * @param {object} [options]    forwarded to titleLooksUntranslated;
 *   `minConfidence` is accepted and inert — the verdict is lexical now, because
 *   the confidence it used to gate on was measured unusable on titles.
 * @returns {boolean}
 */
export function titleLooksUntranslatedFromSource(title, sourceLang, targetLocale, options = {}) {
  const clean = String(title || '').trim();
  if (!clean || !sourceLang || !targetLocale || sourceLang === targetLocale) return false;
  const { minConfidence: _ignored, ...rest } = options;
  return titleLooksUntranslated({ title: clean, sourceLang, targetLocale, ...rest }).untranslated;
}

/**
 * Publisher-authored jobs declare their source language explicitly: the title
 * and description are human-written by the employer in `sourceLang`, so
 * heuristic language detection must never override that slot. Detection sees
 * an Italian title like "Prompt engineer da remoto" as EN (job-title hints are
 * dominated by English loanwords) and then "repairs" the IT slot via
 * heuristicTranslateJobTitle → "Prompt Ingegnere da remoto" — destroying the
 * paid, publisher-written copy. Both heuristic sites
 * (shared-jobs-crawler ensureLocaleFields and dedicated-crawler-common
 * hardenJobLocaleFields) consult this pin before trusting detection.
 *
 * @param {object} job  any job-shaped record
 * @returns {string|null} the declared source locale to pin, or null to detect
 */
export function pinnedTitleSourceLang(job) {
  if (!job || job.source !== 'publisher-submitted') return null;
  const lang = String(job.sourceLang || '').trim().toLowerCase();
  return DEFAULT_JOB_LOCALES.includes(lang) ? lang : null;
}
