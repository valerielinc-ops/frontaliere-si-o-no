import { extractAgatDetailFields, fetchAllAgatJobs } from '../agat-job-parser.mjs';
import { extractLeTeamDetailFields, fetchAllLeTeamJobs } from '../le-team-job-parser.mjs';
import { extractRhExpertChDetailFields, fetchAllRhExpertChJobs } from '../rh-expert-ch-job-parser.mjs';
import {
  extractSeniorenzentrumEngelhofDetailFields,
  fetchAllSeniorenzentrumEngelhofJobs,
} from '../seniorenzentrum-engelhof-job-parser.mjs';
import { isGmoExpectedDetailFilter } from '../gmo-job-parser.mjs';
import { isMedimeoExpectedDetailFilter } from '../medimeo-job-parser.mjs';
import { isMedimeoChExpectedDetailFilter } from '../medimeo-ch-job-parser.mjs';
import { fetchAllRecruitingapp2649Jobs, isRecruitingapp2649ExpectedDetailFilter } from '../recruitingapp-2649-job-parser.mjs';
import {
  extractPromanFleurierDetailFields,
  extractPromanFleurierListingCandidates,
  isPromanFleurierExpectedDetailFilter,
} from '../proman-fleurier-job-parser.mjs';
import {
  extractRecruitingapp2677DetailFields,
  fetchAllRecruitingapp2677Jobs,
  isRecruitingapp2677ExpectedDetailFilter,
} from '../recruitingapp-2677-job-parser.mjs';
import { extractRuntimeDetailFields } from './detail-extract.mjs';
import { CRAWLER_FETCH_FAILURE_OUTCOMES, CRAWLER_FETCH_OUTCOMES } from '../crawler-fetch-outcome.mjs';
import { DETAIL_DROP_ADVISORY_MIN_CANDIDATES, normalizeDetailDrop } from '../crawler-detail-drop.mjs';
import { isDetailFailureWithinGrace } from '../detail-failure-reuse-policy.mjs';

const extractRecruitingapp2649DetailFields = (html, url, opts) =>
  extractRuntimeDetailFields({ platform: 'umantis.com' }, html, url, opts);

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
  'seniorenzentrum-engelhof': Object.freeze({
    version: 'seniorenzentrum-engelhof-dedicated-v1',
    fetchJobs: fetchAllSeniorenzentrumEngelhofJobs,
    detailExtractor: extractSeniorenzentrumEngelhofDetailFields,
    allowRejectedRevalidation: true,
  }),
  'recruitingapp-2649': Object.freeze({
    version: 'recruitingapp-2649-dedicated-v1',
    fetchJobs: fetchAllRecruitingapp2649Jobs,
    detailExtractor: extractRecruitingapp2649DetailFields,
    isExpectedDetailFilter: isRecruitingapp2649ExpectedDetailFilter,
  }),
  'recruitingapp-2677': Object.freeze({
    version: 'recruitingapp-2677-dedicated-v1',
    fetchJobs: fetchAllRecruitingapp2677Jobs,
    detailExtractor: extractRecruitingapp2677DetailFields,
    isExpectedDetailFilter: isRecruitingapp2677ExpectedDetailFilter,
  }),
});

/** @param {{ companyKey?: string } | null | undefined} spec */
export function sourceCrawlerAdapterFor(spec) {
  return SOURCE_CRAWLER_ADAPTERS[String(spec?.companyKey || '')] || null;
}

const PRODUCTION_RUNTIME_OPTIONS = Object.freeze({
  gmo: Object.freeze({ isExpectedDetailFilter: isGmoExpectedDetailFilter }),
  medimeo: Object.freeze({ isExpectedDetailFilter: isMedimeoExpectedDetailFilter }),
  'medimeo-ch': Object.freeze({ isExpectedDetailFilter: isMedimeoChExpectedDetailFilter }),
  'proman-fleurier': Object.freeze({
    listingExtractor: extractPromanFleurierListingCandidates,
    detailExtractor: extractPromanFleurierDetailFields,
    isExpectedDetailFilter: isPromanFleurierExpectedDetailFilter,
  }),
});

/**
 * Return source-specific parser options used to observe the parser's exact
 * output. Unknown geography stays unexpected.
 *
 * @param {{ companyKey?: string } | null | undefined} spec
 * @returns {Record<string, any>|null}
 */
export function productionRuntimeOptionsFor(spec) {
  return PRODUCTION_RUNTIME_OPTIONS[String(spec?.companyKey || '')] || null;
}

