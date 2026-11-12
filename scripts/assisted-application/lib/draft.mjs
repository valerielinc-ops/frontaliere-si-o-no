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

import { guardMobilityMatch } from '../../../functions/src/lib/mobilityRequirements.js';
import { sourceCitations, citationSchema, resolveCitations } from '../../../functions/src/lib/sourceCitations.js';
import { repairApplicationDocuments } from './fact-repair.mjs';
import { pdfRendererMode, renderLetterPdf } from '../../../functions/src/assistedApplicationPdfRenderer.js';
import {
  applicationEmailText,
  applyLetterConventions,
  buildFormAnswers,
  checkDraftTexts,
  filterAuthorizedEvidenceAtoms,
  ensureRequiredQuestions,
  letterAddressOf,
  letterEnclosures,
  letterPdfBlocks,
  letterText,
  printedTitles,
  salutationQuestion,
  sanitizeDocuments,
  swissTypography,
  sanitizeMatch,
  sanitizeProfile,
  sanitizeRequirements,
  verifyQuotes,
} from '../../../functions/src/assistedApplicationAiDraftCore.js';
import { classifyApplicationChannel, fetchJobPosting, resolveApplyUrl } from '../../../functions/src/assistedApplicationAiJob.js';
import { candidateWithEdits } from '../../../functions/src/assistedApplicationCandidateEdits.js';
import { draftCvAnswers } from './cv-answers.mjs';
import { draftDecisionAnswers } from './decision-answers.mjs';
import { verifiedCvAnswers } from '../../../functions/src/assistedApplicationCvAnswers.js';
import { verifiedDecisionAnswers } from '../../../functions/src/assistedApplicationDecisionAnswers.js';
import { withPlatformSuggestions } from '../../../functions/src/assistedApplicationOperationalAnswers.js';
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
  applicationEmailSubject,
  letterSubject,
  matchSystemPrompt,
  matchUserText,
  profileUserText,
  requirementsUserText,
  resolveLetterLanguage,
} from '../../../functions/src/assistedApplicationAiPrompts.js';
import { vettedConciergeDraftInputs } from '../../../functions/src/applicationConciergeEligibility.js';
import { canonicalizeEmployerAgeCitations } from '../../../functions/src/lib/employerFacts.js';
import { atsReport } from '../../../functions/src/assistedApplicationAts.js';
import { assessLegitimacy } from '../../../functions/src/assistedApplicationLegitimacy.js';
import { candidateType } from '../../../functions/src/assistedApplicationCandidateType.js';
import {
  TAILORED_CV_SCHEMA,
  buildTailoredCvPdf,
  checkTailoredCvFacts,
  checkTailoredCvLanguage,
  sanitizeTailoredCv,
  tailoredCvPlainText,
  tailoredCvSystemPrompt,
  tailoredCvUserText,
} from '../../../functions/src/assistedApplicationTailoredCv.js';
import { CV_TEXT_VERSION, readCvText } from './cv-text.mjs';
import { inPlaceCvRecord } from './docx-inplace.mjs';
import { candidatePhoto } from '../../../functions/src/assistedApplicationTailoredCvPdf.js';
import { enclosedDocumentLabels, mergeRequiredDocuments, requiredDocumentsFromRequirements } from '../../../functions/src/assistedApplicationExtraDocuments.js';
import { documentsHeldAsked } from '../../../functions/src/lib/documentQuestions.js';
import { candidateForForm, portalQuestionKey, portalReaderErrorClass, postingAddressForPortal } from './portal/portal.mjs';
import { compactApplicationContract } from './portal/application-contract.mjs';
import { enrichProfileResidenceAddress } from './portal/residence-address.mjs';
import { checkPostingLiveness } from './posting-liveness.mjs';
import { maskValues, personalValuesOf, storeEvidence } from './secure-run.mjs';

const MAX_SOURCE_CHARS = 30_000;
const MAX_POSTING_EXCERPT = 6_000;
// A slow call at effort max must finish rather than fail the draft: the
// broker of assisted-application-agent.yml allows 30 min per request.
const CODEX_TIMEOUT_MS = 30 * 60 * 1000;
// One repair of a text the fact gate stopped (the letter, the tailored CV). Shorter than a first writing:
// profile ∥ requirements, match, documents and the repair still fit the job's 120 minutes.
const REPAIR_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_REPAIR_FINDINGS = 12;
// The reader outcomes copied into the draft's pre-read diagnostic. None of
// them stops the draft (owner decision 2026-11-10: no blocked application):
// the submit run reads the live form again with the same rules, CV and
// decision engine, so a pre-read that did not get through costs nothing.
const PORTAL_PRE_READ_HANDOFFS = new Set([
  'application_form_unreadable', 'captcha_present', 'cookie_preferences_unresolved', 'planner_unavailable',
  'portal_reader_failed', 'posting_mismatch', 'question_label_unreadable', 'question_localization_unavailable',
  'question_planning_failed', 'public_route_unavailable', 'requirements_unavailable',
]);
const CANDIDATE_LOCALES = new Set(['it', 'de', 'fr', 'en']);

