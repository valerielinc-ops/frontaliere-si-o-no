import { createHash } from 'node:crypto';
import { stableStringify } from './stable-stringify.mjs';

export const SOURCE_DETAIL_EVIDENCE_FORMAT = 'frontaliere.source-detail-observation/v1';
export const SOURCE_DETAIL_EVIDENCE_BUNDLE_FORMAT = 'frontaliere.source-detail-observation-bundle/v1';
export const SOURCE_DETAIL_EVIDENCE_FAILURE_FORMAT = 'frontaliere.source-detail-observation-bundle-error/v1';

function sha256(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}

function documentSha256(value) {
  return sha256(stableStringify(value));
}

function requiredString(value, field) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new SourceDetailEvidenceError('evidence-field-missing', `${field} is required`);
  }
  return value;
}

function requiredSha256(value, field) {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) {
    throw new SourceDetailEvidenceError('invalid-digest', `${field} must be a lowercase sha256 digest`);
  }
  return value;
}

function requiredCommitSha(value, field) {
  if (typeof value !== 'string' || !/^[a-f0-9]{40,64}$/.test(value)) {
    throw new SourceDetailEvidenceError('invalid-provenance', `${field} must be a git commit digest`);
  }
  return value;
}

function nonNegativeInteger(value, field) {
  if (!Number.isInteger(value) || value < 0) {
    throw new SourceDetailEvidenceError('invalid-observation', `${field} must be a non-negative integer`);
  }
  return value;
}

export class SourceDetailEvidenceError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'SourceDetailEvidenceError';
    this.code = code;
  }
}

/**
 * Classify the privacy-safe, normalized observation used by both the live
 * audit and historical replay. Descriptions never enter this object: only the
 * lengths and word-set cardinalities required by the mismatch rule do.
 */
export function classifySourceDetailObservation(observation) {
  if (!observation || typeof observation !== 'object') {
    throw new SourceDetailEvidenceError('invalid-observation', 'normalized observation is required');
  }
  const location = observation.location;
  const description = observation.description;
  if (!location || typeof location !== 'object' || !description || typeof description !== 'object') {
    throw new SourceDetailEvidenceError('invalid-observation', 'location and description observations are required');
  }
  for (const field of ['checked', 'matchesPublished', 'inconclusive']) {
    if (typeof location[field] !== 'boolean') {
      throw new SourceDetailEvidenceError('invalid-observation', `location.${field} must be boolean`);
    }
  }
  const publishedDescriptionLength = nonNegativeInteger(description.publishedDescriptionLength, 'description.publishedDescriptionLength');
  const sourceDescriptionLength = nonNegativeInteger(description.sourceDescriptionLength, 'description.sourceDescriptionLength');
  const publishedWordCount = nonNegativeInteger(description.publishedWordCount, 'description.publishedWordCount');
  const overlapWordCount = nonNegativeInteger(description.overlapWordCount, 'description.overlapWordCount');
  if (overlapWordCount > publishedWordCount) {
    throw new SourceDetailEvidenceError('invalid-observation', 'description overlap exceeds the published word set');
  }
  const overlapRatio = publishedWordCount ? overlapWordCount / publishedWordCount : 0;
  const descriptionMismatch = sourceDescriptionLength >= 200
    && (publishedDescriptionLength < 100
      || publishedDescriptionLength < sourceDescriptionLength * 0.45
      || overlapRatio < 0.35);
  return {
    locationChecked: location.checked,
    locationMismatch: location.checked && !location.matchesPublished,
    locationInconclusive: location.inconclusive,
    locationEvidence: requiredString(location.evidence, 'location.evidence'),
    locationAuthority: requiredString(location.authority, 'location.authority'),
    descriptionMismatch,
    publishedLocation: typeof location.published === 'string' ? location.published : '',
    sourceLocation: typeof location.source === 'string' ? location.source : '',
    publishedDescriptionLength,
    sourceDescriptionLength,
    overlapRatio: Number(overlapRatio.toFixed(2)),
  };
}

