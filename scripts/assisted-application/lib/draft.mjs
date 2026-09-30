/**
 * Draft mode of the assisted-application agent (GitHub Actions).
 *
 *   liveness gate → CV text → Codex: profile ∥ requirements → match → documents
 *   → fact gate → letter PDF → ai_drafts/current + encrypted archive → event
 *
 * A regeneration after the candidate's feedback reuses the profile and the
 * requirements of the previous draft when the CV and the posting are the
 * same, so only the two calls that depend on the feedback run again.
 */

import { buildCoverLetterPdf } from '../../../functions/src/assistedApplicationAiDocuments.js';
import {
  buildFormAnswers,
  candidateIdentity,
  checkDraftFacts,
  ensureRequiredQuestions,
  letterPdfBlocks,
  letterText,
  sanitizeDocuments,
  sanitizeMatch,
  sanitizeProfile,
  sanitizeRequirements,
  verifyQuotes,
} from '../../../functions/src/assistedApplicationAiDraftCore.js';
import { classifyApplicationChannel, fetchJobPosting } from '../../../functions/src/assistedApplicationAiJob.js';
import {
  DOCUMENTS_SCHEMA,
  MATCH_SCHEMA,
  PROFILE_SCHEMA,
  PROFILE_SYSTEM_PROMPT,
  REQUIREMENTS_SCHEMA,
  REQUIREMENTS_SYSTEM_PROMPT,
  codexPrompt,
  documentsSystemPrompt,
  documentsUserText,
  letterSubject,
  matchSystemPrompt,
  matchUserText,
  profileUserText,
  requirementsUserText,
  resolveLetterLanguage,
} from '../../../functions/src/assistedApplicationAiPrompts.js';
import { atsReport } from '../../../functions/src/assistedApplicationAts.js';
import { assessLegitimacy } from '../../../functions/src/assistedApplicationLegitimacy.js';
import {
  TAILORED_CV_SCHEMA,
  buildTailoredCvPdf,
  checkTailoredCvFacts,
  sanitizeTailoredCv,
  tailoredCvPlainText,
  tailoredCvSystemPrompt,
  tailoredCvUserText,
} from '../../../functions/src/assistedApplicationTailoredCv.js';
import { readCvText } from './cv-text.mjs';
import { checkPostingLiveness } from './posting-liveness.mjs';
import { maskValues, personalValuesOf, storeEvidence } from './secure-run.mjs';

const MAX_SOURCE_CHARS = 30_000;
const MAX_POSTING_EXCERPT = 6_000;
const CODEX_TIMEOUT_MS = 600_000;
const CANDIDATE_LOCALES = new Set(['it', 'de', 'fr', 'en']);

export class DraftAbort extends Error {
  constructor(eventType, code) {
    super(code);
    this.eventType = eventType;
    this.code = code;
  }
}

function candidateLocale(order) {
  return CANDIDATE_LOCALES.has(order?.locale) ? order.locale : 'it';
}

/**
 * @param {object} ctx
 * @param {object} ctx.order order document data
 * @param {string} ctx.orderId
 * @param {object} ctx.flow automation/flow data (round, answers, feedback)
 * @param {object|null} ctx.previousDraft ai_drafts/current before this run
 * @param {Buffer} ctx.cvBuffer
 * @param {string} ctx.cvType 'pdf' | 'docx' | 'doc'
 * @param {(req:{prompt:string, schema:object, timeoutMs:number})=>Promise<object>} ctx.codex
 * @param {object} ctx.bucket Storage bucket
 * @param {Buffer} ctx.runKey evidence key
 * @param {typeof fetch} [ctx.fetchImpl]
 * @param {number} [ctx.nowMs]
 * @returns {Promise<object>} the draft document to write
 */
