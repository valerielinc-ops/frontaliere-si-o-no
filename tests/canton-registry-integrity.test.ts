import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

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

  it('the shard key set is exactly the registry canton set', () => {
    expect([...CANTON_SHARD_KEYS].sort()).toEqual(
      Object.keys(RAW.cantons).map((k) => k.toUpperCase()).sort(),
    );
  });

  it('the Cloud Functions copy of the registry has not drifted', () => {
    // functions/src/lib/cantonUrlSlugs.json is a second physical copy (Cloud
    // Functions cannot import from data/). Nothing automated syncs it, so the
    // only thing standing between the two is this assertion: a drift would let
    // a function emit a canton URL the SPA has no shard for.
    const fnPath = path.resolve(__dirname, '..', 'functions/src/lib/cantonUrlSlugs.json');
    const fn = JSON.parse(fs.readFileSync(fnPath, 'utf-8')) as CantonUrlSlugsShape;
    expect(Object.keys(fn.cantons).sort()).toEqual(Object.keys(RAW.cantons).sort());
    expect(fn.cantonGroups ?? {}).toEqual(RAW.cantonGroups ?? {});
  });
});
