import { existsSync, readFileSync } from 'node:fs';

/** Read the Firebase service account used by a Remote Config write. */
export function readFirebaseServiceAccountCredentials(env = process.env, { purpose = 'complete the Firebase admin operation' } = {}) {
  const raw = String(env.FIREBASE_SERVICE_ACCOUNT_JSON || '').trim();
  if (raw) {
    try {
      return JSON.parse(raw);
    } catch {
      throw new Error(`Firebase service-account JSON is malformed; cannot ${purpose}`);
    }
  }

  const credentialsPath = String(env.GOOGLE_APPLICATION_CREDENTIALS || '').trim();
  if (!credentialsPath || !existsSync(credentialsPath)) return null;
  try {
    return JSON.parse(readFileSync(credentialsPath, 'utf8'));
  } catch {
    throw new Error(`Firebase service-account file is unreadable; cannot ${purpose}`);
  }
}