export async function buildDraft(ctx) {
  const { order, orderId, flow, previousDraft, cvBuffer, cvType, codex, bucket, runKey } = ctx;
  const fetchImpl = ctx.fetchImpl || fetch;
  const nowMs = ctx.nowMs || Date.now();
  const round = Number(flow?.round) || 1;
  const answers = flow?.answers || {};
  // Fase 2: what the candidate wrote in the e-mail that carried the CV.
  const candidateNotes = String(ctx.intake?.emailNotes || '').slice(0, 4000);
  const log = ctx.log || ((...args) => console.log('[assisted-application]', ...args));
  maskValues(personalValuesOf(order));

  const posting = await fetchJobPosting(order, { fetchImpl });
  const liveness = await checkPostingLiveness({ order, posting, fetchImpl, resolve: ctx.resolve });
  log('liveness', liveness.page?.result || 'n/a', liveness.page?.code || '', liveness.closed ? 'CLOSED' : '');
  if (liveness.closed) throw new DraftAbort('posting_closed', `posting_closed:${liveness.page?.code || 'dataset'}`);
  const postingText = posting.text || `${order.jobTitle || ''} — ${order.companyName || ''}`;

  const reuse = previousDraft?.status === 'ready'
    && previousDraft.cvKey === order.cvStorageKey
    && previousDraft.postingHash === hashText(postingText)
    && previousDraft.profile && previousDraft.requirementsRaw;

  let cvText = previousDraft?.factSources?.text && reuse ? previousDraft.factSources.text : '';
  let cvMethod = reuse ? previousDraft.cvTextMethod : 'none';
  let profile;
  let requirements;
  if (reuse) {
    profile = previousDraft.profile;
    requirements = previousDraft.requirementsRaw;
    log('reusing profile and requirements of the previous round');
  } else {
    const cv = await readCvText(cvBuffer, cvType);
    cvText = cv.text;
    cvMethod = cv.method;
    log('cv text', cv.method, `${cv.text.length} chars`);
    if (cv.text.length < 80) throw new DraftAbort('draft_failed', `cv_unreadable:${cv.method}`);
    const [profileRaw, requirementsRaw] = await Promise.all([
      codex({ prompt: codexPrompt(PROFILE_SYSTEM_PROMPT, profileUserText(cv.text)), schema: PROFILE_SCHEMA, timeoutMs: CODEX_TIMEOUT_MS }),
      codex({
        prompt: codexPrompt(REQUIREMENTS_SYSTEM_PROMPT, requirementsUserText({
          jobTitle: order.jobTitle, companyName: order.companyName, location: posting.location, postingText,
        })),
        schema: REQUIREMENTS_SCHEMA,
        timeoutMs: CODEX_TIMEOUT_MS,
      }),
    ]);
    profile = sanitizeProfile(profileRaw);
    requirements = verifyQuotes(sanitizeRequirements(requirementsRaw), postingText);
  }
  maskValues(personalValuesOf(order, profile));

  const locale = candidateLocale(order);
  const profileJson = JSON.stringify(profile);
  const language = resolveLetterLanguage(requirements.postingLanguage, order.locale);
  const title = String(posting.titles?.[language] || requirements.roleTitle || order.jobTitle || '').slice(0, 300);
  const identity = candidateIdentity(order, profile);
  // The tailored ATS CV needs only the profile and the requirements: it runs
  // while the match and the letter are written.
  const tailoredCvPromise = buildTailoredCv({
    codex, bucket, orderId, round, nowMs, log, profile, requirements, title, language, identity, answers, candidateNotes,
    cvText, postingExcerpt: postingText.slice(0, MAX_POSTING_EXCERPT),
  });
  const matchRaw = await codex({
    prompt: codexPrompt(matchSystemPrompt(locale), matchUserText({
      profile, requirements, answers, candidateNotes, postingExcerpt: postingText.slice(0, MAX_POSTING_EXCERPT),
    })),
    schema: MATCH_SCHEMA,
    timeoutMs: CODEX_TIMEOUT_MS,
  });
  const match = sanitizeMatch(matchRaw, requirements.requirements.length, `${cvText}\n${profileJson}\n${JSON.stringify(answers)}\n${candidateNotes}`);
  const questions = ensureRequiredQuestions(match.questions, { requirements, profile, answers, locale });

  const documentsRaw = await codex({
    prompt: codexPrompt(documentsSystemPrompt(language), documentsUserText({
      candidateName: identity.name,
      profile,
      requirements,
      matches: match.matches,
      answers,
      candidateNotes,
      feedback: flow?.feedback || [],
      posting: {
        title,
        company: order.companyName,
        location: posting.location,
        contactPerson: requirements.contactPerson || posting.contactPerson,
        applicationInstructions: requirements.applicationInstructions,
      },
      postingExcerpt: postingText.slice(0, MAX_POSTING_EXCERPT),
    })),
    schema: DOCUMENTS_SCHEMA,
    timeoutMs: CODEX_TIMEOUT_MS,
  });
  const documents = sanitizeDocuments(documentsRaw);
  if (!documents.coverLetter.paragraphs.length || !documents.emailBody) throw new DraftAbort('draft_failed', 'documents_empty');

  // The CV text is the strict source of facts; the answers the candidate gave
  // are facts too. A CV with no readable text never gets here.
  const factSources = {
    text: cvText.slice(0, MAX_SOURCE_CHARS),
    posting: postingText.slice(0, MAX_SOURCE_CHARS),
    order: [order.jobTitle, order.companyName, identity.name, identity.email, identity.phone, title].join('\n'),
    answers: [...Object.values(answers), candidateNotes].join('\n'),
  };
  const letterBody = letterText(documents.coverLetter);
  const factCheck = checkDraftFacts({
    coverLetter: letterBody,
    emailSubject: documents.emailSubject,
    emailBody: documents.emailBody,
    motivationShort: documents.motivationShort,
    whyCompany: documents.whyCompany,
  }, factSources);

  const channel = classifyApplicationChannel({
    applyUrl: posting.applyUrl || order.jobUrl,
    postingText,
    applicationEmail: requirements.applicationEmail,
  });

  const pdf = buildCoverLetterPdf(letterPdfBlocks({
    identity, profile, posting, companyName: order.companyName, language, letter: documents.coverLetter, title, now: new Date(nowMs),
  }));
  const pdfKey = `assisted-application-uploads/${orderId}/ai-cover-letter-r${round}-${nowMs}.pdf`;
  await bucket.file(pdfKey).save(pdf, { contentType: 'application/pdf', resumable: false });

  // Extras (career-ops): the ATS check of the candidate's own CV and of the
  // tailored one, and the posting's legitimacy tier (Block G).
  const tailored = await tailoredCvPromise;
  const ats = {
    original: atsReport({ requirements: requirements.requirements, roleTitle: requirements.roleTitle, cvText, cvMethod }),
    ...(tailored.text ? { tailored: atsReport({ requirements: requirements.requirements, roleTitle: requirements.roleTitle, cvText: tailored.text, cvMethod: 'pdf' }) } : {}),
  };
  const legitimacy = assessLegitimacy({
    posting, legitimacy: requirements.legitimacy, livenessResult: liveness.page?.result, companyName: order.companyName, nowMs,
  });
  log('ats', ats.original.structural.grade, `${ats.original.keywords.coverage ?? '-'}%`, 'tailored', tailored.record.status, 'legitimacy', legitimacy.tier);

  const signature = [identity.name, identity.email, identity.phone].filter(Boolean).join('\n');
  const draft = {
    status: 'ready',
    round,
    cvKey: order.cvStorageKey,
    cvTextMethod: cvMethod,
    postingHash: hashText(postingText),
    model: 'codex-cli/gpt-5.6-luna',
    effort: 'max',
    completedAt: nowMs,
    language,
    candidateLocale: locale,
    job: { source: posting.source, title, applyUrl: channel.applyUrl || String(order.jobUrl || '').slice(0, 1000) },
    liveness: { result: liveness.page?.result || null, code: liveness.page?.code || null, datasetGone: liveness.datasetGone },
    channel,
    requirementsRaw: requirements,
    requirements: requirements.requirements,
    languageRequirements: requirements.languageRequirements,
    workPermitQuote: requirements.workPermitQuote,
    applicationInstructions: requirements.applicationInstructions,
    contactPerson: requirements.contactPerson || posting.contactPerson,
    matches: match.matches,
    verdict: match.verdict,
    summaryIt: match.summaryIt,
    checksIt: match.checksIt,
    questions,
    coverLetter: { ...documents.coverLetter, text: letterBody, subject: letterSubject(language, title) },
    applicationEmail: {
      to: channel.email || '',
      subject: documents.emailSubject || letterSubject(language, title),
      body: `${documents.emailBody}\n\n${signature}`.trim(),
    },
    formAnswers: buildFormAnswers({ identity, profile, documents, answers }),
    profile,
    factCheck: { ...factCheck, basis: cvMethod },
    factSources,
    coverLetterPdfKey: pdfKey,
    ats,
    legitimacy,
    tailoredCv: tailored.record,
  };

  // career-ops "application snapshot": the posting as it was read and the
  // draft as it was proposed, encrypted, for disputes and interview prep.
  draft.archiveKey = await storeEvidence({
    bucket,
    orderId,
    name: `draft-r${round}`,
    payload: { postingText, posting, draft: { ...draft, factSources: undefined } },
    key: runKey,
    nowMs,
  });
  return draft;
}

