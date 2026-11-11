/** Keep only tracking rows the later self-heal pass could still emit. */
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
    const paths = tracking[slug];
    let hasUnclaimedEmittedPath = false;

    for (const locale of emittedLocales) {
      const relativePath = paths?.[locale];
      if (!relativePath || isPathClaimed(relativePath)) continue;
      hasUnclaimedEmittedPath = true;
      break;
    }

    if (hasUnclaimedEmittedPath) continue;
    delete tracking[slug];
    pruned += 1;
  }

  return { pruned, retained: visited - pruned };
}
