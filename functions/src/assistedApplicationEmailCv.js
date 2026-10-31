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
import { ASSISTED_APPLICATIONS_COLLECTION, ASSISTED_APPLICATION_ORDER_ID_RE } from './assistedApplicationConstants.js';
import { buildAssistedApplicationEvent } from './assistedApplicationAudit.js';
import { detectCvFileType } from './assistedApplicationCvCheck.js';
import { addressOf, parseMimeMessage, senderAuthenticated } from './lib/mimeMessage.js';
import { initialCvArtifactStore } from './lib/assistedApplicationInitialCvIngress.js';

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

async function findWaitingOrder(db, sender, expectedOrderId) {
  const orders = db.collection(ASSISTED_APPLICATIONS_COLLECTION);
  // Only a trusted server caller resolving an alias supplies this dependency.
  // A mismatched target never falls back to another order owned by the sender.
  if (expectedOrderId !== undefined && (typeof expectedOrderId !== 'string' || !ASSISTED_APPLICATION_ORDER_ID_RE.test(expectedOrderId))) return null;
  const expected = expectedOrderId === undefined ? null : await orders.doc(expectedOrderId).get();
  const snapshot = expectedOrderId === undefined
    ? await orders.where('paymentStatus', '==', 'paid').get()
    : { docs: expected?.exists ? [expected] : [] };
  const candidates = (snapshot.docs || []).filter((doc) => {
    const order = doc.data() || {};
    const addresses = [order.customerEmail, order.applicantEmail].map((value) => String(value || '').trim().toLowerCase());
    return order.paymentStatus === 'paid' && addresses.includes(sender) && WAITING_STATUSES.has(order.submissionStatus) && !order.cvStorageKey;
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
 * @param {{db, bucket, secret:string, nowMs?:number, now?:()=>number, expectedOrderId?:string, operationStartedAt?:number, isEnabled?:(orderId:string)=>Promise<boolean>}} deps
 * @returns {Promise<{status:number, body:object}>}
 */
export async function handleAssistedApplicationEmailCv(req, deps) {
  const now = deps.now || Date.now;
  const operationStartedAt = deps.operationStartedAt ?? now();
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

  const orderDoc = await findWaitingOrder(deps.db, sender, deps.expectedOrderId);
  if (!orderDoc) return { status: 200, body: { ok: true, matched: false, reason: 'no_waiting_order' } };

  const orderId = orderDoc.id;
  // Behind the automation flag like the rest of the automated second half
  // (owner decision: everything off until the final trial run), for this
  // order. Off: the e-mail reaches Valerie's inbox as today, nothing attached.
  if (deps.isEnabled && !(await deps.isEnabled(orderId))) return { status: 200, body: { ok: true, matched: false, reason: 'automation_off' } };
  const nowMs = deps.nowMs || operationStartedAt;
  const key = `assisted-application-uploads/${orderId}/${nowMs}-${randomUUID()}-${fileStem(attachment.filename)}.${attachment.type}`;
  const orderRef = orderDoc.ref;
  // Receiving a first attachment grants no application approval, resume or sending.
  const artifacts = initialCvArtifactStore({ db: deps.db, bucket: deps.bucket, orderId, key, operationStartedAt, now,
    uploaderAllows: order => order.paymentStatus === 'paid' && !order.cvStorageKey && WAITING_STATUSES.has(order.submissionStatus)
      && [order.customerEmail, order.applicantEmail].some(address => String(address || '').trim().toLowerCase() === sender)
      && senderAuthenticated(message.headers, sender),
  });
  let stored = false;
  try {
    if (await artifacts.save(attachment.content, { contentType: CONTENT_TYPES[attachment.type], resumable: false })) {
      stored = await artifacts.publish((transaction, { order, nowMs: publishedAt }) => {
        const timestamp = FieldValue.serverTimestamp();
        transaction.set(orderRef, {
          cvStorageKey: key,
          cvFileName: `${fileStem(attachment.filename)}.${attachment.type}`,
          cvUploadedAt: Timestamp.fromMillis(publishedAt),
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
        if (notes) transaction.set(orderRef.collection('automation').doc('intake'), { emailNotes: notes, receivedAt: publishedAt }, { merge: true });
      });
    }
  } catch (error) {
    // Transport-unknown uploads/publications keep the engine's private reconciliation marker.
    await artifacts.abandon().catch(() => {});
    throw error;
  }
  if (!stored) {
    await artifacts.abandon();
    const current = (await orderRef.get()).data() || {};
    return { status: 200, body: { ok: true, matched: false, reason: current.cvStorageKey ? 'cv_already_present' : 'order_changed' } };
  }
  return { status: 200, body: { ok: true, matched: true } };
}
