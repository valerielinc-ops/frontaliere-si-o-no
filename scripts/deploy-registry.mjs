#!/usr/bin/env node
/**
 * deploy-registry.mjs — Manage deploy metadata in Firestore.
 *
 * Firestore collection: deploy_registry
 *   - doc 'latest'          → latest deployed run metadata
 *   - doc 'last_known_good' → last validation-passing run
 *   - doc 'run_<runId>'     → per-run history
 *
 * Commands:
 *   save     --run-id=<id> --sha=<sha> [--trigger=<event>]
 *            [--article-id=] [--article-url=] [--og-title=]
 *            [--og-description=] [--og-image=] [--article-category=]
 *   get      --run-id=<id>
 *   set-good --run-id=<id> --sha=<sha>
 *   get-good
 */
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const args = process.argv.slice(2);
const command = args[0];
const flags = Object.fromEntries(
  args
    .slice(1)
    .filter((a) => a.startsWith('--'))
    .map((a) => {
      const eq = a.indexOf('=');
      return eq === -1 ? [a.slice(2), 'true'] : [a.slice(2, eq), a.slice(eq + 1)];
    }),
);

async function getDb() {
  let admin;
  try {
    admin = await import('firebase-admin');
  } catch {
    throw new Error('firebase-admin not installed');
  }

  const credPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (!credPath || !fs.existsSync(credPath)) {
    throw new Error('GOOGLE_APPLICATION_CREDENTIALS not set or file not found');
  }

  if (!admin.default.apps?.length) {
    admin.default.initializeApp({
      credential: admin.default.credential.cert(
        JSON.parse(fs.readFileSync(credPath, 'utf-8')),
      ),
    });
  }

  return admin.default.firestore();
}

const COLL = 'deploy_registry';

switch (command) {
  case 'save': {
    const { 'run-id': runId, sha, trigger = 'push' } = flags;
    if (!runId || !sha) throw new Error('--run-id and --sha are required');
    const db = await getDb();
    const data = {
      runId,
      sha,
      deployedAt: new Date().toISOString(),
      triggerEvent: trigger,
      articleId: flags['article-id'] || null,
      articleUrl: flags['article-url'] || null,
      ogTitle: flags['og-title'] || null,
      ogDescription: flags['og-description'] || null,
      ogImage: flags['og-image'] || null,
      articleCategory: flags['article-category'] || null,
    };
    await db.collection(COLL).doc('latest').set(data);
    await db.collection(COLL).doc(`run_${runId}`).set(data);
    console.log(`[deploy-registry] saved run ${runId}`);
    break;
  }

  case 'get': {
    const { 'run-id': runId } = flags;
    if (!runId) throw new Error('--run-id is required');
    const db = await getDb();
    const snap = await db.collection(COLL).doc(`run_${runId}`).get();
    console.log(snap.exists ? JSON.stringify(snap.data()) : '{}');
    break;
  }

  case 'set-good': {
    const { 'run-id': runId, sha } = flags;
    if (!runId || !sha) throw new Error('--run-id and --sha are required');
    const db = await getDb();
    await db.collection(COLL).doc('last_known_good').set({
      runId,
      sha,
      updatedAt: new Date().toISOString(),
    });
    console.log(`[deploy-registry] last_known_good → run ${runId}`);
    break;
  }

  case 'get-good': {
    const db = await getDb();
    const snap = await db.collection(COLL).doc('last_known_good').get();
    console.log(snap.exists ? JSON.stringify(snap.data()) : '{}');
    break;
  }

  default:
    throw new Error(`Unknown command: ${command || '(none)'}`);
}

process.exit(0);
