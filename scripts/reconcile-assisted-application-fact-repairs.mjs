import { createRequire } from 'node:module';
import { isInvokedDirectly } from './lib/is-invoked-directly.mjs';
import { reconcileFactRepairSchedule } from '../functions/src/assistedApplicationAutomation.js';

/** Default dry-run; paginate every held order without exposing candidate data. */
export async function reconcileFactRepairSchedules({ db, apply = false }) {
  const summary = { scanned: 0, changed: 0, apply };
  let last = null;
  do {
    let query = db.collection('assisted_applications').where('automationState', 'in', ['owner_review', 'owner_takeover']).orderBy('__name__').limit(200);
    if (last) query = query.startAfter(last);
    const snapshot = await query.get();
    for (const doc of snapshot.docs) {
      const result = await reconcileFactRepairSchedule({ db, orderId: doc.id, apply });
      summary.scanned += 1;
      if (result.changed) summary.changed += 1;
    }
    last = snapshot.size === 200 ? snapshot.docs.at(-1) : null;
  } while (last);
  return summary;
}

if (isInvokedDirectly(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.some(arg => arg !== '--apply')) throw new Error('Usage: node scripts/reconcile-assisted-application-fact-repairs.mjs [--apply]');
  const require = createRequire(new URL('../functions/package.json', import.meta.url));
  const { initializeApp, applicationDefault } = require('firebase-admin/app');
  const { getFirestore } = require('firebase-admin/firestore');
  initializeApp({ credential: applicationDefault(), projectId: 'frontaliere-ticino' });
  process.stdout.write(`${JSON.stringify(await reconcileFactRepairSchedules({ db: getFirestore(), apply: args.includes('--apply') }))}\n`);
}