/** What the fact gate did not find, as the model is told it for the one repair. */
function findingsOf(...results) {
  return results.flatMap((result) => (result?.unsupported || result?.issues || []))
    .slice(0, MAX_REPAIR_FINDINGS)
    .map(({ field, kind, token, context }) => ({ field, kind, token, context }));
}

export class DraftAbort extends Error {
  constructor(eventType, code, { portalContract = null } = {}) {
    super(code);
    this.eventType = eventType;
    this.code = code;
    this.portalContract = compactApplicationContract(portalContract);
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
 * @param {Array<object>} [ctx.evidenceAtoms] Candidate evidence from a trusted record; every atom is checked before any prompt.
 * @param {typeof fetch} [ctx.fetchImpl]
 * @param {Function} [ctx.resolve] DNS lookup of the posting's hosts (tests pass a fake)
 * @param {number} [ctx.nowMs]
 * @param {Function} [ctx.log]
 * @returns {Promise<object>} the draft document to write
 */
export async function buildDraft(ctx) {
  const { order, orderId, flow, previousDraft, cvBuffer, cvType, codex, bucket, runKey } = ctx;
  const rawEvidenceAtoms = [
    ctx.evidenceAtoms,
    order?.evidenceAtoms,
    flow?.evidenceAtoms,
    ctx.intake?.evidenceAtoms,
    previousDraft?.evidenceAtoms,
  ].flatMap((atoms) => Array.isArray(atoms) ? atoms : []);
  const candidateEvidenceAtoms = filterAuthorizedEvidenceAtoms(rawEvidenceAtoms)
    .filter((atom) => typeof atom.claim === 'string' && atom.claim.trim())
    .map((atom) => ({
      ...(typeof atom.id === 'string' ? { id: atom.id.slice(0, 120) } : {}),
      claim: atom.claim.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 1000),
      provenance: atom.provenance,
      ...(atom.approvedByCandidate === true ? { approvedByCandidate: true } : {}),
    }))
    .filter((atom) => atom.claim);
  const candidateEvidenceText = candidateEvidenceAtoms.map((atom) => atom.claim).join('\n');
  const fetchImpl = ctx.fetchImpl || fetch;
  const nowMs = ctx.nowMs || Date.now();
  const round = Number(flow?.round) || 1;
  // Fase 2: what the candidate wrote in the e-mail that carried the CV.
  const candidateNotes = String(ctx.intake?.emailNotes || '').slice(0, 4000);
  const log = ctx.log || ((...args) => console.log('[assisted-application]', ...args));
  maskValues(personalValuesOf(order));

  const posting = await fetchJobPosting(order, { fetchImpl, maxPostingChars: MAX_SOURCE_CHARS });
  const liveness = await checkPostingLiveness({ order, posting, fetchImpl, resolve: ctx.resolve });
  log('liveness', liveness.page?.result || 'n/a', liveness.page?.code || '', liveness.closed ? 'CLOSED' : '');
  if (liveness.closed) throw new DraftAbort('posting_closed', `posting_closed:${liveness.page?.code || 'dataset'}`);
  const postingText = posting.text || `${order.jobTitle || ''} — ${order.companyName || ''}`;

  const reuse = previousDraft?.status === 'ready'
    && previousDraft.cvKey === order.cvStorageKey
    && previousDraft.postingHash === hashText(postingText)
    && previousDraft.profile && previousDraft.requirementsRaw
    // A CV text read before a fix of the reading is read again, and the profile with it.
    && previousDraft.cvTextVersion === CV_TEXT_VERSION
    // Requirements read before the requested documents existed are read again.
    && Array.isArray(previousDraft.requirementsRaw.requestedDocuments)
    // So is a profile read before the kinds of experience: an internship would count as a job.
    && profileOfThisVersion(previousDraft.profile);

  const qualification = !reuse && ctx.db ? await vettedConciergeDraftInputs({ db: ctx.db, order, cvBuffer, postingText }).catch(() => null) : null;
  let cvText = previousDraft?.factSources?.text && reuse ? previousDraft.factSources.text : '';
  let cvMethod = reuse ? previousDraft.cvTextMethod : 'none';
  let profile;
  let requirements;
  if (reuse) {
    // Capped and defaulted as a fresh read.
    profile = sanitizeProfile(previousDraft.profile, { legacy: true, cvText });
    requirements = previousDraft.requirementsRaw;
    log('reusing profile and requirements of the previous round');
  } else {
    const cv = await readCvText(cvBuffer, cvType);
    cvText = cv.text;
    cvMethod = cv.method;
    log('cv text', cv.method, `${cv.text.length} chars`);
    if (cv.text.length < 80) throw new DraftAbort('draft_failed', `cv_unreadable:${cv.method}`);
    const [profileRaw, requirementsRaw] = qualification ? [qualification.profile, qualification.requirements] : await Promise.all([
      codex({ prompt: codexPrompt(PROFILE_SYSTEM_PROMPT, profileUserText(cv.text)), schema: PROFILE_SCHEMA, timeoutMs: CODEX_TIMEOUT_MS }),
      codex({
        prompt: codexPrompt(REQUIREMENTS_SYSTEM_PROMPT, requirementsUserText({
          jobTitle: order.jobTitle, companyName: order.companyName, location: posting.location, postingText,
        })),
        schema: REQUIREMENTS_SCHEMA,
        timeoutMs: CODEX_TIMEOUT_MS,
      }),
    ]);
    profile = sanitizeProfile(profileRaw, { cvText });
    requirements = verifyQuotes(sanitizeRequirements(requirementsRaw), postingText);
  }
  // The CV may state a locality and province without spelling out the CAP or
  // country. Resolve those address properties locally before the portal plan
  // is built; ambiguous localities remain empty and stay candidate questions.
  profile = enrichProfileResidenceAddress(profile, cvText);
  maskValues(personalValuesOf(order, profile));
  // What the candidate corrected on the review page (name, phone, place,
  // languages, permit, salary...) wins over the CV and over older answers:
  // every prompt, the questions and the saved draft use the corrected candidate.
  // With the CV's text: what it says of the candidate in its own words (their form of address, their civil
  // status) is known from here on, and neither is asked (lib/personalFacts.js).
  const edited = candidateWithEdits({ order, draft: { profile, factSources: { text: cvText } }, flow });
  profile = edited.profile;
  const answers = edited.answers;
  const identity = edited.identity;
  const personal = edited.personal;

  const locale = candidateLocale(order);
  const language = resolveLetterLanguage(requirements.postingLanguage, order.locale);
  const title = String(posting.titles?.[language] || requirements.roleTitle || order.jobTitle || '').slice(0, 300);
  // Apprentice, first job or qualified, and the sector: the CV's sections and the letter's plan follow it.
  const kind = candidateType({ profile, postingTitle: title || order.jobTitle, postingText });
  // The tailored ATS CV needs only the profile and the requirements: it runs
  // while the match and the letter are written.
  const tailoredCvPromise = buildTailoredCv({
    kind,
    rendererMode: await pdfRendererMode(),
    codex, bucket, orderId, round, nowMs, log, profile, requirements, title, language, identity, answers, candidateNotes, candidateEvidenceAtoms,
    cvText, postingExcerpt: postingText.slice(0, MAX_POSTING_EXCERPT), flow,
    cvBuffer, cvType, cvKey: order.cvStorageKey, inPlace: ctx.inPlace,
  });
  const reuseQualifiedMatch = qualification && candidateEvidenceAtoms.length === 0 && !candidateNotes && !Object.keys(edited.overrides).length
    && !Object.keys(answers).some(key => key !== 'salutation') && !flow?.feedback?.length;
  const candidateSourceText = candidateEvidenceText
    ? `${cvText}\n${candidateNotes}\n${candidateEvidenceText}`
    : `${cvText}\n${candidateNotes}`;
  const evidenceText = [cvText, JSON.stringify(answers), candidateNotes, JSON.stringify(edited.overrides), ...(candidateEvidenceText ? [candidateEvidenceText] : [])].join('\n');
  const candidateSources = sourceCitations({ cv: cvText, answers: Object.keys(answers).length ? JSON.stringify(answers) : '', notes: candidateNotes,
    corrections: Object.keys(edited.overrides).length ? JSON.stringify(edited.overrides) : '',
    ...(candidateEvidenceText ? { evidenceAtoms: candidateEvidenceText } : {}) });
  const matchRaw = reuseQualifiedMatch ? qualification.match : await codex({
    prompt: codexPrompt(matchSystemPrompt(locale), matchUserText({
      profile, requirements, answers, candidateNotes, postingExcerpt: postingText, candidateSourceExcerpts: candidateSources.excerpts, candidateEvidenceAtoms,
    })),
    schema: citationSchema(MATCH_SCHEMA, 'matches', 'evidence', candidateSources),
    timeoutMs: CODEX_TIMEOUT_MS,
  });
  const match = guardMobilityMatch(requirements, sanitizeMatch(resolveCitations(matchRaw, 'matches', 'evidence', candidateSources), requirements.requirements.length, evidenceText),
    { profile, sourceText: candidateSourceText, answers, memory: flow?.questionAnswers || {}, locale });
  let requiredDocuments = requiredDocumentsFromRequirements(requirements);
  // A document the posting requires is uploaded, not asked about (owner decision 2026-10-08): «do you hold the
  // driver qualification card?» next to that very card among the documents held the order twice for one
  // requirement. The upload is the answer, here and on a portal's form (lib/documentQuestions.js, plan.mjs).
  const notAnsweredByUpload = (question) => {
    const mandatoryDocuments = requiredDocuments.filter((document) => document.required);
    const held = documentsHeldAsked(question, mandatoryDocuments);
    if (held.length) log('question answered by a required document', question.id, held.map((document) => document.id).join(','));
    return !held.length;
  };
  let questions = ensureRequiredQuestions(match.questions, { requirements, profile, answers, locale }).filter(notAnsweredByUpload);

  const contactPerson = requirements.contactPerson || posting.contactPerson;
  // The CV text is the strict source of facts; the answers the candidate gave
  // are facts too. A CV with no readable text never gets here.
  const factSources = {
    text: cvText.slice(0, MAX_SOURCE_CHARS),
    posting: postingText.slice(0, MAX_SOURCE_CHARS),
    order: [order.jobTitle, order.companyName, identity.name, identity.email, identity.phone].join('\n'),
    // The title also as the letter prints it (protected space, an apprenticeship's subject): a name quoted
    // whole, never words that back a job title the candidate claims («tirocinio», «posto»).
    titles: printedTitles(language, title, kind.type).join('\n'),
    // The work place backs a place name in the letter, never a figure.
    place: String(posting.location || '').slice(0, 200),
    // The candidate's own words: answers, notes, the changes asked for, the fields they corrected.
    answers: [
      ...Object.values(answers),
      candidateNotes,
      ...(flow?.feedback || []).map((item) => String(item?.text || '')),
      ...Object.values(edited.overrides),
      ...candidateEvidenceAtoms.map((atom) => atom.claim),
    ].join('\n'),
    // The permit status the texts were written with (a code, '' when none): its presence marks a draft the gate
    // judges on the Swiss permit, with the status of the day (factSourcesNow).
    permitStatus: profile.permitStatus || '',
  };
  /**
   * The letter, the e-mail and the two short texts, as the fact gate reads them. `findings`: what the gate
   * did not find in the version before, for the one repair.
   */
  const writeDocuments = async (findings = [], timeoutMs = CODEX_TIMEOUT_MS) => {
    const written = sanitizeDocuments(await codex({
      prompt: codexPrompt(documentsSystemPrompt(language), documentsUserText({
        candidateName: identity.name,
        candidateType: kind.type,
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
          contactPerson,
          applicationInstructions: requirements.applicationInstructions,
        },
        postingExcerpt: postingText.slice(0, MAX_POSTING_EXCERPT),
        language,
        factCheckFindings: findings,
        candidateEvidenceAtoms,
      })),
      schema: DOCUMENTS_SCHEMA,
      timeoutMs,
    }));
    if (!written.coverLetter.paragraphs.length || !written.emailBody) throw new DraftAbort('draft_failed', 'documents_empty');
    // Bind employer biography to its source in the actual rendered texts, before the strict fact gate.
    const attributeEmployerAge = (text) => canonicalizeEmployerAgeCitations(text, postingText, order.companyName);
    written.coverLetter.paragraphs = written.coverLetter.paragraphs.map(attributeEmployerAge);
    for (const key of ['emailBody', 'motivationShort', 'whyCompany']) written[key] = attributeEmployerAge(written[key]);
    // Swiss conventions in code (study 2026-10-02): salutation and closing per
    // language, no "ß", no line break inside "81 %".
    written.coverLetter = applyLetterConventions(written.coverLetter, { language, contactPerson });
    // The e-mail framed like the letter: the model writes only the message (2026-10-03).
    written.emailBody = applicationEmailText(written.emailBody, { language, contactPerson, signature: [identity.name, identity.email, identity.phone] });
    if (!written.emailBody) throw new DraftAbort('draft_failed', 'documents_empty');
    for (const key of ['motivationShort', 'whyCompany']) written[key] = swissTypography(written[key], language);
    const body = letterText(written.coverLetter);
    const subject = swissTypography(applicationEmailSubject(language, title, identity.name, written.emailSubject, kind.type), language);
    const facts = checkDraftTexts({
      coverLetter: body,
      emailSubject: subject,
      emailBody: written.emailBody,
      motivationShort: written.motivationShort,
      whyCompany: written.whyCompany,
    }, factSources, { language });
    return { documents: written, letterBody: body, emailSubject: subject, factCheck: facts };
  };
  let texts = await writeDocuments();
  // Self-repair (2026-10-07): texts the gate stops are written once more, the model told what the gate did
  // not find. A warning stopped the draft at the owner with no clock, and most are a rule of the prompt the
  // model missed (a job title translated, a figure rounded): the gate stays as strict, and the owner is
  // asked only for what a second writing does not solve. Never fails the draft: a repair that is not
  // better, or does not come, leaves the first version.
  let factRepair = null;
  if (!texts.factCheck.ok) {
    const before = texts.factCheck.unsupported.length;
    const repaired = await writeDocuments(findingsOf(texts.factCheck), REPAIR_TIMEOUT_MS).catch((error) => {
      log('fact repair failed', error instanceof Error ? error.message.slice(0, 80) : 'error');
      return null;
    });
    if (repaired && repaired.factCheck.unsupported.length < before) texts = repaired;
    factRepair = { before, after: texts.factCheck.unsupported.length };
    log('fact repair', `${before} → ${factRepair.after}`);
  }
  if (!texts.factCheck.ok) {
    const repaired = repairApplicationDocuments(texts.documents, factSources, { language, emailSubject: texts.emailSubject });
    if (!repaired.factCheck.ok) throw new DraftAbort('draft_failed', 'fact_repair_failed');
    texts = repaired;
    factRepair = { ...factRepair, after: 0, removed: repaired.removed, method: 'verified_paragraphs' };
    log('fact repair', 'unverified claims removed; full fact gate passed');
  }
  const { documents, letterBody, emailSubject, factCheck } = texts;
  const letterAddress = letterAddressOf(posting, contactPerson);

