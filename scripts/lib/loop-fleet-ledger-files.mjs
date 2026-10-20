import fs from 'node:fs';
import path from 'node:path';

/**
 * The durable ledger keeps the historical canonical files readable while new
 * appends land in bounded per-run shards. Readers must therefore consume the
 * canonical file and every valid shard for the same record type.
 */
export const LOOP_FLEET_LEDGER_FILES = Object.freeze({
  observation: 'loop-observations.jsonl',
  decision: 'loop-decisions.jsonl',
  health: 'loop-health-history.jsonl',
  lifecycle: 'lifecycle-events.jsonl',
});

const CANONICAL_NAMES = Object.freeze(Object.values(LOOP_FLEET_LEDGER_FILES));
const SHARD_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/u;

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function canonicalName(value) {
  const name = path.basename(String(value ?? ''));
  if (CANONICAL_NAMES.includes(name)) return name;
  for (const candidate of CANONICAL_NAMES) {
    const stem = candidate.slice(0, -'.jsonl'.length);
    if (new RegExp(`^${escapeRegExp(stem)}-[A-Za-z0-9][A-Za-z0-9_-]*\\.jsonl$`, 'u').test(name)) {
      return candidate;
    }
  }
  return null;
}

export function ledgerShardName(fileName, shardId = null) {
  const canonical = canonicalName(fileName);
  if (!canonical) throw new Error(`unknown loop-fleet ledger file: ${fileName}`);
  const value = String(shardId ?? '').trim();
  if (!value) return canonical;
  if (!SHARD_ID_RE.test(value)) throw new Error(`invalid loop-fleet ledger shard id: ${shardId}`);
  return `${canonical.slice(0, -'.jsonl'.length)}-${value}.jsonl`;
}

export function canonicalLedgerFileName(fileName) {
  return canonicalName(fileName);
}

/** Return the canonical file plus all bounded shards for one record type. */
export function listLoopFleetLedgerFiles(ledgerDir, fileName) {
  const canonical = canonicalName(fileName);
  if (!canonical) throw new Error(`unknown loop-fleet ledger file: ${fileName}`);
  const root = path.resolve(ledgerDir);
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) return [];
  const stem = canonical.slice(0, -'.jsonl'.length);
  const pattern = new RegExp(`^${escapeRegExp(stem)}(?:-[A-Za-z0-9][A-Za-z0-9_-]*)?\\.jsonl$`, 'u');
  return fs.readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isFile() && pattern.test(entry.name))
    .map((entry) => path.join(root, entry.name))
    .sort((left, right) => {
      const leftCanonical = path.basename(left) === canonical;
      const rightCanonical = path.basename(right) === canonical;
      if (leftCanonical !== rightCanonical) return leftCanonical ? -1 : 1;
      return left.localeCompare(right);
    });
}

/** Resolve a canonical path or a ledger directory to all matching files. */
export function resolveLoopFleetLedgerFiles(inputPath, fileName = null) {
  const absolute = path.resolve(inputPath);
  const canonical = canonicalName(fileName || path.basename(absolute));
  if (!canonical) return fs.existsSync(absolute) ? [absolute] : [];
  return listLoopFleetLedgerFiles(fs.existsSync(absolute) && fs.statSync(absolute).isDirectory()
    ? absolute
    : path.dirname(absolute), canonical);
}