/**
 * Convert a source parser's exact output-array metadata into a validation
 * observation. Array metadata is deliberately non-enumerable, so inspect it
 * before serialization or spreading the rows.
 *
 * @param {any[]} rows
 * @param {{ companyKey?: string, adapter?: Record<string, any>, errors?: string[], requireObservedDetails?: boolean }} [options]
 */
export function sourceAdapterRuntimeObservationFor(rows, options = {}) {
  const output = Array.isArray(rows) ? rows : [];
  const errors = Array.isArray(options.errors) ? options.errors.filter(Boolean) : [];
  const hasFetchOutcome = Object.prototype.hasOwnProperty.call(rows || {}, 'fetchOutcome');
  const rawOutcome = hasFetchOutcome ? rows.fetchOutcome : undefined;
  const outcomePresent = hasFetchOutcome && rawOutcome !== null;
  const malformedOutcome = outcomePresent && typeof rawOutcome !== 'string';
  const outcome = typeof rawOutcome === 'string' ? rawOutcome : '';
  const rawOutcomeType = !hasFetchOutcome
    ? 'absent'
    : rawOutcome === null
      ? 'null'
      : typeof rawOutcome;
  const outcomeEvidence = rawOutcome === null
    || typeof rawOutcome === 'string'
    || typeof rawOutcome === 'number'
    || typeof rawOutcome === 'boolean'
    ? rawOutcome
    : rawOutcome === undefined
      ? null
      : `[${Array.isArray(rawOutcome) ? 'array' : typeof rawOutcome}]`;
  const proof = rows?.authoritativeSnapshotProof && typeof rows.authoritativeSnapshotProof === 'object'
    ? rows.authoritativeSnapshotProof
    : null;
  const discoveredCount = Number.isInteger(proof?.discoveredCount)
    ? proof.discoveredCount
    : (Number.isInteger(rows?.discoveredCount) ? rows.discoveredCount : null);
  const exactMetadata = Number.isInteger(rows?.discoveredCount) && rows.discoveredCount >= 0;
  const hasRawDiscoveredCount = Object.prototype.hasOwnProperty.call(rows || {}, 'discoveredCount');
  const malformedDiscoveredCount = hasRawDiscoveredCount
    && rows.discoveredCount !== null
    && (!Number.isInteger(rows.discoveredCount) || rows.discoveredCount < 0);
  const proofComplete = !proof || (
    proof.complete === true
    && Number.isInteger(proof.discoveredCount)
    && proof.discoveredCount >= 0
    && Number.isInteger(proof.attemptedDetailCount)
    && proof.attemptedDetailCount === proof.discoveredCount
    && Number.isInteger(proof.detailCount)
    && Array.isArray(proof.details)
    && proof.detailCount === proof.details.length
    && proof.detailCount === proof.discoveredCount
    && Number.isInteger(proof.publishedCount)
    && proof.publishedCount === output.length
  );
  const acceptedEmptyOutcome = output.length === 0
    && (discoveredCount === null || discoveredCount === 0)
    && (outcome === 'ok' || outcome === 'filtered_empty');
  const authoritativeEmpty = output.length === 0
    && !malformedDiscoveredCount
    && (discoveredCount === null || discoveredCount === 0)
    && (rows?.authoritativeEmptyState === 'authoritative-source-zero' || acceptedEmptyOutcome);
  const unverifiedZeroListing = output.length === 0
    && discoveredCount === 0
    && !proof
    && !authoritativeEmpty;
  const rawDetailDrop = rows?.detailDrop;
  const detailDrop = rawDetailDrop == null ? null : normalizeDetailDrop(rawDetailDrop);
  const malformedDetailDrop = rawDetailDrop != null && !detailDrop;
  const detailDropExceeded = Boolean(detailDrop)
    && detailDrop.candidates >= DETAIL_DROP_ADVISORY_MIN_CANDIDATES
    && !isDetailFailureWithinGrace(detailDrop.dropped, detailDrop.candidates);
  const rawExpectedFilterCount = rows?.expectedFilterCount;
  const declaredExpectedFilterCount = Number.isInteger(rawExpectedFilterCount)
    && rawExpectedFilterCount >= 0
    ? rawExpectedFilterCount
    : 0;
  const malformedExpectedFilterCount = rawExpectedFilterCount != null
    && (!Number.isInteger(rawExpectedFilterCount) || rawExpectedFilterCount < 0);
  const declaredExpectedFilters = rows?.expectedFilters && typeof rows.expectedFilters === 'object'
    && !Array.isArray(rows.expectedFilters)
    ? rows.expectedFilters
    : {};
  const malformedExpectedFilters = rows?.expectedFilters != null
    && (typeof rows.expectedFilters !== 'object' || Array.isArray(rows.expectedFilters));

  let proofExpectedForeignCount = 0;
  if (proof && Array.isArray(proof.details) && typeof options.adapter?.isExpectedDetailFilter === 'function') {
    proofExpectedForeignCount = proof.details.filter((detail) => options.adapter.isExpectedDetailFilter({
      spec: { companyKey: options.companyKey },
      row: { title: detail.title || '', url: detail.id || '' },
      detail: {
        locationCandidates: (Array.isArray(detail.locations) ? detail.locations : [])
          .map((location) => ({ location, addressLocality: location })),
      },
      decision: { geography: detail.swiss ? { source: 'proof' } : null },
      descriptionSufficient: detail.rich === true,
      reason: 'geography',
    }) === true).length;
  }
  const expectedFilterCount = declaredExpectedFilterCount + proofExpectedForeignCount;
  const expectedFilters = {
    ...declaredExpectedFilters,
    ...(proofExpectedForeignCount
      ? { authoritative_foreign_geography: proofExpectedForeignCount }
      : {}),
  };

  const unknownOutcome = outcomePresent
    && typeof rawOutcome === 'string'
    && !CRAWLER_FETCH_OUTCOMES.has(rawOutcome);
  const fetchFailed = errors.length > 0
    || malformedOutcome
    || CRAWLER_FETCH_FAILURE_OUTCOMES.has(outcome)
    || unknownOutcome;
  const outputMismatch = proof && Number.isInteger(proof.publishedCount)
    && proof.publishedCount !== output.length;
  const allUnexpectedDropsNoOutput = discoveredCount > 0
    && output.length === 0
    && ((detailDrop?.dropped || 0) > 0 || expectedFilterCount < discoveredCount);
  const unexplainedEmpty = discoveredCount > 0
    && discoveredCount > expectedFilterCount
    && output.length === 0
    && !proof
    && (detailDrop?.dropped || 0) === 0;
  const unaccountedProofRows = proof && proofComplete && !detailDrop
    ? Math.max(0, discoveredCount - proofExpectedForeignCount - output.length)
    : 0;
  const proofFailed = Boolean(proof && !proofComplete) || Boolean(outputMismatch);
  const productionSnapshotAccepted = !fetchFailed
    && !proofFailed
    && !malformedDiscoveredCount
    && !malformedDetailDrop
    && !detailDropExceeded
    && !unverifiedZeroListing;
  const authoritativeEmptyAccepted = authoritativeEmpty && !fetchFailed && !proofFailed;
  const exactListingCount = Boolean(proofComplete && proof)
    || (exactMetadata && !proof);
  const unverifiedListingCount = !exactListingCount;
  const observedDetailsByUrl = rows?.observedDetailsByUrl instanceof Map
    ? rows.observedDetailsByUrl
    : null;
  const missingObservedDetailCount = options.requireObservedDetails === true
    ? output.filter((row) => !row?.url || !observedDetailsByUrl?.has(row.url)).length
    : 0;
  const observedDetailsIncomplete = options.requireObservedDetails === true
    && missingObservedDetailCount > 0;
  const accountedRows = output.length + expectedFilterCount + (detailDrop?.dropped || 0);
  const rowAccountingMismatch = exactListingCount && discoveredCount !== accountedRows;
  const complete = productionSnapshotAccepted
    && exactListingCount
    && !malformedDiscoveredCount
    && !malformedExpectedFilterCount
    && !malformedExpectedFilters
    && !rowAccountingMismatch
    && !observedDetailsIncomplete
    && !allUnexpectedDropsNoOutput
    && !unexplainedEmpty
    && !unverifiedZeroListing
    && unaccountedProofRows === 0;
  const sourceBackedLocationCount = proof?.details?.filter((detail) => detail.swiss === true).length ?? null;
  const sourceBackedLocationDenominator = discoveredCount === null
    ? null
    : Math.max(0, discoveredCount - expectedFilterCount);
  const qualityDropDenominator = detailDrop?.candidates ?? sourceBackedLocationDenominator;
  const dropCounts = {
    ...(errors.length ? { source_adapter_fetch_error: errors.length } : {}),
    ...(malformedOutcome ? { source_adapter_malformed_fetch_outcome: 1 } : {}),
    ...(CRAWLER_FETCH_FAILURE_OUTCOMES.has(outcome) ? { [`fetch_outcome_${outcome}`]: 1 } : {}),
    ...(unknownOutcome ? { source_adapter_unknown_fetch_outcome: 1 } : {}),
    ...(malformedDiscoveredCount ? { source_adapter_malformed_listing_count: 1 } : {}),
    ...(proofFailed ? { authoritative_snapshot_proof_incomplete: 1 } : {}),
    ...(unverifiedListingCount ? { source_adapter_listing_count_unverified: 1 } : {}),
    ...(malformedExpectedFilterCount || malformedExpectedFilters
      ? { malformed_expected_filter_metadata: 1 }
      : {}),
    ...(rowAccountingMismatch ? { source_adapter_row_accounting_mismatch: 1 } : {}),
    ...(observedDetailsIncomplete
      ? { source_adapter_detail_observation_missing: missingObservedDetailCount }
      : {}),
    ...(malformedDetailDrop ? { malformed_detail_drop_metadata: 1 } : {}),
    ...(unaccountedProofRows ? { source_adapter_unaccounted_rows: unaccountedProofRows } : {}),
    ...(unexplainedEmpty ? { source_adapter_unverified_empty_output: 1 } : {}),
    ...(unverifiedZeroListing ? { source_adapter_zero_listing_unverified: 1 } : {}),
    ...(detailDrop ? {
      detail_runtime_gone: detailDrop.gone,
      detail_runtime_rejected: detailDrop.rejected,
    } : {}),
  };
  const failure = errors[0]
    || (malformedOutcome ? 'fetchOutcome must be a string when present' : '')
    || (CRAWLER_FETCH_FAILURE_OUTCOMES.has(outcome) ? `fetchOutcome=${outcome}` : '')
    || (unknownOutcome ? `unrecognized fetchOutcome=${outcome}` : '')
    || (malformedDiscoveredCount ? 'discoveredCount metadata is malformed' : '')
    || (proofFailed ? 'authoritative snapshot proof incomplete or inconsistent' : '')
    || (unverifiedListingCount ? 'exact listing count is missing' : '')
    || (malformedExpectedFilterCount || malformedExpectedFilters ? 'expected filter metadata is malformed' : '')
    || (rowAccountingMismatch ? 'listing rows are not accounted for by output, expected filters, or drops' : '')
    || (observedDetailsIncomplete ? 'adapter output lacks its already-fetched detail observation' : '')
    || (malformedDetailDrop ? 'detailDrop metadata is malformed' : '')
    || (unaccountedProofRows ? 'source adapter proof contains rows unexplained by output or expected filters' : '')
    || (detailDropExceeded ? 'detail drops exceed the shared 15% grace' : '')
    || (unverifiedZeroListing ? 'zero-row adapter listing lacks an accepted fetch outcome or authoritative proof' : '')
    || (allUnexpectedDropsNoOutput || unexplainedEmpty ? 'non-empty listing produced no publishable output' : '')
    || null;

  return {
    algorithmVersion: 'source-adapter-output-v2',
    sourceAdapterVersion: options.adapter?.version || null,
    fetchOutcome: outcome || null,
    fetchOutcomePresent: hasFetchOutcome,
    fetchOutcomeType: rawOutcomeType,
    fetchOutcomeValue: outcomeEvidence,
    malformedFetchOutcome: malformedOutcome,
    listingCount: discoveredCount,
    partialListingCount: exactListingCount ? null : discoveredCount,
    publishableCount: output.length,
    runtimeOutputCount: productionSnapshotAccepted ? output.length : 0,
    snapshotAccepted: productionSnapshotAccepted || authoritativeEmptyAccepted,
    productionSnapshotAccepted: productionSnapshotAccepted || authoritativeEmptyAccepted,
    qualityDropDenominator,
    exactListingCount,
    observedDetailCount: observedDetailsByUrl?.size ?? 0,
    missingObservedDetailCount,
    listingPopulationComplete: exactListingCount && proofComplete,
    expectedFilterCount,
    expectedFilters,
    dropCounts,
    sourceBackedLocationCount,
    sourceBackedLocationDenominator,
    sourceBackedLocationRate: Number.isInteger(sourceBackedLocationCount)
      ? (sourceBackedLocationDenominator
        ? Number((sourceBackedLocationCount / sourceBackedLocationDenominator).toFixed(3))
        : 0)
      : null,
    complete: complete || authoritativeEmptyAccepted,
    promotionObservationComplete: complete || authoritativeEmptyAccepted,
    detailDrop,
    failure,
  };
}
