import { canonicalJson, digestDocument } from './canonical-json-digest.mjs';

export const CRAWLER_ROSTER_PATH = 'scripts/ci/crawler-generation-roster.json';
export const TRANSLATE_PENDING_ARTIFACT = 'translate-pending.yml';

const COMMIT_RE = /^[a-f0-9]{40}$/u;
const ARTIFACT_RE = /^crawler-group-(\d{2})\.ya?ml$/u;

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function compareCodePoint(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function exactKeys(value, keys) {
  return isRecord(value)
    && canonicalJson(Object.keys(value).sort(compareCodePoint))
      === canonicalJson([...keys].sort(compareCodePoint));
}

function validCount(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function normalizeArtifactFiles(artifactFiles) {
  if (!Array.isArray(artifactFiles)) throw new TypeError('crawler artifact files must be an array');
  const files = artifactFiles.map((file) => String(file ?? ''));
  if (new Set(files).size !== files.length) throw new TypeError('crawler artifact files must be unique');
  return files.sort(compareCodePoint);
}

export function crawlerArtifactFiles(groupCount) {
  if (!Number.isSafeInteger(groupCount) || groupCount < 1) {
    throw new TypeError(`crawler groupCount must be a positive safe integer, got ${JSON.stringify(groupCount)}`);
  }
  return [
    ...Array.from({ length: groupCount }, (_, index) => `crawler-group-${String(index + 1).padStart(2, '0')}.yml`),
    TRANSLATE_PENDING_ARTIFACT,
  ].sort(compareCodePoint);
}

export function deriveCrawlerRosterCardinality({ sourceCommit, roster } = {}) {
  if (!COMMIT_RE.test(String(sourceCommit ?? ''))) {
    throw new TypeError(`crawler roster sourceCommit must be a 40-character lowercase SHA, got ${JSON.stringify(sourceCommit)}`);
  }
  if (!isRecord(roster) || !isRecord(roster.groups)) {
    throw new TypeError('crawler roster groups must be a JSON object');
  }

  const groupIds = Object.keys(roster.groups).sort(compareCodePoint);
  if (!validCount(roster.groupCount) || roster.groupCount !== groupIds.length || groupIds.length < 1) {
    throw new TypeError('crawler roster groupCount disagrees with its groups');
  }
  const members = [];
  for (const group of groupIds) {
    if (!Array.isArray(roster.groups[group]) || roster.groups[group].some((crawlerId) => typeof crawlerId !== 'string')) {
      throw new TypeError(`crawler roster group ${group} is invalid`);
    }
    members.push(...roster.groups[group]);
  }
  if (new Set(members).size !== members.length) throw new TypeError('crawler roster contains duplicate crawlers');
  if (!validCount(roster.crawlerCount) || roster.crawlerCount !== members.length) {
    throw new TypeError('crawler roster crawlerCount disagrees with its groups');
  }

  const { digest, ...payload } = roster;
  if (typeof digest !== 'string' || digestDocument(payload) !== digest) {
    throw new TypeError('crawler roster digest is invalid');
  }

  return {
    sourceCommit: String(sourceCommit),
    groupCount: groupIds.length,
    artifactCount: crawlerArtifactFiles(groupIds.length).length,
    crawlerCount: members.length,
  };
}

export function buildCrawlerRosterCardinality({ sourceCommit, roster, artifactFiles } = {}) {
  const expected = deriveCrawlerRosterCardinality({ sourceCommit, roster });
  const actualFiles = normalizeArtifactFiles(artifactFiles);
  const expectedFiles = crawlerArtifactFiles(expected.groupCount);
  if (canonicalJson(actualFiles) !== canonicalJson(expectedFiles)) {
    throw new TypeError('crawler artifact files disagree with the source roster group count');
  }
  return { ...expected, artifactCount: actualFiles.length };
}

export function validateCrawlerRosterCardinalityDeclaration({
  declared,
  sourceCommit,
  groupCount,
  artifactCount,
  crawlerCount,
} = {}) {
  const errors = [];
  if (!exactKeys(declared, ['sourceCommit', 'groupCount', 'artifactCount', 'crawlerCount'])) {
    errors.push('invalid_crawler_roster_cardinality_shape');
    return { valid: false, errors };
  }
  if (!COMMIT_RE.test(String(sourceCommit ?? '')) || declared.sourceCommit !== sourceCommit) {
    errors.push('crawler_roster_cardinality_source_commit_mismatch');
  }
  for (const [key, expected] of Object.entries({ groupCount, artifactCount, crawlerCount })) {
    if (!validCount(expected) || declared[key] !== expected) {
      errors.push(`crawler_roster_cardinality_${key}_mismatch`);
    }
  }
  return { valid: errors.length === 0, errors };
}

export function validateCrawlerContractCardinality({ contract, sourceCommit, roster } = {}) {
  const errors = [];
  let expected;
  try {
    expected = deriveCrawlerRosterCardinality({ sourceCommit, roster });
  } catch (error) {
    return {
      valid: false,
      errors: ['source_crawler_roster_invalid'],
      error: error instanceof Error ? error.message : String(error),
    };
  }

  const declared = validateCrawlerRosterCardinalityDeclaration({
    declared: contract?.crawlerRosterCardinality,
    sourceCommit,
    groupCount: expected.groupCount,
    artifactCount: expected.artifactCount,
    crawlerCount: expected.crawlerCount,
  });
  errors.push(...declared.errors);

  for (const [key, value] of Object.entries(expected)) {
    if (contract?.[key] !== value) errors.push(`crawler_contract_${key}_mismatch`);
  }
  if (contract?.crawlerGeneration?.rosterPath !== CRAWLER_ROSTER_PATH) {
    errors.push('crawler_roster_path_mismatch');
  }
  if (contract?.crawlerGeneration?.rosterDigest !== roster?.digest) {
    errors.push('crawler_roster_digest_mismatch');
  }

  const expectedFiles = crawlerArtifactFiles(expected.groupCount);
  const declaredFiles = Array.isArray(contract?.artifacts)
    ? normalizeArtifactFiles(contract.artifacts.map((artifact) => artifact?.file))
    : [];
  if (canonicalJson(declaredFiles) !== canonicalJson(expectedFiles)) {
    errors.push('crawler_artifact_set_mismatch');
  }

  const groupArtifacts = Array.isArray(contract?.artifacts)
    ? contract.artifacts.filter((artifact) => ARTIFACT_RE.test(String(artifact?.file ?? '')))
    : [];
  const members = [];
  for (const artifact of groupArtifacts) {
    if (!Array.isArray(artifact.members) || artifact.members.some((crawlerId) => typeof crawlerId !== 'string')) {
      errors.push('crawler_artifact_members_invalid');
      continue;
    }
    members.push(...artifact.members);
  }
  if (members.length !== expected.crawlerCount) errors.push('crawler_artifact_crawler_count_mismatch');
  if (new Set(members).size !== members.length) errors.push('crawler_artifact_duplicate_crawler');

  return { valid: errors.length === 0, errors: [...new Set(errors)], expected };
}
