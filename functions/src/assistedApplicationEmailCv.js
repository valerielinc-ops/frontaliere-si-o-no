/**
 * The CV that arrives as a reply to valerie@ is attached to its order
 * automatically (fase 2 of the automated assisted application).
 *
 * The concierge e-mail asks the customer to simply reply with the CV. The
 * Cloudflare Email Worker (infra/cloudflare-email-worker) still forwards every
 * reply to the human inbox, and additionally hands a reply that carries
 * attachments to this endpoint as the raw message. Here:
 *   1. the sender must be authenticated (DKIM or SPF aligned with From, as
 *      Cloudflare's MX recorded it), so nobody can put a CV on someone else's
 *      order by forging the From;
 *   2. the sender must own a paid order still waiting for its CV (customer or
 *      applicant address, most recent first); an order that already has a CV
 *      is never overwritten;
 *   3. the first attachment whose bytes are a PDF, DOC or DOCX (≤ 5 MB) is
 *      stored in the order's folder, the order moves to "materials received",
 *      and the reply text is kept (private) as the candidate's notes for the
 *      AI draft.
 * The order-trigger then runs the usual type check, which starts the flow.
 * Anything that does not match is dropped here: the human inbox has it.
 */

import { randomUUID, timingSafeEqual } from 'node:crypto';
import { FieldValue, Timestamp } from 'firebase-admin/firestore';
import { ASSISTED_APPLICATIONS_COLLECTION } from './assistedApplicationConstants.js';
import { buildAssistedApplicationEvent } from './assistedApplicationAudit.js';
import { detectCvFileType } from './assistedApplicationCvCheck.js';
import { addressOf, parseMimeMessage, senderAuthenticated } from './lib/mimeMessage.js';

export const MAX_RAW_MESSAGE_BYTES = 9 * 1024 * 1024;
const MAX_CV_BYTES = 5 * 1024 * 1024;
const MAX_NOTES_CHARS = 4000;
const WAITING_STATUSES = new Set(['awaiting_upload', 'ready_for_manual_submission', 'in_progress']);
const CONTENT_TYPES = {
  pdf: 'application/pdf',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
};

function secretsMatch(expected, provided) {
  const left = Buffer.from(String(expected || ''));
  const right = Buffer.from(String(provided || ''));
  return left.length > 0 && left.length === right.length && timingSafeEqual(left, right);
}

