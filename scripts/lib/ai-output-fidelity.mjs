/**
 * Invariants for AI steps whose output must stay faithful to the text they were
 * given (the job-description formatter and the thin-description composer in
 * shared-jobs-crawler.mjs).
 *
 * Why this exists. `structureJobDescription` asks the model to "keep ALL original
 * content verbatim … only add markdown structure", but used to accept ANY answer
 * at least 70 % as long as the input. A reasoning model answered with its own
 * thinking — «Here's a thinking process: 1. Analyze User Input: - Role: Job
 * listing formatter …», 12 000 characters that also quote the whole input — and
 * that passed the length check, landed in the persistent AI cache and was then
 * translated into every locale (swiss-medical-network `montchoisi-motionlab`,
 * 2026-09). A length ratio cannot tell a restructuring from a monologue ABOUT the
 * restructuring; the token content can.
 *
 * Two independent checks, both pure and deterministic:
 *   1. detectAiReasoningLeak(): the answer opens with a reasoning preamble or
 *      echoes our own prompt (role/rules/"analyze user input"), in any of the
 *      site's four languages — including the garbled machine translations of
 *      those markers that the free cascade produced from a leaked source slot.
 *   2. assessVerbatimRestructure(): after removing markdown markers and the
 *      section headings the prompt itself asks for, the answer must be (almost)
 *      only input tokens (precision) and must carry (almost) all of them
 *      (recall). Counted as multisets, so an answer that quotes the input AND
 *      adds commentary, or repeats it twice, fails precision.
 *
 * assessComposedFromInputs() is the weaker contract of the composer step, which
 * legitimately writes new connective prose: every sentence/bullet it writes must
 * be anchored in the data it was given.
 *
 * detectAiReasoningLeak() is also the leak check of the translation steps
 * (translation-quality isAcceptableTranslation, dedicated-crawler-common
 * aiTranslateJobDescriptionDCC, re-localize-jobs) — two published slots were
 * born there («I'll translate this job description from Italian to English. Let
 * me first read the full content from the file. [{"tool_name": …») — and of the
 * repair selector (relocalize-pending-jobs isIncomplete), so a slot that already
 * leaked is queued for retranslation instead of counting as complete.
 */

// Measured on tests/fixtures/ai-output-fidelity/formatter-pairs.json (real
// formatter answers from the published slices, 2026-09-29): the six faithful
// restructurings score precision 0.947–1.000 and recall 0.904–1.000 (the model
// drops an "apply here" line or a link now and then); the leaked answers score
// precision 0.347 (a monologue that quotes the whole input) and 0.573 (a chatty
// preamble before a paraphrase). 0.9 sits between the two populations.
export const VERBATIM_RESTRUCTURE_MIN_PRECISION = 0.9;
export const VERBATIM_RESTRUCTURE_MIN_RECALL = 0.9;

// A composed sentence is "anchored" when at least this share of its content
// words appears somewhere in the data the composer was given.
export const COMPOSED_UNIT_MIN_SUPPORT = 0.5;
// Units with fewer content words than this are too short to judge (a label, a
// location line, "Lugano, 100%").
export const COMPOSED_UNIT_MIN_WORDS = 4;

// How far into the answer a reasoning preamble is looked for. The markers below
// are ordinary words ("processus de réflexion", "your instructions") that a real
// job ad can contain in its body; at the very start of an answer that was told
// to output only the formatted ad, they are a preamble.
const LEADING_WINDOW_CHARS = 320;

const APOS = "['’]";

