import { buildAssembledJobIdentity, buildStableJobIdentity } from './job-identity.mjs';
import { identityUrlKey } from './job-url-key.mjs';
import { isTargetCanton } from './target-swiss-locations.mjs';

const own = Object.prototype.hasOwnProperty;

function normalizedCanton(value) {
  const canton = String(value || '').trim().toUpperCase();
  return isTargetCanton(canton) ? canton : '';
}

function hasHash(url) {
  try {
    return new URL(url).hash !== '';
  } catch {
    return String(url || '').includes('#');
  }
}

/**
 * Match a persisted pin key from the pre-fragment identity contract.
 *
 * `identityUrlKey()` strips a hash, so it cannot be used blindly here: a
 * freshly migrated `url:...#job.id=...` key would otherwise look like the
 * legacy shared key and be deleted during the same pass. Hash-bearing keys
 * are therefore matched only when they are an exact stable identity (for
 * hash-aware identity families such as Johdi Suite).
 */
function isLegacyKeyFor(stableKey, ledgerKey) {
  if (stableKey === ledgerKey) return true;
  if (!stableKey.startsWith('url:') || !ledgerKey.startsWith('url:')) return false;

  const rawLedgerUrl = ledgerKey.slice('url:'.length);
  if (hasHash(rawLedgerUrl)) return false;
  const normalized = identityUrlKey(rawLedgerUrl);
  return normalized ? `url:${normalized}` === stableKey : false;
}

/**
 * Re-key canton pins written before assembled identities retained URL
 * fragments.
 *
 * The old stable identity intentionally stripped fragments, so a portal such
 * as Galenica stored all requisitions under one shared key. The assembled
 * identity now preserves those fragments. Before the new key is looked up,
 * split every safely-resolvable legacy group into deterministic fragment keys
 * carrying the current job canton, then remove the shared key. Incomplete or
 * conflicting groups are left untouched so a migration cannot silently lose
 * the only known route pin.
 *
 * Mutates `ledger` in place and returns counters for caller logging.
 *
 * @param {Record<string, string>} ledger
 * @param {Array<Record<string, any>>} jobs
 * @returns {{legacyKeysRemoved: number, fragmentPinsWritten: number, skippedGroups: number}}
 */
export function migrateLegacyCantonPins(ledger, jobs = []) {
  if (!ledger || typeof ledger !== 'object' || Array.isArray(ledger)) {
    return { legacyKeysRemoved: 0, fragmentPinsWritten: 0, skippedGroups: 0 };
  }

  const groups = new Map();
  for (const job of Array.isArray(jobs) ? jobs : []) {
    const stableKey = buildStableJobIdentity(job);
    const assembledKey = buildAssembledJobIdentity(job);
    if (!stableKey || !assembledKey || stableKey === assembledKey) continue;

    let group = groups.get(stableKey);
    if (!group) {
      group = { candidates: new Map(), unresolved: false };
      groups.set(stableKey, group);
    }

    const canton = normalizedCanton(job?.canton);
    if (!canton) {
      group.unresolved = true;
      continue;
    }

    const prior = group.candidates.get(assembledKey);
    if (prior && prior !== canton) {
      group.unresolved = true;
      continue;
    }
    group.candidates.set(assembledKey, canton);
  }

  let legacyKeysRemoved = 0;
  let fragmentPinsWritten = 0;
  let skippedGroups = 0;

  for (const [stableKey, group] of groups) {
    const legacyKeys = Object.keys(ledger).filter((key) => isLegacyKeyFor(stableKey, key));
    if (legacyKeys.length === 0) continue;

    if (group.unresolved || group.candidates.size === 0) {
      skippedGroups++;
      continue;
    }

    const orderedCandidates = [...group.candidates.entries()].sort(([a], [b]) => a.localeCompare(b));
    for (const [assembledKey, canton] of orderedCandidates) {
      if (ledger[assembledKey] !== canton) {
        ledger[assembledKey] = canton;
        fragmentPinsWritten++;
      }
    }

    for (const legacyKey of legacyKeys) {
      if (own.call(ledger, legacyKey)) {
        delete ledger[legacyKey];
        legacyKeysRemoved++;
      }
    }
  }

  return { legacyKeysRemoved, fragmentPinsWritten, skippedGroups };
}