function normalizedProvenance(provenance) {
  const repoHeadSha = requiredCommitSha(provenance?.repoHeadSha, 'provenance.repoHeadSha');
  const datasetCommitSha = requiredCommitSha(provenance?.datasetLastCommit?.sha, 'provenance.datasetLastCommit.sha');
  return {
    repoHeadSha,
    datasetCommitSha,
    datasetCommittedAt: provenance?.datasetLastCommit?.committedAt || null,
  };
}

/**
 * Bind one fetched response to the exact normalized classifier input. The raw
 * body and source URL are intentionally not emitted: their sha256 digests make
 * the observation content-addressed, while the immutable normalized blob is
 * sufficient to replay the verdict without leaking descriptions, contacts or
 * signed URL parameters into the report artifact.
 */
export function createSourceDetailEvidence({
  crawlerKey,
  sourceUrl,
  body,
  observation,
  provenance,
  versions,
}) {
  requiredString(body, 'body');
  const immutableObservation = JSON.parse(stableStringify(observation));
  const record = {
    format: SOURCE_DETAIL_EVIDENCE_FORMAT,
    crawlerKey: requiredString(crawlerKey, 'crawlerKey'),
    provenance: normalizedProvenance(provenance),
    versions: {
      extractor: requiredString(versions?.extractor, 'versions.extractor'),
      normalizer: requiredString(versions?.normalizer, 'versions.normalizer'),
    },
    sourceUrlSha256: sha256(requiredString(sourceUrl, 'sourceUrl')),
    bodySha256: sha256(body),
    observation: immutableObservation,
    observationSha256: documentSha256(immutableObservation),
  };
  // Validate before sealing so malformed observations can never be persisted
  // and later mistaken for a replayable green result.
  classifySourceDetailObservation(immutableObservation);
  return { ...record, recordSha256: documentSha256(record) };
}

function verifyExpectedContext(record, expected) {
  const expectedProvenance = normalizedProvenance(expected?.provenance);
  const expectedExtractor = requiredString(expected?.versions?.extractor, 'expected.versions.extractor');
  const expectedNormalizer = requiredString(expected?.versions?.normalizer, 'expected.versions.normalizer');
  if (record.provenance.repoHeadSha !== expectedProvenance.repoHeadSha
    || record.provenance.datasetCommitSha !== expectedProvenance.datasetCommitSha) {
    throw new SourceDetailEvidenceError('provenance-mismatch', 'evidence commit or dataset does not match the requested replay');
  }
  if (record.versions.extractor !== expectedExtractor || record.versions.normalizer !== expectedNormalizer) {
    throw new SourceDetailEvidenceError('version-mismatch', 'evidence extractor or normalizer version does not match');
  }
}

/** Replay one immutable observation, failing closed on every trust failure. */
export function replaySourceDetailEvidence(record, expected) {
  if (!record || typeof record !== 'object') {
    throw new SourceDetailEvidenceError('missing-evidence', 'source detail evidence is required');
  }
  if (record.format !== SOURCE_DETAIL_EVIDENCE_FORMAT) {
    throw new SourceDetailEvidenceError('version-mismatch', 'unsupported source detail evidence format');
  }
  requiredString(record.crawlerKey, 'crawlerKey');
  requiredSha256(record.sourceUrlSha256, 'sourceUrlSha256');
  requiredSha256(record.bodySha256, 'bodySha256');
  requiredSha256(record.observationSha256, 'observationSha256');
  requiredSha256(record.recordSha256, 'recordSha256');
  normalizedProvenance({
    repoHeadSha: record.provenance?.repoHeadSha,
    datasetLastCommit: {
      sha: record.provenance?.datasetCommitSha,
      committedAt: record.provenance?.datasetCommittedAt,
    },
  });
  requiredString(record.versions?.extractor, 'versions.extractor');
  requiredString(record.versions?.normalizer, 'versions.normalizer');
  const { recordSha256, ...unsignedRecord } = record;
  if (documentSha256(unsignedRecord) !== recordSha256
    || documentSha256(record.observation) !== record.observationSha256) {
    throw new SourceDetailEvidenceError('tampered-evidence', 'source detail evidence digest does not match');
  }
  verifyExpectedContext(record, expected);
  return {
    crawlerKey: record.crawlerKey,
    url: `sha256:${record.sourceUrlSha256}`,
    replayed: true,
    evidenceProvenance: record.provenance,
    ...classifySourceDetailObservation(record.observation),
  };
}

