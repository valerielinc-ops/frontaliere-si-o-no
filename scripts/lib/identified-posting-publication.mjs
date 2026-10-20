import { extractJobPostingsLd, jobPostingDescriptionText } from './jsonld-jobposting.mjs';
import { sourceCompactOffsetPostingDateFields, sourcePostingDateFields } from './source-posting-date.mjs';

const USER_AGENT = process.env.JOBS_CRAWLER_USER_AGENT
  || 'Mozilla/5.0 (compatible; FrontaliereTicinoBot/1.0; +https://frontaliereticino.ch/)';

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
  return sourceCompactOffsetPostingDateFields(matching.length === 1 ? matching[0].datePosted : undefined);
}

/** Fetch a vacancy's own page and read its identity-matched JobPosting date. */
export async function fetchIdentifiedPostingPublication(url = '', expectedTitle = '', options = {}) {
  if (!/^https:\/\//i.test(url)) return sourcePostingDateFields();
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs || 20_000);
  try {
    const response = await fetchImpl(url, {
      signal: controller.signal,
      headers: { 'User-Agent': USER_AGENT, Accept: 'text/html,application/xhtml+xml' },
    });
    if (!response.ok || !String(response.headers.get('content-type') || '').toLowerCase().includes('html')) {
      return sourcePostingDateFields();
    }
    return identifiedPostingPublication(await response.text(), url, expectedTitle);
  } catch {
    return sourcePostingDateFields();
  } finally {
    clearTimeout(timer);
  }
}
