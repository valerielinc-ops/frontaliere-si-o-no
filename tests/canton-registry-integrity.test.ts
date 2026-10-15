import { describe, expect, it } from 'vitest';

import cantonSlugFile from '../data/canton-url-slugs.json';
import { CANTON_SHARD_KEYS } from '../services/jobCantonShards';
import { resolveCantonGroup, expandCantonGroup, CANTON_CODES } from '../services/cantonList';

/**
 * Integrity of `data/canton-url-slugs.json` as a REGISTRY, not as a code path.
 *
 * PR #5336 shipped per-canton job shards named after this file's canton keys,
 * and #5342 consolidated the member→group inversion so the shard layer and the
 * URL layer can no longer disagree in CODE. Both fixed the same 404 class —
 * a bridge fetching `BS-it.json`, a file the URL layer never emits — from the
 * code side.
 *
 * This file closes it from the DATA side. `resolveCantonGroup` is only as
 * correct as the table it reads: a hand-edit that adds a `cantonGroups` key
 * absent from `cantons`, or drops a canton, makes it return a key that
 * `CANTON_SHARD_KEYS` does not contain — no shard file, 404, live indexed job
 * on JobOrphanView, with every unit test still green because the code is fine.
 *
 * Cheap invariants, checked against the real file. They are what makes the
 * dedup in #5342 safe to rely on.
 */

interface CantonUrlSlugsShape {
  cantons: Record<string, unknown>;
  cantonGroups?: Record<string, { members?: readonly string[] }>;
}
const RAW = cantonSlugFile as unknown as CantonUrlSlugsShape;

describe('canton URL-slug registry integrity', () => {
  it('every cantonGroups key is itself a canton key (else it resolves to a shard that is never emitted)', () => {
    const cantonKeys = new Set(Object.keys(RAW.cantons));
    const orphans = Object.keys(RAW.cantonGroups ?? {}).filter((k) => !cantonKeys.has(k));
    expect(orphans, `group keys missing from "cantons": ${orphans.join(', ')}`).toEqual([]);
  });

  it('group MEMBERS are never canton keys themselves (they are merged away, not addressable)', () => {
    // If `BS` were both a member of BASILEA and its own `cantons` entry, the
    // URL layer and the shard layer would each have a defensible-but-different
    // answer for where a Basel job lives.
    const cantonKeys = new Set(Object.keys(RAW.cantons));
    const leaked: string[] = [];
    for (const [group, def] of Object.entries(RAW.cantonGroups ?? {})) {
      for (const m of def?.members ?? []) {
        if (cantonKeys.has(String(m).toUpperCase())) leaked.push(`${m} (member of ${group})`);
      }
    }
    expect(leaked, `members that are also canton keys: ${leaked.join(', ')}`).toEqual([]);
  });

  it('THE guard: every real BFS canton resolves to a key that has a shard file', () => {
    // The end-to-end property, independent of how many resolvers exist or which
    // one a caller reaches for. All 26 cantons — including the four half-cantons
    // that have no shard of their own — must land on an emitted key.
    expect(CANTON_CODES.length).toBe(26);
    const shardKeys = new Set(CANTON_SHARD_KEYS);
    for (const code of CANTON_CODES) {
      const key = resolveCantonGroup(code);
      expect(shardKeys.has(key), `${code} → "${key}", which has no shard file`).toBe(true);
    }
  });

  it('resolveCantonGroup and expandCantonGroup are mutual inverses across the registry', () => {
    // expand(resolve(x)) must contain x, for every real canton.
    for (const code of CANTON_CODES) {
      expect(expandCantonGroup(resolveCantonGroup(code)), `round-trip lost ${code}`).toContain(code);
    }
    // …and resolve(expand(k)) collapses back onto k, for every shard key.
    for (const key of CANTON_SHARD_KEYS) {
      for (const member of expandCantonGroup(key)) {
        expect(resolveCantonGroup(member), `${member} does not collapse back to ${key}`).toBe(key);
      }
    }
  });

  it('the shard key set is exactly the registry canton set, uppercased', () => {
    // Honest about its own strength: both sides derive from the same JSON, so
    // this cannot catch a bad registry — the assertions above do that. What it
    // pins is CANTON_SHARD_KEYS' DERIVATION: that it still reads this file,
    // still uppercases, and still takes the keys rather than the members. Drop
    // the `.toUpperCase()` in jobCantonShards and this is the test that fails.
    expect([...CANTON_SHARD_KEYS].sort()).toEqual(
      Object.keys(RAW.cantons).map((k) => k.toUpperCase()).sort(),
    );
    expect(CANTON_SHARD_KEYS.every((k) => k === k.toUpperCase())).toBe(true);
  });

  // The parity of functions/src/lib/cantonUrlSlugs.json (the Cloud Functions
  // copy of this registry) is NOT asserted here on purpose:
  // tests/canton-url-slugs-parity.test.ts already locks the two files together
  // and covers `aggregate` as well, and that file is named in the `_syncNote`
  // of the duplicate itself. A second, weaker copy of that assertion would be
  // exactly the duplication the shard work spent two PRs removing.

  it('exercises the sentinel and unknown-code branches, which CANTON_CODES never reaches', () => {
    // CANTON_CODES holds only the 26 real BFS codes, so every assertion above
    // walks the happy path. These two inputs are the ones real callers pass
    // that are NOT cantons: `getDefaultCantonForVisit()` returns the aggregate
    // sentinel, and a slug map entry can carry a stale/garbage canton. Both
    // must round-trip untouched rather than resolve to some arbitrary key —
    // the shard fetch's own 404 handling is what covers them downstream.
    expect(resolveCantonGroup('_AGGREGATE_')).toBe('_AGGREGATE_');
    expect(CANTON_SHARD_KEYS).not.toContain('_AGGREGATE_');
    expect(resolveCantonGroup('ZZ')).toBe('ZZ');
    expect(resolveCantonGroup('')).toBe('');
    expect(expandCantonGroup('_AGGREGATE_')).toEqual(['_AGGREGATE_']);
    expect(expandCantonGroup('')).toEqual([]);
  });
});
