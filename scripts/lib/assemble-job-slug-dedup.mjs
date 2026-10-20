import { carryForwardMarks } from './job-mark-persistence.mjs';
import { deduplicateJobsBySlug } from './job-slug-dedup.mjs';

/**
 * Resolve the assembler's slug collisions without dropping distinct postings.
 * The first sorted job keeps the established route; distinct later postings
 * receive deterministic Italian routes. Confirmed duplicate records retain
 * the existing retranslation-mark handoff.
 */
export function deduplicateAssembledJobsBySlug(jobs) {
  const result = deduplicateJobsBySlug(jobs, { disambiguateFirst: false });
  let marksCarried = 0;
  for (const { winner, loser } of result.duplicates) {
    marksCarried += carryForwardMarks(winner, loser);
  }
  return { ...result, marksCarried };
}
