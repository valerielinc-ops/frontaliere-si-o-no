/**
 * Shared translation-quality gate for free-cascade / provider output before it
 * is written to the indexed `descriptionByLocale` dataset.
 *
 * Single source of truth for the "hard char floor accepts clips" anti-pattern:
 * the free cascade (DeepL / Google Translate / SimplyTranslate) can return a
 * string cut to a provider-dependent length cap. A char floor alone accepts
 * those clips, so a faithful translation must also stay within
 * MIN_TRANSLATION_RATIO of the source length. When the source length is unknown
 * (empty/falsy), only the char floor applies.
 *
 * Also the source of truth for a second anti-pattern: free-cascade providers
 * routinely swallow the source text's newlines, returning a same-length
 * candidate where a `\n• item` list got flattened into inline `. • item`
 * running prose. Length/ratio checks alone don't catch this (the char count
 * survives) — audit #3721 found this landed 14 crawlers' `descriptionByLocale`
 * as "no structured content" even though the source-language `description`
 * had proper bullets, because this gate never checked structure parity. Mirrors
 * the equivalent check already in `job-localization-pipeline.mjs`'s
 * `passesQualityGate` (local NLLB/Ollama path) — this gate is the free-cascade
 * equivalent so both translation paths reject the same defect.
 */
import { detectAiReasoningLeak, detectDegenerateRepetition } from './ai-output-fidelity.mjs';
import { detectAiMetaResponse } from './ai-meta-response.mjs';
import { decodeEntities } from './prospector/entities.mjs';
import { hasMojibake } from './repair-mojibake.mjs';

// The deploy validator rejects locale titles shorter than three characters.
// Keep this floor shared by every writer so a provider cannot persist a title
// that the dist gate will reject on the next validation run.
export const MIN_TITLE_CHARS = 3;

export function hasUsableTitle(value) {
  return String(value || '').trim().length >= MIN_TITLE_CHARS;
}

/**
 * True when `text` is a model's answer ABOUT the request instead of the
 * requested title or description: its reasoning or an echo of our prompt
 * (`detectAiReasoningLeak`), or a refusal, a request for the input, the
 * narration of its own tool use, a bare template label
 * (`detectAiMetaResponse`, ai-meta-response.mjs). One predicate for every
 * writer that accepts a translation and for the repair selector
 * (translation-incomplete.mjs), so what one rejects the other re-queues.
 *
 * @param {string} text
 * @param {string} [source] the text it was translated from: meta-response
 *   wording that the source itself carries does not count
 */
export function isModelMetaAnswer(text, source = '') {
  return Boolean(detectAiReasoningLeak(text) || detectAiMetaResponse(text, { source }));
}

// A faithful translation stays within a reasonable band of the source length.
export const MIN_TRANSLATION_RATIO = 0.6;
// Absolute character floor: anything shorter is too thin to be a real
// translation regardless of the source length.
export const MIN_TRANSLATION_CHARS = 100;
export function countBullets(text = '') {
  return (String(text || '').match(/^\s*[-*•]\s+/gm) || []).length;
}

function stripHtmlForStructure(value = '') {
  const withoutTags = String(value || '')
    .replace(/<li\b[^>]*>/gi, '\n- ')
    .replace(/<\/li\s*>/gi, '\n')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\r\n?/g, '\n');
  return decodeEntities(withoutTags);
}

const LIST_ITEM_LINE_RE = /^\s*(?:[-•*][ \t]+|\d+[.)][ \t]+)/u;
const INLINE_LIST_ITEM_RE = /\s+([-•*]|\d+[.)])[ \t]+/gu;
const INLINE_LIST_ITEM_START_RE = /^(?:[\p{Lu}\dÀ-ÖØ-Þ]|[•*])/u;

function isNumberedHeading(line, marker) {
  return /^\s*\d+[.)][ \t]+/.test(marker) && /:\s*$/u.test(line.slice(marker.length));
}

/**
 * Count list entries using the same structural definition at every translation
 * gate. Providers sometimes flatten a list into one line, so an inline marker
 * is counted when it follows a sentence boundary inside an existing list, or
 * when a colon-anchored inline list has a repeated marker run. Hyphens in a
 * title/prose line (e.g. `Bouchère - Boucher`) are not list entries. Empty
 * lines are intentionally ignored.
 */