/** Prompt echoes: fragments of OUR prompts, or of the model's analysis of them. Never in a job ad. */
const PROMPT_ECHO_PATTERNS = [
  /<\/?think>/i,
  /\bjob listing (?:formatter|expert)\b/i,
  /\bformattatore di annunci\b/i,
  /\bformatierer (?:von|für) stellen/i,
  new RegExp(`\\bformateur d${APOS}(?:offres|annonces)`, 'i'),
  /\bkeep all (?:the )?original content\b/i,
  /\bonly add markdown structure\b/i,
  /\boutput only the formatted markdown\b/i,
  new RegExp(`\\banaly[sz]e (?:the )?user(?:${APOS}s)? (?:input|request)\\b`, 'i'),
  new RegExp(`\\banalizza(?:re)? l${APOS}input (?:dell${APOS})?utente\\b`, 'i'),
  new RegExp(`\\banalisi dei dati forniti dall${APOS}utente\\b`, 'i'),
  /\bbenutzereingaben? analysieren\b/i,
  new RegExp(`\\banalyser (?:l${APOS}entrée|les entrées) de l${APOS}utilisateur`, 'i'),
  // The translation prompts (dedicated-crawler-common aiTranslateJobDescriptionDCC /
  // aiLocalizeJobContentDCC, re-localize-jobs.mjs).
  /\btranslate this job (?:description|posting) from\b/i,
  /\bkeep company names, product names\b/i,
  /\breturn only translated text\b/i,
  /\bmultilingual job content editor\b/i,
];

