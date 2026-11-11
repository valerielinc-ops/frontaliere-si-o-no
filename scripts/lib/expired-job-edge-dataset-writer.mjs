import fs from 'node:fs';
import path from 'node:path';
import {
  EXPIRED_JOB_EDGE_DATASET_PREFIX,
  EXPIRED_JOB_EDGE_SCHEMA_VERSION,
  EXPIRED_JOB_EDGE_SHARD_COUNT,
  expiredJobEdgeShardId,
  normalizeExpiredJobEdgePath,
  parseExpiredJobEdgeSections,
} from './expired-job-edge-dataset.mjs';

const SHARD_BUFFER_LIMIT = 128 * 1024;
const SECTION_RE = /^[a-z][a-z0-9-]*$/;
const GENERATION_RE = /^[a-zA-Z0-9._-]{1,80}$/;
const LOCALE_RE = /^(it|en|de|fr)$/;

/** Stream compact page records into hash shards with bounded build memory. */
export function createExpiredJobEdgeDatasetWriter({
  distDir,
  locale,
  generation,
  template,
  adSnippetHtml = '',
  coverage = {},
  requestedSections = [],
}) {
  if (!LOCALE_RE.test(locale)) throw new TypeError(`Unsupported expired-job edge locale: ${locale}`);
  if (!GENERATION_RE.test(generation)) throw new TypeError('Invalid expired-job edge generation');
  if (typeof template !== 'string' || !template.includes('__FT_EDGE_BODY__')) {
    throw new TypeError('Expired-job edge template is missing its body slot');
  }
  if (typeof adSnippetHtml !== 'string') throw new TypeError('Expired-job edge AdSense snippet must be a string');

  const localeDir = path.join(distDir, EXPIRED_JOB_EDGE_DATASET_PREFIX.slice(1), locale);
  const generationDir = path.join(localeDir, generation);
  fs.rmSync(generationDir, { recursive: true, force: true });
  fs.mkdirSync(generationDir, { recursive: true });

  const shards = new Map();
  const sectionCounts = new Map();
  let pageCount = 0;
  let finished = false;

  const flush = (shard) => {
    if (!shard.buffer) return;
    fs.appendFileSync(shard.filePath, shard.buffer, 'utf8');
    shard.buffer = '';
    shard.bufferBytes = 0;
  };

  return {
    addPage(canonicalPath, section, page) {
      if (finished) throw new Error('Expired-job edge dataset writer is already finished');
      const pathname = normalizeExpiredJobEdgePath(canonicalPath);
      if (!pathname || pathname === '/' || typeof section !== 'string' || !SECTION_RE.test(section)) return false;
      if (!page || typeof page !== 'object' || Array.isArray(page)) return false;
      const shardId = expiredJobEdgeShardId(pathname);
      if (!shardId) return false;

      let shard = shards.get(shardId);
      if (!shard) {
        const filePath = path.join(generationDir, `${shardId}.json`);
        const prefix = `{"version":${EXPIRED_JOB_EDGE_SCHEMA_VERSION},"locale":${JSON.stringify(locale)},`
          + `"generation":${JSON.stringify(generation)},"shardId":${JSON.stringify(shardId)},`
          + '"coverage":{"complete":true},"pages":{';
        fs.writeFileSync(filePath, prefix, 'utf8');
        shard = { filePath, count: 0, buffer: '', bufferBytes: 0 };
        shards.set(shardId, shard);
      }

      const entry = `${shard.count ? ',' : ''}${JSON.stringify(pathname)}:${JSON.stringify(page)}`;
      shard.buffer += entry;
      shard.bufferBytes += Buffer.byteLength(entry);
      shard.count += 1;
      pageCount += 1;
      sectionCounts.set(section, (sectionCounts.get(section) ?? 0) + 1);
      if (shard.bufferBytes >= SHARD_BUFFER_LIMIT) flush(shard);
      return true;
    },

    finish() {
      if (finished) throw new Error('Expired-job edge dataset writer is already finished');
      finished = true;
      for (const shard of shards.values()) {
        flush(shard);
        fs.appendFileSync(shard.filePath, '}}', 'utf8');
      }

      const availableSections = [...sectionCounts.keys()].sort();
      const requested = new Set(parseExpiredJobEdgeSections(requestedSections.join(',')));
      const activeSections = coverage.complete === true
        ? availableSections.filter((section) => requested.has(section))
        : [];
      const shardIds = [...shards.keys()].sort();
      const manifest = {
        version: EXPIRED_JOB_EDGE_SCHEMA_VERSION,
        locale,
        generation,
        datasetPrefix: EXPIRED_JOB_EDGE_DATASET_PREFIX,
        shardCount: EXPIRED_JOB_EDGE_SHARD_COUNT,
        shardIds,
        pageCount,
        availableSections,
        activeSections,
        coverage: { ...coverage, complete: coverage.complete === true },
        template,
        adSnippetHtml,
      };
      const manifestPath = path.join(localeDir, 'manifest.json');
      fs.writeFileSync(manifestPath, `${JSON.stringify(manifest)}\n`, 'utf8');
      return { manifestPath, manifest, generationDir };
    },
  };
}
