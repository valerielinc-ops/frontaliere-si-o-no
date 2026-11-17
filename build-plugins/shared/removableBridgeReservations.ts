import { explainUnsafeDistPath, getSafeDistPageTargets } from './distPathSafety';

export const MAX_UNSAFE_REMOVABLE_BRIDGE_SKIPS = 2000;

export interface RemovableBridgeCandidate {
  path: string;
  locale: string;
  kind: string;
}

export interface RemovableBridgeReservation {
  path: string;
  directoryPath: string;
}

export interface UnsafeRemovableBridgeSkip {
  path: string;
  locale: string;
  kind: string;
  reasons: string[];
}

export interface RemovableBridgeReservationPlan {
  reservations: RemovableBridgeReservation[];
  skipped: UnsafeRemovableBridgeSkip[];
  removableCountsByLocale: Map<string, number>;
  removableCountsByKind: Map<string, number>;
  emittedRemovableCount: number;
}

/**
 * A removable bridge is served as a Worker 301 and emits no file. If its
 * directory-only dist target is unsafe, every dist writer applies the same
 * path preflight and cannot emit there either, so reserving it has no effect.
 * Builds 44062717920 and 44084800725 failed late on this case; #19217 fixed
 * the optional flat twin and #19224 fixed a retained 251-byte alias. The
 * count and 2% valve below still fails the build if unsafe removals become
 * systemic instead of letting a single unaddressable Worker path abort it.
 */
export function planRemovableBridgeReservations({
  distDir,
  bridges,
  removable,
  shouldEmitLocale,
}: {
  distDir: string;
  bridges: readonly RemovableBridgeCandidate[];
  removable: ReadonlySet<string>;
  shouldEmitLocale: (locale: string) => boolean;
}): RemovableBridgeReservationPlan {
  const reservations: RemovableBridgeReservation[] = [];
  const skipped: UnsafeRemovableBridgeSkip[] = [];
  const removableCountsByLocale = new Map<string, number>();
  const removableCountsByKind = new Map<string, number>();
  let emittedRemovableCount = 0;

  for (const bridge of bridges) {
    if (!removable.has(bridge.path)) continue;

    removableCountsByLocale.set(bridge.locale, (removableCountsByLocale.get(bridge.locale) ?? 0) + 1);
    removableCountsByKind.set(bridge.kind, (removableCountsByKind.get(bridge.kind) ?? 0) + 1);

    if (!shouldEmitLocale(bridge.locale)) continue;
    emittedRemovableCount++;

    const targets = getSafeDistPageTargets(distDir, bridge.path, { includeFlat: false });
    if (!targets) {
      skipped.push({
        path: bridge.path,
        locale: bridge.locale,
        kind: bridge.kind,
        reasons: explainUnsafeDistPath(distDir, bridge.path),
      });
      continue;
    }

    reservations.push({ path: bridge.path, directoryPath: targets.directoryPath });
  }

  return {
    reservations,
    skipped,
    removableCountsByLocale,
    removableCountsByKind,
    emittedRemovableCount,
  };
}

export function assertRemovableBridgeSkipThreshold(plan: RemovableBridgeReservationPlan): void {
  const skippedCount = plan.skipped.length;
  if (
    skippedCount <= MAX_UNSAFE_REMOVABLE_BRIDGE_SKIPS
    && skippedCount <= plan.emittedRemovableCount * 0.02
  ) return;

  const examples = plan.skipped
    .slice(0, 10)
    .map(({ path, reasons }) => `${JSON.stringify(path)} [${reasons.join(', ')}]`)
    .join('; ');
  throw new Error(
    `[job-alias-redirect-gate] ${skippedCount} removable bridge paths are not safe dist targets `
    + `(limit ${MAX_UNSAFE_REMOVABLE_BRIDGE_SKIPS}; 2% of ${plan.emittedRemovableCount} emitted removable paths); `
    + `first: ${examples}`,
  );
}
