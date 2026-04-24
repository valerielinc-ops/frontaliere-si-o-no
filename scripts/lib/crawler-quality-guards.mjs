/**
 * Reusable quality guards for job crawlers.
 *
 * Extracted from the Copilot fix-prompts plan (docs/copilot-crawler-fix-prompts.md):
 * every dedicated crawler should drop jobs that fail the minimum description
 * length, the company-name sanity check, or the title-overlap threshold.
 *
 * Designed to be a drop-in post-processing pass after the base crawler has
 * populated jobs.json. It mutates the jobs array in place (removing rejected
 * records) and returns a diagnostics summary that crawlers can log.
 */

export const DEFAULT_MIN_DESCRIPTION = 150;
export const DEFAULT_MIN_TITLE_OVERLAP = 0.5;

/**
 * Jaccard-like token overlap between two titles. Returns a value in [0, 1].
 * Matches the heuristic used by the Coop and VOLG crawlers.
 *
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
export function titleOverlap(a = '', b = '') {
  const toTokens = (s) =>
    new Set(
      String(s || '')
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-z0-9 ]+/g, ' ')
        .split(/\s+/)
        .filter((w) => w.length > 2),
    );
  const A = toTokens(a);
  const B = toTokens(b);
  if (!A.size || !B.size) return 0;
  const inter = [...A].filter((t) => B.has(t)).length;
  const union = new Set([...A, ...B]).size;
  return inter / union;
}

/**
 * Build a normalized list of accepted aliases for a company (case/accent-insensitive).
 * @param {string|string[]} expected
 * @returns {string[]}
 */
function buildCompanyAliases(expected) {
  const raw = Array.isArray(expected) ? expected : [expected];
  return raw
    .map((s) =>
      String(s || '')
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-z0-9 ]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim(),
    )
    .filter(Boolean);
}

/**
 * Verify that `job.company` resolves to one of the accepted aliases.
 * @param {{ company?: string }} job
 * @param {string|string[]} expected - canonical name(s) or alias(es)
 * @returns {{ ok: boolean, reason?: string }}
 */
export function checkCompanyNameSanity(job, expected) {
  const aliases = buildCompanyAliases(expected);
  if (!aliases.length) return { ok: true };

  const actual = String(job?.company || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!actual) return { ok: false, reason: 'empty company name' };

  const match = aliases.some((alias) => actual === alias || actual.includes(alias));
  if (!match) {
    return {
      ok: false,
      reason: `company name "${job.company}" does not match expected alias (${aliases.join(' | ')})`,
    };
  }
  return { ok: true };
}

/**
 * Verify that the description meets the minimum character threshold.
 * @param {{ description?: string }} job
 * @param {number} minLen
 * @returns {{ ok: boolean, reason?: string }}
 */
export function checkMinDescription(job, minLen = DEFAULT_MIN_DESCRIPTION) {
  const len = (job?.description || '').trim().length;
  if (len < minLen) {
    return { ok: false, reason: `description too short (${len} < ${minLen} chars)` };
  }
  return { ok: true };
}

/**
 * Apply the full guard battery to an array of jobs, mutating in place.
 *
 * @param {Array} jobs
 * @param {{
 *   companyName?: string|string[],
 *   minDescription?: number,
 *   expectedTitleRefField?: string,
 *   minTitleOverlap?: number,
 *   logger?: (msg: string) => void,
 * }} opts
 * @returns {{ kept: number, rejected: number, reasons: Record<string, number> }}
 */
export function runQualityGuards(jobs, opts = {}) {
  if (!Array.isArray(jobs)) return { kept: 0, rejected: 0, reasons: {} };

  const minDescription = opts.minDescription ?? DEFAULT_MIN_DESCRIPTION;
  const minTitleOverlap = opts.minTitleOverlap ?? DEFAULT_MIN_TITLE_OVERLAP;
  const log = opts.logger || (() => {});
  const refField = opts.expectedTitleRefField;

  const reasons = Object.create(null);
  const bump = (k) => {
    reasons[k] = (reasons[k] || 0) + 1;
  };

  const kept = [];
  for (const job of jobs) {
    const desc = checkMinDescription(job, minDescription);
    if (!desc.ok) {
      bump('min_description');
      log(`  ⚠️ reject "${job?.title || '?'}" — ${desc.reason}`);
      continue;
    }

    if (opts.companyName) {
      const company = checkCompanyNameSanity(job, opts.companyName);
      if (!company.ok) {
        bump('company_name');
        log(`  ⚠️ reject "${job?.title || '?'}" — ${company.reason}`);
        continue;
      }
    }

    if (refField && job?.[refField]) {
      const ov = titleOverlap(job.title || '', job[refField]);
      if (ov < minTitleOverlap) {
        bump('title_overlap');
        log(
          `  ⚠️ reject "${job.title}" — title overlap ${(ov * 100).toFixed(0)}% < ${(minTitleOverlap * 100).toFixed(0)}%`,
        );
        continue;
      }
    }

    kept.push(job);
  }

  const rejected = jobs.length - kept.length;
  if (rejected > 0) {
    jobs.length = 0;
    jobs.push(...kept);
  }

  return { kept: kept.length, rejected, reasons };
}