function requestedSampleCommitments(expected) {
  if (!Array.isArray(expected?.requestedSamples) || expected.requestedSamples.length === 0) {
    throw new SourceDetailEvidenceError('missing-evidence', 'expected.requestedSamples are required');
  }
  const requestedCount = nonNegativeInteger(expected?.requestedCount, 'expected.requestedCount');
  if (requestedCount === 0 || expected.requestedSamples.length !== requestedCount) {
    throw new SourceDetailEvidenceError('missing-evidence', 'source detail request manifest count does not match');
  }
  const seen = new Set();
  return expected.requestedSamples.map((sample, index) => {
    const crawlerKey = requiredString(sample?.crawlerKey, `requestedSamples[${index}].crawlerKey`);
    const requestUrlSha256 = sha256(requiredString(sample?.url, `requestedSamples[${index}].url`));
    const identity = `${crawlerKey}:${requestUrlSha256}`;
    if (seen.has(identity)) {
      throw new SourceDetailEvidenceError('duplicate-evidence', 'source detail request manifest contains a duplicate identity');
    }
    seen.add(identity);
    return { index, crawlerKey, requestUrlSha256 };
  });
}

function sourceResultCommitment(result, expectedSample, expected) {
  const index = expectedSample.index;
  const crawlerKey = requiredString(result?.crawlerKey, `samples[${index}].crawlerKey`);
  const requestUrlSha256 = sha256(requiredString(result?.url, `samples[${index}].url`));
  if (crawlerKey !== expectedSample.crawlerKey || requestUrlSha256 !== expectedSample.requestUrlSha256) {
    throw new SourceDetailEvidenceError('request-mismatch', 'source detail result identity does not match the requested sample');
  }
  const outcomeCount = Number(Boolean(result?.sourceDetailEvidence))
    + Number(Boolean(result?.fetchFailed))
    + Number(Boolean(result?.processingFailed));
  if (outcomeCount !== 1) {
    throw new SourceDetailEvidenceError('invalid-observation', 'source detail result must have exactly one outcome');
  }
  const sourceUrlSha256 = result?.sourceDetailEvidence?.sourceUrlSha256
    || requestUrlSha256;
  if (result?.sourceDetailEvidence) {
    const replayed = replaySourceDetailEvidence(result.sourceDetailEvidence, expected);
    if (replayed.crawlerKey !== crawlerKey) {
      throw new SourceDetailEvidenceError('tampered-evidence', 'sample identity does not match its replayable record');
    }
    return {
      index,
      crawlerKey,
      requestUrlSha256,
      sourceUrlSha256,
      outcome: 'replayable',
      record: result.sourceDetailEvidence,
    };
  }
  if (result?.fetchFailed) {
    return {
      index,
      crawlerKey,
      requestUrlSha256,
      sourceUrlSha256,
      outcome: 'fetch-failed',
      status: Number.isInteger(result.status) && result.status >= 0 ? result.status : 0,
    };
  }
  if (result?.processingFailed) {
    return {
      index,
      crawlerKey,
      requestUrlSha256,
      sourceUrlSha256,
      outcome: 'processing-failed',
      errorCode: 'source-detail-processing-failed',
    };
  }
  throw new SourceDetailEvidenceError('missing-evidence', `sample ${index} has no replayable or failed outcome`);
}

