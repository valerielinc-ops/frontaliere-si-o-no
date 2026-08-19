import { escapeRegExpLiteral } from './escape-regexp.mjs';

/**
 * job-location-plausibility — the two pure detectors behind layers 5 and 6 of
 * `scripts/audit-job-locations.mjs`.
 *
 * THEY LIVE HERE, NOT IN THE AUDIT, for the reason
 * `scripts/lib/job-locale-population.mjs` gives for the same split: the audit
 * reads `data/jobs.json` at module scope, so importing it to test a predicate
 * would read a 340 MB artefact that does not exist in a sparse worktree and run
 * the whole walk as a side effect. Everything below is pure, takes its input as
 * arguments, and is driven from synthetic fixtures in
 * `tests/job-location-audit-layers.test.ts`.
 */

/**
 * Why the cleaned location cannot be a municipality name, or `[]` when it is
 * plausible. Judged on the STRIPPED city (layer 5 already removed the
 * legitimate canton/country markers) so a redundancy is never re-reported here
 * as junk: "Geneva, GENEVA, Switzerland" cleans up to "Geneva" and passes,
 * while "0200 Deutsch Suche Suche Masterdata Specialist" cleans up to itself.
 *
 * Conservative on purpose — every rule fires on shapes no Swiss municipality
 * has, never on ones that are merely unusual. Checked against
 * `data/canton-municipalities.json` rather than assumed: of its 2,294
 * municipalities, 1,977 are one word, 244 two, 67 three and SIX are four
 * ("Santa Maria in Calanca", "Wangen an der Aare", "Büren an der Aare",
 * "Ellikon an der Thur", "Thalheim an der Thur", "Oetwil an der Limmat").
 * NONE reaches five, and the longest by characters is 27
 * ("Deisswil bei Münchenbuchsee"). So a five-word value is page furniture, a
 * street address or a multi-site note — never a city — and the 70-char rule
 * keeps 43 characters of margin over the real maximum.
 *
 * @param {string} city @returns {string[]}
 */
export function implausibilityReasons(city) {
  const reasons = [];
  const words = city.split(/\s+/).filter(Boolean);
  if (words.length >= 5) reasons.push('too-many-words');
  // Diacritics folded like the sibling `job-location-display.mjs` does: the two
  // copies a scraper leaves behind are rarely byte-identical ("Zürich, Zurich").
  const folded = words.map((w) => w
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, ''));
  if (folded.some((w, i) => w && w === folded[i + 1])) reasons.push('repeated-word');
  if (/[<>{}|]|https?:\/\//.test(city)) reasons.push('markup');
  if (city.length > 70) reasons.push('over-70-chars');
  return reasons;
}

const REGION_QUALIFIER_COUNTRY = 'CH|CHE|Switzerland|Schweiz|Suisse|Svizzera';
const REGION_QUALIFIER_LABEL = '(?:Kanton|canton|Canton|Cantone|Kt\\.?)?';


/**
 * The evidence string when a job's DESCRIPTION names the place, then the
 * country, then the canton — "Konolfingen, CH, Kanton BE" — or `null`.
 *
 * WHY THE TRIPLE, AND NOT "THE CANTON APPEARS TWICE". The naive shape is
 * overwhelmingly correct prose and would bury the defect it is meant to find:
 * measured across the corpus, "two region qualifiers in a row" matches 4,124
 * jobs, nearly all of them `Zürich (ZH)`, `Bern, Svizzera`, `ZH, Switzerland`,
 * `Standort: Aarau (Kanton AG)` — perfectly good German and Italian. Requiring
 * the COUNTRY marker BETWEEN the city and the canton isolates the real thing:
 * 60 jobs, in exactly two crawlers (nestle 35, convit-holding 25), with no
 * false positive in the sample.
 *
 * WHY IT NO LONGER DEPENDS ON THE LOCATION STILL BEING MALFORMED. This check
 * used to run only for jobs whose `location` still carried a redundant marker.
 * Production disproved that within the hour: after the nestle parser fix
 * shipped, the re-crawl at 2026-08-19T10:18Z cleaned the location field on 85
 * of 86 jobs — and all 36 stale DESCRIPTIONS stayed exactly as they were,
 * because descriptions are preserved when a job is merged by stable id. The
 * old check reported 0 while the defect was live on 36 indexed pages. Fixing a
 * crawler must not blind the audit to what that crawler already froze.
 *
 * @param {object} job @param {string} location @param {string} canton
 * @returns {string|null}
 */
export function descriptionRepeatsRegion(job, location, canton) {
  if (!location || !canton) return null;
  const texts = [job.description, ...Object.values(job.descriptionByLocale || {})]
    .filter(Boolean)
    .map(String);
  if (!texts.length) return null;
  const re = new RegExp(
    `${escapeRegExpLiteral(location)}\\s*[,(/-]\\s*(?:${REGION_QUALIFIER_COUNTRY})\\s*[,(/-]\\s*${REGION_QUALIFIER_LABEL}\\s*${escapeRegExpLiteral(canton)}\\b`,
    'i',
  );
  for (const text of texts) {
    const match = re.exec(text);
    if (match) return match[0].replace(/\s+/g, ' ');
  }
  return null;
}