  let channel = classifyApplicationChannel({
    applyUrl: posting.applyUrl || order.jobUrl,
    postingText,
    applicationEmail: requirements.applicationEmail,
  });
  const postingUrl = posting.postingUrl || order.jobUrl || (channel.type === 'employer_site' ? channel.applyUrl : '');
  // The employer's page is the native source of truth for its «Apply» control.
  // Re-read it when the published apply URL is a separate portal address too:
  // Prospective listings can retain a SuccessFactors sign-in bookmark while
  // the live posting's online application is a different channel (PastaHR).
  // A failed/ambiguous lookup keeps the published address, so this remains a
  // bounded, fail-open repair rather than a guessed URL rewrite.
  if (postingUrl && (channel.type === 'employer_site' || postingUrl !== channel.applyUrl)) {
    const target = await resolveApplyUrl(postingUrl, { fetchImpl, resolve: ctx.resolve });
    const applyUrl = target.via ? target.applyUrl : postingUrl;
    const resolvedChannel = classifyApplicationChannel({ applyUrl, postingText, applicationEmail: requirements.applicationEmail });
    // A published posting URL can already be the ATS's job-bound route. In
    // that case there is no redirect to resolve, but the channel still needs
    // to be classified from the route rather than the stale saved apply URL.
    if (target.via || resolvedChannel.type !== 'employer_site') {
      channel = {
        ...resolvedChannel,
        postingUrl,
        ...(target.via ? { via: target.via } : {}),
      };
      log('apply redirect', target.via || 'posting URL', channel.type);
    }
  }
  // The portal's own required questions, read ahead on a single-page form
  // (career-ops apply.md): the candidate answers them on the first review,
  // not in a second round at submit time. Questions already asked are kept.
  const formAnswers = buildFormAnswers({ identity, profile, documents, answers, locale, personal });
  const readPortal = ctx.readPortalRequirements || ctx.readPortalQuestions;
  const portalPostingUrl = postingAddressForPortal({
    applyUrl: channel.applyUrl,
    postingUrls: [posting.postingUrl, channel.postingUrl, order.jobUrl, posting.applyUrl, channel.applyUrl],
    fallback: posting.postingUrl || order.jobUrl || '',
  });
  let portalContract = null;
  let portalPreRead = null;
  if (readPortal && channel.applyUrl) {
    // The form of address the name gives is the platform's answer to a required
    // portal title field (owner decision 2026-11-09): never asked, always shown
    // among the form fields, where the candidate can correct it.
    const portalAnswers = { ...answers };
    // The pre-read is an optimisation of the first review, never a gate on
    // the draft: a reader that throws is recorded like one that hands off.
    const portalResult = await Promise.resolve().then(() => readPortal({
      channelType: channel.type,
      applyUrl: channel.applyUrl,
      postingUrl: portalPostingUrl,
      job: { title, company: order.companyName || '' },
      ...(channel.via === 'successfactors' ? {
        postingRouteProof: {
          via: 'successfactors',
          applyUrl: channel.applyUrl,
          postingUrl: posting.postingUrl || order.jobUrl || '',
        },
      } : {}),
      language,
      candidateLocale: locale,
      candidate: candidateForForm({ identity, profile, answers: portalAnswers, draft: { formAnswers, coverLetter: { text: letterBody } }, language, personal, job: { title, company: order.companyName || '' }, platformFacts: edited.platformFacts }),
      codex,
      log,
    })).catch((error) => ({ questions: [], documents: [], handoff: 'portal_reader_failed', readerError: portalReaderErrorClass(error) }));
    // Older test/integration callers return only the question array; the live
    // reader also returns required file fields so they reach the upload picker
    // before the first submission attempt.
    const portal = Array.isArray(portalResult) ? { questions: portalResult, documents: [] } : (portalResult || { questions: [], documents: [] });
    portalContract = compactApplicationContract(portal.portalContract);
    if (portal.handoff) {
      // A diagnostic, not a block (owner decision 2026-11-10): the letter, the
      // CV, the platform's answers and the decision engine do not depend on
      // the portal's form, and the submit run reads that form live. Only this
      // fixed set of reader outcomes is copied, so the field outlives the
      // purged Actions log without carrying page text.
      const reason = PORTAL_PRE_READ_HANDOFFS.has(portal.handoff) ? portal.handoff : 'unknown';
      const readerError = /^[a-z_]{1,40}$/.test(String(portal.readerError || '')) ? portal.readerError : null;
      portalPreRead = { status: 'unavailable', handoff: reason, ...(readerError ? { readerError } : {}) };
      log('portal pre-read unavailable', reason, readerError || '-', 'draft continues; the submit run reads the form');
    } else {
      requiredDocuments = mergeRequiredDocuments(requiredDocuments, portal.documents);
      // The document requirement is the answer to a narrow "do you hold it?"
      // question. Re-run this filter after the portal has contributed its own
      // document labels.
      questions = questions.filter(notAnsweredByUpload);
      const known = new Set(questions.map((question) => portalQuestionKey(question) || question.id));
      for (const question of Array.isArray(portal.questions) ? portal.questions : []) {
        if (!notAnsweredByUpload(question)) continue;
        const key = portalQuestionKey(question) || question.id;
        const existingIndex = questions.findIndex((existing) => (portalQuestionKey(existing) || existing.id) === key);
        if (existingIndex >= 0) {
          const existing = questions[existingIndex];
          // Upgrade a legacy portal question in place. Keeping its id preserves
          // an answer already stored under that id, while the new application
          // copy/options and candidate-language copy replace stale raw wording.
          if (existing?.source === 'portal' && question?.source === 'portal'
            && (question.applicationQuestion || question.applicationOptions?.length)) {
            questions[existingIndex] = { ...existing, ...question, id: existing.id || question.id };
          }
          continue;
        }
        if (known.has(key)) continue;
        known.add(key);
        questions.push(question);
      }
      portalPreRead = { status: 'read', questions: portal.questions?.length || 0, documents: portal.documents?.length || 0 };
      log('portal pre-read', channel.type, `${portal.questions?.length || 0} questions`, `${portal.documents?.length || 0} documents`);
    }
  }
  // The CV answers the open text questions (owner decisions 2026-11-10, lib/cv-answers.mjs): a technical
  // one with cited excerpts, a behavioural one with a plausible description built from the CV. A verified
  // answer is a platform proposal (platformFacts.cvAnswers): shown and editable, never in flow.answers.
  ({ questions } = await draftCvAnswers({ questions, answers, facts: edited.platformFacts, cvText, codex, locale, log }));
  // What neither a platform rule nor the CV answered, the decision engine decides by the owner's principles
  // (lib/decision-answers.mjs, 2026-11-10): a platform proposal too (platformFacts.decisionAnswers), only the
  // categories of CANDIDATE_ONLY_CATEGORIES stay with the candidate.
  ({ questions } = await draftDecisionAnswers({
    questions, answers, cvText, codex, log, employer: order.companyName || '', jobTitle: title,
    postingRequirements: requirements.requirements,
    facts: { ...edited.platformFacts, cvAnswers: verifiedCvAnswers(questions, cvText) },
  }));
  // A portal's form asks the form of address («Title: Ms / Mr / Other»): asked
  // now, optional, so it does not cost the candidate a second round at submit time.
  // Not when the candidate corrected the field on the review page, even to nothing: they have spoken.
  const salutation = salutationQuestion({ channel, questions, answers, locale, corrected: Object.hasOwn(edited.overrides, 'salutation') });
  if (salutation) questions.push(salutation);
  // Every answer the platform gives (a rule, a decision of the engine) is mirrored on its question in the
  // field's shape (`suggestedAnswer`, `answerOrigin`): the draft shows what the candidate is proposed. The
  // review page and the runner keep projecting it live.
  questions = withPlatformSuggestions(questions, {
    locale,
    answers,
    facts: {
      ...edited.platformFacts,
      cvAnswers: verifiedCvAnswers(questions, cvText),
      decisionAnswers: verifiedDecisionAnswers(questions, cvText, { postingTitle: title, postingRequirements: requirements.requirements }),
    },
  });