/**
 * The tailored ATS CV (functions/src/assistedApplicationTailoredCv.js). Never
 * fails the draft: without it the original CV is sent.
 * @returns {Promise<{record: object, text: string}>}
 */
async function buildTailoredCv({ codex, bucket, orderId, round, nowMs, log, profile, requirements, title, language, identity, answers, candidateNotes, cvText, postingExcerpt }) {
  try {
    const raw = await codex({
      prompt: codexPrompt(tailoredCvSystemPrompt(language), tailoredCvUserText({
        profile, requirements: requirements.requirements, roleTitle: title, postingExcerpt, answers,
      })),
      schema: TAILORED_CV_SCHEMA,
      timeoutMs: CODEX_TIMEOUT_MS,
    });
    const cv = sanitizeTailoredCv(raw, { profile, cvText, language });
    const text = tailoredCvPlainText(cv, { identity, profile });
    const facts = checkTailoredCvFacts(cv, { cvText, profile, answers: { ...answers, notes: candidateNotes } });
    if (!facts.ok) {
      log('tailored cv: fact gate failed, the original CV will be sent');
      return { record: { status: 'fact_check_failed', unsupported: facts.unsupported.slice(0, 10), dropped: cv.dropped, language }, text };
    }
    const pdfKey = `assisted-application-uploads/${orderId}/ai-cv-r${round}-${nowMs}.pdf`;
    await bucket.file(pdfKey).save(buildTailoredCvPdf(cv, { identity, profile }), { contentType: 'application/pdf', resumable: false });
    return { record: { status: 'ready', pdfKey, language, headline: cv.headline, dropped: cv.dropped }, text };
  } catch (error) {
    log('tailored cv failed', error instanceof Error ? error.message.slice(0, 80) : 'error');
    return { record: { status: 'failed', language }, text: '' };
  }
}

function hashText(text) {
  let hash = 0;
  for (let index = 0; index < text.length; index += 1) hash = (hash * 31 + text.charCodeAt(index)) | 0;
  return String(hash >>> 0);
}
