#!/usr/bin/env node

/**
 * Build the common outcome record for a validated loop run.
 *
 * Domain runners decide whether their source join is trustworthy and pass that
 * assertion explicitly. This helper only applies the registry contract: a
 * missing, stale or non-independent source can never retain measured values.
 */
import {
  OUTCOME_STATES,
  buildOutcome,
  findLoopPolicy,
} from './loop-fleet-contract.mjs';

function finite(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function iso(value) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value))
    ? new Date(value).toISOString()
    : null;
}

/**
 * Turn a domain verdict into a registry-checked outcome.
 *
 * `independent` is an explicit assertion from the domain runner. It is never
 * inferred from `quality`, because a green local calculation is not by itself
 * an independent oracle.
 */
export function buildValidatedLoopOutcome({
  registry,
  loopId,
  quality,
  independent = false,
  numerator = null,
  denominator = null,
  observedAt = null,
  reason,
  now = new Date(),
} = {}) {
  const policy = findLoopPolicy(registry, loopId);
  const requestedStatus = OUTCOME_STATES.includes(quality) ? quality : 'unmeasurable';
  const timestamp = iso(observedAt);
  const candidateNumerator = finite(numerator);
  const candidateDenominator = finite(denominator);
  const measuredStatus = requestedStatus === 'observed' || requestedStatus === 'zero';
  const completeFields = Boolean(timestamp && candidateNumerator !== null && candidateDenominator !== null);
  const measured = measuredStatus && independent === true && completeFields;
  const status = measured
    ? requestedStatus
    : (measuredStatus ? 'partial' : requestedStatus);
  const requiredFieldsPresent = [
    timestamp ? 'generatedAt' : null,
    measured ? 'numerator' : null,
    measured ? 'denominator' : null,
  ].filter(Boolean);
  const missingFields = policy.outcome.requiredFields.filter((field) => !requiredFieldsPresent.includes(field));

  return buildOutcome({
    outcomeId: policy.outcome.outcomeId,
    status,
    independent: measured,
    sourceRefs: policy.outcome.sourceRefs,
    primaryMetric: policy.primaryMetric,
    numerator: measured ? candidateNumerator : null,
    denominator: measured ? candidateDenominator : null,
    requiredFieldsPresent,
    missingFields,
    reason,
    observedAt: timestamp,
    allowNumeratorExceedDenominator: policy.outcome.allowNumeratorExceedDenominator,
    recordedAt: now.toISOString(),
  });
}
