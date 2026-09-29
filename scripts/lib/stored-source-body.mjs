/**
 * Keep the source body of a vacancy whose fresh read fell under the shared
 * word floor (source-body-floor.mjs).
 *
 * A crawler that no longer pads a thin or unreadable detail page with text
 * of its own (#5253) has two honest options for such a vacancy: publish the
 * body stored from an earlier read of the SAME source page, or not publish
 * the vacancy this run. Stored text the crawler once invented must already
 * be removed (drop-fabricated-description.mjs) before this runs, so what is
 * kept is always source text.
 */
import { meetsSourceBodyFloor } from './source-body-floor.mjs';

/**
 * @param {object[]} discoveredJobs  fresh jobs; `description` is '' when the
 *   source body was under the floor
 * @param {object[]} storedJobs      stored jobs of the same crawler
 * @param {(url: string) => string} keyOf  stable id of a job URL
 * @returns {object[]} the jobs to publish: fresh ones over the floor, and the
 *   others with their stored source body; the rest is left out this run.
 */
export function keepStoredSourceBodies(discoveredJobs = [], storedJobs = [], keyOf = (url) => url) {
  const storedByKey = new Map((Array.isArray(storedJobs) ? storedJobs : []).map((job) => [keyOf(job?.url), job]));
  return (Array.isArray(discoveredJobs) ? discoveredJobs : []).flatMap((job) => {
    if (meetsSourceBodyFloor(job?.description)) return [job];
    const prev = storedByKey.get(keyOf(job?.url));
    const prevLang = prev?.sourceLang;
    const prevBody = (prevLang && prev?.descriptionByLocale?.[prevLang]) || prev?.description || '';
    if (!prevLang || !meetsSourceBodyFloor(prevBody)) return [];
    return [{ ...job, description: prevBody, descriptionByLocale: { [prevLang]: prevBody }, sourceLang: prevLang }];
  });
}
