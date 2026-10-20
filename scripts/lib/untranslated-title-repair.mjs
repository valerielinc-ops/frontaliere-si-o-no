import { titleLooksUntranslated } from './job-locale-utils.mjs';

// Reasons that send a title to the Codex repair lane. Gender codes are
// reported by titleLooksUntranslated(), but are not an untranslated verdict
// unless the caller explicitly opts into that policy.
//
// `source-overlap` was kept out (PR 11898) because overlap alone also
// describes valid titles that share terms with the source. It then stayed with
// the Argos overwrite path, which handled it worst: translate-pending
// 38517635747 (2026-10-14) judged 20 such Argos candidates, all
// `source-overlap` — 9 rejected as source echoes, 1 by the meaning guard, 8
// unclear, 2 accepted (one turning "temp" into "Temperatur") — and that
// residue tripped the overwrite rollback in every run. The class mixes both
// cases (sample of 17 slices: «Bouchère - Boucher / Charcutière - Charcutier»
// left French in the Italian slot next to valid «Senior Automation Engineer»
// in English); Codex translates the first and returns the second unchanged,
// which the lane's retry backoff then parks for days, so a valid title costs
// at most a couple of calls.
export const TITLE_REPAIR_QUEUE_REASONS = Object.freeze([
  'source-copy',
  'llm-reasoning',
  'source-function-word',
  'source-orthography',
  'binnen-i',
  'compound-residue',
  'source-overlap',
]);

const TITLE_REPAIR_QUEUE_REASON_SET = new Set(TITLE_REPAIR_QUEUE_REASONS);

/**
 * Whether a detector verdict is safe to hand to the title repair cascade.
 *
 * The cascade still validates its output with the same detector before it
 * writes. This helper only broadens the input queue to marker-backed
 * wrong-language titles; it does not turn the detector's low-confidence
 * overlap signal or a gender-code marker into a write permission.
 */
export function isTitleRepairQueueVerdict(verdict) {
  return verdict?.untranslated === true
    && TITLE_REPAIR_QUEUE_REASON_SET.has(String(verdict.reason || ''));
}

/**
 * Source locale of a job as the base language code the locale maps are keyed
 * by: a stored regional tag (`de-CH`, `fr_CH`) must still find the `de`/`fr`
 * slot and must still exclude it from the target locales. One place for the
 * default, so lookup, exclusion and the detector cannot drift.
 */
export function titleRepairSourceLang(job) {
  const base = String(job?.sourceLang || '').trim().toLowerCase().split(/[-_]/u)[0];
  return base || 'it';
}

/**
 * The source title both lanes translate FROM: `job.title`, or the source
 * locale's slot when a crawler left `title` empty. The Argos handoff and the
 * Codex discovery must read the same value, or a slot Argos gives up is never
 * picked up by Codex.
 */
export function titleRepairSourceTitle(job) {
  const sourceLang = titleRepairSourceLang(job);
  // Trim before choosing: a whitespace-only `title` is an empty title, not a
  // reason to skip the source-locale slot.
  return String(job?.title || '').trim()
    || String(job?.titleByLocale?.[sourceLang] || '').trim();
}

/**
 * Locale slots of one job admitted to the Codex title-repair lane, with the
 * detector reason. Single discovery predicate for `fix-untranslated-titles`.
 */
export function titleRepairQueueLocales(job, locales = []) {
  const sourceLang = titleRepairSourceLang(job);
  if (!titleRepairSourceTitle(job)) return [];
  const admitted = [];
  for (const locale of locales) {
    if (locale === sourceLang) continue;
    const existing = String(job?.titleByLocale?.[locale] || '').trim();
    if (!existing) continue;
    const verdict = titleRepairDetectorVerdict({ job, locale, title: existing });
    if (isTitleRepairQueueVerdict(verdict)) admitted.push({ locale, reason: verdict.reason });
  }
  return admitted;
}

/**
 * Run the title detector with the exact job context used by the Codex lane.
 * Keeping this context here prevents the Argos handoff from drifting on
 * address/company stripping or on the source-locale fallback.
 */
export function titleRepairDetectorVerdict({ job, locale, title } = {}) {
  const sourceLang = titleRepairSourceLang(job);
  return titleLooksUntranslated({
    title,
    sourceTitle: titleRepairSourceTitle(job),
    sourceLang,
    targetLocale: locale,
    company: job?.company || '',
    location: job?.addressLocality || job?.location || '',
  });
}

/**
 * Whether an existing title is admitted to the Codex repair lane.
 * `isTitleRepairQueueVerdict()` remains the single allowlist predicate.
 */
export function isTitleRepairQueueSlot({ job, locale, title } = {}) {
  return isTitleRepairQueueVerdict(titleRepairDetectorVerdict({ job, locale, title }));
}
