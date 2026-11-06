import fs from 'node:fs';
import path from 'node:path';
import { DATA_ROOT } from './config.mjs';
import { setStatus, byStatus } from './candidate-store.mjs';

const FIRST_CRAWL_GRACE_HOURS = 48;

/**
 * Read the crawler's assembled public slice without treating an absent,
 * malformed, stale, or empty file as a successful first crawl.
 *
 * @param {{ dataRoot?: string, crawlerKey: string, promotedAt?: string }} options
 * @returns {{ status: string, assembledAt: string|null, jobCount: number, reason?: string }}
 */
export function readPublishedCrawlerOutput({ dataRoot = DATA_ROOT, crawlerKey, promotedAt }) {
  const key = String(crawlerKey || '').trim();
  if (!key || path.basename(key) !== key || !/^[a-z0-9_-]+$/i.test(key)) {
    return { status: 'invalid_key', assembledAt: null, jobCount: 0, reason: 'invalid_crawler_key' };
  }
  const file = path.join(dataRoot, 'jobs', 'by-crawler', `${key}.json`);
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return { status: 'missing', assembledAt: null, jobCount: 0 };
    return { status: 'unreadable', assembledAt: null, jobCount: 0, reason: 'read_error' };
  }
  let slice;
  try { slice = JSON.parse(text); } catch {
    return { status: 'malformed', assembledAt: null, jobCount: 0, reason: 'malformed_json' };
  }
  if (!slice || typeof slice !== 'object' || !Array.isArray(slice.jobs)) {
    return { status: 'malformed', assembledAt: null, jobCount: 0, reason: 'invalid_slice_shape' };
  }
  if (slice.crawlerKey && slice.crawlerKey !== key) {
    return { status: 'mismatched', assembledAt: null, jobCount: slice.jobs.length, reason: 'crawler_key_mismatch' };
  }
  if (slice.jobs.length === 0) {
    return { status: 'empty', assembledAt: String(slice.assembledAt || '') || null, jobCount: 0 };
  }
  const assembledAtMs = Date.parse(String(slice.assembledAt || ''));
  const promotedAtMs = Date.parse(String(promotedAt || ''));
  if (!Number.isFinite(assembledAtMs) || !Number.isFinite(promotedAtMs)) {
    return { status: 'unverifiable', assembledAt: String(slice.assembledAt || '') || null, jobCount: slice.jobs.length, reason: 'missing_timestamp' };
  }
  if (assembledAtMs < promotedAtMs) {
    return { status: 'stale', assembledAt: new Date(assembledAtMs).toISOString(), jobCount: slice.jobs.length };
  }
  return { status: 'published', assembledAt: new Date(assembledAtMs).toISOString(), jobCount: slice.jobs.length };
}

/**
 * Promote a merged crawler to `production` only after its fresh, non-empty
 * jobs slice is assembled. Missing output gets an explicit 48-hour escalation.
 *
 * @param {any} store
 * @param {{ dataRoot?: string, now?: number, graceHours?: number, ledgerFile?: string|null }} [options]
 * @returns {{ verified: number, pending: number, escalated: number, changed: number }}
 */
export function reconcileAwaitingFirstCrawls(store, options = {}) {
  const now = Number(options.now ?? Date.now());
  const graceHours = Number(options.graceHours ?? FIRST_CRAWL_GRACE_HOURS);
  let verified = 0;
  let pending = 0;
  let escalated = 0;
  let changed = 0;

  for (const candidate of byStatus(store, 'awaiting_first_crawl')) {
    const output = readPublishedCrawlerOutput({
      dataRoot: options.dataRoot || DATA_ROOT,
      crawlerKey: candidate.crawlerKey,
      promotedAt: candidate.promotedAt,
    });
    if (output.status === 'published') {
      const patch = {
        firstCrawlerOutputStatus: 'published',
        firstCrawlerOutputAttention: false,
        firstCrawlerOutputReason: null,
        firstCrawlerOutputAt: output.assembledAt,
        firstCrawlerJobCount: output.jobCount,
      };
      const needsUpdate = candidate.firstCrawlerOutputStatus !== patch.firstCrawlerOutputStatus
        || candidate.status !== 'production'
        || candidate.firstCrawlerOutputReason !== patch.firstCrawlerOutputReason
        || candidate.firstCrawlerOutputAt !== patch.firstCrawlerOutputAt
        || candidate.firstCrawlerJobCount !== patch.firstCrawlerJobCount;
      setStatus(store, candidate.key, 'production', patch, options.ledgerFile);
      if (needsUpdate) changed++;
      verified++;
      continue;
    }

    const promotedAtMs = Date.parse(String(candidate.promotedAt || ''));
    const ageMs = Number.isFinite(promotedAtMs) ? now - promotedAtMs : 0;
    const attention = ageMs >= graceHours * 3_600_000;
    const patch = {
      firstCrawlerOutputStatus: output.status,
      firstCrawlerOutputAttention: attention,
      firstCrawlerOutputReason: output.reason || null,
      firstCrawlerOutputAt: output.assembledAt,
      firstCrawlerJobCount: output.jobCount,
      ...(attention && !candidate.firstCrawlerOutputAttention
        ? { firstCrawlerOutputAttentionAt: new Date(now).toISOString() }
        : {}),
    };
    const needsUpdate = Object.keys(patch).some((key) => candidate[key] !== patch[key]);
    if (needsUpdate) {
      setStatus(store, candidate.key, 'awaiting_first_crawl', patch, options.ledgerFile);
      changed++;
    }
    if (attention) escalated++;
    else pending++;
  }

  return { verified, pending, escalated, changed };
}
