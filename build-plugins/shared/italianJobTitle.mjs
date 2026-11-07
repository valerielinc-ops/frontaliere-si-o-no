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
 * Publisher source-language pins protect crawler normalization, but they do
 * not permit a foreign application title to appear in Italian social cards.
 */
export function getItalianJobTitle(job) {
  const title = job?.titleByLocale?.it;
  const cleanTitle = typeof title === 'string' ? title.trim() : '';
  if (!cleanTitle) return '';

  const pinnedSourceLang = pinnedTitleSourceLang(job);
  const declaredSourceLang = normalizeJobLocale(job?.sourceLang);
  const sourceEvidence = jobTitleSourceLangEvidence(job, 'it');
  const sourceLang = pinnedSourceLang
    || (declaredSourceLang && declaredSourceLang !== 'it' && isTitleSourceCopy(cleanTitle, job?.title)
      ? declaredSourceLang
      : sourceEvidence || declaredSourceLang)
    || 'it';

  // Some crawled and publisher-submitted records copy the raw application title
  // into titleByLocale.it even when the job's declared source language is not
  // Italian. A decisive foreign-language dictionary hint means the candidate
  // is not Italian, regardless of the source-language pin.
  const titleLanguage = detectJobTitleLocaleDetails(cleanTitle, sourceLang);
  if (
    titleLanguage.lang !== 'it'
    && titleLanguage.confidence >= TITLE_LANG_DECISION_CONFIDENCE
    && titleLanguage.method.startsWith('title-hints')
  ) {
    return '';
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
  const crossLocaleMarkerVerdict = sourceLang === 'it'
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
