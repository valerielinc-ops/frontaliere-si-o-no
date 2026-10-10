import { extractJobPostingsLd } from './jsonld-jobposting.mjs';
import { sourceCompactOffsetPostingDateFields, sourcePostingDateFields } from './source-posting-date.mjs';

const USER_AGENT = process.env.JOBS_CRAWLER_USER_AGENT
  || 'Mozilla/5.0 (compatible; FrontaliereTicinoBot/1.0; +https://frontaliereticino.ch/)';

function identity(value = '') {
  return String(value || '').toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Accept publication evidence only from the uniquely matching JobPosting. */
export function matchingJobPostingPublication(html = '', expectedTitle = '') {
  const wanted = identity(expectedTitle);
  if (!wanted) return sourcePostingDateFields();
  const matching = extractJobPostingsLd(html)
    .filter((posting) => identity(posting?.title) === wanted);
  return sourceCompactOffsetPostingDateFields(matching.length === 1 ? matching[0]?.datePosted : '');
}

/** Fetch a vacancy's own page and read its title-matched JobPosting date. */
export async function fetchMatchingJobPostingPublication(url = '', expectedTitle = '', options = {}) {
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
    return matchingJobPostingPublication(await response.text(), expectedTitle);
  } catch {
    return sourcePostingDateFields();
  } finally {
    clearTimeout(timer);
  }
}
