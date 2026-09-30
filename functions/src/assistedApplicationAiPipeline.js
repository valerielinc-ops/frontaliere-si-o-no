/**
 * AI draft for the 0,99 € assisted application — the second, formerly manual,
 * half of the service.
 *
 * When a paid order's CV passes the server-side type check (or when the owner
 * asks for it from the queue), this pipeline:
 *   1. reads the CV and extracts a structured profile (Gemini on Vertex AI);
 *   2. reads the posting and fixes its requirements BEFORE seeing the CV;
 *   3. matches profile ↔ requirements with verbatim evidence, and writes the
 *      cover letter, the application e-mail and the portal answers in the
 *      posting's language;
 *   4. runs the deterministic fact gate, renders the letter as PDF and stores
 *      everything in `assisted_applications/{id}/ai_drafts/current`.
 *
 * Nothing leaves for an employer from here. The owner reviews the draft in
 * the admin queue and either sends it by e-mail (`sendAssistedApplicationEmail`,
 * only when the posting itself publishes an address or the owner enters one)
 * or uses the portal kit and marks the order as submitted.
 *
 * The draft lives in a subcollection on purpose: the customer can `get` the
 * order document (firestore.rules), and the operator's fit analysis is not
 * theirs to read. No rule matches `ai_drafts`, so clients are denied.
 */

import admin from 'firebase-admin';
import { FieldValue } from 'firebase-admin/firestore';
import { randomUUID } from 'node:crypto';
import { ASSISTED_APPLICATIONS_COLLECTION } from './assistedApplicationConstants.js';
import { buildAssistedApplicationEvent } from './assistedApplicationAudit.js';
import { isAssistedApplicationCvKey, detectCvFileType } from './assistedApplicationCvCheck.js';
import { buildCoverLetterPdf, extractCvText } from './assistedApplicationAiDocuments.js';
import { buildFactIndex, checkGeneratedFacts } from './assistedApplicationAiFactCheck.js';
import { classifyApplicationChannel, fetchJobPosting, isPlausibleEmail } from './assistedApplicationAiJob.js';
import {
  DOCUMENTS_SCHEMA,
  PROFILE_SCHEMA,
  PROFILE_SYSTEM_PROMPT,
  REQUIREMENTS_SCHEMA,
  REQUIREMENTS_SYSTEM_PROMPT,
  documentsParts,
  documentsSystemPrompt,
  formatLetterDate,
  letterSubject,
  profileParts,
  requirementsParts,
  resolveLetterLanguage,
} from './assistedApplicationAiPrompts.js';
import { generateStructured, getAssistedApplicationAiConfig } from './assistedApplicationAiVertex.js';

export const AI_DRAFTS_SUBCOLLECTION = 'ai_drafts';
export const AI_DRAFT_DOC_ID = 'current';

const STORAGE_BUCKET =
  process.env.FIREBASE_STORAGE_BUCKET ||
  process.env.STORAGE_BUCKET ||
  'frontaliere-ticino.firebasestorage.app';

const RUN_CLAIM_TTL_MS = 6 * 60 * 1000;
const SEND_CLAIM_TTL_MS = 10 * 60 * 1000;
const CLOSED_STATUSES = new Set(['submitted', 'refunded', 'cancelled']);
const SENDABLE_STATUSES = new Set(['awaiting_upload', 'ready_for_manual_submission', 'in_progress']);
const SUPPORTED_CV_TYPES = new Set(['pdf', 'docx']);
const MAX_SOURCE_CHARS = 30_000;
const MAX_POSTING_EXCERPT = 6_000;
const OWNER_MAILBOX = 'valerie@frontaliereticino.ch';

const LETTER_FILE_LABEL = {
  it: 'Lettera di presentazione',
  de: 'Motivationsschreiben',
  fr: 'Lettre de motivation',
  en: 'Cover letter',
};

function clean(value, max = 500) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function cleanBlock(value, max = 4000) {
  return String(value ?? '').replace(/\r\n?/g, '\n').replace(/[ \t]+\n/g, '\n').trim().slice(0, max);
}

