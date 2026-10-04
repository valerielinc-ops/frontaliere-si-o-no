/**
 * translation-incomplete — the ONE predicate that decides whether a job still
 * needs translation work.
 *
 * Moved verbatim out of `scripts/relocalize-pending-jobs.mjs` (which re-exports
 * it, so every existing importer keeps working) because the crawler slice
 * writer needs the same verdict: translate-pending clears `needsRetranslation`
 * from every slice record that passes this predicate BEFORE translating
 * anything (`reconcileRetranslationState`, direct scan). A crawler flag on a
 * record this predicate calls complete is therefore erased on the next run
 * without any repair — the flap measured on 2026-09-26 (see
 * `crawler-retranslation-baseline.mjs`). Importing the script itself from the
 * crawler path is not an option: it reads argv/env and the run clock at module
 * scope and pulls in `scatter-jobs-to-slices.mjs`, which imports the assembler.
 *
 * Kept free of module-scope side effects so the assembler can import it.
 */
import {
  SOURCE_LANG_HOLD_CONFIDENCE,
  titleLooksUntranslated,
} from './job-locale-utils.mjs';
import { normalizeForLengthComparison } from './dedicated-crawler-common.mjs';
import { detectLanguageWithConfidence } from './detect-language.mjs';
import {
  detectAiReasoningLeak,
  detectDegenerateRepetition,
  repetitionProfile,
} from './ai-output-fidelity.mjs';
import { hasStructuredContent, isStructureFlattenedCopy, MIN_TITLE_CHARS } from './translation-quality.mjs';

const LOCALES = ['it', 'en', 'de', 'fr'];
const MIN_DESC_CHARS = 120;

/**
 * Check if a job has incomplete locale coverage.
 * Returns true if any locale is missing an adequate title or description.
 */
