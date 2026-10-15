const CRAWLER_GROUP_ID_RE = /^(?:0[1-9]|[1-9][0-9])$/u;

function compareCodePoint(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function isCrawlerGroupId(value) {
  return typeof value === 'string' && CRAWLER_GROUP_ID_RE.test(value);
}

export function createCrawlerGroupIds(count) {
  if (!Number.isInteger(count) || count < 1 || count > 99) {
    throw new TypeError('Crawler group count must be an integer from 1 to 99');
  }
  return Object.freeze(Array.from(
    { length: count },
    (_, index) => String(index + 1).padStart(2, '0'),
  ));
}

export function normalizeCrawlerGroupIds(value) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new TypeError('Crawler group IDs must be a non-empty array');
  }
  if (value.some((group) => !isCrawlerGroupId(group))) {
    throw new TypeError('Crawler group IDs must be two-digit positive IDs');
  }
  const sorted = [...value].sort(compareCodePoint);
  if (new Set(sorted).size !== sorted.length) {
    throw new TypeError('Crawler group IDs must be unique');
  }
  const expected = createCrawlerGroupIds(sorted.length);
  if (JSON.stringify(sorted) !== JSON.stringify(expected)) {
    throw new TypeError('Crawler group IDs must be a complete sequence starting at 01');
  }
  return expected;
}

export function deriveCrawlerGroupIdsFromGroups(groups) {
  if (!groups || typeof groups !== 'object' || Array.isArray(groups)) {
    throw new TypeError('Crawler group map is invalid');
  }
  return normalizeCrawlerGroupIds(Object.keys(groups));
}

export function deriveCrawlerGroupIdsFromArtifactFiles(files) {
  if (!Array.isArray(files)) throw new TypeError('Crawler artifact list is invalid');
  const groups = files.flatMap((entry) => {
    const file = typeof entry === 'string' ? entry : entry?.file;
    const match = /^crawler-group-(\d{2})\.yml$/u.exec(file ?? '');
    return match ? [match[1]] : [];
  });
  return normalizeCrawlerGroupIds(groups);
}

export function deriveCrawlerGroupIdsFromContract(contract) {
  if (!contract || typeof contract !== 'object' || Array.isArray(contract)) {
    throw new TypeError('Crawler generation contract is invalid');
  }
  const groupIds = deriveCrawlerGroupIdsFromArtifactFiles(contract.artifacts);
  if (contract.groupCount !== groupIds.length) {
    throw new TypeError('Crawler generation contract group count is inconsistent');
  }
  return groupIds;
}
