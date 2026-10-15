import { extractAgatDetailFields, fetchAllAgatJobs } from '../agat-job-parser.mjs';
import { extractLeTeamDetailFields, fetchAllLeTeamJobs } from '../le-team-job-parser.mjs';
import { extractRhExpertChDetailFields, fetchAllRhExpertChJobs } from '../rh-expert-ch-job-parser.mjs';

/**
 * Source-specific production parsers that must also grade their own output.
 * Bump an adapter version when its extraction semantics change: explicitly
 * opted-in rejected candidates use that version as their one-time retry key.
 */
export const SOURCE_CRAWLER_ADAPTERS = Object.freeze({
  'le-team': Object.freeze({
    version: 'le-team-dedicated-v1',
    fetchJobs: fetchAllLeTeamJobs,
    detailExtractor: extractLeTeamDetailFields,
  }),
  agat: Object.freeze({
    version: 'agat-dedicated-v1',
    fetchJobs: fetchAllAgatJobs,
    detailExtractor: extractAgatDetailFields,
  }),
  'rh-expert-ch': Object.freeze({
    version: 'rh-expert-ch-dedicated-v1',
    fetchJobs: fetchAllRhExpertChJobs,
    detailExtractor: extractRhExpertChDetailFields,
    allowRejectedRevalidation: true,
  }),
});

/** @param {{ companyKey?: string } | null | undefined} spec */
export function sourceCrawlerAdapterFor(spec) {
  return SOURCE_CRAWLER_ADAPTERS[String(spec?.companyKey || '')] || null;
}
