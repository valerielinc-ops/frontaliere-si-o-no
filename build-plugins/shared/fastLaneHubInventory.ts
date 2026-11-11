import { stableJobId } from './stableJobId.mjs';

type StableJob = { id?: string | null; slug?: string | null };

/** Keep fast-lane hub cards to pages already published or in this batch. */
export function filterFastLaneHubInventory<T extends StableJob>(
 jobs: readonly T[],
 visibleJobIds: ReadonlySet<string>,
): T[] {
 return jobs.filter((job) => visibleJobIds.has(stableJobId(job)));
}
