import { assertSiteAdmin } from './adminAuth.js';
import { getAdminDb } from './newsletterResendWebhookCore.js';
import { ADMIN_AUDIT_COLLECTION, sanitizeAdminAuditDetails } from './adminAudit.js';

const PAGE_SIZE = 50;
const CURSOR_LIMIT = 512;

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

function decodeCursor(value) {
  if (!value) return null;
  if (typeof value !== 'string' || value.length > CURSOR_LIMIT) throw new Error('invalid_cursor');
  try {
    const decoded = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    if (!decoded || typeof decoded.at !== 'string' || !Number.isFinite(Date.parse(decoded.at)) || typeof decoded.id !== 'string') throw new Error('invalid_cursor');
    return decoded;
  } catch {
    throw new Error('invalid_cursor');
  }
}

export function encodeAdminAuditCursor(entry) {
  return Buffer.from(JSON.stringify({ at: entry.at, id: entry.id }), 'utf8').toString('base64url');
}

function queryParam(req, key) {
  const value = req?.query?.[key];
  return Array.isArray(value) ? value[0] : value;
}

function parseFilters(req) {
  const action = String(queryParam(req, 'action') || '').trim();
  const rawFrom = String(queryParam(req, 'from') || '').trim();
  const rawTo = String(queryParam(req, 'to') || '').trim();
  const from = /^\d{4}-\d{2}-\d{2}$/u.test(rawFrom) ? `${rawFrom}T00:00:00.000Z` : rawFrom;
  const to = /^\d{4}-\d{2}-\d{2}$/u.test(rawTo) ? `${rawTo}T23:59:59.999Z` : rawTo;
  if (action.length > 100 || (from && Number.isNaN(Date.parse(from))) || (to && Number.isNaN(Date.parse(to)))) throw new Error('invalid_filter');
  return { action, from: from || null, to: to || null, cursor: decodeCursor(queryParam(req, 'cursor')) };
}

function serializeEntry(doc) {
  const data = doc.data?.() || {};
  const at = timestampToIso(data.at) || timestampToIso(data.createdAt) || null;
  return {
    id: String(doc.id || ''),
    at,
    uid: String(data.uid || ''),
    action: String(data.action || ''),
    target: String(data.target || ''),
    status: typeof data.status === 'number' ? data.status : String(data.status || ''),
    details: sanitizeAdminAuditDetails(data.details || data),
  };
}

function isInRange(entry, filters) {
  const time = entry.at ? Date.parse(entry.at) : Number.NaN;
  if (filters.from && (!Number.isFinite(time) || time < Date.parse(filters.from))) return false;
  if (filters.to && (!Number.isFinite(time) || time > Date.parse(filters.to))) return false;
  if (filters.action && entry.action !== filters.action) return false;
  return true;
}

export async function handleAdminAuditLog(req, dependencies = {}) {
  if (String(req?.method || 'GET').toUpperCase() !== 'GET') return response(405, { ok: false, error: 'method_not_allowed' });
  const authGate = dependencies.assertSiteAdmin || assertSiteAdmin;
  const auth = await authGate(req);
  if (!auth.ok) return response(auth.status, { ok: false, error: auth.error });
  let filters;
  try { filters = parseFilters(req); } catch (error) { return response(400, { ok: false, error: error.message || 'invalid_filter' }); }

  try {
    const db = dependencies.db || getAdminDb();
    let query = db.collection(ADMIN_AUDIT_COLLECTION);
    if (filters.action && typeof query.where === 'function') query = query.where('action', '==', filters.action);
    if (filters.from && typeof query.where === 'function') query = query.where('at', '>=', new Date(filters.from));
    if (filters.to && typeof query.where === 'function') query = query.where('at', '<=', new Date(filters.to));
    if (typeof query.orderBy === 'function') {
      query = query.orderBy('at', 'desc');
      query = query.orderBy('__name__', 'desc');
    }
    if (filters.cursor && typeof query.startAfter === 'function') query = query.startAfter(new Date(filters.cursor.at), filters.cursor.id);
    if (typeof query.limit === 'function') query = query.limit(PAGE_SIZE + 1);
    const snapshot = await query.get();
    let entries = (snapshot.docs || []).map(serializeEntry).filter((entry) => isInRange(entry, filters));
    if (filters.cursor && typeof query.startAfter !== 'function') {
      entries = entries.filter((entry) => entry.at && (entry.at < filters.cursor.at || (entry.at === filters.cursor.at && entry.id < filters.cursor.id)));
    }
    entries = entries.slice(0, PAGE_SIZE);
    const hasMore = (snapshot.docs || []).length > PAGE_SIZE;
    return response(200, { ok: true, entries, nextCursor: hasMore && entries.length ? encodeAdminAuditCursor(entries[entries.length - 1]) : null });
  } catch (error) {
    console.error('adminAuditLog GET failed', error);
    return response(500, { ok: false, error: 'audit_read_failed' });
  }
}
