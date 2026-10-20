/**
 * A crawler run that finds no job keeps the stored slice ("No jobs
 * discovered. Keeping existing jobs."). Text the crawler itself once wrote
 * into those stored jobs is normally removed in the merge, before the fresh
 * jobs are merged in; a run that stops before the merge would keep it for as
 * long as the source stays empty — a tenant that migrated never returns a job
 * again. This runs the same cleanup on the stored jobs at that exit.
 *
 * The slice is rewritten only when the cleanup changed something: same jobs,
 * same slugs and dates, no retirement, no stale pruning, no merge. The slice
 * writer's boilerplate guard is evaluated only on publishable jobs; thin rows
 * are quarantined with a housekeeping proof so indexed routes can land in the
 * expired slice. A failed write still keeps the exit soft.
 */
import {
  detectBoilerplateDescriptions,
  isSystemicBoilerplateFailure,
} from '../assemble-jobs-dataset.mjs';
import { meetsSourceBodyFloor } from './source-body-floor.mjs';
import { SOURCE_BODY_FAILURE_REASON } from './source-body-failure.mjs';
import { sourceBodyForJob } from './stored-source-body.mjs';

/**
 * @param {{
 *   prepare?: (jobs: object[]) => (object[]|void),
 *   storedJobs: object[],
 *   companyKey: string,
 *   companyLabel: string,
 *   write: (jobs: object[], options?: { housekeepingProof?: object[] }) => (unknown|Promise<unknown>),
 *   assemble?: () => (unknown|Promise<unknown>),
 *   sourceBodyFailureJobs?: object[],
 *   sourceBodyFailureKeyOf?: (job: object) => string,
 * }} options `prepare` repairs the stored jobs in place or returns a
 *   replacement array (the `prepareExistingJobs` contract); `write` persists
 *   the crawler's slice, with the same writer the crawler uses on a normal run;
 *   `assemble` rebuilds the assembled dataset after a successful rewrite;
 *   `sourceBodyFailureJobs` identifies stored rows whose fresh PDF/source
 *   extraction failed, so their removal is recorded as an operational failure
 *   rather than a thin-source quarantine.
 * @returns {Promise<boolean>} true when the slice was rewritten.
 */
export async function rewritePreparedStoredJobs({
  prepare,
  storedJobs,
  companyKey,
  companyLabel,
  write,
  assemble,
  sourceBodyFailureJobs = [],
  sourceBodyFailureKeyOf = (job) => job?.url,
}) {
  if (typeof prepare !== 'function' || !Array.isArray(storedJobs) || storedJobs.length === 0) return false;
  const before = JSON.stringify(storedJobs);
  const prepared = prepare(storedJobs) || storedJobs;
  const publishable = prepared.filter((job) => meetsSourceBodyFloor(sourceBodyForJob(job)));
  const quarantined = prepared.filter((job) => !meetsSourceBodyFloor(sourceBodyForJob(job)));
  const sourceFailureKeys = new Set(
    (Array.isArray(sourceBodyFailureJobs) ? sourceBodyFailureJobs : [])
      .map(sourceBodyFailureKeyOf)
      .filter(Boolean),
  );
  const failedRows = quarantined.filter((job) => sourceFailureKeys.has(sourceBodyFailureKeyOf(job)));
  const thinRows = quarantined.filter((job) => !sourceFailureKeys.has(sourceBodyFailureKeyOf(job)));
  const preparedChanged = JSON.stringify(prepared) !== before;
  if (!preparedChanged && quarantined.length === 0) return false;

  const boilerplateReport = detectBoilerplateDescriptions(publishable, companyKey);
  if (publishable.length > 0 && isSystemicBoilerplateFailure(boilerplateReport)) {
    console.log(
      `  ⚠️ ${companyLabel}: the stored jobs left without the crawler's own text would trip the slice boilerplate guard; slice not rewritten.`,
    );
    return false;
  }
  if (failedRows.length > 0) {
    console.warn(
      `  ⚠️ ${companyLabel}: ${failedRows.length} stored job(s) have a failed source/PDF extraction; they are not thin-source quarantine(s).`,
    );
  }
  if (thinRows.length > 0) {
    console.warn(
      `  ⚠️ ${companyLabel}: quarantining ${thinRows.length} stored job(s) without a source body of at least 50 words (thin-source path).`,
    );
  }
  const housekeepingProof = [
    ...thinRows.map((job) => ({
      job,
      reason: 'thin-source-quarantine',
      definitive: true,
    })),
    ...failedRows.map((job) => ({
      job,
      reason: SOURCE_BODY_FAILURE_REASON,
      definitive: true,
    })),
  ];
  try {
    await write(publishable, housekeepingProof.length > 0 ? { housekeepingProof } : {});
  } catch (err) {
    console.warn(
      `  ⚠️ ${companyLabel}: rewrite of the stored jobs failed (${err?.message || err}); keeping the prior slice.`,
    );
    return false;
  }
  if (typeof assemble === 'function') await assemble();
  console.log(`  🧹 ${companyLabel}: stored slice rewritten without the crawler's own text (${publishable.length} job(s), ${thinRows.length} thin-source quarantine(s), ${failedRows.length} source extraction failure(s)).`);
  return true;
}
