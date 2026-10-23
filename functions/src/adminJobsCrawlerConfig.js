import { FieldValue } from 'firebase-admin/firestore';
import { getAdminDb } from './newsletterResendWebhookCore.js';
import { assertSiteAdmin } from './adminAuth.js';
import {
  JOBS_CRAWLER_CONFIG_DEFAULTS,
  normalizeJobsCrawlerConfig,
} from './jobsCrawlerConfig.js';

const CONFIG_COLLECTION = 'admin_config';
const CONFIG_DOCUMENT = 'jobsCrawler';
const AUDIT_COLLECTION = 'admin_audit_log';

function response(status, body) {
  return { status, body };
}

function timestampToIso(value) {
  if (!value) return null;
  if (typeof value.toDate === 'function') return value.toDate().toISOString();
  if (value instanceof Date) return value.toISOString();
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function configDiff(previous, next) {
  const changedFields = [];
  const diff = {};
  const fields = [
    'domainWhitelist',
    'domainBlacklist',
    'minQualityScore',
    'minDescriptionChars',
    'aiLocalizationEnabled',
    'aiLocalizationMaxJobsPerRun',
    'contentReuse',
    'companyPriority',
    'sourceSeeds',
  ];

  for (const field of fields) {
    if (JSON.stringify(previous?.[field]) === JSON.stringify(next?.[field])) continue;
    changedFields.push(field);
    diff[field] = { from: previous?.[field] ?? null, to: next?.[field] ?? null };
  }
  return { changedFields, diff };
}

function configFromSnapshot(snapshot) {
  return snapshot?.exists
    ? normalizeJobsCrawlerConfig(snapshot.data() || {}, { strict: false })
    : normalizeJobsCrawlerConfig(JOBS_CRAWLER_CONFIG_DEFAULTS, { strict: false });
}

async function readConfig(db) {
  const snapshot = await db.collection(CONFIG_COLLECTION).doc(CONFIG_DOCUMENT).get();
  return {
    snapshot,
    config: configFromSnapshot(snapshot),
    updatedAt: snapshot?.exists ? timestampToIso(snapshot.data()?.updatedAt) : null,
    updatedBy: snapshot?.exists ? String(snapshot.data()?.updatedBy || '') || null : null,
  };
}

function errorFromAuth(auth) {
  return response(auth.status, { ok: false, error: auth.error });
}

export async function handleAdminJobsCrawlerConfig(req, dependencies = {}) {
  const auth = dependencies.assertSiteAdmin
    ? await dependencies.assertSiteAdmin(req)
    : await assertSiteAdmin(req);
  if (!auth.ok) return errorFromAuth(auth);

  const db = dependencies.db || getAdminDb();
  const method = String(req?.method || 'GET').toUpperCase();
  if (method === 'GET') {
    try {
      const current = await readConfig(db);
      return response(200, {
        ok: true,
        config: current.config,
        updatedAt: current.updatedAt,
        updatedBy: current.updatedBy,
        source: current.snapshot?.exists ? 'firestore' : 'default',
      });
    } catch (error) {
      console.error('adminJobsCrawlerConfig GET failed', error);
      return response(500, { ok: false, error: 'config_read_failed' });
    }
  }

  if (method !== 'POST') {
    return response(405, { ok: false, error: 'method_not_allowed' });
  }

  let nextConfig;
  try {
    const body = req?.body && typeof req.body === 'object' ? req.body : {};
    const candidate = Object.prototype.hasOwnProperty.call(body, 'config') ? body.config : body;
    nextConfig = normalizeJobsCrawlerConfig(candidate, { strict: true });
  } catch (error) {
    return response(400, { ok: false, error: error?.message || 'invalid_config' });
  }

  try {
    const current = await readConfig(db);
    const { changedFields, diff } = configDiff(current.config, nextConfig);
    await db.collection(CONFIG_COLLECTION).doc(CONFIG_DOCUMENT).set({
      ...nextConfig,
      updatedAt: FieldValue.serverTimestamp(),
      updatedBy: auth.email,
    }, { merge: true });

    await db.collection(AUDIT_COLLECTION).add({
      at: FieldValue.serverTimestamp(),
      uid: auth.uid,
      email: auth.email,
      action: 'crawler_config_update',
      target: `${CONFIG_COLLECTION}/${CONFIG_DOCUMENT}`,
      changedFields,
      diff,
      status: 200,
    });

    return response(200, {
      ok: true,
      config: nextConfig,
      updatedAt: new Date().toISOString(),
      updatedBy: auth.email,
      source: 'firestore',
    });
  } catch (error) {
    console.error('adminJobsCrawlerConfig POST failed', error);
    return response(500, { ok: false, error: 'config_write_failed' });
  }
}