export function countListItems(value = '') {
  return scanListLines(stripHtmlForStructure(value).split('\n'))
    .reduce((total, line) => total + line.count, 0);
}

/**
 * The list entries of each line, as countListItems counts them: `count` per
 * line, and the inline markers it counted with their absolute position in the
 * line. One scanner for the gate and for preserveStructuredTranslation, so the
 * translator splits a line exactly where the gate will look for entries.
 */
function scanListLines(lines) {
  const result = [];
  let previousListLine = false;
  let continuationAfterBlank = false;

  for (const line of lines) {
    if (!line.trim()) {
      continuationAfterBlank = previousListLine;
      previousListLine = false;
      result.push({ count: 0, inlineMarkers: [] });
      continue;
    }

    const lineMarker = LIST_ITEM_LINE_RE.exec(line);
    const numberedHeading = lineMarker && isNumberedHeading(line, lineMarker[0]);
    const startsList = Boolean(lineMarker && !numberedHeading);
    let count = startsList ? 1 : 0;

    const contentOffset = lineMarker ? lineMarker[0].length : 0;
    const content = line.slice(contentOffset);
    const inlineMarkers = [...content.matchAll(INLINE_LIST_ITEM_RE)];
    const firstInlineBefore = inlineMarkers.length > 0
      ? content.slice(0, inlineMarkers[0].index).trimEnd()
      : '';
    const standaloneInlineRun = inlineMarkers.length >= 2
      && /:\s*$/u.test(firstInlineBefore);
    const listContext = startsList || previousListLine || continuationAfterBlank;
    const counted = [];

    for (const marker of inlineMarkers) {
      const before = content.slice(0, marker.index).trimEnd();
      const after = content.slice(marker.index + marker[0].length).trimStart();
      const strongBoundary = /[.!?:;]/u.test(before.at(-1) || '');
      const repeatedListRun = (listContext || standaloneInlineRun)
        && inlineMarkers.length >= 2
        && (standaloneInlineRun || INLINE_LIST_ITEM_START_RE.test(after));
      const explicitGlyph = marker[1] === '•' || marker[1] === '*';

      if ((strongBoundary && (listContext || standaloneInlineRun))
        || repeatedListRun
        || (explicitGlyph && (listContext || standaloneInlineRun))) {
        count += 1;
        counted.push({ index: contentOffset + marker.index, length: marker[0].length });
      }
    }

    previousListLine = startsList || counted.length > 0;
    continuationAfterBlank = false;
    result.push({
      count,
      inlineMarkers: counted,
      // Every inline marker of the line, counted or not: whether one counts
      // can depend on the others (`repeatedListRun` needs two).
      allInlineMarkers: inlineMarkers.map((marker) => ({ index: contentOffset + marker.index, length: marker[0].length })),
    });
  }

  return result;
}

/**
 * Same structure predicate used by the parser-quality audit. Keep this as the
 * shared source of truth for translation writers and repair selectors: the
 * audit must measure the same list markers that the pipeline protects.
 */
export function hasStructuredContent(value = '') {
  return countListItems(value) > 0;
}

/**
 * Require a candidate not to lose source list entries. A source without list
 * entries has no list-parity constraint; other quality checks still apply.
 * Marker kind and line wrapping may change, and extra explicit markers do not
 * prove content loss, but a smaller candidate count does.
 */
export function hasStructureParity(source = '', candidate = '') {
  const sourceItems = countListItems(source);
  return sourceItems === 0 || countListItems(candidate) >= sourceItems;
}

