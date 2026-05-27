import fs from 'node:fs';
import path from 'node:path';

export const CRAWLER_SUMMARY_DATA_RELATIVE_PATH = 'data/jobs-crawler-summaries.json';
export const LEGACY_PUBLIC_CRAWLER_SUMMARY_RELATIVE_PATH = 'public/data/jobs-crawler-summaries.json';

const MERGE_CONFLICT_MARKER_PATTERN = /^(<<<<<<<|=======|>>>>>>>)|(?:\n<<<<<<<|\n=======|\n>>>>>>>)/m;

export function createEmptyCrawlerSummaryStore() {
  return {
    updatedAt: null,
    summaries: [],
  };
}

export function resolveCrawlerSummaryStorePath(root = process.cwd()) {
  return path.resolve(root, CRAWLER_SUMMARY_DATA_RELATIVE_PATH);
}

export function resolveLegacyPublicCrawlerSummaryPath(root = process.cwd()) {
  return path.resolve(root, LEGACY_PUBLIC_CRAWLER_SUMMARY_RELATIVE_PATH);
}

export function containsMergeConflictMarkers(text) {
  return typeof text === 'string' && MERGE_CONFLICT_MARKER_PATTERN.test(text);
}

function assertPlainObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object`);
  }
}

export function validateCrawlerSummaryStore(payload, label = 'crawler summary store') {
  assertPlainObject(payload, label);

  if (!(payload.updatedAt === null || typeof payload.updatedAt === 'string')) {
    throw new Error(`${label}.updatedAt must be a string or null`);
  }

  if (!Array.isArray(payload.summaries)) {
    throw new Error(`${label}.summaries must be an array`);
  }

  payload.summaries.forEach((summary, index) => {
    const entryLabel = `${label}.summaries[${index}]`;
    assertPlainObject(summary, entryLabel);

    if (typeof summary.key !== 'string' || !summary.key.trim()) {
      throw new Error(`${entryLabel}.key must be a non-empty string`);
    }

    if (!(summary.generatedAt === undefined || summary.generatedAt === null || typeof summary.generatedAt === 'string')) {
      throw new Error(`${entryLabel}.generatedAt must be a string when present`);
    }

    for (const collectionKey of ['newJobs', 'updatedJobs', 'removedJobs', 'unchangedJobs']) {
      if (!(summary[collectionKey] === undefined || Array.isArray(summary[collectionKey]))) {
        throw new Error(`${entryLabel}.${collectionKey} must be an array when present`);
      }
    }
  });

  return payload;
}

export function parseCrawlerSummaryStoreText(text, label = 'crawler summary store') {
  if (containsMergeConflictMarkers(text)) {
    throw new Error(`${label} contains Git merge conflict markers`);
  }

  let payload;
  try {
    payload = JSON.parse(text);
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error.message}`);
  }

  return validateCrawlerSummaryStore(payload, label);
}

export function readCrawlerSummaryStore(filePath, { allowMissing = false } = {}) {
  if (!fs.existsSync(filePath)) {
    if (allowMissing) return createEmptyCrawlerSummaryStore();
    throw new Error(`${filePath} does not exist`);
  }

  const text = fs.readFileSync(filePath, 'utf8');
  return parseCrawlerSummaryStoreText(text, filePath);
}

export function writeCrawlerSummaryStore(filePath, payload) {
  const validatedPayload = validateCrawlerSummaryStore(payload, filePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(validatedPayload, null, 2)}\n`, 'utf8');
}

export function ensureLegacyPublicCrawlerSummaryCopyAbsent(root = process.cwd()) {
  const legacyPath = resolveLegacyPublicCrawlerSummaryPath(root);
  if (fs.existsSync(legacyPath)) {
    throw new Error(
      `Legacy public crawler summary copy must not exist anymore: ${LEGACY_PUBLIC_CRAWLER_SUMMARY_RELATIVE_PATH}`
    );
  }
}
