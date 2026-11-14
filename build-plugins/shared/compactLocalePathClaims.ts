/**
 * Exact route claims with compact storage.
 *
 * The old Set stored the complete `section/slug` string for every route. A
 * deploy can claim millions of routes while the expired archive is emitted;
 * storing a shared prefix and an interned leaf keeps the same exact
 * membership semantics without copying the prefix into every Set entry.
 */
export class CompactLocalePathClaims {
  private readonly leafIds = new Map<string, number>();
  private readonly idsByPrefix = new Map<string, Set<number>>();
  private claimedCount = 0;
  private nextLeafId = 1;

  get size(): number {
    return this.claimedCount;
  }

  claim(path: string): boolean {
    const { prefix, leaf } = splitClaimPath(path);
    const leafId = this.internLeaf(leaf);
    let ids = this.idsByPrefix.get(prefix);
    if (!ids) {
      ids = new Set<number>();
      this.idsByPrefix.set(prefix, ids);
    }
    if (ids.has(leafId)) return false;
    ids.add(leafId);
    this.claimedCount++;
    return true;
  }

  has(path: string): boolean {
    const { prefix, leaf } = splitClaimPath(path);
    const leafId = this.leafIds.get(leaf);
    return leafId !== undefined && this.idsByPrefix.get(prefix)?.has(leafId) === true;
  }

  clear(): void {
    this.idsByPrefix.clear();
    this.leafIds.clear();
    this.claimedCount = 0;
    this.nextLeafId = 1;
  }

  private internLeaf(leaf: string): number {
    const existing = this.leafIds.get(leaf);
    if (existing !== undefined) return existing;
    const id = this.nextLeafId++;
    this.leafIds.set(leaf, id);
    return id;
  }
}

function splitClaimPath(path: string): { prefix: string; leaf: string } {
  const normalized = String(path ?? '').replace(/^\/+|\/+$/g, '');
  const slash = normalized.lastIndexOf('/');
  if (slash < 0) return { prefix: '', leaf: normalized };
  return {
    prefix: normalized.slice(0, slash),
    leaf: normalized.slice(slash + 1),
  };
}