const STRUCTURED_LINE_RE = /^(\s*(?:#{1,6}\s+|[-*•]\s+|\d+[.)]\s+)?)(.*)$/;
const HAS_LETTERS_RE = /[^\W\d_]/u;

/**
 * An inline entry is counted by its shape: the capital that opens it and the
 * sentence mark that closes the text before the next marker. A translation
 * into Italian or French opens «Störungsanalyse» as «analisi» and may drop a
 * closing «:», so the entry would no longer count. Carry both over from the
 * source segment; the words stay the provider's.
 */
const URL_START_RE = /^(?:https?:\/\/|www\.)/i;
const URL_END_RE = /(?:https?:\/\/|www\.)\S+$/i;

function withEntryShape(source, translated) {
  let out = translated;
  const sourceFirst = source.match(/\p{L}/u)?.[0] || '';
  // Only a word that opens the segment: a URL, markup or code keeps its case.
  if (sourceFirst && sourceFirst !== sourceFirst.toLowerCase() && /^\p{Ll}/u.test(out) && !URL_START_RE.test(out)) {
    out = out.replace(/^\p{Ll}/u, (letter) => letter.toUpperCase());
  }
  const sourceEnd = source.match(/[.!?:;]$/u)?.[0];
  if (sourceEnd && !/[.!?:;]$/u.test(out) && !URL_END_RE.test(out)) out += sourceEnd;
  return out;
}

/**
 * Translate each source line independently while retaining its structural
 * prefix and blank lines. A failed line translation keeps that source line:
 * dropping content is safer than inventing text, and the caller's normal
 * quality gate still decides whether the assembled candidate is publishable.
 */
export async function preserveStructuredTranslation(text, translateLine, { concurrent = false, shouldSkipLine = null } = {}) {
  const lines = String(text || '').replace(/\r\n/g, '\n').split('\n');
  // Inline entries («Tätigkeiten - Wartung - Reparatur - Prüfung» on one
  // line) are split where countListItems counts them and each entry is
  // translated alone: translated as one line, providers turn the « - »
  // separators into commas and the gate refuses the result as
  // `lost-list-items` (run 38686616395, 2026-10-15: all 357 refusals of phase
  // 2e; 575 of 581 untranslated slots in the ten slices with most refusals
  // carry inline entries). HTML lines keep the whole-line path: the scanner
  // counts `<li>` on tag-stripped text, whose lines do not map onto these —
  // only those lines: the other lines of the same text are still split.
  const scanned = scanListLines(lines);
  const hasMarkup = (line) => /<[a-z][^>]*>/i.test(line);
  const translateSegment = async (segment, { keepEntryShape = false } = {}) => {
    const content = segment.trim();
    if (!content || !HAS_LETTERS_RE.test(content)) return segment;
    if (typeof shouldSkipLine === 'function' && shouldSkipLine(content)) return content;
    const translated = await translateLine(content);
    const translatedText = String(translated || '');
    const oneLine = (translatedText.includes('\n') ? '' : translatedText)
      .replace(/[ \t]+/g, ' ')
      .trim();
    if (!oneLine) return content;
    return keepEntryShape ? withEntryShape(content, oneLine) : oneLine;
  };
  const translateOneLine = async (line, lineIndex) => {
    const match = STRUCTURED_LINE_RE.exec(line);
    const prefix = match?.[1] || '';
    const content = match?.[2] || '';
    if (!content.trim() || !HAS_LETTERS_RE.test(content)) {
      return line;
    }
    const markers = hasMarkup(line)
      ? []
      // A line with counted entries is split at ALL its inline markers, kept
      // verbatim: a counted entry can depend on an uncounted marker beside it
      // («des 24. & 31. Dezembers»: « 31. » counts only next to « 24. »), and
      // a provider that writes «del 24» drops the entry (run 39005358922: 52
      // `lost-list-items` refusals, one entry each, in phase 2e).
      : (scanned[lineIndex]?.inlineMarkers?.length
        ? scanned[lineIndex].allInlineMarkers
        : []).filter((marker) => marker.index >= prefix.length);
    if (markers.length === 0) {
      return `${prefix}${await translateSegment(content)}`;
    }
    const pieces = [];
    let cursor = prefix.length;
    for (const marker of markers) {
      pieces.push({ text: line.slice(cursor, marker.index) });
      pieces.push({ marker: line.slice(marker.index, marker.index + marker.length).replace(/^\s+/, ' ') });
      cursor = marker.index + marker.length;
    }
    pieces.push({ text: line.slice(cursor) });
    const translatedPieces = [];
    for (const piece of pieces) {
      translatedPieces.push(piece.marker !== undefined
        ? piece.marker
        : await translateSegment(piece.text, { keepEntryShape: true }));
    }
    return `${prefix}${translatedPieces.join('').replace(/[ \t]+$/, '')}`;
  };
  const translatedLines = concurrent
    ? await Promise.all(lines.map((line, index) => translateOneLine(line, index)))
    : [];
  if (!concurrent) {
    for (let index = 0; index < lines.length; index += 1) {
      translatedLines.push(await translateOneLine(lines[index], index));
    }
  }
  return translatedLines.join('\n').trim();
}

/**
 * Detects a stored locale copy that lost the source's list structure
 * ("structure-flattening", the #3721/#3836 class): the source text carries
 * audited structured content (a line-start bullet/numbered list or `<li>`)
 * while the non-empty candidate has fewer (or no) items. Unlike
 * `isAcceptableTranslation` (which gates NEW translations before they are
 * persisted), this predicate is meant for EXISTING `descriptionByLocale`
 * entries, so repair passes (hardenJobLocaleFields, translateMissingJobLocales,
 * enrichJobLocalesDCC) can re-flag fossil flattened copies that were written
 * before the gates existed and are otherwise preserved forever by the
 * locale-preserving merge.
 *
 * @param {string} source - authoritative same-language text (usually job.description)
 * @param {string} candidate - stored locale copy to check
 * @returns {boolean} true when candidate does not preserve the source's list-item count
 */
export function isStructureFlattenedCopy(source, candidate) {
  const cand = typeof candidate === 'string' ? candidate.trim() : '';
  if (!cand) return false;
  return hasStructuredContent(source) && !hasStructureParity(source, cand);
}

/**
 * Why a candidate translation may not be persisted, or null when it may.
 * One predicate with a name for each refusal, so a writer that logs a refusal
 * can say which rule refused it: phase 2e logged every refusal as «truncated
 * translation (N% of source)», and on run 38609788214 (2026-10-14) 438
 * descriptions were refused at 87–119% of the source length — none of them
 * by the length ratio, which is the only rule the label named.
 *
 * @param {string} source - original (source-language) text being translated
 * @param {string} translated - candidate translation to validate
 * @returns {null | 'not-text' | 'too-short' | 'mojibake' | 'model-meta' | 'degenerate-repetition' | 'below-source-ratio' | 'lost-list-items'}
 */
export function translationRejectionReason(source, translated) {
  if (typeof translated !== 'string') return 'not-text';
  const candidate = translated.trim();
  if (candidate.length < MIN_TRANSLATION_CHARS) return 'too-short';
  // A provider result with double-encoded UTF-8 is not publishable content.
  // Reject it here so the cascade can try another provider, and so an old
  // cache hit is re-queued by translation-incomplete.mjs below.
  if (hasMojibake(candidate)) return 'mojibake';
  // A model answer carrying its reasoning or echoing the prompt is not a
  // translation, however long (see ai-output-fidelity.mjs). This predicate also
  // judges localize-job-v2 cache hits, so a stored leak is busted on read.
  // Nor is a refusal or a request for the input («I need to see the text…»).
  if (isModelMetaAnswer(candidate, typeof source === 'string' ? source : '')) return 'model-meta';
  // Nor is a candidate that loops («Risk-Lights-Lights-Lights-…») or collapses
  // onto a handful of words compared with its source.
  if (detectDegenerateRepetition(candidate, { references: [typeof source === 'string' ? source : ''] })) return 'degenerate-repetition';
  const srcLen = (typeof source === 'string' ? source.trim() : '').length;
  if (srcLen > 0 && candidate.length < srcLen * MIN_TRANSLATION_RATIO) return 'below-source-ratio';
  if (!hasStructureParity(source, candidate)) return 'lost-list-items';
  return null;
}

/**
 * @param {string} source - original (source-language) text being translated
 * @param {string} translated - candidate translation to validate
 * @returns {boolean} true if the candidate is acceptable to persist
 */
export function isAcceptableTranslation(source, translated) {
  return translationRejectionReason(source, translated) === null;
}

// Locales where a single run of MIN_LEN+ letters with no internal space is a
// reliable "source words got glued together" signal (a known free-cascade
// title-translation failure — e.g. "Direttore di filiale" -> "Direttoredifiliale").
// German is deliberately excluded: legitimate compound nouns (e.g.
// "Geschäftsführerin", "Sachbearbeiterin") routinely clear 15+ letters with no
// space, so the same length-only heuristic would false-positive on healthy
// German titles instead of catching a translation defect.
const CONCATENATED_WORD_MIN_LEN = { it: 15, fr: 16, en: 16 };
const LETTER_TOKEN_RE = /^[a-zà-öø-ÿ]+$/i;

/**
 * Legitimate long single-WORD professional terms that would otherwise trip
 * the length-only heuristic below. Normalized (diacritics stripped, case
 * folded) so "kinésithérapeute" / "KINESITHERAPEUTE" / "Kinesitherapeute" all
 * match the same entry.
 *
 * Why a closed allowlist and not a wider/looser length threshold (#5593):
 * `CONCATENATED_WORD_MIN_LEN.fr = 16` false-positived on "kinésithérapeute"
 * and "physiothérapeute" — both EXACTLY 16 letters, both real, frequent job
 * titles in this corpus (see tests/fixtures/title-locale-corpus.json, which
 * already carries live "PHYSIOTHERAPEUTE" titles). Raising the number would
 * only move the false-positive to the next casualty ("ergothérapeute" is 15,
 * "psychomotricien" is 15, "orthophoniste" is 13 — but
 * "audioprothésiste"/"audioprothesiste" is 16 and "psychothérapeute" is 16
 * too) — the healthcare/therapy vocabulary this jobs board indexes is full of
 * siblings at exactly the same length as the two reported here, so a numeric
 * bump is not a fix, only a slower-motion repeat of the same bug. A closed,
 * reviewed list fails differently: a NEW unlisted long word is a silent false
 * positive same as before, but every ADDITION here is a deliberate, auditable
 * decision instead of an opaque cutoff. Add to this list as new false
 * positives are confirmed against a real job title — do not "fix" this by
 * raising CONCATENATED_WORD_MIN_LEN instead.
 */
const LEGITIMATE_LONG_WORDS = new Set([
  // fr — allied health / therapy professions (gender-neutral -e forms and
  // explicit -e/-euse/-ien(ne) variants both included)
  'kinesitherapeute', 'kinesitherapeutes',
  'physiotherapeute', 'physiotherapeutes',
  'ergotherapeute', 'ergotherapeutes',
  'psychotherapeute', 'psychotherapeutes',
  'psychomotricien', 'psychomotricienne', 'psychomotriciens', 'psychomotriciennes',
  'orthophoniste', 'orthophonistes',
  'orthoptiste', 'orthoptistes',
  'audioprothesiste', 'audioprothesistes',
  'osteopathe', 'osteopathes',
  'dieteticien', 'dieteticienne', 'dieteticiens', 'dieteticiennes',
  'radiologue', 'radiologues',
  // it — same professions, Italian forms
  'fisioterapista', 'fisioterapisti', 'fisioterapiste',
  'logopedista', 'logopedisti', 'logopediste',
  'psicomotricista', 'psicomotricisti', 'psicomotriciste',
  'radiologo', 'radiologa', 'radiologhe',
  // en
  'physiotherapist', 'physiotherapists',
  'psychotherapist', 'psychotherapists',
  'occupationaltherapist', 'occupationaltherapists',
]);

/** Fold accents and case so the allowlist matches every spelling variant. */
function normalizeForAllowlist(token) {
  return String(token || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();
}

/**
 * Detects a title where 2+ source words were fused into one unspaced token
 * by a translation pass, instead of translating each word and keeping the
 * spaces. Only checked for locales in CONCATENATED_WORD_MIN_LEN — there is
 * no reliable length/charset split between this defect and a genuine long
 * compound word for other locales (notably German).
 *
 * A token that clears the length floor is still exempted when it (or its
 * hyphen-split part) matches LEGITIMATE_LONG_WORDS above — see that constant
 * for why this is a curated list rather than a higher number.
 *
 * @param {string} text - candidate title in the target locale
 * @param {string} locale - target locale of `text`
 * @returns {boolean} true if `text` looks like it has glued-together words
 */
export function hasConcatenatedWords(text, locale) {
  const minLen = CONCATENATED_WORD_MIN_LEN[locale];
  if (!minLen) return false;
  if (typeof text !== 'string') return false;
  const trimmed = text.trim();
  if (!trimmed) return false;
  // Split on hyphens too: hyphenated compounds (e.g. "Sous-directeur-adjoint",
  // "Employe-e") are legitimate multi-word titles, not glued-together output —
  // each hyphen-joined part must independently clear the length floor.
  return trimmed.split(/\s+/).some((rawToken) => rawToken.split(/[-–—]/).some((part) => {
    const token = part.replace(/[.,;:!?'’"()/]/g, '');
    if (token.length < minLen || !LETTER_TOKEN_RE.test(token)) return false;
    if (LEGITIMATE_LONG_WORDS.has(normalizeForAllowlist(token))) return false;
    return true;
  }));
}
