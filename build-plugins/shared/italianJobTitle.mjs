/** Return the Italian-localized title without falling back to source text. */
export function getItalianJobTitle(job) {
  const title = job?.titleByLocale?.it;
  return typeof title === 'string' ? title.trim() : '';
}
