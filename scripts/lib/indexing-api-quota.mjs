/** Shared Google Indexing API quota contract. */
import fs from 'node:fs';
import { positiveIntFromEnv } from './int-from-env.mjs';

/**
 * Publish requests per day that Google actually grants this GCP project.
 *
 * 2,000 (#16092, 2026-10-31) was the quota REQUESTED, never the one granted:
 * from 2026-11-03 every daily run stopped on 429 "Quota exceeded for quota
 * metric 'Publish requests' ... per day" after ~200 publishes (run
 * 41673225264: 207; run 42678323947: 211). Google's default is 200/day.
 * Override with INDEXING_API_DAILY_QUOTA once a higher quota is approved in
 * the Cloud console — the ledger counter, the run budgets and the article
 * publisher all read this one value.
 */
export const DEFAULT_DAILY_QUOTA = 200;
export const DAILY_BUDGET = positiveIntFromEnv('INDEXING_API_DAILY_QUOTA', DEFAULT_DAILY_QUOTA);
export const DEFAULT_INDEXING_LEDGER = '/tmp/indexing-api-jobs-ledger.json';

/**
 * Replace the ledger file atomically: a failed write throws and leaves the
 * previous state on disk, so a full disk cannot truncate the shared counter.
 */
export function writeLedgerFile(ledgerPath, ledger) {
  const tmpPath = `${ledgerPath}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmpPath, JSON.stringify(ledger));
    fs.renameSync(tmpPath, ledgerPath);
  } catch (err) {
    try { fs.rmSync(tmpPath, { force: true }); } catch { /* the write error matters more */ }
    throw err;
  }
}