  // Typst with the embedded font; the standard-font writer when it fails or the switch says "legacy".
  const rendererMode = await pdfRendererMode();
  const { pdf, renderer: letterRenderer } = await renderLetterPdf(letterPdfBlocks({
    identity, profile, posting: letterAddress, companyName: order.companyName, language, letter: documents.coverLetter, title, now: new Date(nowMs),
    enclosures: letterEnclosures(language, enclosedDocumentLabels({ requiredDocuments }, null, orderId)), type: kind.type,
  }), { mode: rendererMode, log });
  const pdfKey = `assisted-application-uploads/${orderId}/ai-cover-letter-r${round}-${nowMs}.pdf`;
  await bucket.file(pdfKey).save(pdf, { contentType: 'application/pdf', resumable: false });

  // Extras (career-ops): the ATS check of the candidate's own CV and of the
  // tailored one, and the posting's legitimacy tier (Block G).
  const tailored = await tailoredCvPromise;
  const ats = {
    original: atsReport({ requirements: requirements.requirements, roleTitle: requirements.roleTitle, cvText, cvMethod }),
    // The tailored text against the honest ceiling of the candidate's own CV.
    ...(tailored.text ? { tailored: atsReport({ requirements: requirements.requirements, roleTitle: requirements.roleTitle, cvText: tailored.text, cvMethod: 'pdf', baselineText: cvText }) } : {}),
  };
  const legitimacy = assessLegitimacy({
    posting, legitimacy: requirements.legitimacy, livenessResult: liveness.page?.result, companyName: order.companyName,
    titles: [title, order.jobTitle, requirements.roleTitle], nowMs,
  });
  log('ats', ats.original.structural.grade, `${ats.original.keywords.coverage ?? '-'}%`, 'tailored', tailored.record.status, 'legitimacy', legitimacy.tier);

