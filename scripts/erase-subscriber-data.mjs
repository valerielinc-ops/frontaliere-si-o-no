#!/usr/bin/env node
/**
 * Manual operator tool only.
 *
 * This script is intentionally not a Firebase Function, HTTP handler,
 * callable, route, SPA import, or user-flow dependency. Run it from a
 * trusted operator shell with an already-authorized Firebase Admin credential.
 *
 * Usage:
 *   node scripts/erase-subscriber-data.mjs <email>
 *   node scripts/erase-subscriber-data.mjs <email> --dry-run
 *   node scripts/erase-subscriber-data.mjs <email> --apply
 *
 * The first two forms are read-only. Deletion is possible only with the
 * explicit --apply flag, and the process exits non-zero unless the final
 * zero-residual verification succeeds.
 */

import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { getFirestoreDb } from './lib/firestore-admin.mjs';
import {
  eraseSubscriberData,
  formatEraseReport,
  normalizeEmail,
} from './lib/eraseSubscriberData.mjs';

function usageError(message) {
  return new Error(
    message
    + '\nUso: node scripts/erase-subscriber-data.mjs <email> [--dry-run|--apply]',
  );
}

export function parseArgs(argv) {
  const args = argv.slice(2);
  let email = null;
  let apply = false;
  let explicitDryRun = false;

  for (const arg of args) {
    if (arg === '--apply') {
      apply = true;
      continue;
    }
    if (arg === '--dry-run') {
      explicitDryRun = true;
      continue;
    }
    if (arg.startsWith('--')) {
      throw usageError('Opzione non riconosciuta: ' + arg);
    }
    if (email !== null) {
      throw usageError('Indicare un solo email');
    }
    email = arg;
  }

  if (apply && explicitDryRun) {
    throw usageError('Scegliere --apply oppure --dry-run, non entrambi');
  }
  const normalized = normalizeEmail(email);
  if (!normalized || !normalized.includes('@') || normalized === '_meta_') {
    throw usageError('Email non valida o riservata');
  }

  return {
    email: normalized,
    apply,
    dryRun: !apply,
  };
}

async function getAuth() {
  const { getAuth } = await import('firebase-admin/auth');
  return getAuth();
}

export async function run(argv = process.argv, dependencies = {}) {
  const options = parseArgs(argv);
  const db = dependencies.db || await getFirestoreDb();
  const auth = dependencies.auth || await getAuth();
  return eraseSubscriberData(db, options.email, auth, { apply: options.apply });
}

async function main() {
  try {
    const result = await run();
    console.log(formatEraseReport(result));
  } catch (error) {
    console.error('ERRORE: ' + (error?.message || error));
    if (error?.partial) {
      console.error(
        'Cancellazione interrotta o verifica finale fallita: '
        + 'non considerare l’operazione riuscita.',
      );
    }
    process.exitCode = 1;
  }
}

const invokedPath = process.argv[1]
  ? pathToFileURL(path.resolve(process.argv[1])).href
  : null;
if (invokedPath === import.meta.url) {
  void main();
}
