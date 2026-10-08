import { titleLooksUntranslated } from './job-locale-utils.mjs';

// Reasons with a source-language marker strong enough to enter the title
// repair lane. `source-overlap` stays out: overlap alone is deliberately a
// secondary signal and can describe a valid title containing a shared term.
// Gender codes are reported by titleLooksUntranslated(), but are not an
// untranslated verdict unless the caller explicitly opts into that policy.
export const TITLE_REPAIR_QUEUE_REASONS = Object.freeze([
  'source-copy',
  'llm-reasoning',
  'source-function-word',
  'source-orthography',
  'binnen-i',
  'compound-residue',
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
 * The source title both lanes translate FROM: `job.title`, or the source
 * locale's slot when a crawler left `title` empty. The Argos handoff and the
 * Codex discovery must read the same value, or a slot Argos gives up is never
 * picked up by Codex.
 */
export function titleRepairSourceTitle(job) {
  const sourceLang = job?.sourceLang || 'it';
  return String(job?.title || job?.titleByLocale?.[sourceLang] || '').trim();
}

/**
 * Locale slots of one job admitted to the Codex title-repair lane, with the
 * detector reason. Single discovery predicate for `fix-untranslated-titles`.
 */
export function titleRepairQueueLocales(job, locales = []) {
  const sourceLang = job?.sourceLang || 'it';
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
  const sourceLang = job?.sourceLang || 'it';
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
