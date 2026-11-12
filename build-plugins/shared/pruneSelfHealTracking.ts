/** Keep only tracking rows the later self-heal pass could still emit. */
export function isSelfHealTrackingRowPrunable<TPaths extends Readonly<Record<string, string | undefined>>>(
  paths: TPaths | undefined,
  emittedLocales: readonly string[],
  isPathClaimed: (relativePath: string) => boolean,
): boolean {
  for (const locale of emittedLocales) {
    const relativePath = paths?.[locale];
    if (relativePath && !isPathClaimed(relativePath)) return false;
  }
  return true;
}

/** Drop one row once every path owned by this build shard is already claimed. */
export function pruneSelfHealTrackingRow<TPaths extends Readonly<Record<string, string | undefined>>>(
  tracking: Record<string, TPaths>,
  slug: string,
  emittedLocales: readonly string[],
  isPathClaimed: (relativePath: string) => boolean,
): boolean {
  if (!Object.prototype.hasOwnProperty.call(tracking, slug)) return false;
  if (!isSelfHealTrackingRowPrunable(tracking[slug], emittedLocales, isPathClaimed)) return false;
  delete tracking[slug];
  return true;
}

export function pruneSelfHealTracking<TPaths extends Readonly<Record<string, string | undefined>>>(
  tracking: Record<string, TPaths>,
  emittedLocales: readonly string[],
  isPathClaimed: (relativePath: string) => boolean,
): { pruned: number; retained: number } {
  let visited = 0;
  let pruned = 0;

  for (const slug in tracking) {
    if (!Object.prototype.hasOwnProperty.call(tracking, slug)) continue;
    visited += 1;
    if (pruneSelfHealTrackingRow(tracking, slug, emittedLocales, isPathClaimed)) pruned += 1;
  }

  return { pruned, retained: visited - pruned };
}
