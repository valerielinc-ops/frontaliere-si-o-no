/**
 * extraction-completeness.mjs — turn "I found some listings" into
 * "I found exactly as many listings as the source says exist".
 *
 * THE PROBLEM this solves (structural, fleet-wide):
 * 117 bespoke `update-*-jobs.mjs` crawlers run their own listing extraction,
 * and 106 of them validate the result ONLY by checking it is non-empty. A
 * selector that stops matching after a markup change therefore does not fail —
 * it returns a fraction and exits 0. That is a partial failure reporting
 * success, and nothing downstream can tell it apart from a legitimate drop:
 *   - the shared pipelines are no stricter (crawler-template.mjs soft-returns
 *     on zero listings, dedicated-crawler-common.mjs throws only when the
 *     caller opted in via `failWhenNoJobs`);
 *   - the anti-shrink guard in assemble-jobs-dataset.mjs is a RELATIVE check
 *     (new count vs. prior slice). It catches a cliff, but it cannot catch a
 *     crawler that was partial from its very first run, nor a slice that
 *     erodes gradually, and it reports the damage hours later and off-site.
 * Observed: grace-la-margna extracted 1 listing out of 14, exited 0, and the
 * only signal was the shrink guard rejecting the write (#5139 → #5200).
 *
 * THE FIX: many job boards publish their own total — `Job offers (14)` in a
 * profile tab, `totalNumber` in an API payload, `123 results` above a result
 * list. Where such a number exists, the extractor can be held to it. Passing
 * that number here converts a silent partial extraction into a loud, immediate
 * failure at the point of extraction, before anything is written.
 *
 * Fail-closed on purpose: a MISSING declared total is itself a failure, not a
 * free pass. If the counter cannot be located, completeness is unverifiable,
 * and a check that cannot check must not report success — otherwise it becomes
 * exactly the thing it was added to prevent.
 *
 * Adoption is per-crawler and cheap: parse the source's own total, then call
 * this. Crawlers whose source declares no total anywhere cannot use it and
 * remain covered only by the shrink guard.
 */

/**
 * Assert that an extraction is complete against the source's declared total.
 *
 * @param {object} input
 * @param {string} input.label crawler/source name, used in the error message
 * @param {number} input.extractedCount how many items the extractor produced
 * @param {number|null|undefined} input.declaredTotal the source-declared total
 * @param {string} [input.declaredTotalRaw] raw text the total was parsed from
 * @param {string} [input.escapeHatchEnvVar] env var name to cite as the override
 * @param {boolean} [input.skip] when true, skip the check (override engaged)
 * @returns {{extractedCount: number, declaredTotal: number|null, verified: boolean}}
 * @throws {Error} when the counts disagree, or the total could not be found
 */
export function assertExtractionComplete({
  label = 'crawler',
  extractedCount = 0,
  declaredTotal = null,
  declaredTotalRaw = '',
  escapeHatchEnvVar = '',
  skip = false,
} = {}) {
  const normalizedTotal = Number.isInteger(declaredTotal) && declaredTotal >= 0 ? declaredTotal : null;
  const override = escapeHatchEnvVar ? ` Set ${escapeHatchEnvVar}=1 to proceed unverified.` : '';

  if (skip) {
    return { extractedCount, declaredTotal: normalizedTotal, verified: false };
  }

  if (normalizedTotal === null) {
    throw new Error(
      `[${label}] completeness unverifiable: the source-declared total could not be found ` +
        `(raw: ${JSON.stringify(String(declaredTotalRaw || '').slice(0, 120))}). ` +
        `Extracted ${extractedCount} item(s), but with no declared total there is no way to tell a complete ` +
        `run from a partial one — refusing to report success. Re-point the counter selector.${override}`,
    );
  }

  if (extractedCount !== normalizedTotal) {
    throw new Error(
      `[${label}] incomplete extraction: the source declares ${normalizedTotal} item(s) but the extractor ` +
        `matched ${extractedCount}. The page structure has changed and the parser no longer follows it — ` +
        `refusing to write a partial slice. Fix the extraction selector.${override}`,
    );
  }

  return { extractedCount, declaredTotal: normalizedTotal, verified: true };
}