/** Reasoning/chatter openers, only meaningful at the start of the answer. */
const LEADING_REASONING_PATTERNS = [
  // «Here's a thinking process:», «Ecco un processo di ragionamento:»,
  // «Hier ist ein Denkansatz:», «Voici un processus de réflexion :». Only
  // reasoning nouns: «Ecco il processo di selezione» is an ad, not a leak.
  /^(?:here(?:['’]s| is)) (?:a|an|my|the) (?:thinking|thought|reasoning)\b/i,
  /^ecco (?:un|il mio|il) (?:processo di (?:ragionamento|riflessione|pensiero)|ragionamento)\b/i,
  /^hier ist (?:ein|mein|der) (?:denkansatz|denkprozess|gedankengang)\b/i,
  /^voici (?:un|mon|le) (?:processus de (?:réflexion|pensée)|raisonnement)/i,
  /^(?:thinking|thought|reasoning)(?: process)?\s*:/i,
  // «I notice the text provided is in German and Italian …»
  /^(?:i notice|i noticed|i see that|i can see that|noto che|ho notato|ich bemerke|mir fällt auf|je remarque|je constate)\b/i,
  /^(?:okay|ok|alright|sure|certainly|certo|va bene|gerne|alles klar|bien sûr|d['’]accord)[,.!:]?\s+(?:let me|let['’]s|here|i(?:['’]ll| will| need)|the user|so\b|ecco|hier|voici)/i,
  // «Let's think:», «Let me analyze the text», «Ragioniamo:», «Lass uns
  // überlegen», «Réfléchissons» — also behind a list number (leadingWindow
  // strips «1.»/«1)»), which is how a step-by-step answer opens.
  /^(?:let(?:['’]s| me| us)|lass(?:t)? uns|lasciami)\s+(?:think|analy[sz]e|break (?:it|this) down|reason|consider|start by|go through|look at (?:the|this)|überlegen|nachdenken|analysieren|ragionare|analizzare|pensare)\b/i,
  // Only verbs of deliberation: «Pensiamo in grande» or «Denken wir weiter»
  // can open a real ad.
  /^(?:ragioniamo|analizziamo|überlegen wir|analysieren wir|réfléchissons|analysons|raisonnons)\b/i,
];

const LEADING_ANYWHERE_IN_WINDOW_PATTERNS = [
  /\b(?:following|per|as per|according to) your (?:instructions?|rules|request)\b/i,
  /\b(?:the user|l['’]utente|der (?:benutzer|nutzer)|l['’]utilisateur) (?:wants|asks|is asking|has provided|provided|vuole|chiede|ha fornito|möchte|will|hat|veut|souhaite|demande|a fourni)\b/i,
  /\bhere(?:['’]s| is) (?:the|my|a) (?:formatted|restructured|structured|composed|translated|translation)\b/i,
];

function leadingWindow(text) {
  // Markdown markers and list numbering («1. Let's think:», «1) …») are not
  // content: the opener is judged after them.
  return String(text || '')
    .replace(/^(?:[\s#>*_`\-•]+|\(?\d{1,2}[.)]\s*)+/u, '')
    .slice(0, LEADING_WINDOW_CHARS);
}

/**
 * Detect a model answer that contains its reasoning or echoes the prompt instead
 * of (only) the requested text.
 * @param {string} text
 * @returns {{ kind: 'prompt-echo' | 'reasoning-preamble', marker: string } | null}
 */
export function detectAiReasoningLeak(text) {
  const value = String(text || '');
  if (!value.trim()) return null;
  for (const re of PROMPT_ECHO_PATTERNS) {
    const m = value.match(re);
    if (m) return { kind: 'prompt-echo', marker: m[0] };
  }
  const head = leadingWindow(value);
  for (const re of LEADING_REASONING_PATTERNS) {
    const m = head.match(re);
    if (m) return { kind: 'reasoning-preamble', marker: m[0] };
  }
  for (const re of LEADING_ANYWHERE_IN_WINDOW_PATTERNS) {
    const m = head.match(re);
    if (m) return { kind: 'reasoning-preamble', marker: m[0] };
  }
  return null;
}

function stripMarkupForTokens(text) {
  return String(text || '')
    .normalize('NFC')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/&nbsp;|&amp;|&lt;|&gt;|&quot;|&#39;/g, ' ');
}

/** Lower-cased letter/number tokens; markdown markers and punctuation are not tokens. */
export function fidelityTokens(text) {
  return stripMarkupForTokens(text).toLowerCase().match(/[\p{L}\p{N}]+/gu) || [];
}

function countTokens(tokens) {
  const counts = new Map();
  for (const t of tokens) counts.set(t, (counts.get(t) || 0) + 1);
  return counts;
}

function normalizeHeadingText(text) {
  return fidelityTokens(text).join(' ');
}

const MAX_HEADING_TOKENS = 8;

/**
 * Split an answer into body tokens and heading tokens. Heading lines are the
 * structure the formatter prompt asks for (`## Mansioni`), plus lines that are
 * only one of the known localized section headings (`**Requisiti:**`). A long
 * "heading" is content and stays in the body.
 */
function splitHeadingTokens(output, headingVocabulary) {
  const known = new Set((headingVocabulary || []).map(normalizeHeadingText).filter(Boolean));
  const body = [];
  const heading = [];
  for (const line of String(output || '').split(/\r?\n/)) {
    const tokens = fidelityTokens(line);
    if (tokens.length === 0) continue;
    const isMarkdownHeading = /^\s*#{1,6}\s/.test(line) && tokens.length <= MAX_HEADING_TOKENS;
    const isKnownHeading = known.has(tokens.join(' '));
    if (isMarkdownHeading || isKnownHeading) heading.push(...tokens);
    else body.push(...tokens);
  }
  return { body, heading };
}

/**
 * The formatter invariant: `output` is `input` plus markdown structure.
 * @param {string} input   the flat text given to the model
 * @param {string} output  the model's answer (code fences already removed)
 * @param {{ headingVocabulary?: string[], minPrecision?: number, minRecall?: number }} [opts]
 * @returns {{ ok: boolean, reason: string | null, precision: number, recall: number, leak: object | null }}
 */
export function assessVerbatimRestructure(input, output, opts = {}) {
  const minPrecision = opts.minPrecision ?? VERBATIM_RESTRUCTURE_MIN_PRECISION;
  const minRecall = opts.minRecall ?? VERBATIM_RESTRUCTURE_MIN_RECALL;
  const leak = detectAiReasoningLeak(output);
  const inCounts = countTokens(fidelityTokens(input));
  const inTotal = [...inCounts.values()].reduce((a, b) => a + b, 0);
  const { body, heading } = splitHeadingTokens(output, opts.headingVocabulary);
  const bodyCounts = countTokens(body);
  const remaining = new Map(inCounts);
  let matchedBody = 0;
  for (const [t, c] of bodyCounts) {
    const avail = remaining.get(t) || 0;
    const m = Math.min(c, avail);
    matchedBody += m;
    if (m) remaining.set(t, avail - m);
  }
  let matchedHeading = 0;
  for (const [t, c] of countTokens(heading)) {
    const avail = remaining.get(t) || 0;
    const m = Math.min(c, avail);
    matchedHeading += m;
    if (m) remaining.set(t, avail - m);
  }
  const precision = body.length ? matchedBody / body.length : 0;
  const recall = inTotal ? (matchedBody + matchedHeading) / inTotal : 0;
  let reason = null;
  // A few repeats of one word barely move precision in a long answer
  // («… Lights Lights Lights Lights Lights …»), so the loop is judged on its own.
  const degenerate = leak ? null : detectDegenerateRepetition(output, { references: [input] });
  if (leak) reason = `reasoning-leak:${leak.marker}`;
  else if (degenerate) reason = `degenerate-repetition:${degenerate.kind}`;
  else if (!body.length) reason = 'empty-output';
  else if (precision < minPrecision) reason = `added-content:precision=${precision.toFixed(3)}`;
  else if (recall < minRecall) reason = `dropped-content:recall=${recall.toFixed(3)}`;
  return { ok: reason === null, reason, precision, recall, leak };
}

// Function words that carry no claim, so a composed sentence is judged on the
// words that do. Only words of ≥ 4 letters matter (shorter ones are skipped).
const COMPOSED_STOPWORDS = new Set([
  // it
  'della', 'delle', 'dello', 'degli', 'nella', 'nelle', 'nello', 'negli', 'alla', 'alle', 'allo', 'agli',
  'dalla', 'dalle', 'sulla', 'sulle', 'sono', 'siamo', 'essere', 'viene', 'questo', 'questa', 'questi',
  'queste', 'anche', 'come', 'oppure', 'nonché', 'inoltre', 'presso', 'verso', 'tutti', 'tutte', 'ogni',
  'nostro', 'nostra', 'nostri', 'nostre', 'vostro', 'vostra', 'tuoi', 'loro', 'quale', 'quali', 'dove',
  'quando', 'mentre', 'molto', 'più', 'sarà', 'saranno', 'possono', 'deve', 'devono',
  // en
  'with', 'your', 'from', 'that', 'this', 'these', 'those', 'will', 'into', 'have', 'has', 'been', 'being',
  'their', 'there', 'they', 'which', 'while', 'where', 'when', 'also', 'within', 'about', 'other', 'such',
  'more', 'most', 'must', 'should', 'would', 'could', 'each', 'both', 'well', 'including',
  // de
  'eine', 'einer', 'einem', 'einen', 'eines', 'sich', 'oder', 'sowie', 'auch', 'wird', 'werden', 'sind',
  'dein', 'deine', 'deinen', 'deiner', 'unser', 'unsere', 'unseren', 'unserer', 'unserem', 'ihre', 'ihren',
  'ihrer', 'dass', 'durch', 'nach', 'über', 'unter', 'für', 'beim', 'zum', 'zur', 'dies', 'diese',
  'dieser', 'dieses', 'haben', 'hast', 'kann', 'können', 'mehr', 'sehr', 'bzw',
  // fr
  'pour', 'dans', 'avec', 'vous', 'votre', 'vos', 'nous', 'notre', 'nos', 'leur', 'leurs', 'sont', 'être',
  'ainsi', 'aussi', 'cette', 'ces', 'afin', 'chez', 'sera', 'seront', 'plus', 'très', 'tout', 'tous',
  'toutes', 'toute', 'entre', 'dont', 'mais', 'lors',
]);

function contentWords(text) {
  return fidelityTokens(text).filter((t) => (t.length >= 4 && !COMPOSED_STOPWORDS.has(t)) || /\d/.test(t));
}

// A composed sentence re-inflects the words it takes from the data
// («exklusiven Mitarbeiterpreisen» → «exklusive Mitarbeiterpreise»,
// «Weiterbildung» → «Weiterbildungen»). Words are compared on their prefixes of
// at least max(4, length − 3) letters, which absorbs inflectional endings in the
// four languages without matching unrelated words of a shared 3-letter root.
function inflectionPrefixes(token) {
  const min = Math.max(4, token.length - 3);
  const out = [];
  for (let n = Math.min(min, token.length); n <= token.length; n += 1) out.push(token.slice(0, n));
  return out;
}

function composedUnits(output) {
  const units = [];
  for (const rawLine of String(output || '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || /^#{1,6}\s/.test(line)) continue;
    const text = line.replace(/^[-*•]\s+/, '');
    for (const sentence of text.split(/(?<=[.!?])\s+(?=[\p{Lu}"«„])/u)) {
      if (sentence.trim()) units.push(sentence.trim());
    }
  }
  return units;
}

/**
 * The composer invariant: every sentence or bullet of `output` is anchored in
 * the data the model was given. A sentence whose content words are mostly
 * absent from ALL inputs is invented text ("Offriamo un ambiente dinamico e
 * stimolante" for an ad that lists no benefit).
 * @param {string[]} inputs        every text the prompt carried (title, company, description, bullets…)
 * @param {string} output
 * @param {{ allowedWords?: string[], minSupport?: number, minWords?: number, references?: string[] }} [opts]
 *   references: the text(s) the composition expands (the thin description), for the repetition check
 * @returns {{ ok: boolean, reason: string | null, unsupported: string[], leak: object | null }}
 */
export function assessComposedFromInputs(inputs, output, opts = {}) {
  const minSupport = opts.minSupport ?? COMPOSED_UNIT_MIN_SUPPORT;
  const minWords = opts.minWords ?? COMPOSED_UNIT_MIN_WORDS;
  const leak = detectAiReasoningLeak(output);
  if (leak) return { ok: false, reason: `reasoning-leak:${leak.marker}`, unsupported: [], leak };
  // Anchoring alone accepts one well-anchored sentence repeated in a loop, so
  // the composition is also judged against the text it expands.
  const degenerate = detectDegenerateRepetition(output, { references: opts.references || [] });
  if (degenerate) return { ok: false, reason: `degenerate-repetition:${degenerate.kind}`, unsupported: [], leak: null };
  const known = new Set();
  const addKnown = (text) => {
    for (const t of fidelityTokens(text)) for (const p of inflectionPrefixes(t)) known.add(p);
  };
  for (const input of inputs || []) addKnown(input);
  for (const w of opts.allowedWords || []) addKnown(w);
  const isKnown = (word) => inflectionPrefixes(word).some((p) => known.has(p));
  const unsupported = [];
  for (const unit of composedUnits(output)) {
    const words = contentWords(unit);
    if (words.length < minWords) continue;
    const supported = words.filter(isKnown).length;
    if (supported / words.length < minSupport) unsupported.push(unit);
  }
  if (unsupported.length > 0) {
    return { ok: false, reason: `unsupported-sentence:${unsupported[0].slice(0, 80)}`, unsupported, leak: null };
  }
  return { ok: true, reason: null, unsupported, leak: null };
}

// ── Degenerate repetition (model/MT loops) ─────────────────────────────────
// A translator that falls into a repetition loop publishes garbage that is long,
// in the right language and not a copy, so no length/language/copy check sees
// it: pkb-private-bank `en` «For our headquarters in Lugano we receive a
// Risk-Lights-Lights-Lights-…», julius-baer «the individual ρ ρ ρ ρ …»,
// galliker «un chauffeur de chauffeur de chauffeur de …».
//
// Two signals, both judged RELATIVE to the text that was translated, because a
// source can repeat legitimately (a phone number «92 92», a CSS dump, gender
// forms collapsing to «Metzgerin - Metzgerin») and a faithful translation
// repeats with it:
//   • loop: some n-gram (n ≤ 8) repeated back to back ≥ 5 times, and more than
//     twice as often as the most repetition-free reference;
//   • collapse: over the same window (the first ≤ 120 tokens of each), the
//     share of distinct tokens is < 0.35 of the reference's.
// Calibrated on every description slot on origin/main 2026-09-29 (122,323
// slots, 89,325 of them with a comparable window): the 284 slots either rule
// flags were read one by one and are all garbage. Below the thresholds, the
// first legitimate translations sit at 4 back-to-back repeats («Macellaio -
// Macellaio / Macellaio - Macellaio», a faithful rendering of distinct French
// gender forms) and at a window ratio of 0.58 against the source slot alone
// (anker-swiss); the rule takes the more lenient of the two references.
export const DEGENERATE_LOOP_MIN_REPEATS = 5;
export const DEGENERATE_MAX_GRAM = 8;
export const DEGENERATE_TTR_WINDOW = 120;
export const DEGENERATE_TTR_MIN_WINDOW = 40;
export const DEGENERATE_TTR_MAX_RATIO = 0.35;

/**
 * Tokens plus the longest back-to-back repetition of any n-gram (n ≤ 8).
 * Computed once per text so callers comparing several slots against the same
 * reference do not re-tokenize it.
 * @param {string} text
 * @returns {{ tokens: string[], repeats: number, gram: string }}
 */
export function repetitionProfile(text) {
  const tokens = fidelityTokens(text);
  let repeats = 1;
  let gram = '';
  for (let p = 1; p <= DEGENERATE_MAX_GRAM; p += 1) {
    let run = 0;
    for (let i = p; i < tokens.length; i += 1) {
      if (tokens[i] === tokens[i - p]) {
        run += 1;
        const r = Math.floor((run + p) / p);
        if (r > repeats) {
          repeats = r;
          gram = tokens.slice(i - p + 1, i + 1).join(' ');
        }
      } else {
        run = 0;
      }
    }
  }
  return { tokens, repeats, gram };
}

function windowTypeTokenRatio(tokens, window) {
  const slice = tokens.slice(0, window);
  return slice.length ? new Set(slice).size / slice.length : 1;
}

const asProfile = (value) => (value && typeof value === 'object' && Array.isArray(value.tokens)
  ? value
  : repetitionProfile(String(value || '')));

/**
 * Is `text` a degenerate (looping / collapsed) rendering of its references?
 * @param {string | ReturnType<typeof repetitionProfile>} text
 * @param {{ references?: Array<string | ReturnType<typeof repetitionProfile> | null | undefined> }} [opts]
 *   the text(s) it was translated from — the source slot and/or the crawled
 *   description. Without references only the loop signal applies.
 * @returns {{ kind: 'loop', gram: string, repeats: number } | { kind: 'collapse', ratio: number } | null}
 */
export function detectDegenerateRepetition(text, { references = [] } = {}) {
  const profile = asProfile(text);
  if (profile.tokens.length === 0) return null;
  const refs = (references || [])
    .filter((r) => r !== null && r !== undefined && r !== '')
    .map(asProfile)
    .filter((r) => r.tokens.length > 0);
  const refRepeats = refs.length ? Math.min(...refs.map((r) => r.repeats)) : 1;
  if (profile.repeats >= DEGENERATE_LOOP_MIN_REPEATS && profile.repeats > 2 * refRepeats) {
    return { kind: 'loop', gram: profile.gram, repeats: profile.repeats };
  }
  let bestRatio = null;
  for (const ref of refs) {
    const window = Math.min(DEGENERATE_TTR_WINDOW, profile.tokens.length, ref.tokens.length);
    if (window < DEGENERATE_TTR_MIN_WINDOW) continue;
    const ratio = windowTypeTokenRatio(profile.tokens, window) / windowTypeTokenRatio(ref.tokens, window);
    if (bestRatio === null || ratio > bestRatio) bestRatio = ratio;
  }
  if (bestRatio !== null && bestRatio < DEGENERATE_TTR_MAX_RATIO) return { kind: 'collapse', ratio: bestRatio };
  return null;
}