function millis(value) {
  if (!value) return 0;
  if (typeof value.toMillis === 'function') return value.toMillis();
  if (value instanceof Date) return value.getTime();
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function orderRefFor(db, orderId) {
  return db.collection(ASSISTED_APPLICATIONS_COLLECTION).doc(String(orderId));
}

export function draftRefFor(db, orderId) {
  return orderRefFor(db, orderId).collection(AI_DRAFTS_SUBCOLLECTION).doc(AI_DRAFT_DOC_ID);
}

function defaultBucket() {
  return admin.storage().bucket(STORAGE_BUCKET);
}

/** The CV of the order passed the magic-byte check for its current key. */
export function isCvReady(order) {
  const check = order?.cvFileCheck;
  return Boolean(order?.cvStorageKey && check && check.key === order.cvStorageKey && check.verdict === 'ok');
}

export function aiDraftEligibility(order, orderId) {
  if (!order || order.paymentStatus !== 'paid') return { eligible: false, reason: 'not_paid' };
  if (CLOSED_STATUSES.has(order.submissionStatus)) return { eligible: false, reason: 'order_closed' };
  if (!order.cvStorageKey) return { eligible: false, reason: 'cv_missing' };
  if (!isAssistedApplicationCvKey(orderId, order.cvStorageKey)) return { eligible: false, reason: 'cv_invalid_key' };
  if (!isCvReady(order)) return { eligible: false, reason: 'cv_not_verified' };
  if (!SUPPORTED_CV_TYPES.has(order.cvFileCheck.detectedType)) return { eligible: false, reason: 'cv_format_unsupported' };
  return { eligible: true, reason: null };
}

/**
 * Why (if at all) this order write should start a draft.
 *   'requested' — the owner pressed "Genera/Rigenera bozza AI" (always honoured);
 *   'cv_ready'  — a CV just passed the type check and the RC flag is on.
 */
export function aiDraftTriggerReason(before, after, { autoDraft = false } = {}) {
  if (!after) return null;
  if (after.aiDraftRequestId && after.aiDraftRequestId !== before?.aiDraftRequestId) return 'requested';
  if (!autoDraft) return null;
  const readyBefore = isCvReady(before) && before?.cvStorageKey === after.cvStorageKey;
  return isCvReady(after) && !readyBefore ? 'cv_ready' : null;
}

async function claimRun(db, orderId, order, trigger, nowMs) {
  const draftRef = draftRefFor(db, orderId);
  const runId = randomUUID();
  let outcome = { claimed: false, reason: null, previous: null };
  await db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(draftRef);
    const current = snapshot.exists ? snapshot.data() || {} : null;
    if (current?.status === 'running' && nowMs - millis(current.claimedAt) < RUN_CLAIM_TTL_MS) {
      outcome = { claimed: false, reason: 'already_running', previous: current };
      return;
    }
    if (trigger === 'cv_ready' && current?.status === 'ready' && current.cvKey === order.cvStorageKey) {
      outcome = { claimed: false, reason: 'already_drafted', previous: current };
      return;
    }
    transaction.set(draftRef, {
      status: 'running',
      runId,
      trigger,
      cvKey: order.cvStorageKey,
      requestId: order.aiDraftRequestId || null,
      claimedAt: new Date(nowMs),
      error: null,
    }, { merge: true });
    outcome = { claimed: true, reason: null, previous: current };
  });
  return { ...outcome, runId };
}

function candidateIdentity(order, profile) {
  const name = clean(order.applicantName, 200) || clean(profile?.fullName, 200);
  const email = clean(order.applicantEmail, 320) || clean(profile?.email, 320) || clean(order.customerEmail, 320);
  const phone = clean(order.applicantPhone, 80) || clean(profile?.phone, 80);
  return { name, email, phone };
}

function splitName(fullName) {
  const parts = clean(fullName, 200).split(' ').filter(Boolean);
  if (parts.length < 2) return { firstName: parts[0] || '', lastName: '' };
  return { firstName: parts.slice(0, -1).join(' '), lastName: parts[parts.length - 1] };
}

function letterText(letter) {
  return [letter.salutation, ...(letter.paragraphs || []), letter.closing].map((part) => cleanBlock(part, 3000)).filter(Boolean).join('\n\n');
}

/** Parse an operator-edited letter back into salutation / paragraphs / closing. */
export function parseLetterText(text) {
  const blocks = cleanBlock(text, 8000).split(/\n\s*\n/).map((block) => block.trim()).filter(Boolean);
  if (blocks.length <= 2) return { salutation: '', paragraphs: blocks, closing: '' };
  return { salutation: blocks[0], paragraphs: blocks.slice(1, -1), closing: blocks[blocks.length - 1] };
}

function field(key, label, value, { needsConfirmation = false, note = '' } = {}) {
  return { key, label, value: clean(value, 2000), needsConfirmation, note };
}

/**
 * Standard portal fields. Legal, salary and availability answers are never
 * made up (career-ops apply rule): when the CV is silent they are flagged for
 * the operator to ask the candidate.
 */
