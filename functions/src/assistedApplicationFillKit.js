/**
 * The fill kit of one order, for the owner's browser extension
 * (scripts/assisted-application/extension). Owner decision 2026-10-01: when
 * a portal refuses the robot (JOIN's invisible reCAPTCHA), Valerie sends the
 * application herself — the candidate paid for the sending — and the
 * extension types for her what the portal runner would have typed, leaving
 * her the final click.
 *
 * The same sources as the runner (scripts/assisted-application/lib/submit.mjs):
 * the candidate with their review-page edits (candidateWithEdits), the CV
 * facts, the approved answers, and first of all the answers the runner put
 * on this very portal in its last pass (`portalAnswers`, worded as the
 * portal asks). The documents travel as signed links the extension downloads.
 */

import { LETTER_FILE_LABEL, safeFileStem } from './assistedApplicationAiDraftCore.js';
import { candidateWithEdits } from './assistedApplicationCandidateEdits.js';
import { extraDocumentFileName } from './assistedApplicationExtraDocuments.js';
import { isoDateOf } from './lib/cvPeriod.js';
import { permitStatement, printedPermitText } from './lib/permitStatus.js';

const text = (value, max = 500) => String(value ?? '').trim().slice(0, max);

/**
 * @param {{orderId:string, order?:object, draft?:object, flow?:object,
 *   documents?:{cv?:{url:string, extension?:string}|null, coverLetter?:{url:string}|null,
 *     extra?:Array<{slot:string, label:string, kind:string, keywords?:string[], files:Array<{url:string, detectedType:string}>}>}}} input
 * @returns {object} the kit (no secret: what the extension types and attaches)
 */
export function buildFillKit({ orderId, order = {}, draft = {}, flow = {}, documents = {} }) {
  const { identity, profile, answers } = candidateWithEdits({ order, draft, flow });
  const address = profile.address || {};
  // The runner's own answers first: their questions are the portal's words.
  const fromPortal = (draft.portalAnswers?.answers || [])
    .map((item) => ({ question: item?.question, answer: item?.answer, source: item?.source || 'portal' }));
  const fromDraft = (draft.questions || [])
    .map((question) => ({ question: question.question, answer: answers[question.id], source: 'answers' }));
  const seen = new Set();
  const kitAnswers = [...fromPortal, ...fromDraft]
    .map((item) => ({ question: text(item.question, 300), answer: text(item.answer, 2000), source: text(item.source, 20) }))
    .filter((item) => {
      const key = item.question.toLowerCase();
      if (!item.question || !item.answer || seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 60);
  const motivation = Object.fromEntries((draft.formAnswers || []).map((field) => [field?.key, field?.value]));
  // The file names the runner gives them (lib/submit.mjs).
  const stem = safeFileStem(identity.name);
  const language = LETTER_FILE_LABEL[draft.language] ? draft.language : 'it';
  return {
    version: 1,
    orderId,
    applyUrl: text(draft.channel?.applyUrl || draft.job?.applyUrl, 2000),
    job: { title: text(draft.job?.title || order.jobTitle, 200), company: text(order.companyName, 200) },
    language,
    identity: {
      firstName: text(identity.firstName, 100),
      lastName: text(identity.lastName, 100),
      fullName: text(identity.name, 200),
      email: text(identity.email, 200),
      phone: text(identity.phone, 40),
      location: text(profile.location, 200),
      address: {
        street: text(address.street, 200),
        postalCode: text(address.postalCode, 20),
        city: text(address.city, 100),
        country: text(address.country, 100),
      },
      linkedin: text(profile.linkedin, 300),
      website: text(profile.website, 300),
    },
    profile: {
      // In a form the extension reads (parseDate reads only numeric dates).
      dateOfBirth: text(isoDateOf(profile.dateOfBirth) || profile.dateOfBirth, 20),
      nationality: text(profile.nationality, 100),
      // The status the candidate chose, as the portal planner's sentence; nothing chosen: the CV's own words.
      workPermit: text(profile.permitStatus ? permitStatement(profile.permitStatus, language) : printedPermitText(profile.workPermit), 200),
      availability: text(profile.availability, 200),
      salary: text(answers.salary_expectation, 200),
    },
    answers: kitAnswers,
    texts: {
      coverLetter: text(draft.coverLetter?.text, 8000),
      motivationShort: text(motivation.motivationShort, 2000),
      whyCompany: text(motivation.whyCompany, 2000),
    },
    documents: {
      cv: documents.cv?.url ? { url: documents.cv.url, fileName: `CV_${stem}.${documents.cv.extension || 'pdf'}` } : null,
      coverLetter: documents.coverLetter?.url ? { url: documents.coverLetter.url, fileName: `${safeFileStem(LETTER_FILE_LABEL[language])}_${stem}.pdf` } : null,
      // The requested documents (school reports, test results…) the candidate gave, by form slot.
      extra: (documents.extra || []).map((document) => {
        const files = (document.files || []).filter((file) => file?.url);
        return {
          slot: text(document.slot, 20),
          label: text(document.label, 160),
          kind: text(document.kind, 30),
          keywords: (document.keywords || []).map((word) => text(word, 40)).filter(Boolean).slice(0, 12),
          files: files.map((file, index) => ({ url: file.url, fileName: extraDocumentFileName({ label: document.label, index, count: files.length, name: identity.name, type: file.detectedType }) })),
        };
      }).filter((document) => document.slot && document.files.length),
    },
  };
}