/** Seal every requested sample, including explicit fetch/processing failures. */
export function createSourceDetailEvidenceBundle(sourceResults, expected) {
  if (!Array.isArray(sourceResults) || sourceResults.length === 0) {
    throw new SourceDetailEvidenceError('missing-evidence', 'source detail sample results are required');
  }
  const requestedSamples = requestedSampleCommitments(expected);
  if (sourceResults.length !== requestedSamples.length) {
    throw new SourceDetailEvidenceError('missing-evidence', 'source detail sample count does not match the request');
  }
  const seen = new Set();
  for (const [index, result] of sourceResults.entries()) {
    const crawlerKey = requiredString(result?.crawlerKey, `samples[${index}].crawlerKey`);
    const requestUrlSha256 = sha256(requiredString(result?.url, `samples[${index}].url`));
    const identity = `${crawlerKey}:${requestUrlSha256}`;
    if (seen.has(identity)) {
      throw new SourceDetailEvidenceError('duplicate-evidence', 'source detail results contain a duplicate identity');
    }
    seen.add(identity);
  }
  const samples = sourceResults.map((result, index) => sourceResultCommitment(result, requestedSamples[index], expected));
  const bundle = {
    format: SOURCE_DETAIL_EVIDENCE_BUNDLE_FORMAT,
    provenance: normalizedProvenance(expected?.provenance),
    versions: {
      extractor: requiredString(expected?.versions?.extractor, 'expected.versions.extractor'),
      normalizer: requiredString(expected?.versions?.normalizer, 'expected.versions.normalizer'),
    },
    requestedCount: requestedSamples.length,
    requestSha256: documentSha256(requestedSamples),
    replayableCount: samples.filter((sample) => sample.outcome === 'replayable').length,
    samplesSha256: documentSha256(samples),
    samples,
  };
  return { ...bundle, bundleSha256: documentSha256(bundle) };
}

/** Serializable fail-closed artifact when no trustworthy bundle can be made. */
export function createSourceDetailEvidenceFailureBundle({ requestedCount = 0, errorCode = 'bundle-failed' } = {}) {
  const failure = {
    format: SOURCE_DETAIL_EVIDENCE_FAILURE_FORMAT,
    status: 'invalid',
    requestedCount: Number.isInteger(requestedCount) && requestedCount >= 0 ? requestedCount : 0,
    errorCode: requiredString(errorCode, 'errorCode'),
  };
  return { ...failure, bundleSha256: documentSha256(failure) };
}