export function buildFormAnswers({ identity, profile, documents, requirements }) {
  const { firstName, lastName } = splitName(identity.name);
  const languages = (profile?.languages || []).map((item) => [item.language, item.level].filter(Boolean).join(' ')).filter(Boolean).join(', ');
  const salaryAsked = /salar|lohn|gehalt|rémunération|pretese|prétentions/i.test(requirements?.applicationInstructions || '');
  return [
    field('firstName', 'Nome', firstName),
    field('lastName', 'Cognome', lastName),
    field('email', 'Email', identity.email),
    field('phone', 'Telefono', identity.phone),
    field('location', 'Località', profile?.location || ''),
    field('linkedin', 'LinkedIn', profile?.linkedin || ''),
    field('workPermit', 'Permesso di lavoro', profile?.workPermit || '', {
      needsConfirmation: !profile?.workPermit,
      note: profile?.workPermit ? '' : 'Non indicato nel CV: chiedilo al candidato.',
    }),
    field('availability', 'Disponibilità / preavviso', profile?.availability || '', {
      needsConfirmation: !profile?.availability,
      note: profile?.availability ? '' : 'Non indicata nel CV.',
    }),
    field('salary', 'Pretese salariali', '', {
      needsConfirmation: true,
      note: salaryAsked ? 'L’annuncio le chiede: vanno confermate dal candidato.' : 'Mai inventate: solo se il candidato le fornisce.',
    }),
    field('languages', 'Lingue', languages),
    field('motivationShort', 'Motivazione (campo breve)', documents?.motivationShort || ''),
    field('whyCompany', 'Perché questa azienda', documents?.whyCompany || ''),
  ];
}

function sanitizeRequirements(raw) {
  const requirements = (Array.isArray(raw?.requirements) ? raw.requirements : []).slice(0, 12).map((item) => {
    const basis = item?.basis === 'inferred' ? 'inferred' : 'stated';
    let importance = ['critical', 'high', 'meaningful', 'preferred'].includes(item?.importance) ? item.importance : 'meaningful';
    // career-ops rule, enforced in code: an inferred row is never critical/high.
    if (basis === 'inferred' && (importance === 'critical' || importance === 'high')) importance = 'meaningful';
    return {
      requirement: clean(item?.requirement, 200),
      importance,
      basis,
      quote: basis === 'inferred' ? '' : clean(item?.quote, 400),
    };
  }).filter((item) => item.requirement);
  return {
    postingLanguage: clean(raw?.postingLanguage, 5).toLowerCase(),
    roleTitle: clean(raw?.roleTitle, 300),
    requirements,
    languageRequirements: (Array.isArray(raw?.languageRequirements) ? raw.languageRequirements : []).slice(0, 6).map((item) => ({
      language: clean(item?.language, 60), level: clean(item?.level, 60), quote: clean(item?.quote, 300),
    })).filter((item) => item.language),
    workPermitQuote: clean(raw?.workPermitQuote, 400),
    applicationEmail: clean(raw?.applicationEmail, 254),
    contactPerson: clean(raw?.contactPerson, 200),
    applicationInstructions: clean(raw?.applicationInstructions, 400),
  };
}

/** A quote the posting does not contain verbatim is dropped, not trusted. */
function verifyQuotes(requirements, postingText) {
  const haystack = clean(postingText, 100_000).toLowerCase();
  const holds = (quote) => !quote || haystack.includes(clean(quote, 400).toLowerCase());
  for (const item of requirements.requirements) {
    if (!holds(item.quote)) {
      item.quote = '';
      item.quoteUnverified = true;
    }
  }
  if (!holds(requirements.workPermitQuote)) requirements.workPermitQuote = '';
  if (requirements.applicationEmail && !haystack.includes(requirements.applicationEmail.toLowerCase())) {
    requirements.applicationEmail = '';
  }
  return requirements;
}

function sanitizeDocuments(raw, requirementCount, profileText) {
  const profileHaystack = clean(profileText, 200_000).toLowerCase();
  const matches = (Array.isArray(raw?.matches) ? raw.matches : [])
    .filter((item) => Number.isInteger(item?.index) && item.index >= 0 && item.index < requirementCount)
    .map((item) => {
      const evidence = clean(item?.evidence, 400);
      const verified = !evidence || profileHaystack.includes(evidence.toLowerCase());
      return {
        index: item.index,
        status: ['met', 'partial', 'missing'].includes(item?.status) ? item.status : 'missing',
        evidence: verified ? evidence : '',
        evidenceUnverified: !verified,
      };
    });
  const letter = raw?.coverLetter || {};
  return {
    matches,
    verdict: ['strong', 'good', 'weak', 'poor'].includes(raw?.verdict) ? raw.verdict : 'weak',
    summaryIt: clean(raw?.summaryIt, 800),
    checksIt: (Array.isArray(raw?.checksIt) ? raw.checksIt : []).map((item) => clean(item, 300)).filter(Boolean).slice(0, 8),
    coverLetter: {
      salutation: clean(letter.salutation, 200),
      paragraphs: (Array.isArray(letter.paragraphs) ? letter.paragraphs : []).map((item) => cleanBlock(item, 2000)).filter(Boolean).slice(0, 5),
      closing: clean(letter.closing, 200),
    },
    emailSubject: clean(raw?.emailSubject, 250),
    emailBody: cleanBlock(raw?.emailBody, 3000),
    motivationShort: clean(raw?.motivationShort, 600),
    whyCompany: clean(raw?.whyCompany, 400),
  };
}

