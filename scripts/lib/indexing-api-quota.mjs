/** Shared Google Indexing API quota contract. */
import fs from 'node:fs';

export const DAILY_BUDGET = 2_000;
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
