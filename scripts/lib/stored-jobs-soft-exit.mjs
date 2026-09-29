/**
 * A crawler run that finds no job keeps the stored slice ("No jobs
 * discovered. Keeping existing jobs."). Text the crawler itself once wrote
 * into those stored jobs is normally removed in the merge, before the fresh
 * jobs are merged in; a run that stops before the merge would keep it for as
 * long as the source stays empty — a tenant that migrated never returns a job
 * again. This runs the same cleanup on the stored jobs at that exit.
 *
 * The slice is rewritten only when the cleanup changed something: same jobs,
 * same slugs and dates, no retirement, no stale pruning, no merge. A rewrite
 * the slice writer's boilerplate guard would refuse as systemic (most stored
 * jobs left without a description) is skipped — the prior slice stays and the
 * next run with jobs cleans it through the merge — and so is a failed write:
 * the exit stays a soft one.
 */
import {
  detectBoilerplateDescriptions,
  isSystemicBoilerplateFailure,
} from '../assemble-jobs-dataset.mjs';
import { meetsSourceBodyFloor } from './source-body-floor.mjs';
import { sourceBodyForJob } from './stored-source-body.mjs';

/**
 * @param {{
 *   prepare?: (jobs: object[]) => (object[]|void),
 *   storedJobs: object[],
 *   companyKey: string,
 *   companyLabel: string,
 *   write: (jobs: object[], options?: { skipShrinkGuard?: boolean }) => (unknown|Promise<unknown>),
 *   assemble?: () => (unknown|Promise<unknown>),
 * }} options `prepare` repairs the stored jobs in place or returns a
 *   replacement array (the `prepareExistingJobs` contract); `write` persists
 *   the crawler's slice, with the same writer the crawler uses on a normal run;
 *   `assemble` rebuilds the assembled dataset after a successful rewrite.
 * @returns {Promise<boolean>} true when the slice was rewritten.
 */
export async function rewritePreparedStoredJobs({
  prepare,
  storedJobs,
  companyKey,
  companyLabel,
  write,
  assemble,
}) {
  if (typeof prepare !== 'function' || !Array.isArray(storedJobs) || storedJobs.length === 0) return false;
  const before = JSON.stringify(storedJobs);
  const prepared = prepare(storedJobs) || storedJobs;
  const preparedChanged = JSON.stringify(prepared) !== before;
  const thinSourceJobs = prepared.filter((job) => !meetsSourceBodyFloor(sourceBodyForJob(job)));
  if (!preparedChanged && thinSourceJobs.length === 0) return false;

  if (isSystemicBoilerplateFailure(detectBoilerplateDescriptions(prepared, companyKey))) {
    console.log(
      `  ⚠️ ${companyLabel}: the stored jobs left without the crawler's own text would trip the slice boilerplate guard; slice not rewritten.`,
    );
    return false;
  }
  const publishable = prepared.filter((job) => meetsSourceBodyFloor(sourceBodyForJob(job)));
  const quarantineCount = prepared.length - publishable.length;
  if (quarantineCount > 0) {
    console.warn(
      `  ⚠️ ${companyLabel}: quarantining ${quarantineCount} stored job(s) without a source body of at least 50 words (thin-source path).`,
    );
  }
  try {
    await write(publishable, quarantineCount > 0 ? { skipShrinkGuard: true } : {});
  } catch (err) {
    console.warn(
      `  ⚠️ ${companyLabel}: rewrite of the stored jobs failed (${err?.message || err}); keeping the prior slice.`,
    );
    return false;
  }
  if (typeof assemble === 'function') await assemble();
  console.log(`  🧹 ${companyLabel}: stored slice rewritten without the crawler's own text (${publishable.length} job(s), ${quarantineCount} thin-source quarantine(s)).`);
  return true;
}
