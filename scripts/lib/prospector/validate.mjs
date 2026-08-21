/**
 * Extraction quality — graded against the employer's own page, field by field.
 *
 * "The crawler ran" is not quality. A parser that returns twelve rows of
 * navigation chrome runs perfectly and publishes twelve fake vacancies, and the
 * existing health monitor cannot tell the difference because it counts rows.
 * So this grades CONTENT: for a sample of the vacancies a spec produced, fetch
 * the detail page the employer actually serves and check that what we hold is
 * what that page says.
 *
 * Four checks, each a fraction in [0,1], because they fail independently:
 *
 *   reachable   — the URL we would publish resolves. A dead link is the one
 *                 defect a reader always notices.
 *   titleMatch  — our title is recognisably the page's own <h1>/<title>.
 *                 Catches the classic template-clustering failure, where the
 *                 anchor text was a category label rather than a job title.
 *   contentful  — the detail page carries real vacancy prose, not a shell.
 *                 Catches SPA listings whose detail pages render client-side.
 *   distinct    — titles across the listing differ from one another. Catches a
 *                 selector that latched onto a repeated element and produced
 *                 N copies of the same row.
 *
 * A grade is only as good as its sample, so the sample size is recorded with
 * the score and a spec graded on fewer than two detail pages is reported as
 * `insufficient` rather than given a number that reads as confidence.
 */
import { politeFetch } from './polite-fetch.mjs';
import { textOf } from './extract.mjs';

/** Normalise a string for fuzzy comparison. */
const norm = (s = '') => String(s).toLowerCase()
  .normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/[^a-z0-9 ]+/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();

/**
 * Token-overlap ratio of `needle` against `haystack`, in [0,1].
 * Word-level rather than substring, so word order and punctuation do not matter.
 *
 * @param {string} needle
 * @param {string} haystack
 * @returns {number}
 */
export function tokenOverlap(needle, haystack) {
  const n = [...new Set(norm(needle).split(' ').filter((w) => w.length > 2))];
  if (!n.length) return 0;
  const hay = new Set(norm(haystack).split(' '));
  return n.filter((w) => hay.has(w)).length / n.length;
}

/**
 * Grade ONE vacancy against its own detail page.
 *
 * @param {{ title: string, url: string, description?: string }} vacancy
 * @returns {Promise<{ url: string, reachable: boolean, titleMatch: number, contentful: boolean, words: number, status: number }>}
 */
export async function gradeVacancy(vacancy) {
  const res = await politeFetch(vacancy.url);
  const out = { url: vacancy.url, reachable: false, titleMatch: 0, contentful: false, words: 0, status: res.status };
  if (!res.ok || res.body.length < 200) return out;
  out.reachable = true;

  const h1 = /<h1[^>]*>([\s\S]{0,300}?)<\/h1>/i.exec(res.body)?.[1] || '';
  const title = /<title[^>]*>([\s\S]{0,300}?)<\/title>/i.exec(res.body)?.[1] || '';
  const heading = `${textOf(h1)} ${textOf(title)}`;
  out.titleMatch = Math.max(tokenOverlap(vacancy.title, heading), tokenOverlap(vacancy.title, textOf(res.body).slice(0, 4000)));

  const words = textOf(res.body).split(/\s+/).filter(Boolean).length;
  out.words = words;
  // 120 words is the floor for a real vacancy in any of the four locales; below
  // it the page is a shell, a cookie wall, or a client-rendered stub.
  out.contentful = words >= 120;
  return out;
}

/**
 * @typedef {Object} QualityReport
 * @property {string} companyKey
 * @property {number} vacancyCount
 * @property {number} sampled
 * @property {number} reachableRate
 * @property {number} titleMatchRate
 * @property {number} contentfulRate
 * @property {number} distinctRate
 * @property {number} score           0..1, the gate value
 * @property {'good'|'weak'|'bad'|'insufficient'} verdict
 * @property {string[]} problems
 * @property {any[]} samples
 */

/**
 * Grade a whole spec's output.
 *
 * @param {{ companyKey: string }} spec
 * @param {any[]} vacancies
 * @param {{ sampleSize?: number, goodAt?: number, weakAt?: number }} [opts]
 * @returns {Promise<QualityReport>}
 */
export async function gradeExtraction(spec, vacancies, opts = {}) {
  const sampleSize = opts.sampleSize ?? 4;
  const goodAt = opts.goodAt ?? 0.75;
  const weakAt = opts.weakAt ?? 0.5;
  const problems = [];

  const titles = vacancies.map((v) => norm(v.title)).filter(Boolean);
  const distinctRate = titles.length ? new Set(titles).size / titles.length : 0;
  if (vacancies.length >= 3 && distinctRate < 0.6) problems.push('titoli ripetuti: il selettore ha agganciato un elemento ricorrente');

  // Spread the sample across the listing rather than taking the first N: a
  // broken listing is often correct at the top and chrome further down.
  const step = Math.max(1, Math.floor(vacancies.length / sampleSize));
  const picks = [];
  for (let i = 0; i < vacancies.length && picks.length < sampleSize; i += step) picks.push(vacancies[i]);

  const graded = [];
  for (const v of picks) graded.push(await gradeVacancy(v));

  const rate = (fn) => (graded.length ? graded.filter(fn).length / graded.length : 0);
  const reachableRate = rate((g) => g.reachable);
  const contentfulRate = rate((g) => g.contentful);
  const titleMatchRate = graded.length
    ? graded.reduce((a, g) => a + g.titleMatch, 0) / graded.length
    : 0;

  if (reachableRate < 1 && graded.length) problems.push(`${Math.round((1 - reachableRate) * 100)}% degli URL non risolve`);
  if (titleMatchRate < 0.5 && graded.length) problems.push('i titoli estratti non corrispondono alla pagina ufficiale');
  if (contentfulRate < 0.5 && graded.length) problems.push('pagine di dettaglio senza testo: probabile render lato client');

  const score = graded.length
    ? (reachableRate * 0.35) + (titleMatchRate * 0.35) + (contentfulRate * 0.2) + (distinctRate * 0.1)
    : 0;

  let verdict = 'insufficient';
  if (graded.length >= 2) verdict = score >= goodAt ? 'good' : (score >= weakAt ? 'weak' : 'bad');

  return {
    companyKey: spec.companyKey,
    vacancyCount: vacancies.length,
    sampled: graded.length,
    reachableRate: Number(reachableRate.toFixed(3)),
    titleMatchRate: Number(titleMatchRate.toFixed(3)),
    contentfulRate: Number(contentfulRate.toFixed(3)),
    distinctRate: Number(distinctRate.toFixed(3)),
    score: Number(score.toFixed(3)),
    verdict,
    problems,
    samples: graded,
  };
}
