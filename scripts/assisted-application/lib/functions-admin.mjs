/**
 * The firebase-admin instance of the code under `functions/`.
 *
 * `functions/` has its own `node_modules` (and lockfile): its modules build `FieldValue` sentinels
 * (serverTimestamp, ...) with THEIR firebase-admin. A database object created by the repository root's firebase-admin
 * rejects them («Couldn't serialize object of type "ServerTimestampTransform"»), so a script that hands its db to a
 * `functions/src` module that writes (applyAutomationEvent, the audit events, ...) must create that db from the same
 * instance. Where `functions/node_modules` does not exist (a sparse worktree) the lookup falls back to the root's,
 * which is then the only instance.
 */
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getFirestoreDb } from '../../lib/firestore-admin.mjs';

const FUNCTIONS_PACKAGE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../functions/package.json');

/** The `{app, firestore}` modules of the instance the `functions/src` modules import. */
export function functionsAdminModules() {
  const require = createRequire(FUNCTIONS_PACKAGE);
  return { app: require('firebase-admin/app'), firestore: require('firebase-admin/firestore') };
}

/**
 * A Firestore db of the functions instance. The root's app is initialised first (same credentials) so that what the
 * script does with the root's firebase-admin (Storage, Remote Config) keeps working next to it.
 */
export async function getFunctionsFirestoreDb(projectId) {
  await getFirestoreDb(projectId);
  return getFirestoreDb(projectId, { adminModules: functionsAdminModules() });
}
