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

function object(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function text(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

function measuredStatus(value) {
  return value === 'observed' || value === 'zero';
}

function exactSourceRefs(actual, expected) {
  return Array.isArray(actual)
    && Array.isArray(expected)
    && actual.length === expected.length
    && actual.every((sourceRef) => typeof sourceRef === 'string' && expected.includes(sourceRef))
    && expected.every((sourceRef) => actual.includes(sourceRef));
}

/**
 * Check the provenance that must accompany an independent outcome claim.
 *
 * The recorder receives runner artifacts, not a canonical source ledger. A
 * measured claim is therefore accepted only when the outcome itself carries
 * the registry binding and a direct source/decision chain. No nested artifact
 * timestamp, metric or registry declaration is promoted into that claim.
 */
export function validateLoopOutcomeProvenance({
  policy,
  candidate = null,
  sourceSnapshot = null,
  decision = null,
  now = new Date(),
  assertedIndependent = false,
} = {}) {
  const errors = [];
  const candidateObject = object(candidate);
  const candidateStatus = candidateObject && OUTCOME_STATES.includes(candidate.status)
    ? candidate.status
    : null;
  const measuredClaim = assertedIndependent === true
    || candidateObject?.independent === true
    || measuredStatus(candidateStatus);

  if (!measuredClaim) {
    return {
      ok: true,
      errors: [],
      measuredClaim: false,
      candidateId: null,
      sourceRecordId: null,
      source: null,
      expiresAt: null,
      observedAt: null,
    };
  }

  if (!candidateObject) {
    errors.push('independent outcome candidate is missing');
  } else {
    if (!measuredStatus(candidateStatus)) {
      errors.push('independent outcome status must be observed or zero');
    }
    if (assertedIndependent === true && candidate.independent !== true) {
      errors.push('independent outcome candidate must explicitly assert independent=true');
    }
    if (candidate.recordType !== 'outcome') errors.push('independent outcome recordType must be outcome');
    if (candidate.schemaVersion !== 1) errors.push('independent outcome schemaVersion must be 1');
    if (candidate.outcomeId !== policy?.outcome?.outcomeId) {
      errors.push('independent outcome outcomeId does not match the registry');
    }
    if (candidate.primaryMetric !== policy?.primaryMetric) {
      errors.push('independent outcome primaryMetric does not match the registry');
    }
    if (!exactSourceRefs(candidate.sourceRefs, policy?.outcome?.sourceRefs)) {
      errors.push('independent outcome sourceRefs must exactly match the registry');
    }
    if (typeof candidate.numerator !== 'number' || !Number.isFinite(candidate.numerator)) {
      errors.push('independent outcome numerator must be present on the outcome record');
    }
    if (typeof candidate.denominator !== 'number' || !Number.isFinite(candidate.denominator)) {
      errors.push('independent outcome denominator must be present on the outcome record');
    }
  }

  const outcomeSource = text(sourceSnapshot?.source);
  if (!object(sourceSnapshot) || !outcomeSource) {
    errors.push('independent outcome sourceSnapshot.source is missing');
  }

  const decisionSource = text(decision?.sourceSnapshot?.source);
  const candidateId = text(decision?.recordId);
  const startedAt = iso(decision?.startedAt);
  const decidedAt = iso(decision?.decidedAt);
  const expiresAt = iso(decision?.expiresAt);
  const nowMs = now instanceof Date ? now.getTime() : Date.parse(now);
  if (!object(decision)) {
    errors.push('independent outcome decision reference is missing');
  } else {
    if (!candidateId) errors.push('independent outcome candidate/source recordId is missing');
    if (!decisionSource) errors.push('independent outcome decision sourceSnapshot.source is missing');
    else if (outcomeSource && decisionSource !== outcomeSource) {
      errors.push('independent outcome source snapshots do not identify the same source');
    }
    if (!startedAt) errors.push('independent outcome decision startedAt is missing or invalid');
    if (!decidedAt) errors.push('independent outcome decision decidedAt is missing or invalid');
    if (startedAt && decidedAt && Date.parse(decidedAt) < Date.parse(startedAt)) {
      errors.push('independent outcome decision decidedAt cannot precede startedAt');
    }
    if (!expiresAt) errors.push('independent outcome decision expiresAt is missing or invalid');
    else {
      if (startedAt && Date.parse(expiresAt) < Date.parse(startedAt)) {
        errors.push('independent outcome decision expiresAt cannot precede startedAt');
      }
      if (decidedAt && policy?.lifecycle?.candidateTtlHours !== undefined
          && Date.parse(expiresAt) > Date.parse(decidedAt) + policy.lifecycle.candidateTtlHours * 3_600_000) {
        errors.push('independent outcome decision expiresAt exceeds the registry candidate TTL');
      }
      if (Number.isFinite(nowMs) && Date.parse(expiresAt) <= nowMs) {
        errors.push('independent outcome decision expiresAt ' + expiresAt + ' is expired');
      }
    }
  }

  const observedAt = candidateObject
    ? (iso(candidate.observedAt) || iso(candidate.generatedAt))
    : null;
  if (!observedAt) errors.push('independent outcome observedAt/generatedAt must be direct on the outcome record');
  else if (Number.isFinite(nowMs) && Date.parse(observedAt) > nowMs) {
    errors.push('independent outcome observedAt/generatedAt cannot be in the future');
  }

  return {
    ok: errors.length === 0,
    errors,
    measuredClaim: true,
    candidateId,
    sourceRecordId: candidateId,
    source: outcomeSource,
    expiresAt,
    observedAt,
  };
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
  evidence = null,
} = {}) {
  const policy = findLoopPolicy(registry, loopId);
  const requestedStatus = OUTCOME_STATES.includes(quality) ? quality : 'unmeasurable';
  const timestamp = iso(observedAt);
  const candidateNumerator = finite(numerator);
  const candidateDenominator = finite(denominator);
  const measuredStatus = requestedStatus === 'observed' || requestedStatus === 'zero';
  const completeFields = Boolean(timestamp && candidateNumerator !== null && candidateDenominator !== null);
  const evidenceCandidate = evidence
    ? (evidence.candidate ?? evidence.outcome ?? null)
    : null;
  const provenance = evidence
    ? validateLoopOutcomeProvenance({
      policy,
      candidate: evidenceCandidate,
      sourceSnapshot: evidence.sourceSnapshot,
      decision: evidence.decision,
      now,
      assertedIndependent: independent,
    })
    : { ok: true, errors: [] };
  const provenanceErrors = [...(provenance.errors || [])];
  if (evidence && provenance.ok && provenance.measuredClaim) {
    const evidenceTimestamp = iso(evidenceCandidate?.observedAt)
      || iso(evidenceCandidate?.generatedAt);
    const evidenceNumerator = finite(evidenceCandidate?.numerator);
    const evidenceDenominator = finite(evidenceCandidate?.denominator);
    if (evidenceTimestamp !== timestamp) provenanceErrors.push('independent outcome timestamp is not linked to the measured values');
    if (evidenceNumerator !== candidateNumerator) provenanceErrors.push('independent outcome numerator is not linked to the candidate');
    if (evidenceDenominator !== candidateDenominator) provenanceErrors.push('independent outcome denominator is not linked to the candidate');
  }
  const measured = measuredStatus && independent === true && completeFields && provenanceErrors.length === 0;
  const status = measured
    ? requestedStatus
    : (measuredStatus ? 'partial' : requestedStatus);
  const requiredFieldsPresent = [
    timestamp ? 'generatedAt' : null,
    measured ? 'numerator' : null,
    measured ? 'denominator' : null,
  ].filter(Boolean);
  const missingFields = policy.outcome.requiredFields.filter((field) => !requiredFieldsPresent.includes(field));
  const outcomeReason = provenanceErrors.length
    ? [reason, 'independent outcome evidence rejected: ' + provenanceErrors.join('; ')].filter(Boolean).join('; ')
    : reason;

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
    reason: outcomeReason,
    observedAt: timestamp,
    allowNumeratorExceedDenominator: policy.outcome.allowNumeratorExceedDenominator,
    recordedAt: now.toISOString(),
  });
}