/** Validate and replay a complete evidence bundle. */
export function replaySourceDetailEvidenceBundle(bundle, expected) {
  if (!bundle || typeof bundle !== 'object') {
    throw new SourceDetailEvidenceError('missing-evidence', 'source detail evidence bundle is required');
  }
  if (bundle.format === SOURCE_DETAIL_EVIDENCE_FAILURE_FORMAT) {
    throw new SourceDetailEvidenceError('invalid-bundle', 'source detail evidence bundle was not created');
  }
  if (bundle.format !== SOURCE_DETAIL_EVIDENCE_BUNDLE_FORMAT) {
    throw new SourceDetailEvidenceError('version-mismatch', 'unsupported source detail evidence bundle format');
  }
  if (!Array.isArray(bundle.samples) || bundle.samples.length === 0
    || bundle.samples.length !== bundle.requestedCount) {
    throw new SourceDetailEvidenceError('missing-evidence', 'source detail evidence bundle sample count does not match');
  }
  requiredSha256(bundle.requestSha256, 'requestSha256');
  requiredSha256(bundle.samplesSha256, 'samplesSha256');
  requiredSha256(bundle.bundleSha256, 'bundleSha256');
  const { bundleSha256, ...unsignedBundle } = bundle;
  if (documentSha256(bundle.samples) !== bundle.samplesSha256
    || documentSha256(unsignedBundle) !== bundleSha256) {
    throw new SourceDetailEvidenceError('tampered-evidence', 'source detail evidence bundle digest does not match');
  }
  verifyExpectedContext({ provenance: bundle.provenance, versions: bundle.versions }, expected);
  const requestedSamples = requestedSampleCommitments(expected);
  if (requestedSamples.length !== bundle.requestedCount
    || documentSha256(requestedSamples) !== bundle.requestSha256) {
    throw new SourceDetailEvidenceError('request-mismatch', 'source detail evidence request manifest does not match');
  }
  const seen = new Set();
  const replayed = bundle.samples.map((sample, index) => {
    if (sample?.index !== index) {
      throw new SourceDetailEvidenceError('missing-evidence', 'source detail evidence sample order is incomplete');
    }
    requiredString(sample.crawlerKey, `samples[${index}].crawlerKey`);
    requiredSha256(sample.requestUrlSha256, `samples[${index}].requestUrlSha256`);
    requiredSha256(sample.sourceUrlSha256, `samples[${index}].sourceUrlSha256`);
    const expectedSample = requestedSamples[index];
    const identity = `${sample.crawlerKey}:${sample.requestUrlSha256}`;
    if (seen.has(identity)) {
      throw new SourceDetailEvidenceError('duplicate-evidence', 'source detail evidence bundle contains a duplicate identity');
    }
    seen.add(identity);
    if (sample.crawlerKey !== expectedSample.crawlerKey
      || sample.requestUrlSha256 !== expectedSample.requestUrlSha256) {
      throw new SourceDetailEvidenceError('request-mismatch', 'source detail evidence sample identity does not match the request');
    }
    if (sample.outcome === 'replayable') {
      const result = replaySourceDetailEvidence(sample.record, expected);
      if (result.crawlerKey !== sample.crawlerKey || sample.record.sourceUrlSha256 !== sample.sourceUrlSha256) {
        throw new SourceDetailEvidenceError('tampered-evidence', 'sample identity does not match its replayable record');
      }
      return result;
    }
    if (sample.outcome === 'fetch-failed') {
      return {
        crawlerKey: sample.crawlerKey,
        url: `sha256:${sample.sourceUrlSha256}`,
        fetchFailed: true,
        status: nonNegativeInteger(sample.status, `samples[${index}].status`),
        replayed: true,
        evidenceProvenance: bundle.provenance,
      };
    }
    if (sample.outcome === 'processing-failed') {
      if (sample.errorCode !== 'source-detail-processing-failed') {
        throw new SourceDetailEvidenceError('invalid-observation', 'source detail processing failure code is invalid');
      }
      return {
        crawlerKey: sample.crawlerKey,
        url: `sha256:${sample.sourceUrlSha256}`,
        processingFailed: true,
        processingError: 'SourceDetailEvidenceError: source-detail-processing-failed',
        replayed: true,
        evidenceProvenance: bundle.provenance,
      };
    }
    throw new SourceDetailEvidenceError('missing-evidence', `sample ${index} has no recognized outcome`);
  });
  const replayableCount = bundle.samples.filter((sample) => sample.outcome === 'replayable').length;
  if (nonNegativeInteger(bundle.replayableCount, 'replayableCount') !== replayableCount) {
    throw new SourceDetailEvidenceError('missing-evidence', 'source detail replayable count does not match');
  }
  return replayed;
}

function rejectedReplayResult(record, error) {
  const code = error instanceof SourceDetailEvidenceError ? error.code : 'replay-failed';
  return {
    crawlerKey: typeof record?.crawlerKey === 'string' ? record.crawlerKey : 'source-detail-replay',
    url: typeof record?.sourceUrlSha256 === 'string' ? `sha256:${record.sourceUrlSha256}` : 'sha256:missing',
    processingFailed: true,
    processingError: `SourceDetailEvidenceError: ${code}`,
  };
}

/**
 * Batch replay adapter for applySourceDetailResults(). A rejected record is a
 * processing failure (therefore CRITICAL), never an omitted or green sample.
 */
export function replaySourceDetailEvidenceBatch(records, expected) {
  if (!Array.isArray(records)) {
    return [rejectedReplayResult(null, new SourceDetailEvidenceError('missing-evidence', 'records are required'))];
  }
  return records.map((record) => {
    try {
      return replaySourceDetailEvidence(record, expected);
    } catch (error) {
      return rejectedReplayResult(record, error);
    }
  });
}

/** Fail-closed bundle adapter for applySourceDetailResults(). */
export function replaySourceDetailEvidenceBundleAsResults(bundle, expected) {
  try {
    return replaySourceDetailEvidenceBundle(bundle, expected);
  } catch (error) {
    return [rejectedReplayResult(null, error)];
  }
}
