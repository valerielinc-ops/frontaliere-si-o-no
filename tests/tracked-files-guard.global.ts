// globalSetup di Vitest: fotografa i file tracciati prima della run e fallisce
// se la run ne lascia uno modificato. Logica e motivazione in
// scripts/ci/lib/tracked-files-guard.mjs.
import path from 'node:path';
import {
  formatTrackedChanges,
  snapshotTrackedState,
  trackedChanges,
} from '../scripts/ci/lib/tracked-files-guard.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');

type GuardProject = { config?: { update?: boolean | string; watch?: boolean } } | undefined;

// Registrato alla radice di vitest.config.ts, viene ereditato dai due project
// (`extends: true`) e Vitest lo chiama una volta per ciascuno: misurato sul
// censimento del 2026-09-30, tre fotografie e tre errori identici per run. La
// prima chiamata fa il lavoro, le altre sono no-op.
let armed = false;

export function setup(project?: GuardProject) {
  if (armed) return undefined;
  armed = true;
  // In watch mode il teardown arriva solo all'uscita dalla sessione: le
  // modifiche fatte a mano nel frattempo risulterebbero scritte dai test.
  if (project?.config?.watch) return undefined;
  const before = snapshotTrackedState(ROOT);
  if (!before) {
    console.warn('[tracked-files-guard] git non disponibile in questo checkout: controllo saltato.');
    return undefined;
  }
  return () => {
    const after = snapshotTrackedState(ROOT);
    if (!after) return;
    const update = project?.config?.update;
    const changed = trackedChanges(before, after, {
      allowSnapshotUpdates: Boolean(update) && update !== 'none',
    });
    if (changed.length === 0) return;
    const message = formatTrackedChanges(changed);
    console.error(`\n${message}\n`);
    throw new Error(message);
  };
}
