/**
 * The candidate's reply to valerie@ is attached to their order automatically:
 * the CV it carries and the facts it states (owner mandate 2026-11-10:
 * applications run without anyone in between).
 *
 * The concierge e-mail asks the customer to simply reply with the CV and a few
 * facts. The Cloudflare Email Worker (infra/cloudflare-email-worker) still
 * forwards every reply to the human inbox, and additionally hands every reply
 * that is not an order alias's mail to this endpoint as the raw message. Here:
 *   1. the sender must be authenticated (DKIM or SPF aligned with From, as
 *      Cloudflare's MX recorded it), so nobody can put a CV or a fact on someone
 *      else's order by forging the From;
 *   2. the sender must own a paid order still open (customer or applicant
 *      address): the one the reply quotes by its reference, else the most
 *      recent, and for a CV the most recent still waiting for one;
 *   3. the first attachment whose bytes are a PDF, DOC or DOCX (≤ 5 MB) is
 *      stored in the order's folder when the order has no CV yet (an order that
 *      already has a CV is never overwritten), and the order moves to
 *      "materials received". The order-trigger then runs the usual type check,
 *      which starts the flow;
 *   4. the reply's own text (no quoted history) is kept, private, as the
 *      candidate's notes for the AI draft and as a `candidate_replies` document,
 *      which assistedApplicationCandidateReply.js reads with Codex and applies
 *      to the order (permit, nationality, phone, start date, workload, languages).
 * Anything that does not match is dropped here: the human inbox has it.
 */

import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { FieldValue, Timestamp } from 'firebase-admin/firestore';
import { ASSISTED_APPLICATIONS_COLLECTION } from './assistedApplicationConstants.js';
import { buildAssistedApplicationEvent } from './assistedApplicationAudit.js';
import { CANDIDATE_REPLIES_SUBCOLLECTION } from './assistedApplicationCandidateReply.js';
import { detectCvFileType } from './assistedApplicationCvCheck.js';
import { parseHeaders, parseMimeMessage, senderAuthenticated, singleMailboxAddress } from './lib/mimeMessage.js';

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

/** An order still open for the candidate: paid, not refunded, not sent yet. */
function isOpenOrder(order) {
  return order.paymentStatus === 'paid' && WAITING_STATUSES.has(order.submissionStatus)
    && !order.refundedAt && order.refundStatus !== 'pending' && !order.retentionPurgedAt;
}

/**
 * The sender's order the reply is about. The concierge e-mails print the order's reference: an order of the
 * sender quoted in the reply (also in the quoted history) is that one; otherwise the most recent open order,
 * and for a CV the most recent one still waiting for it.
 */
export async function findReplyOrder(db, sender, { fullText = '', hasCv = false } = {}) {
  const snapshot = await db.collection(ASSISTED_APPLICATIONS_COLLECTION).where('paymentStatus', '==', 'paid').get();
  const owned = (snapshot.docs || []).filter((doc) => {
    const order = doc.data() || {};
    const addresses = [order.customerEmail, order.applicantEmail].map((value) => String(value || '').trim().toLowerCase());
    return addresses.includes(sender) && isOpenOrder(order);
  });
  owned.sort((left, right) => millis(right.data()?.paidAt) - millis(left.data()?.paidAt));
  const quoted = owned.filter((doc) => doc.id.length >= 8 && String(fullText).includes(doc.id));
  if (quoted.length === 1) return quoted[0];
  if (hasCv) {
    const waiting = owned.find((doc) => !doc.data()?.cvStorageKey);
    if (waiting) return waiting;
  }
  return owned[0] || null;
}

function fileStem(name) {
  return String(name || 'cv').replace(/\.[A-Za-z0-9]{1,5}$/, '').normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'cv';
}

/** One document per message: Cloudflare can hand the same reply over twice. */
function replyIdentity(raw) {
  const text = Buffer.from(raw || '').toString('latin1');
  const separator = /\r?\n\r?\n/.exec(text);
  const ids = parseHeaders(separator ? text.slice(0, separator.index) : text)
    .filter(([name]) => name === 'message-id').map(([, value]) => value.trim()).filter(Boolean);
  const identity = ids.length === 1 ? `message-id:${ids[0]}` : raw;
  return `re-${createHash('sha256').update(identity).digest('hex').slice(0, 40)}`;
}