export function isIncomplete(job) {
  const dbl = job.descriptionByLocale || {};
  const tbl = job.titleByLocale || {};
  const srcLang = job.sourceLang || 'it';
  const sourceDesc = (job.description || '').trim().toLowerCase();
  const baseDesc = (job.description || '').trim();
  const sourceStructureDesc = hasStructuredContent(baseDesc)
    ? baseDesc
    : (dbl[srcLang] || baseDesc).trim();

  // Source locale 85% guard: if the source locale copy has lost significant content
  // compared to the authoritative base, the job needs reprocessing.
  // Guard: skip if base is unparsed HTML garbage (>10 tags).
  // Threshold 0.55: crawlers often clean raw descriptions (strip recruitment blurbs,
  // PDF links, footer text) so dbl[srcLang] is naturally 20-35% shorter than
  // job.description. Only flag when >45% of content is genuinely missing.
  if (baseDesc.length >= 120 && (baseDesc.match(/<[^>]+>/g) || []).length <= 10) {
    const currentSrc = (dbl[srcLang] || '').trim();
    if (currentSrc) {
      const normBase = normalizeForLengthComparison(baseDesc);
      const normSrc = normalizeForLengthComparison(currentSrc);
      if (normSrc.length / Math.max(1, normBase.length) < 0.55) return true;
    }
  }

  // Repetition profiles of the texts a slot was translated from, built once per
  // job: the crawled description and the source-locale slot (see below).
  let baseProfile;
  let sourceSlotProfile;
  const profileOf = (text) => (text ? repetitionProfile(text) : null);

  for (const locale of LOCALES) {
    const title = (tbl[locale] || '').trim();
    const desc = (dbl[locale] || '').trim();

    // Missing or too short
    if (title.length < MIN_TITLE_CHARS || desc.length < MIN_DESC_CHARS) return true;

    // A slot holding an AI model's reasoning or an echo of its prompt instead
    // of the ad (formatter leak, then translated into every locale — 11 jobs /
    // 31 slots on 2026-09-29). Long, not a copy and in a plausible language, so
    // no check below sees it; without this the job is never selected for
    // repair and a flagged one is un-flagged by reconcileRetranslationState.
    // Checked on every slot, source included: the forced relocalization resets
    // the source slot from the crawled description and retranslates from it.
    if (detectAiReasoningLeak(desc)) return true;

    // A slot where the translator fell into a repetition loop
    // («Risk-Lights-Lights-Lights-…», 181 jobs / 284 slots on 2026-09-29), judged
    // against what it was translated from so a source that repeats on its own
    // (a CSS dump, a phone number) does not keep a job in the queue that no
    // retranslation can change. A translation is compared with the source slot
    // AND the crawled description (the cleaner one decides), the source slot
    // with the description only.
    if (baseProfile === undefined) baseProfile = profileOf(baseDesc);
    if (sourceSlotProfile === undefined) sourceSlotProfile = profileOf((dbl[srcLang] || '').trim());
    const references = locale === srcLang ? [baseProfile] : [sourceSlotProfile, baseProfile];
    if (detectDegenerateRepetition(desc, { references })) return true;

    // Title still in a language that is not `locale`.
    //
    // S3 (2026-08-10) — what was here and why it is gone. Two separate title
    // checks, each wrapped in the same cross-locale escape hatch: "if at least
    // one OTHER non-source locale has a title differing from the source, the job
    // has been translated, so skip this locale". That rule is the written-down
    // form of the reported bug: a DE-source job whose EN and FR slots translated
    // and whose IT slot stayed German had the IT check suppressed BY EN and FR.
    // The second occurrence also gated the only dataset-level title-language
    // check in this file, so that check ran on almost nothing.
    //
    // The verdict is now per slot and needs no corroboration from the other
    // slots by construction: whether THIS title reads as `locale` is a property
    // of this title. It also replaces the local hint-detector + stop-word
    // regexes that followed — `detectJobTitleLocaleDetails(title, locale) >= 0.65`
    // was measured (300 live titles, 2026-08-10) at a 32.7% false-alarm rate on
    // correct Italian and a 55.0% miss rate on broken titles, and passing
    // `locale` as its fallback is what it returns when uncertain, i.e. it hid
    // the bug. One implementation, in job-locale-utils.mjs, for every caller.
    //
    // Volume: this function SELECTS work, it does not flag it. `main()` sorts
    // and slices to `effectiveMax = min(MAX_JOBS, pending.length)` (default 100)
    // before any write, and the only place it turns into a stored
    // `needsRetranslation` is the per-company re-flag loop, which iterates
    // `cappedPending`. So a wider predicate changes WHICH ~100 jobs a run picks,
    // never how many. Genuinely-international titles that no translator can
    // improve are absorbed by the existing give-up valve
    // (MAX_RETRANSLATION_ATTEMPTS → `localeMismatchSuppressed`).
    if (locale !== (job.sourceLang || 'it') && title) {
      const verdict = titleLooksUntranslated({
        title,
        sourceTitle: (tbl[job.sourceLang || 'it'] || job.title || '').trim(),
        sourceLang: job.sourceLang || 'it',
        targetLocale: locale,
        company: job.company || '',
        location: job.addressLocality || job.location || '',
      });
      if (verdict.untranslated) return true;
    }

    // Description identical to source (not translated) — exact match
    if (desc.length > 0 && desc.toLowerCase() === sourceDesc && locale !== (job.sourceLang || 'it')) return true;

    // A source list that disappeared from a saved locale is a translation
    // defect even when the flattened text is long enough and not a byte-copy.
    // Keep this in the selector so fossil slots without needsRetranslation are
    // queued for repair instead of waiting for a crawler to touch them again.
    if (locale !== srcLang && isStructureFlattenedCopy(sourceStructureDesc, desc)) return true;

    // Description near-identical to source (whitespace-normalized match) — catches
    // crawler-seeded copies where the description got stripped of newlines but
    // still contains the raw untranslated source text.
    if (desc.length >= MIN_DESC_CHARS && locale !== (job.sourceLang || 'it')) {
      const normDesc = normalizeForLengthComparison(desc).toLowerCase();
      const normSource = normalizeForLengthComparison(baseDesc).toLowerCase();
      if (normSource.length >= MIN_DESC_CHARS && normDesc === normSource) return true;
    }

    // Cross-locale description contamination: description text detected as a
    // DIFFERENT language than the locale slot it sits in. This catches:
    //   1. Crawler seed-copies of source text that weren't translated
    //   2. AI translation that wrote to the wrong locale slot
    //   3. Locale slots polluted with a different translation pass
    // Only flag when detection is confident (>=SOURCE_LANG_HOLD_CONFIDENCE) and the detected language
    // is actually one of our supported locales (avoid false positives on short
    // or mixed-language text). Aligned with the shared source-language hold
    // threshold to reduce false positives from Romance-language cognates
    // (IT/FR share many words).
    if (desc.length >= MIN_DESC_CHARS) {
      const detected = detectLanguageWithConfidence(desc, locale);
      if (
        detected.confidence >= SOURCE_LANG_HOLD_CONFIDENCE &&
        detected.lang !== locale &&
        LOCALES.includes(detected.lang)
      ) {
        return true;
      }
    }

    // Thin translation: locale description is suspiciously short compared to the source.
    // Language-pair aware thresholds — Italian is the most verbose Romance language,
    // so IT→DE/FR translations naturally compress 40-50%. FR/DE sources also compress.
    // Only EN source uses the stricter 0.55 threshold (EN→other compression is minimal).
    if (locale !== (job.sourceLang || 'it') && desc.length > 0) {
      const srcLangThin = job.sourceLang || 'it';
      const srcDesc = (dbl[srcLangThin] || job.description || '').trim();
      if (srcDesc.length >= 500) {
        const normDesc = normalizeForLengthComparison(desc);
        const normSrc = normalizeForLengthComparison(srcDesc);
        // IT source compresses heavily to DE/FR (40-50% normal) → 0.45
        // FR/DE source compresses to other languages → 0.50
        // EN source has minimal compression → 0.55
        const thinRatio = srcLangThin === 'it' ? 0.45
          : (srcLangThin === 'fr' || srcLangThin === 'de') ? 0.50
          : 0.55;
        if (normSrc.length >= 500 && normDesc.length < normSrc.length * thinRatio) return true;
      }
    }

    // (The second title check — "cross-locale contamination", same escape hatch,
    // three hand-rolled stop-word regexes and the unreliable hint detector — was
    // folded into the single per-slot verdict above. See the S3 note there.)
  }

  // NOTE: Slug localization is NOT checked here anymore.
  // Slugs are a cosmetic concern handled by Phase 3 (regenerate-slugs-by-locale.mjs).
  // Previously, slug checks here caused an infinite loop:
  //   isIncomplete() flags for slug → clearRetranslationFlags can't clear →
  //   translate pipeline re-processes job → no translation needed → flag stays → repeat
  // 342 jobs were stuck in this loop. Slugs are now decoupled from translation completeness.

  return false;
}