function letterPdfBlocks({ identity, profile, posting, order, language, letter, title, now }) {
  const senderLines = [identity.name, clean(profile?.location, 200), identity.email, identity.phone];
  const recipientLines = [
    clean(order.companyName, 200),
    posting.contactPerson || '',
    posting.streetAddress || '',
    [posting.postalCode, posting.location].filter(Boolean).join(' '),
  ];
  const city = clean(profile?.location, 200).split(/[,(]/)[0].trim();
  const date = formatLetterDate(language, now);
  return {
    senderLines,
    recipientLines,
    placeDate: city ? `${city}, ${date}` : date,
    subject: letterSubject(language, title),
    salutation: letter.salutation,
    paragraphs: letter.paragraphs,
    closing: letter.closing,
    signature: identity.name,
    title: `${LETTER_FILE_LABEL[language] || LETTER_FILE_LABEL.it} – ${identity.name}`,
  };
}

async function deleteStorageKey(bucket, orderId, key) {
  if (!key || !isAssistedApplicationCvKey(orderId, key)) return;
  try {
    await bucket.file(key).delete({ ignoreNotFound: true });
  } catch (error) {
    console.warn('[assistedApplicationAi] old letter delete failed', orderId, error instanceof Error ? error.message : String(error));
  }
}

function errorCode(error) {
  const code = error?.code || error?.message || 'unknown_error';
  return String(code).replace(/[^A-Za-z0-9_:.-]/g, '_').slice(0, 120);
}

/**
 * Run the draft for one order. Safe to call concurrently: a transaction claims
 * the run, and a stale claim (crashed instance) expires after 6 minutes.
 */
export async function runAssistedApplicationAiDraft({
  db,
  orderId,
  trigger = 'requested',
  bucket = null,
  generate = generateStructured,
  fetchPosting = fetchJobPosting,
  config = null,
  nowMs = Date.now(),
} = {}) {
  const orderSnapshot = await orderRefFor(db, orderId).get();
  if (!orderSnapshot.exists) return { ok: false, skipped: true, reason: 'order_not_found' };
  const order = orderSnapshot.data() || {};
  const draftRef = draftRefFor(db, orderId);

  const eligibility = aiDraftEligibility(order, orderId);
  if (!eligibility.eligible) {
    // Only an explicit owner request leaves a visible trace of the refusal.
    if (trigger === 'requested') {
      await draftRef.set({ status: 'skipped', error: eligibility.reason, updatedAt: new Date(nowMs) }, { merge: true });
    }
    return { ok: false, skipped: true, reason: eligibility.reason };
  }

  const claim = await claimRun(db, orderId, order, trigger, nowMs);
  if (!claim.claimed) return { ok: false, skipped: true, reason: claim.reason };

  const storage = bucket || defaultBucket();
  const settings = config || await getAssistedApplicationAiConfig();
  const callOptions = { model: settings.model, location: settings.location };
  const usage = { input: 0, output: 0, thinking: 0 };
  const addUsage = (result) => {
    usage.input += result.usage?.input || 0;
    usage.output += result.usage?.output || 0;
    usage.thinking += result.usage?.thinking || 0;
    return result.data;
  };

  try {
    const [cvBuffer] = await storage.file(order.cvStorageKey).download();
    // Re-check the bytes we are about to send: the key may have been
    // replaced between the type check and this run.
    const cvType = detectCvFileType(cvBuffer.subarray(0, 8));
    if (!SUPPORTED_CV_TYPES.has(cvType)) throw new Error('cv_format_unsupported');
    const cvText = await extractCvText(cvBuffer, cvType).catch(() => '');
    if (cvType === 'docx' && !cvText) throw new Error('cv_text_empty');

    const profile = addUsage(await generate({
      ...callOptions,
      systemPrompt: PROFILE_SYSTEM_PROMPT,
      parts: profileParts(cvType === 'pdf' ? { pdfBase64: cvBuffer.toString('base64') } : { cvText }),
      schema: PROFILE_SCHEMA,
      temperature: 0,
      thinkingBudget: 0,
      maxOutputTokens: 8192,
    }));

    const posting = await fetchPosting(order);
    const postingText = posting.text || `${order.jobTitle || ''} — ${order.companyName || ''}`;
    const requirements = verifyQuotes(sanitizeRequirements(addUsage(await generate({
      ...callOptions,
      systemPrompt: REQUIREMENTS_SYSTEM_PROMPT,
      parts: requirementsParts({
        jobTitle: order.jobTitle,
        companyName: order.companyName,
        location: posting.location,
        postingText,
      }),
      schema: REQUIREMENTS_SCHEMA,
      temperature: 0,
      thinkingBudget: 1024,
      maxOutputTokens: 4096,
    }))), postingText);

    const language = resolveLetterLanguage(requirements.postingLanguage, order.locale);
    const title = clean(posting.titles?.[language], 300) || requirements.roleTitle || clean(order.jobTitle, 300);
    const identity = candidateIdentity(order, profile);
    const profileJson = JSON.stringify(profile);

    const documents = sanitizeDocuments(addUsage(await generate({
      ...callOptions,
      systemPrompt: documentsSystemPrompt(language),
      parts: documentsParts({
        candidateName: identity.name,
        profile,
        requirements,
        posting: {
          title,
          company: order.companyName,
          location: posting.location,
          contactPerson: requirements.contactPerson || posting.contactPerson,
          applicationInstructions: requirements.applicationInstructions,
        },
        postingExcerpt: postingText.slice(0, MAX_POSTING_EXCERPT),
      }),
      schema: DOCUMENTS_SCHEMA,
      temperature: 0.3,
      thinkingBudget: 2048,
      maxOutputTokens: 8192,
    })), requirements.requirements.length, `${cvText}\n${profileJson}`);

    if (!documents.coverLetter.paragraphs.length || !documents.emailBody) throw new Error('documents_empty');

    // The CV text is the strict source; a scanned PDF (no text layer) falls
    // back to the extracted profile, and the draft says so.
    const factBasis = cvText ? 'cv_text' : 'profile';
    const sourceText = (cvText || profileJson).slice(0, MAX_SOURCE_CHARS);
    const orderFacts = [order.jobTitle, order.companyName, identity.name, identity.email, identity.phone, title].join('\n');
    const factIndex = buildFactIndex([sourceText, postingText, orderFacts]);
    const letterBody = letterText(documents.coverLetter);
    const factCheck = checkGeneratedFacts({
      coverLetter: letterBody,
      emailSubject: documents.emailSubject,
      emailBody: documents.emailBody,
      motivationShort: documents.motivationShort,
      whyCompany: documents.whyCompany,
    }, factIndex);

    const channel = classifyApplicationChannel({
      applyUrl: posting.applyUrl || order.jobUrl,
      postingText,
      applicationEmail: requirements.applicationEmail,
    });

    const now = new Date(nowMs);
    const pdf = buildCoverLetterPdf(letterPdfBlocks({
      identity, profile, posting, order, language, letter: documents.coverLetter, title, now,
    }));
    const pdfKey = `assisted-application-uploads/${orderId}/ai-cover-letter-${nowMs}.pdf`;
    await storage.file(pdfKey).save(pdf, { contentType: 'application/pdf', resumable: false });

    const signature = [identity.name, identity.email, identity.phone].filter(Boolean).join('\n');
    const draft = {
      status: 'ready',
      runId: claim.runId,
      cvKey: order.cvStorageKey,
      model: settings.model,
      location: settings.location,
      usage,
      completedAt: FieldValue.serverTimestamp(),
      error: null,
      language,
      job: {
        source: posting.source,
        title,
        applyUrl: channel.applyUrl || clean(order.jobUrl, 1000),
      },
      channel,
      requirements: requirements.requirements,
      languageRequirements: requirements.languageRequirements,
      workPermitQuote: requirements.workPermitQuote,
      applicationInstructions: requirements.applicationInstructions,
      contactPerson: requirements.contactPerson || posting.contactPerson,
      matches: documents.matches,
      verdict: documents.verdict,
      summaryIt: documents.summaryIt,
      checksIt: documents.checksIt,
      coverLetter: { ...documents.coverLetter, text: letterBody, subject: letterSubject(language, title) },
      applicationEmail: {
        to: channel.email || '',
        subject: documents.emailSubject || letterSubject(language, title),
        body: `${documents.emailBody}\n\n${signature}`.trim(),
      },
      formAnswers: buildFormAnswers({ identity, profile, documents, requirements }),
      profile,
      factCheck: { ...factCheck, basis: factBasis },
      factSources: { text: sourceText, posting: postingText.slice(0, MAX_SOURCE_CHARS), order: orderFacts },
      coverLetterPdfKey: pdfKey,
    };

    // Our claim may have expired and been taken over; never overwrite a newer run.
    const latest = await draftRef.get();
    if (latest.exists && latest.data()?.runId !== claim.runId) {
      await deleteStorageKey(storage, orderId, pdfKey);
      return { ok: false, skipped: true, reason: 'superseded' };
    }
    await draftRef.set(draft, { merge: false });
    await deleteStorageKey(storage, orderId, claim.previous?.coverLetterPdfKey);
    return { ok: true, verdict: documents.verdict, factCheckOk: factCheck.ok, channel: channel.type, usage };
  } catch (error) {
    const code = errorCode(error);
    console.error('[assistedApplicationAi] draft failed', orderId, code);
    await draftRef.set({ status: 'failed', error: code, failedAt: new Date(nowMs), runId: claim.runId }, { merge: true });
    return { ok: false, error: code };
  }
}

/** Firestore onDocumentWritten entry point (index.js). */
export async function handleAssistedApplicationAiTrigger(before, after, orderId, { db, loadConfig = getAssistedApplicationAiConfig, run = runAssistedApplicationAiDraft } = {}) {
  if (!after) return { ok: true, skipped: 'deleted' };
  const requested = after.aiDraftRequestId && after.aiDraftRequestId !== before?.aiDraftRequestId;
  // Only read Remote Config when a CV might have just become ready.
  const cvJustReady = isCvReady(after) && !(isCvReady(before) && before?.cvStorageKey === after.cvStorageKey);
  if (!requested && !cvJustReady) return { ok: true, skipped: 'no_trigger' };
  const config = await loadConfig();
  const trigger = aiDraftTriggerReason(before, after, config);
  if (!trigger) return { ok: true, skipped: 'auto_draft_disabled' };
  return run({ db, orderId, trigger, config });
}

// ── Owner queue helpers ────────────────────────────────────────────────────

function isoOrNull(value) {
  const ms = millis(value);
  return ms ? new Date(ms).toISOString() : null;
}

/** Draft as the admin queue shows it (no raw CV text). */
export async function loadAiDraftForAdmin(db, orderId, { signUrl } = {}) {
  const snapshot = await draftRefFor(db, orderId).get();
  if (!snapshot.exists) return null;
  const draft = snapshot.data() || {};
  const letterUrl = draft.status === 'ready' && signUrl && isAssistedApplicationCvKey(orderId, draft.coverLetterPdfKey)
    ? await signUrl(draft.coverLetterPdfKey).catch(() => null)
    : null;
  return {
    status: clean(draft.status, 20) || null,
    error: clean(draft.error, 120) || null,
    trigger: clean(draft.trigger, 20) || null,
    model: clean(draft.model, 80) || null,
    claimedAt: isoOrNull(draft.claimedAt),
    completedAt: isoOrNull(draft.completedAt),
    stale: Boolean(draft.cvKey) && draft.status === 'ready' ? undefined : undefined,
    language: clean(draft.language, 5) || null,
    job: draft.job || null,
    channel: draft.channel || null,
    verdict: draft.verdict || null,
    summaryIt: draft.summaryIt || '',
    checksIt: Array.isArray(draft.checksIt) ? draft.checksIt : [],
    requirements: Array.isArray(draft.requirements) ? draft.requirements : [],
    languageRequirements: Array.isArray(draft.languageRequirements) ? draft.languageRequirements : [],
    matches: Array.isArray(draft.matches) ? draft.matches : [],
    workPermitQuote: draft.workPermitQuote || '',
    applicationInstructions: draft.applicationInstructions || '',
    contactPerson: draft.contactPerson || '',
    coverLetter: draft.coverLetter || null,
    applicationEmail: draft.applicationEmail || null,
    formAnswers: Array.isArray(draft.formAnswers) ? draft.formAnswers : [],
    factCheck: draft.factCheck || null,
    coverLetterUrl: letterUrl,
    emailSend: draft.emailSend
      ? {
        status: clean(draft.emailSend.status, 20),
        to: clean(draft.emailSend.to, 320),
        sentAt: isoOrNull(draft.emailSend.sentAt),
        error: clean(draft.emailSend.lastError, 200) || null,
      }
      : null,
  };
}

/** "Genera/Rigenera bozza AI": the trigger picks the request id up. */
export async function requestAiDraft(db, orderId, adminEmail) {
  const orderRef = orderRefFor(db, orderId);
  const snapshot = await orderRef.get();
  if (!snapshot.exists) return { ok: false, error: 'order_not_found', status: 404 };
  const order = snapshot.data() || {};
  const eligibility = aiDraftEligibility(order, orderId);
  if (!eligibility.eligible) return { ok: false, error: eligibility.reason, status: 409 };
  const requestId = randomUUID();
  await orderRef.set({
    aiDraftRequestId: requestId,
    aiDraftRequestedAt: FieldValue.serverTimestamp(),
  }, { merge: true });
  await orderRef.collection('events').doc().set(buildAssistedApplicationEvent('ai_draft_requested', {
    actorEmail: adminEmail,
    requestId,
  }));
  return { ok: true, requestId };
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function textToHtml(text) {
  return cleanBlock(text, 10_000)
    .split(/\n\s*\n/)
    .map((paragraph) => `<p>${escapeHtml(paragraph).replace(/\n/g, '<br>')}</p>`)
    .join('');
}

function safeFileStem(value) {
  return clean(value, 80)
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '') || 'Candidato';
}

function senderName(name) {
  const safe = clean(name, 80).replace(/["<>\\]/g, '');
  return safe ? `"${safe} via Frontaliere Ticino"` : 'Frontaliere Ticino';
}

export class AssistedApplicationSendError extends Error {
  constructor(code, status = 400, details = null) {
    super(code);
    this.name = 'AssistedApplicationSendError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

/**
 * Owner-approved e-mail application to the employer: CV and cover letter
 * attached, reply-to the candidate, then the order moves to `submitted`
 * (which sends the existing "inviata" e-mail to the customer).
 */
export async function sendAssistedApplicationEmail({
  db,
  orderId,
  input,
  adminEmail,
  bucket = null,
  sendCascade = null,
  ensureProviders = null,
  nowMs = Date.now(),
}) {
  const to = clean(input?.to, 320).toLowerCase();
  const subject = clean(input?.subject, 300);
  const body = cleanBlock(input?.body, 8000);
  const letterOverride = cleanBlock(input?.coverLetterText, 8000);
  const acknowledge = input?.acknowledgeFactWarnings === true;
  if (!isPlausibleEmail(to) || !subject || !body) throw new AssistedApplicationSendError('invalid_input', 400);
  if (to === OWNER_MAILBOX) throw new AssistedApplicationSendError('invalid_recipient', 400);

  const orderRef = orderRefFor(db, orderId);
  const draftRef = draftRefFor(db, orderId);
  const [orderSnapshot, draftSnapshot] = await Promise.all([orderRef.get(), draftRef.get()]);
  if (!orderSnapshot.exists) throw new AssistedApplicationSendError('order_not_found', 404);
  const order = orderSnapshot.data() || {};
  if (order.paymentStatus !== 'paid') throw new AssistedApplicationSendError('payment_not_confirmed', 409);
  if (order.refundStatus === 'pending') throw new AssistedApplicationSendError('refund_in_progress', 409);
  if (!SENDABLE_STATUSES.has(order.submissionStatus)) throw new AssistedApplicationSendError('invalid_transition', 409);
  if (!isCvReady(order) || !isAssistedApplicationCvKey(orderId, order.cvStorageKey)) {
    throw new AssistedApplicationSendError('cv_not_verified', 409);
  }
  const draft = draftSnapshot.exists ? draftSnapshot.data() || {} : null;
  if (!draft || draft.status !== 'ready') throw new AssistedApplicationSendError('ai_draft_not_ready', 409);
  if (draft.cvKey !== order.cvStorageKey) throw new AssistedApplicationSendError('ai_draft_stale', 409);

  const sources = draft.factSources || {};
  const factCheck = checkGeneratedFacts(
    { emailSubject: subject, emailBody: body, coverLetter: letterOverride || draft.coverLetter?.text || '' },
    buildFactIndex([sources.text, sources.posting, sources.order]),
  );
  if (!factCheck.ok && !acknowledge) {
    throw new AssistedApplicationSendError('fact_check_failed', 409, factCheck.unsupported.slice(0, 20));
  }

  // Claim the send: a double click or a retried request must not mail twice.
  await db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(draftRef);
    const current = snapshot.data()?.emailSend;
    if (current?.status === 'sent' || current?.status === 'ambiguous') {
      throw new AssistedApplicationSendError('already_sent', 409);
    }
    if (current?.status === 'sending' && nowMs - millis(current.claimedAt) < SEND_CLAIM_TTL_MS) {
      throw new AssistedApplicationSendError('send_in_progress', 409);
    }
    transaction.set(draftRef, {
      emailSend: { status: 'sending', to, claimedAt: new Date(nowMs), actorEmail: adminEmail },
    }, { merge: true });
  });

  const storage = bucket || defaultBucket();
  const identity = {
    name: clean(order.applicantName, 200) || clean(draft.profile?.fullName, 200),
    email: clean(order.applicantEmail, 320) || clean(draft.profile?.email, 320) || clean(order.customerEmail, 320),
  };
  const language = draft.language || 'it';
  let cvBuffer;
  let letterPdf;
  try {
    [cvBuffer] = await storage.file(order.cvStorageKey).download();
    if (letterOverride && letterOverride !== cleanBlock(draft.coverLetter?.text, 8000)) {
      const posting = {
        contactPerson: draft.contactPerson || '', streetAddress: '', postalCode: '', location: '',
      };
      letterPdf = buildCoverLetterPdf(letterPdfBlocks({
        identity: { ...identity, phone: clean(order.applicantPhone, 80) || clean(draft.profile?.phone, 80) },
        profile: draft.profile || {},
        posting,
        order,
        language,
        letter: parseLetterText(letterOverride),
        title: draft.job?.title || order.jobTitle || '',
        now: new Date(nowMs),
      }));
    } else {
      [letterPdf] = await storage.file(draft.coverLetterPdfKey).download();
    }
  } catch (error) {
    await draftRef.set({ emailSend: { status: 'failed', to, lastError: 'attachment_read_failed', failedAt: new Date(nowMs) } }, { merge: true });
    throw new AssistedApplicationSendError('attachment_read_failed', 500);
  }

  const cvType = detectCvFileType(cvBuffer.subarray(0, 8));
  const stem = safeFileStem(identity.name);
  const attachments = [
    { filename: `CV_${stem}.${cvType === 'docx' ? 'docx' : 'pdf'}`, content: cvBuffer.toString('base64') },
    { filename: `${safeFileStem(LETTER_FILE_LABEL[language] || LETTER_FILE_LABEL.it)}_${stem}.pdf`, content: Buffer.from(letterPdf).toString('base64') },
  ];

  const cascade = sendCascade || (await import('./emailCascade.js')).sendEmailCascade;
  const providersReady = ensureProviders || (async () => {
    const { bridgeEmailCascadeCredentialsToEnv } = await import('./remoteConfigSecrets.js');
    const { isProviderConfigured } = await import('./emailCascade.js');
    await bridgeEmailCascadeCredentialsToEnv();
    return isProviderConfigured('resend');
  });
  if (!(await providersReady())) {
    await draftRef.set({ emailSend: { status: 'failed', to, lastError: 'resend_not_configured', failedAt: new Date(nowMs) } }, { merge: true });
    throw new AssistedApplicationSendError('resend_not_configured', 503);
  }

  const { failed, ambiguous, sent } = await cascade([{
    payload: {
      from: `${senderName(identity.name)} <${OWNER_MAILBOX}>`,
      to: [to],
      subject,
      text: body,
      html: textToHtml(body),
      ...(identity.email ? { replyTo: identity.email } : {}),
      attachments,
      tracking: false,
    },
    recipient: { email: to },
    meta: { orderId: String(orderId), key: 'employer_application' },
  }], { delayMs: 0, forceProvider: 'resend' });

  if (failed.length > 0) {
    const status = failed[0].ambiguousDelivery ? 'ambiguous' : 'failed';
    await draftRef.set({
      emailSend: { status, to, lastError: clean(failed[0].error, 200), failedAt: new Date(nowMs) },
    }, { merge: true });
    throw new AssistedApplicationSendError(`send_${status}`, 502);
  }

  const outcome = sent[0] || {};
  await draftRef.set({
    emailSend: {
      status: ambiguous.length > 0 ? 'ambiguous' : 'sent',
      to,
      subject,
      provider: outcome.provider || null,
      messageId: outcome.messageId || null,
      sentAt: FieldValue.serverTimestamp(),
      actorEmail: adminEmail,
      factWarningsAcknowledged: !factCheck.ok,
    },
  }, { merge: true });

  // Same transition the "Segna come inviata" button performs.
  const notes = `Candidatura inviata via email a ${to} (bozza AI approvata).`;
  await db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(orderRef);
    const current = snapshot.data() || {};
    if (!SENDABLE_STATUSES.has(current.submissionStatus)) return;
    const timestamp = FieldValue.serverTimestamp();
    transaction.set(orderRef, {
      submissionStatus: 'submitted',
      submittedAt: timestamp,
      statusChangedAt: timestamp,
      updatedAt: timestamp,
      submissionNotes: notes,
    }, { merge: true });
    transaction.set(orderRef.collection('events').doc(), buildAssistedApplicationEvent('manual_submission_completed', {
      actorEmail: adminEmail,
      fromStatus: current.submissionStatus,
      toStatus: 'submitted',
      submissionNotes: notes,
      channel: 'email',
    }));
  });
  return { ok: true, to, provider: outcome.provider || null, factWarningsAcknowledged: !factCheck.ok };
}
