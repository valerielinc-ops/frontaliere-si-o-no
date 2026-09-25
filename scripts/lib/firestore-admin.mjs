// Shared firebase-admin Firestore bootstrap for the outreach/insights scripts.
//
// Every script that writes employer data (build-employer-insights,
// sync-employer-contacts-to-firestore, send-cold-emails, write-employer-traffic…)
// repeated the same cert-from-GOOGLE_APPLICATION_CREDENTIALS init. One copy here
// stops the project id / credential-shape handling from drifting between them.

import fs from 'node:fs';

/**
 * Initialise (once) and return the Admin Firestore handle.
 * Credentials come from the GOOGLE_APPLICATION_CREDENTIALS service-account JSON;
 * an explicit `project_id` uses a cert credential, otherwise we fall back to
 * application-default with the canonical project id.
 *
 * @param {string} [projectId='frontaliere-ticino'] fallback project id
 * @returns {Promise<import('firebase-admin/firestore').Firestore>}
 */
export async function getFirestoreDb(projectId = 'frontaliere-ticino') {
  const credPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (!credPath || !fs.existsSync(credPath)) {
    throw new Error('GOOGLE_APPLICATION_CREDENTIALS required (Firebase service account JSON).');
  }
  const { initializeApp, cert, getApps, applicationDefault } = await import('firebase-admin/app');
  const { getFirestore } = await import('firebase-admin/firestore');
  if (getApps().length === 0) {
    const cred = JSON.parse(fs.readFileSync(credPath, 'utf8'));
    if (cred.project_id) initializeApp({ credential: cert(cred) });
    else initializeApp({ credential: applicationDefault(), projectId });
  }
  return getFirestore();
}