function millis(value) {
  if (!value) return 0;
  if (typeof value.toMillis === 'function') return value.toMillis();
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** The reply without quoted history and signatures' long tails. */
export function candidateNotesFrom(text) {
  const lines = [];
  for (const line of String(text || '').replace(/\r\n?/g, '\n').split('\n')) {
    if (/^\s*>/.test(line)) continue;
    // "Il giorno … ha scritto:", "Am … schrieb …:", "Le … a écrit :", "On … wrote:"
    if (/^(il giorno|am |le |on ).{0,200}(ha scritto|schrieb|a écrit|wrote)\s*:?\s*$/i.test(line.trim())) break;
    lines.push(line);
  }
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim().slice(0, MAX_NOTES_CHARS);
}

async function findWaitingOrder(db, sender) {
  const snapshot = await db.collection(ASSISTED_APPLICATIONS_COLLECTION).where('paymentStatus', '==', 'paid').get();
  const candidates = (snapshot.docs || []).filter((doc) => {
    const order = doc.data() || {};
    const addresses = [order.customerEmail, order.applicantEmail].map((value) => String(value || '').trim().toLowerCase());
    return addresses.includes(sender) && WAITING_STATUSES.has(order.submissionStatus) && !order.cvStorageKey;
  });
  candidates.sort((left, right) => millis(right.data()?.paidAt) - millis(left.data()?.paidAt));
  return candidates[0] || null;
}

function fileStem(name) {
  return String(name || 'cv').replace(/\.[A-Za-z0-9]{1,5}$/, '').normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'cv';
}

/**
 * @param {{method:string, get:(name:string)=>string|undefined, rawBody?:Buffer, body?:any}} req
 * @param {{db, bucket, secret:string, nowMs?:number}} deps
 * @returns {Promise<{status:number, body:object}>}
 */
export async function handleAssistedApplicationEmailCv(req, deps) {
  if (String(req.method || '').toUpperCase() !== 'POST') return { status: 405, body: { ok: false, error: 'method_not_allowed' } };
  if (!secretsMatch(deps.secret, req.get?.('x-stop-secret'))) return { status: 403, body: { ok: false, error: 'forbidden' } };
  const raw = Buffer.isBuffer(req.rawBody) ? req.rawBody : Buffer.from(typeof req.body === 'string' ? req.body : '');
  if (!raw.length || raw.length > MAX_RAW_MESSAGE_BYTES) return { status: 413, body: { ok: false, error: 'size' } };

  const message = parseMimeMessage(raw);
  const sender = addressOf(message.from);
  if (!sender || !senderAuthenticated(message.headers, sender)) return { status: 200, body: { ok: true, matched: false, reason: 'unauthenticated' } };
  const attachment = message.attachments
    .map((item) => ({ ...item, type: detectCvFileType(item.content.subarray(0, 8)) }))
    .find((item) => CONTENT_TYPES[item.type] && item.content.length > 0 && item.content.length <= MAX_CV_BYTES);
  if (!attachment) return { status: 200, body: { ok: true, matched: false, reason: 'no_cv_attachment' } };

  const orderDoc = await findWaitingOrder(deps.db, sender);
  if (!orderDoc) return { status: 200, body: { ok: true, matched: false, reason: 'no_waiting_order' } };

  const orderId = orderDoc.id;
  // Behind the automation flag like the rest of the automated second half
  // (owner decision: everything off until the final trial run), for this
  // order. Off: the e-mail reaches Valerie's inbox as today, nothing attached.
  if (deps.isEnabled && !(await deps.isEnabled(orderId))) return { status: 200, body: { ok: true, matched: false, reason: 'automation_off' } };
  const nowMs = deps.nowMs || Date.now();
  const key = `assisted-application-uploads/${orderId}/${nowMs}-${randomUUID()}-${fileStem(attachment.filename)}.${attachment.type}`;
  await deps.bucket.file(key).save(attachment.content, { contentType: CONTENT_TYPES[attachment.type], resumable: false });

  const orderRef = orderDoc.ref;
  let stored = false;
  await deps.db.runTransaction(async (transaction) => {
    // Firestore retries a contended transaction: a retry that finds another CV
    // must not keep the first attempt's "stored", or the losing file would stay.
    stored = false;
    const snapshot = await transaction.get(orderRef);
    const order = snapshot.data() || {};
    // Raced with an upload from the order page: keep that one.
    if (order.cvStorageKey || !WAITING_STATUSES.has(order.submissionStatus)) return;
    const timestamp = FieldValue.serverTimestamp();
    transaction.set(orderRef, {
      cvStorageKey: key,
      cvUploadedAt: Timestamp.fromMillis(nowMs),
      cvUploadedBy: 'email_reply',
      updatedAt: timestamp,
      ...(order.submissionStatus === 'awaiting_upload' ? { submissionStatus: 'in_progress', statusChangedAt: timestamp } : {}),
    }, { merge: true });
    transaction.set(orderRef.collection('events').doc(), buildAssistedApplicationEvent('materials_received_by_email', {
      actorEmail: 'email_reply',
      fromStatus: order.submissionStatus,
      toStatus: order.submissionStatus === 'awaiting_upload' ? 'in_progress' : order.submissionStatus,
      detectedType: attachment.type,
    }));
    const notes = candidateNotesFrom(message.text);
    if (notes) {
      transaction.set(orderRef.collection('automation').doc('intake'), { emailNotes: notes, receivedAt: nowMs }, { merge: true });
    }
    stored = true;
  });
  if (!stored) {
    await deps.bucket.file(key).delete({ ignoreNotFound: true }).catch(() => {});
    return { status: 200, body: { ok: true, matched: false, reason: 'cv_already_present' } };
  }
  return { status: 200, body: { ok: true, matched: true } };
}