async function storeCv({ deps, orderDoc, attachment, nowMs }) {
  const orderId = orderDoc.id;
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
      cvFileName: `${fileStem(attachment.filename)}.${attachment.type}`,
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
    stored = true;
  });
  if (!stored) await deps.bucket.file(key).delete({ ignoreNotFound: true }).catch(() => {});
  return stored;
}

/**
 * The reply's text for the draft (automation/intake, appended) and for the facts reader
 * (candidate_replies/{replyId}, created once: its trigger reads it with Codex).
 */
async function storeReply({ db, orderRef, replyId, notes, subject, nowMs, cv }) {
  const replyRef = orderRef.collection(CANDIDATE_REPLIES_SUBCOLLECTION).doc(replyId);
  const intakeRef = orderRef.collection('automation').doc('intake');
  let created = false;
  await db.runTransaction(async (transaction) => {
    created = false;
    const [reply, intake] = await Promise.all([transaction.get(replyRef), transaction.get(intakeRef)]);
    if (reply.exists) return;
    const previous = String(intake.data()?.emailNotes || '').trim();
    const emailNotes = (previous ? `${previous}\n\n${notes}` : notes).slice(-MAX_NOTES_CHARS);
    transaction.set(intakeRef, { emailNotes, receivedAt: nowMs }, { merge: true });
    transaction.set(replyRef, {
      status: 'received',
      receivedAt: nowMs,
      text: notes,
      subject: String(subject || '').slice(0, 300),
      cv,
      attempts: 0,
    });
    created = true;
  });
  return created;
}

/**
 * @param {{method:string, get:(name:string)=>string|undefined, rawBody?:Buffer, body?:any}} req
 * @param {{db, bucket, secret:string, isEnabled?:Function, nowMs?:number}} deps
 * @returns {Promise<{status:number, body:object}>}
 */
export async function handleAssistedApplicationEmailCv(req, deps) {
  if (String(req.method || '').toUpperCase() !== 'POST') return { status: 405, body: { ok: false, error: 'method_not_allowed' } };
  if (!secretsMatch(deps.secret, req.get?.('x-stop-secret'))) return { status: 403, body: { ok: false, error: 'forbidden' } };
  const raw = Buffer.isBuffer(req.rawBody) ? req.rawBody : Buffer.from(typeof req.body === 'string' ? req.body : '');
  if (!raw.length || raw.length > MAX_RAW_MESSAGE_BYTES) return { status: 413, body: { ok: false, error: 'size' } };

  const message = parseMimeMessage(raw);
  const sender = singleMailboxAddress(message.from);
  if (!sender || !senderAuthenticated(message.headers, sender)) return { status: 200, body: { ok: true, matched: false, reason: 'unauthenticated' } };
  const attachment = message.attachments
    .map((item) => ({ ...item, type: detectCvFileType(item.content.subarray(0, 8)) }))
    .find((item) => CONTENT_TYPES[item.type] && item.content.length > 0 && item.content.length <= MAX_CV_BYTES);
  const notes = candidateNotesFrom(message.text);
  if (!attachment && !notes) return { status: 200, body: { ok: true, matched: false, reason: 'nothing_to_read' } };

  const orderDoc = await findReplyOrder(deps.db, sender, { fullText: `${message.subject || ''}\n${message.text || ''}`, hasCv: Boolean(attachment) });
  if (!orderDoc) return { status: 200, body: { ok: true, matched: false, reason: 'no_open_order' } };

  const orderId = orderDoc.id;
  // Behind the automation flag like the rest of the automated second half
  // (owner decision: everything off until the final trial run), for this
  // order. Off: the e-mail reaches Valerie's inbox as today, nothing attached.
  if (deps.isEnabled && !(await deps.isEnabled(orderId))) return { status: 200, body: { ok: true, matched: false, reason: 'automation_off' } };
  const nowMs = deps.nowMs || Date.now();

  let cv = 'none';
  if (attachment) {
    if (orderDoc.data()?.cvStorageKey) cv = 'already_present';
    else cv = (await storeCv({ deps, orderDoc, attachment, nowMs })) ? 'stored' : 'already_present';
  }
  const reply = notes
    ? ((await storeReply({ db: deps.db, orderRef: orderDoc.ref, replyId: replyIdentity(raw), notes, subject: message.subject, nowMs, cv })) ? 'queued' : 'duplicate')
    : 'empty';
  const matched = cv === 'stored' || reply === 'queued';
  return { status: 200, body: { ok: true, matched, cv, reply } };
}