  const signature = [identity.name, identity.email, identity.phone].filter(Boolean).join('\n');
  const draft = {
    status: 'ready',
    round,
    cvKey: order.cvStorageKey,
    cvTextMethod: cvMethod,
    cvTextVersion: CV_TEXT_VERSION,
    postingHash: hashText(postingText),
    model: 'codex-cli/gpt-5.6-luna',
    effort: 'max',
    completedAt: nowMs,
    language,
    candidateLocale: locale,
    job: {
      source: posting.source,
      title,
      postingUrl: posting.postingUrl || order.jobUrl || '',
      applyUrl: channel.applyUrl || String(order.jobUrl || '').slice(0, 1000),
    },
    liveness: { result: liveness.page?.result || null, code: liveness.page?.code || null, datasetGone: liveness.datasetGone },
    channel,
    ...(portalContract ? { portalContract } : {}),
    ...(portalPreRead ? { portalPreRead } : {}),
    requirementsRaw: requirements,
    requirements: requirements.requirements,
    languageRequirements: requirements.languageRequirements,
    workPermitQuote: requirements.workPermitQuote,
    applicationInstructions: requirements.applicationInstructions,
    // School reports, test results… besides the CV and the letter: the candidate uploads them on the review page.
    requiredDocuments,
    contactPerson,
    // The letter's recipient: every rebuild of the letter (candidate edits, owner edits, submission) prints it.
    letterAddress,
    matches: match.matches,
    verdict: match.verdict,
    summaryIt: match.summaryIt,
    checksIt: match.checksIt,
    questions,
    coverLetter: { ...documents.coverLetter, text: letterBody, subject: swissTypography(letterSubject(language, title, kind.type), language) },
    applicationEmail: {
      to: channel.email || '',
      subject: emailSubject,
      body: `${documents.emailBody}\n\n${signature}`.trim(),
    },
    formAnswers,
    profile,
    factCheck: { ...factCheck, basis: cvMethod },
    // The one repair of the texts, when the gate asked for it: its warnings before and after.
    ...(factRepair ? { factRepair } : {}),
    factSources,
    coverLetterPdfKey: pdfKey,
    ats,
    legitimacy,
    candidateType: kind,
    // Which writer produced the letter (typst, or legacy as fallback): measured per draft.
    coverLetterRenderer: letterRenderer,
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
async function buildTailoredCv({ kind = { type: 'qualified', sector: 'other' }, rendererMode, codex, bucket, orderId, round, nowMs, log, profile, requirements, title, language, identity, answers, candidateNotes, candidateEvidenceAtoms = [], cvText, postingExcerpt, flow, cvBuffer, cvType, cvKey, inPlace = inPlaceCvRecord }) {
  try {
    const candidateEvidenceText = candidateEvidenceAtoms.map((atom) => atom.claim).join('\n');
    const tailoredSourceText = [cvText, ...(candidateEvidenceText ? [candidateEvidenceText] : [])].join('\n');
    const write = async (findings = [], timeoutMs = CODEX_TIMEOUT_MS) => {
      const raw = await codex({
        prompt: codexPrompt(tailoredCvSystemPrompt(language), tailoredCvUserText({
          profile, requirements: requirements.requirements, roleTitle: title, postingExcerpt, answers, candidateType: kind.type, factCheckFindings: findings, candidateEvidenceAtoms,
        })),
        schema: TAILORED_CV_SCHEMA,
        timeoutMs,
      });
      const written = sanitizeTailoredCv(raw, { profile, cvText: tailoredSourceText, language, type: kind.type, sector: kind.sector, title });
      return {
        cv: written,
        facts: checkTailoredCvFacts(written, { cvText: tailoredSourceText, profile, answers: { ...answers, notes: [candidateNotes, candidateEvidenceText].filter(Boolean).join('\n') } }),
        languageCheck: checkTailoredCvLanguage(written, { profile, language, type: kind.type }),
      };
    };
    let { cv, facts, languageCheck } = await write();
    // Self-repair (2026-10-07): one warning dropped the whole tailored CV for the original one (a real
    // draft: the summary named the posting's company). It is written once more, the model told what the
    // gate did not find; only a repair the gate passes is kept.
    let repaired = false;
    if (!facts.ok || !languageCheck.ok) {
      log(`tailored cv: ${facts.ok ? 'language' : 'fact'} gate failed, one repair`);
      const again = await write(findingsOf(facts, languageCheck), REPAIR_TIMEOUT_MS).catch(() => null);
      if (again?.facts.ok && again?.languageCheck.ok) {
        ({ cv, facts, languageCheck } = again);
        repaired = true;
      }
    }
    const text = tailoredCvPlainText(cv, { identity, profile });
    if (!facts.ok) {
      log('tailored cv: fact gate failed, the original CV will be sent');
      return { record: { status: 'fact_check_failed', unsupported: facts.unsupported.slice(0, 10), dropped: cv.dropped, language }, text };
    }
    if (!languageCheck.ok) {
      log('tailored cv: language gate failed, the original CV will be sent');
      return { record: { status: 'language_check_failed', languageIssues: languageCheck.issues.slice(0, 10), dropped: cv.dropped, language }, text };
    }
    const pdfKey = `assisted-application-uploads/${orderId}/ai-cv-r${round}-${nowMs}.pdf`;
    // The photo the candidate gave on an earlier round stays on the new tailored CV.
    const photo = await candidatePhoto(flow, bucket);
    const { pdf, renderer, photo: photoPrinted } = await buildTailoredCvPdf(cv, { identity, profile, mode: rendererMode, log, ...photo });
    await bucket.file(pdfKey).save(pdf, { contentType: 'application/pdf', resumable: false });
    // Phase 5: the candidate's own Word file with the adapted lines, when the switch is on.
    const inplace = await inPlace({ cvBuffer, cvType, cvKey, cv, profile, identity, bucket, orderId, round, nowMs, log });
    // `cv`: kept so the Cloud Functions rebuild the PDF with the candidate's photo and corrections.
    // `photo`: this PDF carries it (not what was given: the standard-font writer prints none).
    return { record: { status: 'ready', pdfKey, size: pdf.byteLength ?? pdf.length, language, headline: cv.headline, dropped: cv.dropped, renderer, cv, ...(photoPrinted ? { photo: true } : {}), ...(inplace ? { inplace } : {}), ...(repaired ? { repaired: true } : {}) }, text };
  } catch (error) {
    log('tailored cv failed', error instanceof Error ? error.message.slice(0, 80) : 'error');
    return { record: { status: 'failed', language }, text: '' };
  }
}

// Fields every profile read by this version has (sanitizeProfile writes them, even empty).
const PROFILE_FIELDS = ['aptitudeTests', 'recognitions', 'projects', 'interests', 'references', 'drivingLicence', 'currentEducation'];

function profileOfThisVersion(profile) {
  return PROFILE_FIELDS.every((key) => key in profile) && (profile.experience || []).every((role) => typeof role?.kind === 'string');
}

function hashText(text) {
  let hash = 0;
  for (let index = 0; index < text.length; index += 1) hash = (hash * 31 + text.charCodeAt(index)) | 0;
  return String(hash >>> 0);
}
