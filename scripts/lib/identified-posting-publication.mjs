import { extractJobPostingsLd, jobPostingDescriptionText } from './jsonld-jobposting.mjs';
import { sourcePostingDateFields } from './source-posting-date.mjs';

/** Read a publication only from one vacancy matching an independent page/listing title. */
export function identifiedPostingPublication(html, requestedUrl, expectedTitle) {
  const title = (value) => jobPostingDescriptionText(value).replace(/\s+/g, ' ').trim().toLowerCase();
  if (!expectedTitle) return sourcePostingDateFields();
  const postings = extractJobPostingsLd(html);
  const matching = postings.filter((posting) => {
    if (title(posting.title) !== title(expectedTitle)) return false;
    const identities = [posting.url, posting.sameAs].flat(Infinity).filter((value) => value != null && value !== '');
    if (!identities.length) return postings.length === 1;
    return identities.every((value) => {
      try { return typeof value === 'string' && new URL(value, requestedUrl).href === new URL(requestedUrl).href; }
      catch { return false; }
    });
  });
  return sourcePostingDateFields(matching.length === 1 ? matching[0].datePosted : undefined);
}
