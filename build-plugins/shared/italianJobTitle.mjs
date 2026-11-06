import {
  detectJobTitleLocaleDetails,
  isTitleSourceCopy,
  jobTitleSourceLangEvidence,
  normalizeJobLocale,
  pinnedTitleSourceLang,
  TITLE_LANG_DECISION_CONFIDENCE,
  titleLooksUntranslated,
} from '../../scripts/lib/job-locale-utils.mjs';

/**
 * Return a usable Italian title, without falling back to source text.
 * Known source-language residue is treated the same as a missing translation.
 */
export function getItalianJobTitle(job) {
  const title = job?.titleByLocale?.it;
  const cleanTitle = typeof title === 'string' ? title.trim() : '';
  if (!cleanTitle) return '';

  const pinnedSourceLang = pinnedTitleSourceLang(job);
  const declaredSourceLang = normalizeJobLocale(job?.sourceLang);
  const sourceEvidence = jobTitleSourceLangEvidence(job, 'it');
  let sourceLang = pinnedSourceLang
    || (declaredSourceLang && declaredSourceLang !== 'it' && isTitleSourceCopy(cleanTitle, job?.title)
      ? declaredSourceLang
      : sourceEvidence || declaredSourceLang)
    || 'it';

  // Some crawled records are mislabeled as Italian and copy the raw title into
  // titleByLocale.it. A decisive dictionary hint can catch that case, but never
  // overrides an explicitly pinned publisher-authored title.
  const titleLanguage = detectJobTitleLocaleDetails(cleanTitle, sourceLang);
  if (
    !pinnedSourceLang
    && sourceLang === 'it'
    && titleLanguage.lang !== 'it'
    && titleLanguage.confidence >= TITLE_LANG_DECISION_CONFIDENCE
    && titleLanguage.method.startsWith('title-hints')
  ) {
    sourceLang = titleLanguage.lang;
  }

  const sourceTitle = String(
    job?.titleByLocale?.[sourceLang] || job?.title || '',
  ).trim();
  const company = String(job?.company || job?.hiringOrganization?.name || '').trim();
  const location = String(
    job?.location || job?.jobLocation?.address?.addressLocality || '',
  ).trim();
  const verdict = titleLooksUntranslated({
    title: cleanTitle,
    sourceTitle,
    sourceLang,
    targetLocale: 'it',
    company,
    location,
  });
  const crossLocaleMarkerVerdict = !pinnedSourceLang && sourceLang === 'it'
    ? titleLooksUntranslated({
      title: cleanTitle,
      sourceLang: 'en',
      targetLocale: 'it',
      company,
      location,
    })
    : null;

  return verdict.untranslated || crossLocaleMarkerVerdict?.untranslated ? '' : cleanTitle;
}
