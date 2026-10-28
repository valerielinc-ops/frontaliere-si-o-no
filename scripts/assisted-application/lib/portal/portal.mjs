/**
 * Portal runner (fase 3b: portals without an account; fase 3c: accounts).
 *
 *   open the apply URL → reach the real form (career-ops: the application host
 *   may differ from the posting host) → per page: CAPTCHA / login check,
 *   Codex plan, deterministic fill, next → submit → confirmation.
 *
 * NopeCHA solves supported CAPTCHAs in the runner's browser (owner request
 * 2026-10-01); an unresolved challenge still ends in a handoff.
 * A login page is handled by account.mjs: an
 * account on the order's alias, created by the runner and verified through
 * the order's inbox. An application form that asks for the account's password
 * itself (umantis) is the form: filled and sent as any other, the password
 * with it. A required answer only the candidate can give ends in
 * `submit_needs_candidate` with the question; the flow asks it on the review
 * page and dispatches the submission again.
 * A click on "submit" whose outcome cannot be confirmed is never retried
 * (career-ops: an ambiguous submit is not re-submitted).
 * A page the deterministic filler cannot move on (a calendar, option cards,
 * a custom dropdown, fields with generated names) goes to the agentic
 * fallback (agent.mjs): Codex on Playwright's accessibility snapshot, as
 * career-ops drives Playwright MCP. Next and the final submit stay here.
 */

import path from 'node:path';
import { AGENT_ROUNDS, advanceLocator, clickSubmitButton, completeWithAgent, submitLocator } from './agent.mjs';
import { CREATE_ACCOUNT_RE, RESEND_VERIFICATION_RE, SIGN_IN_RE, VERIFY_PAGE_RE, authPageKind, codeField, inlineAccountForm, loginFields, newPortalPassword, registrationOutcome, usesOtpAccountCreation, verificationIsPending, verificationOutcome } from './account.mjs';
import { extractFields, registerPortalChannelType } from './fields.mjs';
import { startPortalDiagnostics } from './diagnostics.mjs';
import { NO_PORTAL_KNOWLEDGE, labelsAt, learnedButton } from './knowledge.mjs';
import { candidateAnswerForField, holdsValue, ownConsent, planPage, questionTopic, targetEmployerNoOption } from './plan.mjs';
import { portalAnswerForApplication, portalOptionMap, portalQuestionId, portalQuestionKey, slugId } from './question-key.mjs';
import { codexPrompt } from '../../../../functions/src/assistedApplicationAiPrompts.js';
import { splitName } from '../../../../functions/src/assistedApplicationAiDraftCore.js';
import { sanitizeValidation } from '../../../../functions/src/lib/answerRules.js';
import { isoDateOf } from '../../../../functions/src/lib/cvPeriod.js';
import { permitStatement, printedPermitText } from '../../../../functions/src/lib/permitStatus.js';
import { formatInternationalPhone, phoneCountryLabel } from '../../../../functions/src/lib/phoneNormalization.js';
import { resolveResidenceAddress } from './residence-address.mjs';
import { CONFIRM_RE, NEXT_RE, REFUSED_RE, SUBMIT_RE, VALIDATION_RE, applyActions, chooseChooserFiles, documentPaths, findButton, locatorFor, uploadReceipt } from './fill.mjs';
import { launchChromium } from '../../../lib/ensure-chromium.mjs';
import { awaitCaptcha, CAPTCHA_TIMEOUT_MS, launchNopechaContext } from './nopecha.mjs';
import { classifyLiveness, isHardClosed } from '../liveness.mjs';

export const WAVE1_CHANNELS = new Set([
  'employer_site', 'lever', 'greenhouse', 'smartrecruiters', 'personio', 'softgarden', 'umantis', 'refline', 'jobs_ch',
  // Workday and SuccessFactors: a guest application where the tenant allows
  // it, otherwise an account on the order's alias (account.mjs).
  'workday', 'successfactors',
]);
// Login pages in one run: create, verify, sign in, and one retry.
const MAX_AUTH_STEPS = 5;
const ACCOUNT_VERIFY_RE = /^(verify|verifizieren|bestätigen|verifica|conferma|vérifier|confirmer)$/i;
const INTL = { it: 'it-CH', de: 'de-CH', fr: 'fr-CH', en: 'en-GB' };
// Anywhere in the label: Personio says "Auf diese Stelle bewerben".
export const APPLY_RE = /(\bapply\b|bewerben\b|bewerbung starten|zur bewerbung|\bcandidati\b|\bcandidarsi\b|invia (la tua )?candidatura|\bcandidatura\s+online\b|\bpostuler\b|\bpostulez\b|je postule)/i;
// «Später bewerben» on Prospective.ch's career pages (Coop, 2026-10-02) keeps
// the posting for later by e-mail: never the way into the form.
export const APPLY_LATER_RE = /(später|spaeter|\blater\b|più tardi|piu tardi|plus tard|merken)/i;
const startsApplication = (text) => APPLY_RE.test(text) && !APPLY_LATER_RE.test(text);
const OUTCOME_TIMEOUT_MS = 60_000;
// How long a registration or a sign-in gets to answer its click, and how often the page is read meanwhile.
const AUTH_OUTCOME_TIMEOUT_MS = 20_000;
const AUTH_OUTCOME_POLL_MS = 500;
// How long the link between the two account pages («Sign In» under the registration form, «Create Account»
// under the sign-in one) gets to draw the other page.
const AUTH_VIEW_TIMEOUT_MS = 8_000;
// Between the last field typed and the reading that checks it is still there: a form drawn anew meanwhile
// shows by then, and Workday counts a click in the first half second of its form as a robot's.
const AUTH_TYPED_WAIT_MS = 600;
// How long a choice gets to redraw the form it belongs to, and how often one page is planned again for it.
const REDRAW_WAIT_MS = 3000;
const MAX_REDRAWS_PER_PAGE = 2;
// A page with nothing to fill on which the portal itself asks to be loaded again («Something went wrong.
// Please refresh the page and then try again»: Workday, when the account already holds an application in
// progress for the posting; its first request for a new one is refused, and the page loaded next is the
// application), and how often one address is loaded again for it.
export const REFRESH_ASKED_RE = /(refresh (the|this) page|reload (the|this) page|seite (neu laden|aktualisieren)|laden sie die seite neu|aktualisieren sie die seite|ricaric(a|are|hi) la pagina|aggiorn(a|are|i) la pagina|(actualise[rz]|rafra[iî]chi(r|ssez)|recharge[rz]) la page)/i;
const MAX_REFRESHES_PER_PAGE = 2;
// The control that takes an uploaded file away again, associated with the row containing its filename.
export const REMOVE_FILE_RE = /(^|\b)(delete|remove|löschen|entfernen|elimina|rimuovi|supprimer|retirer)\b/i;

/** A failed consent click never permits the runner to navigate or submit. */
export function failedConsentRequiresHandoff(result, action, field) {
  if (result?.ok || action?.action !== 'check') return false;
  return action.source === 'consent' || Boolean(field?.required) || ownConsent(field);
}

/** The buttons that remove a file of one of these names: the same document, uploaded by an earlier run. */
export function removalsOf(buttons, names) {
  return (buttons || []).filter((button) => {
    if (button.disabled || !REMOVE_FILE_RE.test(button.text || '')) return false;
    const context = `${button.text || ''} ${button.fileContext || ''}`.toLowerCase();
    return names.some((name) => name && context.includes(String(name).toLowerCase()));
  });
}

const PREVIOUS_FILE_REMOVAL_TIMEOUT_MS = 1500;

/** Wait for an asynchronously removed prior document to leave the rendered page. */
export async function waitForFileRemoval(page, name) {
  try {
    await page.getByText(name, { exact: false }).first()
      .waitFor({ state: 'hidden', timeout: PREVIOUS_FILE_REMOVAL_TIMEOUT_MS });
    return true;
  } catch {
    return false;
  }
}

const EXPERIENCE_SECTION_RE = /\b(?:experience|work history|employment history|berufserfahrung|erfahrung|expérience|parcours professionnel|esperienz[ae]|esperienza lavorativa|esperienze lavorative)\b/i;
const EDUCATION_SECTION_RE = /\b(?:education|education history|academic history|school|ausbildung|bildung|études|formation|educazione|istruzione|formazione)\b/i;

export function profileSectionKind(value) {
  const text = String(value || '');
  if (EXPERIENCE_SECTION_RE.test(text)) return 'experience';
  if (EDUCATION_SECTION_RE.test(text)) return 'education';
  return '';
}

function hasExplicitMonth(value) {
  const text = String(value || '').trim();
  let match = /^(\d{4})[-/.](\d{1,2})(?:[-/.]\d{1,2})?$/.exec(text);
  if (match) return Number(match[2]) >= 1 && Number(match[2]) <= 12;
  match = /^(\d{1,2})[-/.](\d{4})$/.exec(text);
  if (match) return Number(match[1]) >= 1 && Number(match[1]) <= 12;
  return /\b(?:jan(?:uary|uar)?|feb(?:ruary|ruar)?|mar(?:ch|z)?|apr(?:il)?|may|mai|jun(?:e|i)?|jul(?:y|i)?|aug(?:ust)?|sep(?:tember|t)?|oct(?:ober|ober)?|nov(?:ember)?|dec(?:ember)|gen(?:naio)?|febbraio|marzo|apr(?:ile)?|mag(?:gio)?|giu(?:gno)?|lug(?:lio)?|ago(?:sto)?|sett(?:embre)?|ott(?:obre)?|nov(?:embre)?|dic(?:embre)?|janv(?:ier)?|févr(?:ier)?|mars|avr(?:il)?|juin|juil(?:let)?|août|sept(?:embre)?|oct(?:obre)?|nov(?:embre)?|déc(?:embre)?|januar|februar|märz|mai|juni|juli|oktober|dezember)\b.*\b(?:19|20)\d{2}\b/i.test(text);
}

/** Profile rows whose dates retain month-level precision, in the source order. */
export function profileEntriesForSection(candidate, kind) {
  const source = candidate?.profile?.[kind];
  if (!Array.isArray(source) || !['experience', 'education'].includes(kind)) return [];
  return source.filter((entry) => {
    const title = kind === 'experience' ? entry?.role : entry?.degree;
    const organization = kind === 'experience' ? entry?.employer : entry?.institution;
    return Boolean(String(title || '').trim() && String(organization || '').trim()
      && hasExplicitMonth(entry?.start) && hasExplicitMonth(entry?.end));
  });
}

/** Exact labels in an opened history row can use only that row's own profile value. */
export function profileEntryAnswer(entry, kind, field) {
  const label = String(field?.label || '').trim();
  const mappings = kind === 'experience'
    ? [[/^(?:job title|position|role)\s*[＊*]?$/i, 'role'], [/^employer\s*[＊*]?$/i, 'employer'], [/^start date\s*[＊*]?$/i, 'start'], [/^end date\s*[＊*]?$/i, 'end']]
    : kind === 'education'
      ? [[/^(?:degree|qualification)\s*[＊*]?$/i, 'degree'], [/^(?:institution|school)\s*[＊*]?$/i, 'institution'], [/^start date\s*[＊*]?$/i, 'start'], [/^end date\s*[＊*]?$/i, 'end']]
      : [];
  const key = mappings.find(([pattern]) => pattern.test(label))?.[1];
  const value = key ? String(entry?.[key] || '').trim() : '';
  return value ? { value, source: 'profile' } : null;
}
const POPUP_WAIT_TIMEOUT_MS = 60_000;
const POPUP_GRACE_MS = 6_000;
// Scans that only look for buttons, a CAPTCHA or a login never open listboxes (see extractFields).
const NAVIGATION = { listboxOptions: false };
// Codex turns of the agentic fallback in one run (each page has AGENT_ROUNDS at most).
const MAX_AGENT_CALLS = 16;

function isSuccessFactorsPostingEntry({ applyUrl, postingUrl } = {}) {
  try {
    const apply = new URL(String(applyUrl || ''));
    const posting = new URL(String(postingUrl || ''));
    const applyId = /^\/talentcommunity\/apply\/([^/]+)\/?$/i.exec(apply.pathname)?.[1];
    const postingId = /^\/job\/[^/]+\/([^/]+)\/?$/i.exec(posting.pathname)?.[1];
    return apply.origin === posting.origin && Boolean(applyId) && postingId === applyId;
  } catch {
    return false;
  }
}

/**
 * Employer-hosted job apply routes can redirect to a generic application page
 * when opened cold. Enter through the matching job detail page first so its
 * normal Apply link establishes the portal session. Match both origin and the
 * complete job route: a stale or unrelated posting URL must never change
 * which application the runner opens.
 */
function isDirectJobApplyEntry({ applyUrl, postingUrl } = {}) {
  try {
    const apply = new URL(String(applyUrl || ''));
    const posting = new URL(String(postingUrl || ''));
    const applyRoute = /^(.*\/jobs\/)([^/]+)\/apply\/?$/i.exec(apply.pathname);
    const postingRoute = /^(.*\/jobs\/)([^/]+)\/?$/i.exec(posting.pathname);
    return apply.origin === posting.origin
      && Boolean(applyRoute && postingRoute)
      && applyRoute[1] === postingRoute[1]
      && applyRoute[2] === postingRoute[2];
  } catch {
    return false;
  }
}

/**
 * Umantis application URLs carry the vacancy id in the ATS route
 * (`/Vacancies/<id>/Application/...`). Only a posting on the same origin is
 * an explicit URL-level binding to that application; a numeric id on another
 * host can belong to an unrelated job and must never replace the application
 * entry point.
 */
function isUmantisPostingEntry({ applyUrl, postingUrl } = {}) {
  try {
    const apply = new URL(String(applyUrl || ''));
    const posting = new URL(String(postingUrl || ''));
    if (!/(?:^|\.)umantis\.com$/i.test(apply.hostname)) return false;
    const applyId = /\/vacancies\/(\d+)\/application(?:\/|$)/i.exec(apply.pathname)?.[1];
    const postingId = /\/vacancies\/(\d+)(?:\/description(?:\/[^/]+)?)?\/?$/i.exec(posting.pathname)?.[1];
    return apply.origin === posting.origin && Boolean(applyId && postingId && applyId === postingId);
  } catch {
    return false;
  }
}

/**
 * A URL pair that proves the application belongs to the selected posting.
 * This is stronger than the rendered posting text: Umantis can show a generic
 * application form without repeating the employer or vacancy title.
 */
export function isVerifiedPostingEntry({ applyUrl, postingUrl } = {}) {
  return isSuccessFactorsPostingEntry({ applyUrl, postingUrl })
    || isDirectJobApplyEntry({ applyUrl, postingUrl })
    || isUmantisPostingEntry({ applyUrl, postingUrl });
}

export function portalEntryUrl({ applyUrl, postingUrl } = {}) {
  const directUrl = String(applyUrl || '');
  try {
    const apply = new URL(directUrl);
    const posting = new URL(String(postingUrl || ''));
    if (isVerifiedPostingEntry({ applyUrl: apply.href, postingUrl: posting.href })) return posting.href;
  } catch {
    // Keep the given application URL when either address is absent or invalid.
  }
  return directUrl;
}

function portalChannelType(ctx = {}) {
  if (ctx.channelType === 'successfactors') return ctx.channelType;
  // A branded SuccessFactors tenant has an employer hostname, so the draft's
  // hostname classifier can call it `employer_site`. The exact same-origin,
  // same-requisition Jobs2Web route proves which ATS rules apply.
  if (isSuccessFactorsPostingEntry(ctx)) return 'successfactors';
  return ctx.channelType || '';
}

/**
 * The browser's own user agent without "Headless", on the machine's real
 * system: some ATS turn away a browser that calls itself HeadlessChrome
 * (owner decision 2026-10-01). Same Chrome version, nothing else disguised.
 */
export function realisticUserAgent(version, platform = process.platform) {
  const system = platform === 'darwin' ? 'Macintosh; Intel Mac OS X 10_15_7' : platform === 'win32' ? 'Windows NT 10.0; Win64; x64' : 'X11; Linux x86_64';
  const major = /^\d+/.exec(String(version || ''))?.[0] || '140';
  return `Mozilla/5.0 (${system}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`;
}

// Path segments that name the employer or the posting, not the portal's page.
const NAMED_SEGMENT_AFTER = /^(companies|company|jobs|job|careers|career|positions|position|stellen|stelle|offerte|offres|vacancies|postings|o|j)$/i;

/**
 * The page's address with the employer and the posting left out, for a public
 * fix issue (self-correction, level 3): "join.com/companies/acme/16772222/apply/review"
 * → "/companies/*\/*\/apply/review". Ids, long slugs and the segment after
 * "companies", "jobs"… become "*"; the query and the hash go.
 */
export function anonymizePath(url) {
  let path = '';
  try {
    path = new URL(url).pathname;
  } catch {
    return '';
  }
  const segments = path.split('/').filter(Boolean);
  return `/${segments.map((segment, index) => {
    const named = index > 0 && NAMED_SEGMENT_AFTER.test(segments[index - 1]) && segments[index - 1].length > 1;
    return named || /\d/.test(segment) || segment.length > 24 ? '*' : segment;
  }).join('/')}`;
}

/**
 * Where and why the runner stopped, as a fixer needs it and nothing more
 * (self-correction, level 3): the portal's host, the anonymized page, the
 * buttons, the fields' labels and kinds, the form's messages. Never a value:
 * agent.mjs also strikes every value of the candidate out before it leaves.
 */
export function stopReportFrom({ url, reason, step, seen, agent = [] }) {
  let host = '';
  try {
    host = new URL(url).hostname;
  } catch {
    host = '';
  }
  return {
    host,
    path: anonymizePath(url),
    reason,
    step,
    buttons: [...new Set((seen?.buttons || []).map((button) => String(button.text || '').trim()).filter(Boolean))].slice(0, 30),
    fields: (seen?.fields || []).slice(0, 30).map((field) => ({ label: String(field.label || '').slice(0, 120), kind: field.kind, required: Boolean(field.required) })),
    errors: (seen?.errors || []).slice(0, 8),
    agent: agent.map((item) => ({ hint: item.hint, status: item.status })),
  };
}

/** The workflow runs the browser headed on a virtual screen (xvfb-run) when it can. */
export const headedBrowser = () => process.env.ASSISTED_APPLICATION_HEADED === '1';

/** A label that is a generated name, not a question ("select-input-_r_p_", "file:_r_3_:input"). */
export function machineLabel(label) {
  const text = String(label || '').trim();
  return !text || (/^[\w:.-]+$/.test(text) && /[_:\d]/.test(text));
}

export { portalQuestionId, portalQuestionKey, slugId };

/**
 * What the planner may use, with the alias as the e-mail (candidateIdentity).
 * `language`: the form's, for the candidate's Swiss status as a full sentence.
 */
export function candidateForForm({ identity, profile = {}, answers = {}, draft = {}, portalQuestions = [], extraDocuments = [], language = 'it', personal = {}, job = {} }) {
  // The split the candidate chose on the review page, else the surname with its particles (splitName).
  const names = typeof identity.firstName === 'string' ? identity : splitName(identity.name);
  const latest = (profile.experience || [])[0] || {};
  const motivation = Object.fromEntries((draft.formAnswers || []).map((field) => [field.key, field.value]));
  const status = profile.permitStatus || '';
  const portalQuestionsAnswered = portalAnswersForQuestions(portalQuestions, answers, draft.portalAnswers?.answers);
  // Older drafts may predate the profile enrichment done during draft mode;
  // resolve once more at the browser boundary without an external geocoder.
  const address = resolveResidenceAddress(profile.address, profile.location);
  return {
    // The target employer is needed for employer-specific eligibility fields
    // such as «Are you already an employee?». It is public posting data, not a
    // candidate fact; the planner still answers only from the employer list.
    job: {
      title: String(job.title || '').slice(0, 300),
      company: String(job.company || '').slice(0, 300),
      organization: String(job.organization || '').slice(0, 300),
    },
    identity: {
      fullName: identity.name,
      firstName: names.firstName,
      lastName: names.lastName,
      email: identity.email,
      phone: formatInternationalPhone(identity.phone),
      phoneCountry: phoneCountryLabel(identity.phone, language),
      location: profile.location || '',
      address,
      linkedin: profile.linkedin || '',
      website: profile.website || '',
    },
    profile: {
      headline: profile.headline || '',
      currentOrLatestRole: [latest.role, latest.employer].filter(Boolean).join(' — '),
      employers: [...new Set([
        ...(Array.isArray(profile.employers) ? profile.employers : []),
        ...(profile.experience || []).map((item) => item.employer),
      ].filter(Boolean))].slice(0, 15),
      // Workday's, SuccessFactors' and umantis' "My Experience" steps: the work
      // history as the CV states it, instead of questions to the candidate.
      experience: (profile.experience || []).slice(0, 8)
        .map(({ role = '', employer = '', location = '', start = '', end = '' }) => ({ role, employer, location, start, end })),
      languages: profile.languages || [],
      languagesExplicitList: profile.languagesExplicitList === true,
      // The detected language of the candidate's CV is evidence for the
      // planner's conservative native-language rule; it is not a nationality
      // or a replacement for explicitly stated language levels.
      cvLanguage: profile.cvLanguage || '',
      education: (profile.education || []).slice(0, 4)
        .map(({ degree = '', institution = '', start = '', end = '' }) => ({ degree, institution, start, end })),
      currentEducation: {
        degree: profile.currentEducation?.degree || '',
        institution: profile.currentEducation?.institution || '',
        start: profile.currentEducation?.start || '',
        end: profile.currentEducation?.end || '',
        grade: profile.currentEducation?.grade || '',
      },
      // Nothing chosen: the CV's own words, never a permit to come nor «no permit» (lib/permitStatus.js).
      workPermit: status ? '' : printedPermitText(profile.workPermit),
      availability: profile.availability || '',
      // In the form the portals read.
      dateOfBirth: isoDateOf(profile.dateOfBirth) || profile.dateOfBirth || '',
      nationality: profile.nationality || '',
      // What the CV says in its own words, or the candidate corrected (candidateWithEdits `personal`): a
      // portal that asks the civil status is answered from it, not by a question to the candidate. The form
      // of address the CV states is in `answers.salutation` already.
      civilStatus: personal?.civilStatus || '',
    },
    // The Swiss status the candidate chose, as a full sentence in the form's language (decision 9). Outside
    // `answers` and `profile`: the substring rule (plan.mjs knownValuesOf) never reads it, so a label holding
    // «Svizzera» or «Schweiz» never backs a nationality answer.
    swissStatus: status ? { code: status, statement: permitStatement(status, language) } : null,
    // The status chosen replaces the answer to the permit question: the statement says it.
    answers: status ? Object.fromEntries(Object.entries(answers).filter(([id]) => id !== 'work_permit')) : answers,
    portalQuestionsAnswered,
    texts: {
      motivationShort: motivation.motivationShort || '',
      whyCompany: motivation.whyCompany || '',
      coverLetter: draft.coverLetter?.text || '',
    },
    // The requested documents the candidate gave (assistedApplicationExtraDocuments.js), by form slot.
    // With its keywords: the names the same document goes by in the other languages, for the field that asks it
    // and for a question that only asks whether the candidate holds it (plan.mjs).
    // Only a document with a file: being listed here is what answers «do you hold it?» with a yes, and one
    // requested but not given is not held (review of #12363; extraDocumentsToSend already drops them).
    documents: {
      cv: true,
      cover_letter: true,
      extra: extraDocuments
        .filter((document) => Array.isArray(document?.files) && document.files.length > 0)
        .map(({ slot, label, kind, keywords = [] }) => ({ slot, label, kind, keywords })),
    },
  };
}

/**
 * Keep portal answers usable when an ATS changes a question's wording or
 * regenerates its field id between account creation and the application form.
 * Current answers win; canonical topics also reuse an unambiguous answer from
 * the previous portal run when an ATS regenerates its field id.
 */
function portalAnswersForQuestions(questions, answers, previousAnswers = []) {
  const items = questions.map((question) => ({
    question: question.applicationQuestion || question.question,
    ...(question.applicationQuestion ? { applicationQuestion: question.applicationQuestion } : {}),
    ...(question.applicationQuestion ? { candidateQuestion: question.question } : {}),
    context: question.context || '',
    section: question.section || '',
    autocomplete: question.autocomplete || '',
    answer: portalAnswerForApplication(question, answers[question.id]),
    source: 'answers',
    current: true,
  })).filter((item) => item.answer);
  const keyFor = (item) => portalQuestionKey(item) || portalQuestionId(item);
  const currentKeys = new Set(questions
    // An empty value under a regenerated field id is not an answer; keep the
    // previous semantic answer eligible for that same question.
    .filter((question) => question?.id && String(answers[question.id] ?? '').trim())
    .map((question) => keyFor({ applicationQuestion: question.applicationQuestion, question: question.question, context: question.context || '', section: question.section || '', autocomplete: question.autocomplete || '' })));
  const priorGroups = new Map();
  for (const item of Array.isArray(previousAnswers) ? previousAnswers : []) {
    const question = String(item?.question || '').trim();
    const answer = String(item?.answer || '').trim();
    if (!question || !answer) continue;
    const prior = { question, context: String(item?.context || ''), section: String(item?.section || ''), autocomplete: String(item?.autocomplete || ''), answer, source: String(item?.source || 'answers') };
    const key = keyFor(prior);
    if (currentKeys.has(key)) continue;
    const group = priorGroups.get(key) || [];
    group.push(prior);
    priorGroups.set(key, group);
  }
  for (const group of priorGroups.values()) {
    const values = new Set(group.map((item) => item.answer.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, ' ').trim().toLowerCase()));
    if (values.size === 1) items.unshift(group[0]);
  }
  const seen = new Map();
  for (const item of items) {
    const key = keyFor(item);
    const previous = seen.get(key);
    if (!previous || item.current) seen.set(key, item);
  }
  return [...seen.values()].map(({ question, applicationQuestion, candidateQuestion, answer, context, section, autocomplete, source }) => ({
    question, ...(applicationQuestion ? { applicationQuestion } : {}), ...(candidateQuestion ? { candidateQuestion } : {}), answer, source, ...(context ? { context: context.slice(0, 240) } : {}), ...(section ? { section: section.slice(0, 240) } : {}), ...(autocomplete ? { autocomplete: autocomplete.slice(0, 100) } : {}),
  }));
}

/** Resolve required portal questions from the candidate data before the submit gate. */
export function autoAnswersForPortalQuestions({ questions = [], candidate, answers = {} } = {}) {
  const out = {};
  for (const question of questions) {
    if (question?.source !== 'portal' || !question.required || String(answers?.[question.id] ?? '').trim()) continue;
    const options = (Array.isArray(question.applicationOptions) && question.applicationOptions.length
      ? question.applicationOptions
      : Array.isArray(question.options) ? question.options : [])
      .map((option) => typeof option === 'string' ? { label: option } : option)
      .filter((option) => option && String(option.label || '').trim());
    const field = {
      id: question.id,
      kind: options.length || ['choice', 'yes_no'].includes(question.type) ? 'select' : 'text',
      label: question.applicationQuestion || question.question,
      context: question.context || '',
      section: question.section || '',
      autocomplete: question.autocomplete || '',
      required: true,
      options,
    };
    const answer = candidateAnswerForField(candidate, field)
      || (() => {
        const no = targetEmployerNoOption(field, candidate);
        return no ? { value: no.label, source: 'rule' } : null;
      })();
    if (answer?.value) out[question.id] = answer.value;
  }
  return out;
}

/** How an upload reads in the evidence: [CV], [lettera di presentazione], [documento: Bulletins scolaires]. */
function uploadLabel(document, candidate) {
  if (document === 'cover_letter') return '[lettera di presentazione]';
  const extra = (candidate?.documents?.extra || []).find((item) => item.slot === document);
  return extra ? `[documento: ${extra.label}]` : '[CV]';
}

function hasApplicationForm(snapshot) {
  const kinds = snapshot.fields.map((field) => field.kind);
  const textish = snapshot.fields.filter((field) => field.kind === 'text' || field.kind === 'textarea').length;
  const email = snapshot.fields.some((field) => field.inputType === 'email' || /e-?mail/i.test(field.label));
  return kinds.includes('file') || (textish >= 3 && email);
}

/**
 * A page with only the employer site's header/footer controls is not an
 * application form. Keeping this separate from hasApplicationForm matters:
 * custom application widgets may have no native fields yet, but their own
 * buttons are still actionable and must reach the agentic fallback.
 */
export function hasApplicationSurface(snapshot) {
  return Boolean(snapshot?.fields?.length || snapshot?.buttons?.some((button) => !button.chrome));
}

export function needsPortalOptionRead(snapshot = {}) {
  return snapshot.fields?.some((field) => field.kind === 'listbox' || field.selectLike) || false;
}

/** A SuccessFactors page resumed between account creation and OTP submission. */
export function isOtpVerificationPage(snapshot, host, account) {
  if (!account || account.verifiedAt || !usesOtpAccountCreation(host) || hasApplicationForm(snapshot)) return false;
  if (!codeField(snapshot)) return false;
  return Boolean(findButton(snapshot.buttons || [], NEXT_RE)
    || findButton(snapshot.buttons || [], SUBMIT_RE)
    || findButton(snapshot.buttons || [], ACCOUNT_VERIFY_RE));
}

/**
 * A page that has just changed may still be drawing its form (JOIN's steps
 * render a moment after the address changes, dry_run 36817633054 read none):
 * up to 10 s for its fields, and while `unchanged` says it is the old page.
 */
async function awaitFields(page, snapshot, unchanged = () => false) {
  let current = snapshot;
  for (let waited = 0; waited < 10_000 && (unchanged(current) || !current.fields.length); waited += 2000) {
    await page.waitForTimeout(2000);
    current = await extractFields(page);
  }
  return current;
}

/** A page is the same page when the URL and the field labels are (Workday's steps share one URL). */
function pageSignature(page, snapshot) {
  return `${page.url()}|${snapshot.fields.map((field) => field.label).join('|')}`;
}

/** The page's visible text, frames included (Greenhouse embeds its form). */
async function pageText(page) {
  const texts = await Promise.all(page.frames().slice(0, 5).map((frame) => frame.evaluate(() => document.body?.innerText || '').catch(() => '')));
  return texts.join('\n').slice(0, 60_000);
}

async function settle(page) {
  await page.waitForLoadState('domcontentloaded').catch(() => {});
  await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
}

/**
 * The control a snapshot named, found again in a fresh reading of the page: the same name in the same place
 * (the page or the site's header, a dialog or not).
 */
async function sameControl(page, button) {
  const fresh = await extractFields(page, NAVIGATION).catch(() => null);
  return fresh?.buttons.find((candidate) => candidate.text === button.text && !candidate.disabled
    && Boolean(candidate.chrome) === Boolean(button.chrome) && Boolean(candidate.dialog) === Boolean(button.dialog)
    && (candidate.frame || 0) === (button.frame || 0)) || null;
}

/** Presses a control of a snapshot; says how it was found (`id`, `again`, `text`, `href`). */
async function clickButton(page, button) {
  const frame = page.frames()[button.frame || 0] || page.mainFrame();
  try {
    await frame.locator(`[data-aa-id="${button.id}"]`).first().click({ timeout: 6_000 });
    return 'id';
  } catch (error) {
    // Workday animates its apply modal and re-renders its forms, dropping our data-aa-id: the same control
    // is found again in a fresh reading, by its name and its place. Its visible text alone finds the first
    // thing on the page that says so: for the form's «Sign In» on Workday that is the header's, which opens
    // a dialog over the form (dry run of 2026-10-07). A control found again that still cannot be pressed
    // is covered by something: nothing else is pressed in its place.
    if (!button.text) throw error;
    const again = await sameControl(page, button);
    if (again) {
      await frame.locator(`[data-aa-id="${again.id}"]`).first().click({ timeout: 6_000 });
      return 'again';
    }
    try {
      await frame.getByText(button.text, { exact: true }).first().click({ timeout: 6_000 });
      return 'text';
    } catch (textError) {
      // A link that never settles is followed by its address.
      if (!button.href) throw textError;
      await page.goto(button.href, { waitUntil: 'domcontentloaded', timeout: 60_000 });
      return 'href';
    }
  }
}

/**
 * Click a portal link without pinning a stale ElementHandle. Some ATS pages
 * re-render their navigation links while an application session starts; a
 * locator can re-resolve the link, and its href gives us a safe navigation
 * fallback when the click still times out.
 */
export async function clickPortalLink(page, link, { context = null } = {}) {
  // Start this before reading href or clicking: an ATS can re-render the
  // locator for several seconds before dispatching a target="_blank" popup.
  const popup = context?.waitForEvent('page', { timeout: POPUP_WAIT_TIMEOUT_MS }).catch(() => null);
  const href = await link.getAttribute('href', { timeout: 6_000 }).catch(() => null);
  try {
    await link.click({ timeout: 6_000 });
  } catch (error) {
    if (!href || /^(?:#|javascript:|mailto:|tel:)/i.test(String(href).trim())) throw error;
    let target;
    try {
      target = new URL(href, page.url()).href;
    } catch {
      throw error;
    }
    await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  }
  if (!popup) return null;
  // A link without a popup should continue promptly after a short grace
  // window; clear the timer as soon as the popup arrives.
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), POPUP_GRACE_MS);
    popup.then((opened) => {
      clearTimeout(timer);
      resolve(opened);
    });
  });
}

// Cookie banners: refuse the non-essential cookies when the banner offers it,
// otherwise accept (the runner's own browser session, no candidate data).
// SuccessFactors' own cookie manager (Rolex, 2026-10-03) names the cookies in
// each button — «Refuser tous les cookies», «Alle Cookies ablehnen», «Reject
// All Cookies», «Rifiuta tutti i cookie» — and, left open, takes every click
// on the sign-in page behind it.
export const COOKIE_REJECT_RE = /^(ablehnen|alle( cookies)? ablehnen|nur (notwendige|erforderliche)( cookies)?|reject( all)?( cookies)?|decline( all)?( cookies)?|only necessary|rifiuta( tutti| tutto)?( i cookie)?|solo necessari|refuser( tout| tous les cookies)?|tout refuser|continuer sans accepter)$/i;
export const COOKIE_ACCEPT_RE = /^(cookies akzeptieren|alle( cookies)? akzeptieren|akzeptieren|accept( all)?( cookies)?|accetta( tutti)?( i cookie)?|tout accepter|accepter( tout| tous les cookies)?|ok)$/i;
// Workday offers autofill, "use my last application" or a manual application: manual is the predictable one.
const MANUAL_APPLY_RE = /^(manuell bewerben|apply manually|candidarsi manualmente|candidatura manuale|postuler manuellement)$/i;

export async function dismissCookieBanner(page, snapshot) {
  const button = findButton(snapshot.buttons, COOKIE_REJECT_RE) || findButton(snapshot.buttons, COOKIE_ACCEPT_RE);
  if (button) {
    await clickButton(page, button).catch(() => {});
    await page.waitForTimeout(800);
    return true;
  }
  // A banner inside a shadow root (Usercentrics on Coop's career pages,
  // 2026-10-02) is out of the page scan's reach while its overlay takes every
  // click. Only a shadow root's own buttons: marked in the page, clicked by a
  // CSS locator (it pierces open shadow roots).
  if (!await markShadowCookieButton(page)) return false;
  await page.locator('[data-aa-cookie="1"]').first().click({ timeout: 6_000 }).catch(() => {});
  await page.waitForTimeout(800);
  return true;
}

async function markShadowCookieButton(page) {
  return page.evaluate(([reject, accept]) => {
    const roots = [document];
    const shadows = [];
    for (let index = 0; index < roots.length && index < 50; index += 1) {
      for (const element of roots[index].querySelectorAll('*')) {
        if (!element.shadowRoot) continue;
        roots.push(element.shadowRoot);
        shadows.push(element.shadowRoot);
      }
    }
    for (const source of [reject, accept]) {
      const pattern = new RegExp(source, 'i');
      for (const shadow of shadows) {
        const button = [...shadow.querySelectorAll('button, [role="button"]')]
          .find((element) => element.getBoundingClientRect().width > 0 && pattern.test(String(element.innerText || element.textContent || '').trim()));
        if (button) {
          button.setAttribute('data-aa-cookie', '1');
          return true;
        }
      }
    }
    return false;
  }, [COOKIE_REJECT_RE.source, COOKIE_ACCEPT_RE.source]).catch(() => false);
}

/**
 * From the posting to the form, up to three hops (Workday: "Bewerben", then
 * "Manuell bewerben"; a cookie banner can come back on each page). A new tab
 * opened by the apply button is followed.
 */
async function openApplicationForm(context, page, snapshot) {
  for (let hop = 0; hop < 3; hop += 1) {
    if (await dismissCookieBanner(page, snapshot)) snapshot = await extractFields(page, NAVIGATION);
    if (hasApplicationForm(snapshot)) return { page, snapshot };
    const manual = findButton(snapshot.buttons, MANUAL_APPLY_RE);
    const apply = manual ? null : snapshot.buttons.find((button) => !button.disabled && startsApplication(button.text)) || null;
    const link = manual || apply ? null : page.getByRole('link', { name: APPLY_RE }).filter({ hasNotText: APPLY_LATER_RE }).first();
    const linkVisible = link
      ? await link.waitFor({ state: 'visible', timeout: 6_000 }).then(() => true, () => false)
      : false;
    if (!manual && !apply && !linkVisible) return { page, snapshot };
    if (manual || apply) {
      const popup = context.waitForEvent('page', { timeout: POPUP_GRACE_MS }).catch(() => null);
      await clickButton(page, manual || apply);
      page = (await popup) || page;
    } else {
      page = (await clickPortalLink(page, link, { context })) || page;
    }
    await settle(page);
    await page.waitForTimeout(1200); // a modal (Workday's apply dialog) finishes its animation
    snapshot = await extractFields(page, NAVIGATION);
  }
  return { page, snapshot };
}

const normalizeWords = (text) => String(text || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ');
// Legal forms and short words name no company: "Ospedale ABC SA" is "ospedale abc",
// "Coop Genossenschaft" is "coop" (its SuccessFactors pages say only "Coop").
const NOT_A_NAME = new Set(['sa', 'ag', 'gmbh', 'sagl', 'srl', 'spa', 'sarl', 'ltd', 'inc', 'llc', 'kg', 'genossenschaft', 'cooperativa', 'cooperative', 'the', 'und', 'and', 'del', 'della', 'des', 'les', 'der', 'die', 'das']);
const nameWords = (text) => normalizeWords(text).split(' ').filter((word) => word.length >= 3 && !NOT_A_NAME.has(word) && !/^\d+$/.test(word));
const TALENTSOFT_HOST_RE = /(?:^|\.)talent-soft\.com$/i;

function titleMatches(pageText, title) {
  const words = normalizeWords(pageText).split(' ').filter(Boolean);
  const titleWords = nameWords(title).filter((word) => word.length >= 4);
  if (!titleWords.length) return false;
  const variant = (word) => words.some((seen) => seen === word
    || (word.length >= 6 && Math.abs(seen.length - word.length) <= 2 && seen.slice(0, word.length - 2) === word.slice(0, word.length - 2)));
  return titleWords.every(variant);
}

/**
 * Talentsoft employer tenants can use a short brand/acronym in their host
 * while the posting data keeps the employer's localized legal name, e.g.
 * `Ferrovia Retica (RhB)` → `rhb-career.talent-soft.com`. The host is only
 * evidence when the job title is also present: a tenant alone must never turn
 * a generic portal page into this posting's form.
 */
function talentSoftEmployerAliasMatches(pageText, job = {}, pageUrl = '') {
  const aliases = [...String(job.company || '').matchAll(/\(([^)]+)\)/g)]
    .flatMap(([, alias]) => nameWords(alias))
    .filter((alias) => alias.length >= 3);
  if (!aliases.length || !titleMatches(pageText, job.title)) return false;
  const urls = [pageUrl, ...(String(pageText || '').match(/\bhttps?:\/\/[^\s"'<>]+/gi) || [])]
    .filter(Boolean);
  return urls.some((raw) => {
    try {
      const hostname = new URL(raw.replace(/[),.;]+$/, '')).hostname;
      if (!TALENTSOFT_HOST_RE.test(hostname)) return false;
      const tenantTokens = hostname.split('.')[0].split(/[^a-z0-9]+/i).filter(Boolean);
      return aliases.some((alias) => tenantTokens.includes(alias));
    } catch {
      return false;
    }
  });
}

/**
 * Is this form the posting's (career-ops apply.md: company and role on the
 * form match the posting, or stop)? The company's WHOLE name as whole words
 * ("Muster Elektro AG" is not "Altra GmbH — Elektroinstallateur", review of
 * #10715); never its initials ("ME" is in "Tell me more"): a portal that shows
 * only "EOC" goes to Valerie, whose retry goes on. Only when the order names
 * no company, the title: every word, or a gender variant of it
 * ("Infermiere/a" = "Infermiera": same word but the last two letters).
 * 'unknown' when the order names neither.
 */
export function postingMatch(pageText, job = {}, pageUrl = '') {
  const company = nameWords(job.company);
  const title = nameWords(job.title).filter((word) => word.length >= 4);
  if (!company.length && !title.length) return 'unknown';
  if (company.length) {
    // The page's words filtered as the name is ("Ospedale Regionale di Lugano" = "ospedale regionale lugano").
    const named = ` ${nameWords(pageText).join(' ')} `;
    return named.includes(` ${company.join(' ')} `) || talentSoftEmployerAliasMatches(pageText, job, pageUrl) ? 'match' : 'mismatch';
  }
  return titleMatches(pageText, job.title) ? 'match' : 'mismatch';
}

// A page's own vocabulary names no employer («Hotel application», «Bewerbung im Hotel Bereich»).
const FORM_VOCABULARY = new Set([
  'application', 'applications', 'apply', 'bewerbung', 'bewerbungen', 'bewerben', 'candidatura', 'candidature', 'candidati', 'postuler',
  'job', 'jobs', 'career', 'careers', 'karriere', 'carriera', 'carriere', 'stelle', 'stellen', 'offerta', 'offre', 'vacancy', 'vacancies',
  'portal', 'portale', 'portail', 'online', 'form', 'formular', 'formulaire', 'modulo', 'login', 'home', 'tracking', 'system',
  'team', 'bereich', 'welcome', 'willkommen', 'benvenuti', 'bienvenue',
  'process', 'prozess', 'processo', 'processus', 'recruiting', 'recruitment', 'applicant', 'candidate', 'kandidat', 'candidato', 'candidat',
  'stellenangebot', 'stellenanzeige', 'karriereportal', 'jobportal', 'bewerbungsformular', 'onlinebewerbung', 'page', 'seite', 'pagina',
  // SuccessFactors titles every page with its careers section: «Opportunités de carrière : Créer un
  // compte» (Rolex, 2026-10-03), «Karrierechancen: Anmelden» (Coop), «Career Opportunities: …».
  'opportunity', 'opportunities', 'opportunite', 'opportunites', 'opportunita', 'karrierechancen', 'chancen',
  // Workday keeps the title of its account page on every step of the form behind it («Create Account» over
  // «My Information», 2026-10-07): an account page's own words name no employer either.
  'create', 'account', 'sign', 'signin', 'register', 'registration', 'konto', 'erstellen', 'anmelden', 'anmeldung', 'registrieren',
  'registrierung', 'creer', 'compte', 'connexion', 'inscription', 'crea', 'creare', 'accedi', 'accesso', 'registrati', 'registrazione',
]);
// A country in a company's name says which national entity it is, not which company: «Rituals Cosmetics
// Switzerland» and «Rituals Cosmetics Germany GmbH» are one employer's two entities. Countries only:
// «Acme Europe» and «Acme International» are two companies (review of #12292).
const BRANCH_WORDS = new Set([
  'schweiz', 'suisse', 'svizzera', 'switzerland', 'swiss', 'deutschland', 'germany', 'allemagne', 'germania', 'italia', 'italy', 'italien',
  'italie', 'france', 'frankreich', 'francia', 'osterreich', 'austria', 'autriche', 'liechtenstein', 'nederland', 'netherlands',
]);
// What stands next to a country on a form because it labels a field of it, never because it names an
// employer: «Country Switzerland», «Nationality: Switzerland», «Phone Switzerland». Any other word next to
// the country of the order's company still declares someone else («Switzerland Bank», «Other Switzerland»).
const FIELD_LABEL_WORDS = new Set([
  'country', 'countries', 'land', 'lander', 'staat', 'paese', 'nazione', 'stato', 'pays', 'nationality', 'nationalitat', 'staatsangehorigkeit',
  'nazionalita', 'cittadinanza', 'nationalite', 'citizenship', 'residence', 'wohnsitz', 'wohnort', 'residenza', 'domicile', 'domicilio',
  'region', 'regione', 'location', 'standort', 'sede', 'lieu', 'phone', 'telefon', 'telefono', 'telephone', 'mobile', 'code', 'vorwahl',
  'prefisso', 'address', 'adresse', 'indirizzo', 'city', 'ort', 'citta', 'ville', 'canton', 'kanton', 'cantone', 'province', 'provincia',
  'select', 'selected', 'one',
]);

/**
 * Two names of one employer: the same words once the legal form and the country of the branch are left out,
 * and at least one word that is a name (never two «Hotel Schweiz» and «Hotel Deutschland» of anybody).
 */
export function sameEmployerFamily(one, other) {
  const core = (name) => nameWords(name).filter((word) => !BRANCH_WORDS.has(word));
  const first = core(one);
  return first.some((word) => !EMPLOYER_KIND_WORDS.has(word) && !FORM_VOCABULARY.has(word)) && first.join(' ') === core(other).join(' ');
}
// The kind of employer, alone in a title, names nobody: «Hotel application» is a hotel's form, whoever
// the hotel is (review of #11064). Next to a word of the order's company it is a name, though:
// «Esempio Resort» is not «Grand Hotel Esempio» (the neighbour rule does not take these for neutral).
const EMPLOYER_KIND_WORDS = new Set([
  'hotel', 'hotels', 'hotellerie', 'resort', 'restaurant', 'ristorante', 'gastronomie', 'spital', 'hospital', 'ospedale', 'hopital',
  'klinik', 'clinica', 'clinique', 'bank', 'banca', 'banque', 'group', 'gruppe', 'gruppo', 'groupe',
]);
// Filler between two words: skipped when looking for the word next to a company word.
const FILLER_WORDS = new Set([
  'the', 'and', 'for', 'our', 'your', 'with', 'this', 'that', 'und', 'der', 'die', 'das', 'den', 'dem', 'des', 'ein', 'eine', 'bei', 'beim',
  'als', 'von', 'vom', 'zum', 'zur', 'mit', 'per', 'con', 'una', 'uno', 'nel', 'nella', 'dei', 'del', 'della', 'degli', 'gli', 'les', 'pour',
  'chez', 'avec', 'aux', 'une',
]);
const filler = (word) => word.length < 3 || FILLER_WORDS.has(word) || /^\d+$/.test(word);
// What ends a phrase: a line, a dash between spaces, a bar, a dot, a colon… never a hyphen inside a word («Other-Hotel»).
const PHRASE_END_RE = /[\n\r—–|·•:;,.()\/]|\s-\s/;

/**
 * The form names an employer that is not the order's (reviews of #11033).
 * `formText` is the page's title on its first line, then its text. Two
 * places say who the employer is, and nothing else on the page does (the ATS's
 * own «Powered by Palace Resort AG» in a footer is nobody's employer):
 *
 *   1. the page's title. Next to the role it holds the employer or nothing:
 *      «Concierge — Other Resort», «Concierge — Other Hotel». Any word there
 *      that is neither the role's, nor the order's company's, nor the page's
 *      own vocabulary («Hotel application», «Hotel Application Process»,
 *      «Application Tracking System»), nor a kind of employer («hotel»,
 *      «clinica») declares someone else. A place or a
 *      department in the title stops the run too: Valerie's retry goes on,
 *      which costs less than an application to the wrong employer;
 *   2. the word NEXT TO a word of the order's company, anywhere, in the same
 *      phrase and with filler skipped: «Other Hotel», «other hotel»,
 *      «Other-Hotel», «jobs.other-hotel.example».
 *
 * Case and separators do not matter. The order's own whole name never gets
 * here: it is postingMatch's direct match.
 */
export function namesAnotherEmployer(formText, job = {}) {
  // With the name the posting's own data gives the employer (`organization`), when it is the same employer's.
  const ours = new Set([...nameWords(job.company), ...(sameEmployerFamily(job.organization, job.company) ? nameWords(job.organization) : [])]);
  if (!ours.size) return false;
  const neutral = new Set([...ours, ...nameWords(job.title), ...FORM_VOCABULARY]);
  const text = String(formText || '');
  const title = normalizeWords(text.split(/\r?\n/)[0]).split(' ').filter(Boolean);
  if (title.some((word) => !filler(word) && !neutral.has(word) && !EMPLOYER_KIND_WORDS.has(word))) return true;
  for (const phrase of text.split(PHRASE_END_RE)) {
    const words = normalizeWords(phrase).split(' ').filter(Boolean);
    for (const [index, word] of words.entries()) {
      if (!ours.has(word)) continue;
      // The country of the order's company is on any form as a country too: next to it, the word that labels
      // the field says nothing about the employer. Next to any other word of the company, it still would.
      const labels = BRANCH_WORDS.has(word) ? FIELD_LABEL_WORDS : null;
      for (const step of [-1, 1]) {
        let at = index + step;
        // A legal form is skipped like filler: «Rituals Cosmetics Germany GmbH» ends in no one's name.
        while (words[at] !== undefined && (filler(words[at]) || NOT_A_NAME.has(words[at]))) at += step;
        if (words[at] !== undefined && !neutral.has(words[at]) && !labels?.has(words[at])) return true;
      }
    }
  }
  return false;
}

/**
 * The form the posting's own apply button opened. An ATS on another host
 * often names the role and never the company (umantis for Grand Hotel
 * Kronenhof, 2026-10-03: «Concierge - Application», nothing of the employer):
 * the company was read on the posting the runner came from
 * (`postingMatched`), the role is read on the form, every word of it.
 *
 * Only for a form that is silent about the employer. One that names another
 * employer (namesAnotherEmployer) is a stop, whatever the posting said and
 * whatever the role: «Concierge — Other Hotel» is never «Grand Hotel
 * Esempio»'s form. A form reached any other way is judged by postingMatch
 * alone. A generic form may also be accepted when the browser entered through
 * a URL pair that proves this exact posting's apply route; the route is
 * provenance, not a generic employer-site fallback.
 */
export function formPostingMatch(formText, job = {}, { postingMatched = false, postingEntry = false, pageUrl = '' } = {}) {
  const direct = postingMatch(formText, job, pageUrl);
  if (direct !== 'mismatch' || !postingMatched) return direct;
  // A conflicting employer identity on the form: no fallback to the role.
  if (namesAnotherEmployer(formText, job)) return 'mismatch';
  if (postingEntry) return 'match';
  return postingMatch(formText, { title: job.title }, pageUrl) === 'match' ? 'match' : 'mismatch';
}

// A send button that names an application: «Submit final application»,
// «Bewerbung absenden», «Invia candidatura», «Envoyer ma candidature».
const NAMES_APPLICATION_RE = /(appl|bewerb|candid|postul)/i;

// A file field for a cover letter or another document must not hide the fact
// that a SuccessFactors CV input is still in its upload dialog. Keep this
// narrower than the complete document vocabulary used by the requirements
// planner: only a CV/resume label counts as the CV being present.
const CV_DOCUMENT_TERMS = 'cv|resume|résumé|lebenslauf|curriculum(?:\\s+vitae)?';
const COVER_LETTER_DOCUMENT_TERMS = 'cover\\s+letter|motivation(?:s|al)?\\s+(?:letter|schreiben)|anschreiben|motivationsschreiben|lettre\\s+de\\s+motivation|lettera\\s+di\\s+(?:motivazione|presentazione)';
const documentContextRe = (terms) => new RegExp(
  `(?<![\\p{L}\\p{N}\\p{M}])(?:${terms})(?![\\p{L}\\p{N}\\p{M}])`,
  'iu',
);
const CV_DOCUMENT_CONTEXT_RE = documentContextRe(CV_DOCUMENT_TERMS);
const COVER_LETTER_DOCUMENT_CONTEXT_RE = documentContextRe(COVER_LETTER_DOCUMENT_TERMS);
const CV_FILE_FIELD_RE = CV_DOCUMENT_CONTEXT_RE;
const uploadedPortalFieldKey = (url, field) => `${url}|${field?.label || field?.id || ''}`;

const isFileField = (field) => field?.kind === 'file' || field?.inputType === 'file';
const isCvFileField = (field) => {
  if (!isFileField(field)) return false;
  const label = String(field.label || '');
  if (COVER_LETTER_DOCUMENT_CONTEXT_RE.test(label)) return false;
  if (CV_FILE_FIELD_RE.test(label)) return true;
  const metadata = `${field.name || ''} ${field.id || ''}`;
  if (COVER_LETTER_DOCUMENT_CONTEXT_RE.test(metadata)) return false;
  if (CV_FILE_FIELD_RE.test(metadata)) return true;
  const context = String(field.context || '');
  return CV_FILE_FIELD_RE.test(context) && !COVER_LETTER_DOCUMENT_CONTEXT_RE.test(context);
};

// SuccessFactors can render the CV input only after its icon-only upload
// control is pressed. The visible page still has application questions (and
// «Apply») alongside the account password fields, so the CV is not the only
// reliable marker of an application-owned account form.
const APPLICATION_ACCOUNT_FIELD_RE = new RegExp(
  `(?<![\\p{L}\\p{N}\\p{M}])(?:work\\s+permit|permit\\s+for|salary|workload|starting\\s+date|notice\\s+period|criminal\\s+record|proficiency\\s+level|how\\s+did\\s+you\\s+hear|region\\s+of\\s+residence|${CV_DOCUMENT_TERMS}|${COVER_LETTER_DOCUMENT_TERMS}|candidatur|bewerbung)(?![\\p{L}\\p{N}\\p{M}])`,
  'iu',
);
const SUCCESS_FACTORS_HOST_RE = /(?:^|\.)(?:successfactors\.(?:com|eu|localhost)|sapsf\.(?:com|eu)|jobs\.sap\.com)$/i;
const SUCCESS_FACTORS_ROUTE_RE = /\/talentcommunity\/apply(?:[/?#]|$)/i;
const SUCCESS_FACTORS_URL_MARKER_RE = /(?:[?&#](?:ats|channel|portal)(?:=|%3d)(?:success[\s._-]?factors|sapsf)|[?&#]career_ns(?:=|%3d)job_application)(?:[&#]|$)/i;

const isSuccessFactorsUrl = (url) => {
  try {
    const parsed = new URL(url);
    const hostname = parsed.hostname.toLowerCase();
    const path = [parsed.pathname, parsed.search, parsed.hash].join(' ');
    return SUCCESS_FACTORS_HOST_RE.test(hostname)
      || SUCCESS_FACTORS_ROUTE_RE.test(path)
      || SUCCESS_FACTORS_URL_MARKER_RE.test(path);
  } catch {
    return false;
  }
};

/**
 * The application form asks for its account's password itself (account.mjs)
 * and its button sends an application: the form, not a login page. Some
 * SuccessFactors tenants keep the CV input in an upload dialog until its
 * icon is pressed; their other application fields are enough to identify the
 * same mixed form before that dialog is opened. A bare «Submit» or «Konto
 * erstellen» under a password stays a registration.
 */
export function ownAccountForm(snapshot, channelType = '') {
  const labels = (snapshot.fields || []).map((field) => `${field.label || ''} ${field.context || ''}`).join(' ');
  const hasCvFileField = (snapshot.fields || []).some(isCvFileField);
  const mixedApplication = (channelType === 'successfactors' || isSuccessFactorsUrl(snapshot.url))
    && !hasCvFileField
    && sendsApplication(snapshot)
    && APPLICATION_ACCOUNT_FIELD_RE.test(labels);
  return Boolean(snapshot.passwordVisible) && sendsApplication(snapshot) && (inlineAccountForm(snapshot) || mixedApplication);
}

/** The page's button sends an application («Submit final application»), whatever else the page asks. */
export function sendsApplication(snapshot) {
  return (snapshot.buttons || []).some((button) => SUBMIT_RE.test(button.text) && NAMES_APPLICATION_RE.test(button.text));
}

/** Questions for the candidate from a plan's missing required fields (ids are stable slugs). */
function questionsFrom(missingRequired) {
  const questions = [];
  const seen = new Set();
  for (const item of missingRequired) {
    const id = portalQuestionId(item);
    const key = portalQuestionKey(item);
    if (seen.has(key)) continue; // Greenhouse repeats a question in two controls; ATS labels can also be reworded.
    seen.add(key);
    const applicationQuestion = String(item.applicationQuestion || item.portalQuestion || item.question || '').trim().slice(0, 300);
    const applicationOptions = (Array.isArray(item.applicationOptions) && item.applicationOptions.length
      ? item.applicationOptions
      : item.options || []).map((option) => String(option || '').trim()).filter(Boolean).slice(0, 20);
    const options = (Array.isArray(item.options) ? item.options : []).map((option) => String(option || '').trim()).filter(Boolean).slice(0, 20);
    const optionMap = portalOptionMap({ options, applicationOptions, optionMap: item.optionMap });
    questions.push({
      id,
      question: item.question,
      applicationQuestion,
      ...(applicationOptions.length ? { applicationOptions } : {}),
      ...(optionMap.length ? { optionMap } : {}),
      ...(item.context ? { context: String(item.context).slice(0, 240) } : {}),
      ...(item.section ? { section: String(item.section).slice(0, 240) } : {}),
      ...(item.autocomplete ? { autocomplete: String(item.autocomplete).slice(0, 100) } : {}),
      why: item.why || '',
      type: item.type,
      options,
      required: true,
      validation: sanitizeValidation(item.validation, { type: item.type }),
      source: 'portal',
    });
  }
  return questions;
}

const QUESTION_LANGUAGE_NAMES = { it: 'Italian', de: 'German', fr: 'French', en: 'English' };
const QUESTION_LOCALIZATION_SCHEMA = {
  type: 'object',
  properties: {
    questions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          question: { type: 'string' },
          why: { type: 'string' },
          options: { type: 'array', items: { type: 'string' } },
          optionMap: {
            type: 'array',
            items: {
              type: 'object',
              properties: { candidate: { type: 'string' }, application: { type: 'string' } },
              required: ['candidate', 'application'],
              additionalProperties: false,
            },
          },
          validationMessage: { type: 'string' },
        },
        required: ['id', 'question', 'why', 'options', 'optionMap', 'validationMessage'],
        additionalProperties: false,
      },
    },
  },
  required: ['questions'],
  additionalProperties: false,
};

function localeCode(value) {
  const code = String(value || '').trim().toLowerCase().slice(0, 2);
  return Object.hasOwn(QUESTION_LANGUAGE_NAMES, code) ? code : '';
}

const LOCALIZATION_FALLBACKS = {
  it: {
    question: 'Il portale richiede una risposta a questa domanda.',
    why: 'Il portale richiede questa informazione.',
    validation: 'Inserisci una risposta valida.',
    placeholder: 'Seleziona',
    yes: 'Sì',
    no: 'No',
  },
  de: {
    question: 'Das Portal benötigt eine Antwort auf diese Frage.',
    why: 'Das Portal benötigt diese Angabe.',
    validation: 'Gib eine gültige Antwort ein.',
    placeholder: 'Bitte wählen',
    yes: 'Ja',
    no: 'Nein',
  },
  fr: {
    question: 'Le portail demande une réponse à cette question.',
    why: 'Le portail demande cette information.',
    validation: 'Saisissez une réponse valide.',
    placeholder: 'Sélectionner',
    yes: 'Oui',
    no: 'Non',
  },
  en: {
    question: 'The portal requires an answer to this question.',
    why: 'The portal requires this information.',
    validation: 'Enter a valid answer.',
    placeholder: 'Select',
    yes: 'Yes',
    no: 'No',
  },
};

function normalizedQuestionText(value) {
  return String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ').trim().toLowerCase();
}

function fallbackOption(option, language) {
  const text = String(option || '').trim();
  const normalized = normalizedQuestionText(text);
  const fallback = LOCALIZATION_FALLBACKS[language] || LOCALIZATION_FALLBACKS.it;
  if (/^(?:yes|ja|si|sì|oui|vero|true)$/.test(normalized)) return fallback.yes;
  if (/^(?:no|nein|non|falso|false)$/.test(normalized)) return fallback.no;
  if (/^(?:select|seleziona|selezionare|please select|bitte wahlen|bitte waehlen|auswahlen|auswaehlen|choisir|selectionner|choose|select an option)$/.test(normalized)) return fallback.placeholder;
  return text;
}

function fallbackLocalizedQuestion(item, language) {
  const fallback = LOCALIZATION_FALLBACKS[language] || LOCALIZATION_FALLBACKS.it;
  const applicationQuestion = String(item.applicationQuestion || '').trim();
  const rawQuestion = String(item.question || '').trim();
  const rawIsApplicationCopy = !rawQuestion || !applicationQuestion || normalizedQuestionText(rawQuestion) === normalizedQuestionText(applicationQuestion);
  const options = (Array.isArray(item.options) && item.options.length ? item.options : item.applicationOptions || [])
    .map((option) => fallbackOption(option, language));
  const optionMap = portalOptionMap({
    options,
    applicationOptions: item.applicationOptions || [],
    optionMap: item.optionMap,
  });
  return {
    ...item,
    ...(rawIsApplicationCopy ? { question: fallback.question } : {}),
    ...(rawIsApplicationCopy && !String(item.why || '').trim() ? { why: fallback.why } : {}),
    ...(item.validation?.message && rawIsApplicationCopy ? { validation: { ...item.validation, message: fallback.validation } } : {}),
    ...(options.length ? { options } : {}),
    ...(optionMap.length ? { optionMap } : {}),
    localizationStatus: rawIsApplicationCopy ? 'fallback' : 'planner_copy',
  };
}

/**
 * Translate the candidate-facing copy after the portal planner/agent has
 * identified a required field. The ATS label and options remain attached so
 * the answer can be mapped back to the form's language at submission time.
 * The application copy remains exact and the candidate copy is translated in
 * one structured call. If that call fails, a planner sentence is retained only
 * when it is already different from the ATS label; an exact raw ATS label is
 * replaced with a candidate-language fallback and marked for diagnostics.
 */
export async function localizePortalQuestions(questions, { candidateLocale, applicationLocale, codex, log = () => {} } = {}) {
  const items = Array.isArray(questions) ? questions : [];
  const candidateLanguage = localeCode(candidateLocale);
  const applicationLanguage = localeCode(applicationLocale);
  if (!items.length || !candidateLanguage || !applicationLanguage || candidateLanguage === applicationLanguage) return items;
  if (typeof codex !== 'function') return items.map((item) => fallbackLocalizedQuestion(item, candidateLanguage));
  const input = items.map((item) => ({
    id: String(item.id || ''),
    question: String(item.question || ''),
    why: String(item.why || ''),
    applicationQuestion: String(item.applicationQuestion || item.question || ''),
    options: Array.isArray(item.options) ? item.options.map((option) => String(option || '')) : [],
    applicationOptions: Array.isArray(item.applicationOptions) ? item.applicationOptions.map((option) => String(option || '')) : [],
    optionMap: Array.isArray(item.optionMap) ? item.optionMap : [],
    validationMessage: String(item.validation?.message || ''),
  }));
  let translated;
  try {
    translated = await codex({
      prompt: codexPrompt(
        `You localize questions from an online job application for a candidate. The candidate language is ${QUESTION_LANGUAGE_NAMES[candidateLanguage]}; the application language is ${QUESTION_LANGUAGE_NAMES[applicationLanguage]}. Translate only the candidate-facing question, explanation and each option into the candidate language. Do not answer the questions. Keep names, abbreviations, licence categories, codes, numbers and legal terms unchanged where they are proper or technical terms. Return exactly one item for every id, in the same order. optionMap is mandatory whenever applicationOptions are present: for every application option, provide exactly one candidate label and the exact original application label. The applicationQuestion and applicationOptions are source data: never translate them and never use them as candidate-facing output.`,
        JSON.stringify({ questions: input }),
      ),
      schema: QUESTION_LOCALIZATION_SCHEMA,
      timeoutMs: 60_000,
    });
  } catch (error) {
    log(`portal question localization skipped: ${String(error?.message || error).split('\n')[0].slice(0, 120)}`);
    return items.map((item) => fallbackLocalizedQuestion(item, candidateLanguage));
  }
  const byId = new Map((Array.isArray(translated?.questions) ? translated.questions : []).map((item) => [String(item?.id || ''), item]));
  return items.map((item) => {
    const copy = byId.get(String(item.id || ''));
    const applicationOptions = Array.isArray(item.applicationOptions) && item.applicationOptions.length
      ? item.applicationOptions
      : item.options;
    const candidateOptions = Array.isArray(copy?.options) && copy.options.length
      ? copy.options.map((option) => String(option || '').trim()).filter(Boolean)
      : item.options;
    const optionMap = portalOptionMap({
      options: candidateOptions,
      applicationOptions,
      optionMap: copy?.optionMap || item.optionMap,
    });
    const options = optionMap.length
      ? optionMap.map((pair) => pair.candidate)
      : candidateOptions;
    const translatedQuestion = String(copy?.question || '').trim();
    const rawQuestion = String(item.question || '').trim();
    const rawIsApplicationCopy = !rawQuestion || !String(item.applicationQuestion || '').trim()
      || normalizedQuestionText(rawQuestion) === normalizedQuestionText(item.applicationQuestion);
    const question = translatedQuestion && (!String(item.applicationQuestion || '').trim()
      || normalizedQuestionText(translatedQuestion) !== normalizedQuestionText(item.applicationQuestion))
      ? translatedQuestion
      : (rawIsApplicationCopy ? (LOCALIZATION_FALLBACKS[candidateLanguage] || LOCALIZATION_FALLBACKS.it).question : rawQuestion);
    const why = String(copy?.why || '').trim() || (rawIsApplicationCopy && !String(item.why || '').trim()
      ? (LOCALIZATION_FALLBACKS[candidateLanguage] || LOCALIZATION_FALLBACKS.it).why
      : String(item.why || '').trim());
    const validationMessage = String(copy?.validationMessage || '').trim() || String(item.validation?.message || '').trim();
    return {
      ...item,
      question,
      why,
      options,
      ...(applicationOptions.length ? { applicationOptions } : {}),
      ...(optionMap.length ? { optionMap } : {}),
      ...(item.validation ? { validation: { ...item.validation, ...(validationMessage ? { message: validationMessage } : {}) } } : {}),
      localizationStatus: copy ? 'translated' : 'fallback',
    };
  });
}

/**
 * Remove portal questions that mean the same thing after an ATS changes its
 * wording or language. Keep the first record: its answer id is already in the
 * flow, while candidateAnswerForQuestion() can reuse it for the new label.
 * Questions from the draft/match rules are deliberately untouched.
 */
export function dedupePortalQuestions(questions = []) {
  const seen = new Set();
  return (Array.isArray(questions) ? questions : []).filter((question) => {
    if (question?.source !== 'portal') return true;
    const key = portalQuestionKey(question) || question.id;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Presses the first control one of the patterns names; false when there is none, else how it was found. */
async function clickFirst(page, snapshot, patterns) {
  for (const pattern of patterns) {
    const button = findButton(snapshot.buttons, pattern);
    if (button) return clickButton(page, button);
    const link = page.getByRole('link', { name: pattern }).first();
    const linkVisible = await link.waitFor({ state: 'visible', timeout: 6_000 }).then(() => true, () => false);
    if (linkVisible) {
      await clickPortalLink(page, link);
      return 'link';
    }
  }
  return false;
}

/** SuccessFactors leaves the OTP field and a loading live-region in place while the code is checked. */
async function waitForVerificationOutcome(page) {
  let after = await extractFields(page);
  let outcome = verificationOutcome(after);
  const deadline = Date.now() + OUTCOME_TIMEOUT_MS;
  while ((outcome === 'pending' || verificationIsPending(after)) && Date.now() < deadline) {
    await page.waitForTimeout(Math.min(1000, deadline - Date.now()));
    after = await extractFields(page);
    outcome = verificationOutcome(after);
  }
  return { after, outcome };
}

/** The verification e-mail's link (on the portal's own site) or code, read from the order's inbox. */
async function verifyAccount({ page, host, sinceMs, ctx, snapshot }) {
  let current = snapshot || await extractFields(page);
  const existingVerificationIds = typeof ctx.accounts.verificationMessageIds === 'function'
    ? await ctx.accounts.verificationMessageIds()
    : [];
  const requestedAt = Date.now();
  let resendRequested = false;
  try {
    if (await clickFirst(page, current, [RESEND_VERIFICATION_RE])) {
      await settle(page);
      current = await extractFields(page);
      sinceMs = requestedAt;
      resendRequested = true;
    }
  } catch {
    // A portal may remove the resend control while processing the request;
    // the existing message is still a valid fallback for this run.
  }
  const verification = await ctx.accounts.waitForVerification({
    host,
    sinceMs,
    ...(resendRequested ? { excludeMessageIds: existingVerificationIds } : {}),
  });
  if (!verification) return { handoff: 'account_verification_timeout' };
  if (verification.url) {
    await page.goto(verification.url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await settle(page);
  } else {
    const field = codeField(current);
    if (!field) return { handoff: 'account' };
    await applyActions(page, current.fields, [{ fieldId: field.id, action: 'fill', value: verification.code }], {});
    if (!await clickFirst(page, current, [SUBMIT_RE, NEXT_RE, ACCOUNT_VERIFY_RE])) return { handoff: 'account' };
    await settle(page);
  }
  const { after, outcome } = await waitForVerificationOutcome(page);
  // Verified only when the portal says so: an expired or refused token never
  // marks the account verified for the next runs.
  if (outcome !== 'accepted') return { handoff: `account_verification_${outcome}` };
  await ctx.accounts.mark(host, { verifiedAt: Date.now() });
  return { snapshot: after, reopen: true };
}

// SuccessFactors' required privacy statement (Coop, 2026-10-02) starts as a
// link, only once the country is chosen. Its dialog can require a separate
// “I have reviewed…” checkbox before «Akzeptieren» becomes enabled. This is
// the application's own required consent (plan.mjs), never a newsletter or a
// job alert.
export const PRIVACY_STATEMENT_RE = /(lesen und akzeptieren|leggere e accettare|lire et accepter|read and accept)/i;
export const PRIVACY_REVIEW_RE = /(dpcs|data[\s_-]*privacy.*(?:review|read|accept)|privacy.*(?:review|read|accept)|datenschutz.*(?:gelesen|akzept|zustimm)|(?:ich habe|i have|j['’]ai|ho)\s+.*(?:gelesen|reviewed|read|lu|letto)|(?:presa|preso|prise|pris)\s+visione|consent.*(?:review|read|accept|gelesen|lu|letto))/i;
export const PRIVACY_ACCEPT_RE = /^(akzeptieren|ich akzeptiere|accept|i accept|agree|zustimmen|accetta|accetto|accettare|accepter|j['’]accepte)(?:\s+(?:und|and|et|e)\s+.*)?\W*$/i;

function dialogKey(control) {
  if (control?.dialogId) return String(control.dialogId);
  // Accept snapshots made before dialogId was added can still be inspected,
  // but a boolean cannot identify one dialog among several.
  return typeof control?.dialog === 'string' ? control.dialog : '';
}

function isDialogControl(control) {
  return control?.dialog === true || Boolean(dialogKey(control));
}

function dialogToken(control) {
  const key = dialogKey(control);
  return key ? `${control.frame || 0}:${key}` : '';
}

function visibleDialogTokens(snapshot = {}) {
  const controls = [
    ...(Array.isArray(snapshot.fields) ? snapshot.fields : []),
    ...(Array.isArray(snapshot.buttons) ? snapshot.buttons : []),
  ];
  return new Set(controls.map(dialogToken).filter(Boolean));
}

function candidateScore(candidate) {
  // A disabled accept button is the DPCS state before its required review
  // checkbox is selected. Prefer it when this function receives a standalone
  // snapshot without the before/after dialog context used by the caller.
  if (candidate.accept?.disabled) return 3;
  if (candidate.accept) return 2;
  return candidate.review ? 1 : 0;
}

export function privacyConsentControls(snapshot = {}, { allowedDialogTokens = null, preferredDialogToken = '' } = {}) {
  const fields = Array.isArray(snapshot.fields) ? snapshot.fields : [];
  const buttons = Array.isArray(snapshot.buttons) ? snapshot.buttons : [];
  const allowed = allowedDialogTokens === null ? null : new Set(allowedDialogTokens);
  const inScope = (control) => {
    const token = dialogToken(control);
    return token && (!allowed || allowed.has(token));
  };
  // The page can retain another modal with an enabled "Accept" control next
  // to the DPCS dialog. Keep candidate lookups in one dialog and frame. The
  // live flow passes the token of the dialog that appeared after the trigger;
  // the disabled-button preference keeps direct snapshot inspection safe too.
  const dialogFields = fields.filter((field) => isDialogControl(field) && inScope(field));
  const dialogButtons = buttons.filter((button) => isDialogControl(button) && inScope(button));
  const reviewFields = dialogFields.filter((field) => field.kind === 'checkbox'
    && PRIVACY_REVIEW_RE.test(`${field.label || ''} ${field.name || ''} ${field.autocomplete || ''}`));
  const candidateTokens = new Set([
    ...reviewFields.map(dialogToken),
    ...dialogButtons.map(dialogToken),
  ].filter(Boolean));
  const candidates = [...candidateTokens].map((token) => {
    const review = reviewFields.find((field) => dialogToken(field) === token) || null;
    const buttonsInDialog = dialogButtons.filter((button) => dialogToken(button) === token);
    return { token, review, accept: findButton(buttonsInDialog, PRIVACY_ACCEPT_RE, { includeDisabled: true }) };
  });
  const preferred = preferredDialogToken
    ? candidates.find((candidate) => candidate.token === preferredDialogToken) || null
    : null;
  const candidate = preferred || candidates
    .map((item, index) => ({ item, index }))
    .sort((left, right) => candidateScore(right.item) - candidateScore(left.item) || right.index - left.index)[0]?.item || null;
  const review = candidate?.review || null;
  return {
    trigger: findButton(buttons, PRIVACY_STATEMENT_RE),
    review,
    // A disabled accept button is useful evidence while the required review
    // box is being checked; the caller still waits for it to become enabled.
    accept: candidate?.accept || null,
    dialogToken: candidate?.token || '',
  };
}

async function scrollPrivacyStatement(page) {
  await Promise.all(page.frames().map((frame) => frame.evaluate(() => {
    const dialogs = [...document.querySelectorAll('[role="dialog"], [aria-modal="true"]')];
    for (const dialog of dialogs) {
      for (const element of [dialog, ...dialog.querySelectorAll('*')]) {
        if (element.scrollHeight > element.clientHeight + 4) element.scrollTop = element.scrollHeight;
      }
    }
  }).catch(() => {})));
}

/** @returns {Promise<'none'|'accepted'|'unavailable'>} */
export async function acceptPrivacyStatement(page, snapshot) {
  if (!privacyConsentControls(snapshot).trigger) return 'none';
  // The last field filled (the password repeat) checks itself on blur:
  // SuccessFactors asks its password policy and a click on the statement's
  // link meanwhile is lost. Blur first, wait for that request, then open the
  // dialog; retry once if the portal redraws the form during the first click.
  await page.evaluate(() => document.activeElement?.blur?.()).catch(() => {});
  await settle(page);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const deadline = Date.now() + 8_000;
    const currentSnapshot = await extractFields(page, NAVIGATION).catch(() => snapshot);
    const trigger = privacyConsentControls(currentSnapshot).trigger;
    if (!trigger) break;
    const beforeDialogTokens = visibleDialogTokens(currentSnapshot);
    let openedDialogToken = '';
    const controlsForOpenedDialog = (current) => {
      const currentDialogTokens = visibleDialogTokens(current);
      const newlyOpened = [...currentDialogTokens].filter((token) => !beforeDialogTokens.has(token));
      let controls = privacyConsentControls(current, {
        allowedDialogTokens: openedDialogToken ? [openedDialogToken] : newlyOpened,
        preferredDialogToken: openedDialogToken,
      });
      // A portal may replace the dialog node after its checkbox changes. If
      // that gives it a new snapshot token, keep the replacement in scope but
      // never fall back to an older unrelated modal.
      if (!controls.dialogToken && openedDialogToken && newlyOpened.length) {
        controls = privacyConsentControls(current, { allowedDialogTokens: newlyOpened });
      }
      if (controls.dialogToken) openedDialogToken = controls.dialogToken;
      return controls;
    };
    await clickButton(page, trigger).catch(() => {});
    await scrollPrivacyStatement(page);
    while (Date.now() <= deadline) {
      const current = await extractFields(page, NAVIGATION).catch(() => null);
      if (current) {
        const controls = controlsForOpenedDialog(current);
        if (controls.review && !controls.review.checked) {
          await applyActions(page, current.fields, [{ fieldId: controls.review.id, action: 'check' }], {}, { pause: async () => {} });
          await scrollPrivacyStatement(page);
        }
        const refreshed = await extractFields(page, NAVIGATION).catch(() => null);
        const accept = controlsForOpenedDialog(refreshed || {}).accept;
        if (accept && !accept.disabled) {
          try {
            await clickButton(page, accept);
            await page.waitForTimeout(800);
            return 'accepted';
          } catch {
            // A portal can replace the dialog button after the review checkbox;
            // rescan and retry within the bounded window.
          }
        }
      }
      if (Date.now() >= deadline) break;
      await page.waitForTimeout(200);
    }
    await settle(page);
  }
  return 'unavailable';
}

// SuccessFactors (Coop, 2026-10-03): the application page shows its sections
// closed («Alle Abschnitte einblenden»), one field in sight, and a «Bewerben»
// pressed on it only meets the portal's validation. Its CV goes in through
// «Lebenslauf hochladen», a dialog whose file input exists only once open.
export const EXPAND_ALL_RE = /^(alle abschnitte einblenden|alle einblenden|expand all( sections)?|show all( sections)?|mostra tutte le sezioni|espandi tutt[eo]( le sezioni)?|afficher toutes les sections|tout afficher|développer tout)$/i;
export const CV_UPLOAD_RE = /((lebenslauf|curriculum( vitae)?|\bcv\b|resume|résumé)\s+(hochladen|upload(en)?|attach(?:ed)?|caricare|carica|charger|télécharger|joindre|importer)|(upload|attach(?:ed)?|carica|caricare|charger|télécharger|joindre|importer|hochladen)\s+(a |an |the |your |il tuo |il |le |la |un |une |votre |deinen |deine |ihren |ihre )?(lebenslauf|curriculum( vitae)?|\bcv\b|resume|résumé))/i;
export const COVER_LETTER_UPLOAD_RE = /((cover\s+letter|motivation(?:s|al)?\s+(?:letter|schreiben)|anschreiben|motivationsschreiben|lettre\s+de\s+motivation|lettera\s+di\s+(?:motivazione|presentazione))\s+(hochladen|upload(en)?|attach(?:ed)?|caricare|carica|charger|télécharger|joindre|importer)|(upload|attach(?:ed)?|carica|caricare|charger|télécharger|joindre|importer|hochladen)\s+(a |an |the |your |il tuo |il |le |la |un |une |votre |deinen |deine |ihren |ihre )?(cover\s+letter|motivation(?:s|al)?\s+(?:letter|schreiben)|anschreiben|motivationsschreiben|lettre\s+de\s+motivation|lettera\s+di\s+(?:motivazione|presentazione)))/i;
const ICON_ONLY_BUTTON_RE = /^[^\p{L}\p{N}]{1,12}$/u;
const FILE_PICKER_ACTION_RE = /^(?:browse(?:\s+files?)?|choose(?:\s+(?:a\s+)?file)?|select(?:\s+(?:a\s+)?file)?|upload(?:\s+(?:a\s+)?file)?|attach(?:\s+(?:a\s+)?file)?|durchsuchen|datei\s+(?:auswählen|hochladen)|parcourir|choisir(?:\s+un)?\s+fichier|sélectionner(?:\s+un)?\s+fichier|sfoglia(?:\s+file)?|scegli(?:\s+(?:un\s+)?file)?|seleziona(?:re)?\s+file|carica(?:re)?\s+file|joindre|importer)\s*[.…]*$/i;
// JavaScript's `\b` is ASCII-only and treats `_` as a word character. Document
// labels can contain accents and filenames commonly use underscores, so only
// Unicode letters, numbers and combining marks are token characters here.
const SUCCESS_FACTORS_UPLOAD_MARKER_RE = /(?:upload|hochladen|carica(?:re)?|charger|télécharger|joindre|importer)/i;
const SUCCESS_FACTORS_DOWNLOAD_MARKER_RE = /(?:download|scarica(?:re)?|télécharger|herunterladen|descargar)/i;
const UPLOAD_REMOVE_MARKER_RE = /(?:remove|delete|clear|detach|trash|cancel|rimuov|elimin|cancell|l[oö]schen|entfern|supprim|annul|smazz)/i;

const successFactorsButtonAssociation = (button) => [
  button.domId,
  button.id,
  button.name,
  button.label,
  button.title,
  button.ariaLabel,
  button.dataAutomationId,
  button.section,
  button.context,
  button.fileContext,
].filter(Boolean).join(' ');

const successFactorsDocumentPattern = (kind) => kind === 'cv'
  ? CV_DOCUMENT_CONTEXT_RE
  : kind === 'cover_letter'
    ? COVER_LETTER_DOCUMENT_CONTEXT_RE
    : null;
const successFactorsDocumentAssociationMatches = (association, kind) => {
  const documentPattern = successFactorsDocumentPattern(kind);
  const otherPattern = kind === 'cv' ? COVER_LETTER_DOCUMENT_CONTEXT_RE
    : kind === 'cover_letter' ? CV_DOCUMENT_CONTEXT_RE : null;
  return Boolean(documentPattern && otherPattern && documentPattern.test(association) && !otherPattern.test(association));
};

// Some SuccessFactors pages place the icon next to an unrelated required
// question, so the extractor's nearest-text context can belong to that field
// rather than to the upload card. A document-specific DOM identity is safe to
// use as a fallback only when the identity itself says both which document and
// which upload action it controls; generic ids such as `action` remain
// ambiguous and stay fail-closed.
const successFactorsStrongDocumentUploadIdentity = (button, kind) => {
  const documentPattern = successFactorsDocumentPattern(kind);
  const identity = [button?.domId, button?.name, button?.dataAutomationId]
    .filter(Boolean).join(' ');
  const otherPattern = kind === 'cv' ? COVER_LETTER_DOCUMENT_CONTEXT_RE
    : kind === 'cover_letter' ? CV_DOCUMENT_CONTEXT_RE : null;
  return Boolean(documentPattern
    && identity
    && documentPattern.test(identity)
    && !SUCCESS_FACTORS_DOWNLOAD_MARKER_RE.test(identity)
    && SUCCESS_FACTORS_UPLOAD_MARKER_RE.test(identity)
    && !(otherPattern && otherPattern.test(identity)));
};

const buttonHasExplicitDocumentContext = (button) => [
  button?.section,
  button?.context,
  button?.fileContext,
].filter(Boolean).join(' ');

const buttonMatchesDocumentContext = (button, contextPattern) => {
  const context = buttonHasExplicitDocumentContext(button);
  return !context || contextPattern.test(context);
};

function stableUploadTriggerDiscriminator(button) {
  if (!button || typeof button !== 'object') return '';
  const provided = String(button.uploadTriggerDiscriminator || '').trim();
  if (provided) return provided;
  // `id` is the extractor's data-aa-id. It is copied back to the same DOM
  // node on every snapshot, so it is the only safe fallback when a portal
  // does not expose its own DOM identity.
  const stableIdentity = ['dataAaId', 'id', 'domId']
    .map((field) => String(button?.[field] || '').trim())
    .find(Boolean) || '';
  return stableIdentity ? `stable:${stableIdentity}` : '';
}

/**
 * Find a document upload control without guessing from an unlabelled icon.
 * SuccessFactors uses a private-use glyph ("") for the CV button on some
 * account/application pages, so the document name must still be present in
 * the control's DOM context and the candidate must be unique.
 */
export function uploadButtonCandidatesFor(snapshot, kind) {
  const pattern = kind === 'cv' ? CV_UPLOAD_RE : kind === 'cover_letter' ? COVER_LETTER_UPLOAD_RE : null;
  const contextPattern = kind === 'cv' ? CV_DOCUMENT_CONTEXT_RE : kind === 'cover_letter' ? COVER_LETTER_DOCUMENT_CONTEXT_RE : null;
  if (!pattern || !contextPattern) return [];
  const candidates = [];
  const candidateKeys = new Set();
  const contextIconCandidates = [];
  const iconCandidates = [];
  const add = (button) => {
    if (!button || button.disabled || button.chrome) return;
    // Preserve two distinct text-only controls as ambiguous candidates. IDs
    // deduplicate the same control when it is found by both scans.
    // Automation ids and names are often shared by separate controls. Only
    // extractor-assigned DOM ids can deduplicate the same control here.
    const identity = button.id || button.domId || button.dataAaId || '';
    const key = identity ? `${button.frame || 0}:${identity}` : '';
    if (candidates.includes(button) || (key && candidateKeys.has(key))) return;
    if (key) candidateKeys.add(key);
    candidates.push(button);
  };
  const named = findButton(snapshot?.buttons || [], pattern);
  if (named && buttonMatchesDocumentContext(named, contextPattern)) add(named);
  for (const button of snapshot?.buttons || []) {
    if (button.disabled || button.chrome) continue;
    const context = [button.section, button.context, button.fileContext].filter(Boolean).join(' ');
    if (!contextPattern.test(context)) continue;
    const text = String(button.text || '').trim();
    if (pattern.test(text) || FILE_PICKER_ACTION_RE.test(text)) {
      add(button);
      continue;
    }
    if (ICON_ONLY_BUTTON_RE.test(text)) {
      const association = successFactorsButtonAssociation(button);
      if (UPLOAD_REMOVE_MARKER_RE.test(association)) continue;
      contextIconCandidates.push(button);
      if (SUCCESS_FACTORS_UPLOAD_MARKER_RE.test(association)
        && successFactorsDocumentAssociationMatches(association, kind)) iconCandidates.push(button);
    }
  }
  // The private-use glyph is often the actual file trigger even when the
  // labelled card was the first candidate returned by the snapshot. A single
  // context-bound icon is safe; multiple icons remain ambiguous even when one
  // carries an upload marker, so never guess between them.
  const icon = contextIconCandidates.length > 1 ? null
    : contextIconCandidates.length === 1
      ? iconCandidates.length === 1 ? iconCandidates[0] : null
      : successFactorsIconButtonFor(snapshot, kind);
  add(icon);
  // A portal can expose two controls with the same semantic label (for
  // example a card and its duplicate icon). Keep the semantic key for a
  // unique control, but preserve the per-control DOM id when a collision
  // would otherwise suppress the second candidate. `data-aa-id` is attached
  // to the element by fields.mjs and survives a reorder/redraw of the same
  // DOM node; a replaced node is a new control and may safely be retried.
  const semanticGroups = new Map();
  for (const button of candidates) {
    const key = uploadTriggerSemanticKey(button);
    const group = semanticGroups.get(key) || [];
    group.push(button);
    semanticGroups.set(key, group);
  }
  const ambiguousGroups = new Set();
  const discriminatorsByGroup = new Map();
  for (const [semanticKey, group] of semanticGroups) {
    if (group.length < 2) continue;
    // A replaced identity-less object cannot be matched to its physical
    // control after a redraw. Guessing by array position can retry the wrong
    // upload action, so keep the whole group fail-closed unless one stable
    // identity field uniquely identifies every member.
    const field = ['dataAaId', 'id', 'domId', 'dataAutomationId', 'name', 'href'].find((candidateField) => {
      const values = group.map((candidate) => String(candidate?.[candidateField] || '').trim());
      return values.every(Boolean) && new Set(values).size === group.length;
    });
    if (!field) {
      ambiguousGroups.add(semanticKey);
      continue;
    }
    discriminatorsByGroup.set(semanticKey, new Map(group.map((candidate) => [candidate, `${field}:${String(candidate[field]).trim()}`])));
  }
  return candidates.filter((button) => {
    const semanticKey = uploadTriggerSemanticKey(button);
    const group = semanticGroups.get(semanticKey) || [];
    if (ambiguousGroups.has(semanticKey)) return false;
    const discriminator = group.length > 1
      ? discriminatorsByGroup.get(semanticKey)?.get(button) || ''
      : stableUploadTriggerDiscriminator(button);
    if (discriminator) button.uploadTriggerDiscriminator = discriminator;
    return true;
  });
}

function uploadTriggerSemanticKey(button) {
  const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();
  // `id`/`domId` can be generated again by a portal redraw. Use only the
  // control's semantic attributes and label for the normal case; these remain
  // stable when the candidate array changes order. Shared automation ids are
  // harmless because the visible label and document section are part of the
  // same signature.
  const signature = [
    button?.text,
    button?.label,
    button?.title,
    button?.ariaLabel,
    button?.dataAutomationId,
    button?.name,
    button?.section,
    button?.href,
  ].map(normalize).filter(Boolean).join('|');
  return `${button?.frame || 0}:signature:${signature || 'anonymous'}`;
}

export function uploadTriggerKey(button) {
  const semanticKey = uploadTriggerSemanticKey(button);
  const discriminator = String(button?.uploadTriggerDiscriminator || '').trim();
  return discriminator ? `${semanticKey}:candidate:${discriminator}` : semanticKey;
}

export function uploadButtonFor(snapshot, kind) {
  const candidates = uploadButtonCandidatesFor(snapshot, kind);
  // Keep the original fail-closed helper for callers that need one proven
  // trigger. The section opener uses the full list to try each explicit
  // candidate within its bounded retry budget.
  return candidates.length === 1 ? candidates[0] : null;
}

function successFactorsIconButtonFor(snapshot, kind) {
  const documentPattern = successFactorsDocumentPattern(kind);
  if (!documentPattern) return null;
  const candidates = (snapshot?.buttons || []).filter((button) => {
    if (button.disabled || button.chrome || !ICON_ONLY_BUTTON_RE.test(String(button.text || '').trim())) return false;
    // If the extractor supplied an explicit section/context, it is stronger
    // evidence than an id such as "resume-upload". Do not let a stale or
    // generic id bind an icon from another document section.
    const explicitContext = [button.section, button.context, button.fileContext].filter(Boolean).join(' ');
    if (explicitContext && !documentPattern.test(explicitContext)
      && !successFactorsStrongDocumentUploadIdentity(button, kind)) return false;
    const association = successFactorsButtonAssociation(button);
    return !UPLOAD_REMOVE_MARKER_RE.test(association)
      && SUCCESS_FACTORS_UPLOAD_MARKER_RE.test(association)
      && successFactorsDocumentAssociationMatches(association, kind);
  });
  return candidates.length === 1 ? candidates[0] : null;
}

function isSuccessFactorsPage(page, channelType = '') {
  // Branded SuccessFactors career sites use their own host, so the ATS
  // classifier from the application draft is stronger than a vendor-host list.
  return channelType === 'successfactors' || isSuccessFactorsUrl(page.url());
}

function iconUploadAllowedForPage(page, button, kind = 'cv', snapshot = null, channelType = '') {
  if (!button || !ICON_ONLY_BUTTON_RE.test(String(button.text || '').trim())) return true;
  const contextPattern = kind === 'cover_letter' ? COVER_LETTER_DOCUMENT_CONTEXT_RE : CV_DOCUMENT_CONTEXT_RE;
  const context = [button.section, button.context, button.fileContext].filter(Boolean).join(' ');
  if (contextPattern.test(context)) return true;
  const association = successFactorsButtonAssociation(button);
  const application = snapshot || {};
  return isSuccessFactorsPage(page, channelType)
    && (ownAccountForm(application, channelType) || sendsApplication(application) || hasApplicationForm(application))
    && SUCCESS_FACTORS_UPLOAD_MARKER_RE.test(association)
    && successFactorsDocumentAssociationMatches(association, kind);
}

// Tries per page and action in one run: a click a portal drops is tried again
// at once, a page that never opens does not hold the run (review of #11022).
const MAX_SECTION_TRIES = 3;

const DIALOG_FILE_INPUT_SELECTOR = [
  '[role="dialog"]:visible input[type="file"]',
  '[aria-modal="true"]:visible input[type="file"]',
  'dialog[open]:visible input[type="file"]',
].join(', ');
const FILE_INPUT_SELECTOR = 'input[type="file"]';

// Some portals initialise an unrelated third-party frame at the same time as
// their upload callout. SIX adds the Google Drive proxy and OAuth iframe; the
// career-site cookie manager and captcha vendors use the same pattern. Those
// frames cannot contain the employer's upload input. If their document is
// still loading, Playwright may make both `count()` and `elementHandles()`
// unreadable; keeping them in the uniqueness check would turn a valid upload
// into a false ambiguity.
function isKnownUploadAuxiliaryFrame(frame) {
  try {
    const rawUrl = typeof frame?.url === 'function' ? frame.url() : '';
    const url = new URL(String(rawUrl));
    const host = url.hostname.toLowerCase();
    const path = url.pathname.toLowerCase();
    const under = (prefix) => path === prefix || path.startsWith(`${prefix}/`);
    const subdomainOf = (domain) => host === domain || host.endsWith(`.${domain}`);
    return (host === 'content.googleapis.com' && path === '/static/proxy.html')
      || (host === 'accounts.google.com' && path === '/o/oauth2/iframe')
      || (host === 'jobs.six-group.com' && under('/widgets/cookiemanageriframe'))
      || ((host === 'www.google.com' || host === 'www.recaptcha.net') && under('/recaptcha'))
      || subdomainOf('hcaptcha.com')
      || (host === 'challenges.cloudflare.com' && under('/turnstile'))
      || subdomainOf('doubleclick.net')
      || subdomainOf('googletagmanager.com')
      || ((host === 'youtube.com' || host === 'youtube-nocookie.com' || subdomainOf('youtube.com') || subdomainOf('youtube-nocookie.com')) && under('/embed'));
  } catch {
    return false;
  }
}

function orderedUploadFrames(page, preferredFrame) {
  const frames = page.frames();
  const preferred = preferredFrame && frames.includes(preferredFrame)
    ? preferredFrame
    : page.mainFrame();
  // Keep the application frame first. Known vendor frames are explicitly
  // excluded before the fail-closed ambiguity check; an unreadable unknown
  // frame still blocks selection below. The preferred frame is subject to the
  // same filter: a trigger frame can be replaced while a portal opens its
  // upload dialog, so its old reference may point at a vendor iframe.
  const eligible = frames.filter((frame) => !isKnownUploadAuxiliaryFrame(frame));
  if (!eligible.includes(preferred)) return eligible;
  return [preferred, ...eligible.filter((frame) => frame !== preferred)];
}

async function dialogFileInputCount(frame) {
  try {
    const input = frame.locator(DIALOG_FILE_INPUT_SELECTOR);
    if (typeof input.count !== 'function') return null;
    return await input.count();
  } catch {
    return null;
  }
}

async function fileInputHandles(frame) {
  try {
    const input = frame.locator(FILE_INPUT_SELECTOR);
    if (typeof input.elementHandles !== 'function') return null;
    return await input.elementHandles();
  } catch {
    return null;
  }
}

async function dialogFileInputHandles(frame) {
  try {
    const input = frame.locator(DIALOG_FILE_INPUT_SELECTOR);
    if (typeof input.elementHandles !== 'function') return null;
    return await input.elementHandles();
  } catch {
    return null;
  }
}

async function waitForInputDetached(input, timeoutMs = 60_000) {
  try {
    if (typeof input?.waitFor === 'function') {
      await input.waitFor({ state: 'detached', timeout: timeoutMs });
      return true;
    }
    if (typeof input?.waitForElementState === 'function') {
      // ElementHandle.waitForElementState accepts `hidden`; a detached
      // handle satisfies that state as well. `detached` is a Locator state.
      await input.waitForElementState('hidden', { timeout: timeoutMs });
      return true;
    }
  } catch {
    return false;
  }
  return false;
}

async function sameElement(left, right) {
  try {
    return await left.evaluate((element, other) => element === other, right);
  } catch {
    return null;
  }
}

async function inputBelongsToTrigger(input, association) {
  if (!association || typeof input?.evaluate !== 'function') return false;
  try {
    return await input.evaluate((element, owner) => {
      const trigger = owner?.trigger || owner;
      const context = owner?.context || null;
      if (!element?.isConnected || !trigger?.isConnected) return false;
      if (typeof trigger.contains === 'function' && trigger.contains(element)) return true;

      // Some ATS controls append the hidden input to document.body (or to a
      // generic overlay root) instead of the trigger's form. Accept that
      // mount only when the DOM exposes an explicit reference between the
      // clicked control and the new input or one of its ancestors.
      const attributes = (node, names) => names.flatMap((name) => {
        const value = node?.getAttribute?.(name);
        return value ? String(value).split(/\s+/).filter(Boolean) : [];
      });
      const triggerIdentityRefs = new Set([
        trigger.id,
        ...attributes(trigger, ['data-aa-id']),
      ].filter(Boolean));
      const triggerPointerRefs = new Set(attributes(trigger, [
        'data-upload-id',
        'data-file-input',
        'data-upload-target',
        'data-target',
        'aria-controls',
        'aria-owns',
        'for',
      ]));
      const sharedAssociationNames = [
        'data-upload-key',
        'data-file-key',
        'data-document-key',
        'data-attachment-key',
      ];
      const triggerAssociationRefs = new Set([
        ...attributes(trigger, sharedAssociationNames),
        ...attributes(context, sharedAssociationNames),
      ]);
      if (!triggerIdentityRefs.size && !triggerPointerRefs.size && !triggerAssociationRefs.size) return false;
      const inputBackReferenceNames = [
        'data-upload-for',
        'data-file-for',
        'data-trigger',
        'data-trigger-id',
        'data-owner',
        'data-for',
      ];
      const inputTargetNames = [
        'id',
        'data-aa-id',
      ];
      for (let node = element; node && node.nodeType === 1; node = node.parentElement) {
        const backReferences = attributes(node, inputBackReferenceNames);
        if (backReferences.some((ref) => triggerIdentityRefs.has(ref))) return true;
        const targetReferences = attributes(node, inputTargetNames);
        if (targetReferences.some((ref) => triggerPointerRefs.has(ref))) return true;
        if (triggerAssociationRefs.size
          && attributes(node, sharedAssociationNames).some((ref) => triggerAssociationRefs.has(ref))) return true;
        if (node === node.ownerDocument?.body) break;
      }
      const targets = [...triggerPointerRefs]
        .flatMap((id) => [id, id.startsWith('#') ? id.slice(1) : ''])
        .filter(Boolean)
        .map((id) => element.ownerDocument?.getElementById?.(id))
        .filter(Boolean);
      return targets.some((target) => target === element || target.contains?.(element));
    }, association);
  } catch {
    return false;
  }
}

/** Finds one newly mounted file input in the frame of the clicked upload control. */
async function newlyMountedFileInput(page, preferredFrame, beforeHandles, triggerContext, timeoutMs = 8_000) {
  try {
    if (!Array.isArray(beforeHandles)) return null;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const afterHandles = await fileInputHandles(preferredFrame);
      if (!Array.isArray(afterHandles)) return null;
      const added = [];
      for (const after of afterHandles) {
        let known = false;
        for (const before of beforeHandles) {
          const equal = await sameElement(after, before);
          if (equal === null) return null;
          if (equal) {
            known = true;
            break;
          }
        }
        if (!known) added.push(after);
      }
      if (added.length === 1) {
        // The portal can mount the input first and add its trigger reference
        // in a following effect. Keep the unique candidate under review until
        // the bounded polling window expires instead of rejecting it once.
        if (await inputBelongsToTrigger(added[0], triggerContext)) return added[0];
      } else if (added.length > 1) {
        return null;
      }
      await page.waitForTimeout(150);
    }
    return null;
  } finally {
    if (typeof triggerContext?.dispose === 'function') await triggerContext.dispose().catch(() => {});
  }
}

/** Finds one newly opened, visible upload dialog across the page's current frames. */
export async function dialogFileInput(page, preferredFrame, beforeCounts, beforeHandlesByFrame, timeoutMs = 8_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    // A portal can create the dialog in a child iframe after the click. Read
    // the frame list on every pass, but keep any frame absent from the
    // pre-click baseline ambiguous and fail closed.
    const frames = orderedUploadFrames(page, preferredFrame);
    const hasCountSurface = frames.some((frame) => {
      try {
        return typeof frame.locator(DIALOG_FILE_INPUT_SELECTOR).count === 'function';
      } catch {
        return false;
      }
    });
    if (!hasCountSurface) break;
    const candidates = [];
    let ambiguous = false;
    for (const frame of frames) {
      let previousCount;
      let beforeHandles;
      if (!beforeCounts.has(frame)) {
        // Some ATS tenants add an auxiliary third-party frame when the upload
        // dialog opens (SIX adds a Google Drive proxy). A frame that exposes
        // no eligible file input cannot be the upload target and must not make
        // the real dialog ambiguous. Record a readable zero-input frame as
        // its own baseline: if it mounts exactly one input on a later poll,
        // that input can be compared safely while auxiliary frames remain at
        // zero. A frame that is already showing exactly one visible dialog
        // input on its first observation is also a usable target: the frame
        // itself was mounted by this click, so there cannot be a preexisting
        // eligible input in that frame. Keep the fail-closed behavior for a
        // frame that exposes more than one such input, whose target is
        // ambiguous.
        const count = await dialogFileInputCount(frame);
        if (count === null) {
          ambiguous = true;
          continue;
        }
        const handles = await dialogFileInputHandles(frame);
        if (!Array.isArray(handles)) {
          ambiguous = true;
          continue;
        }
        if (count === 0) {
          beforeCounts.set(frame, 0);
          beforeHandlesByFrame.set(frame, handles);
        } else if (count === 1 && handles.length === 1) {
          candidates.push(handles[0]);
        } else {
          ambiguous = true;
        }
        continue;
      }
      previousCount = beforeCounts.get(frame);
      beforeHandles = beforeHandlesByFrame.get(frame);
      // A frame that was present in the pre-click snapshot can be temporarily
      // unreadable while the portal navigates it. Ignore that frame for this
      // pass; a frame that was not in the snapshot remains ambiguous above.
      if (!Number.isInteger(previousCount) || !Array.isArray(beforeHandles)) continue;
      const count = await dialogFileInputCount(frame);
      if (count === null) continue;
      const added = count - previousCount;
      if (added > 1) ambiguous = true;
      else if (added === 1) {
        const afterHandles = await dialogFileInputHandles(frame);
        if (!Array.isArray(afterHandles)) {
          ambiguous = true;
          continue;
        }
        const addedHandles = [];
        for (const after of afterHandles) {
          let known = false;
          for (const before of beforeHandles) {
            const equal = await sameElement(after, before);
            if (equal === null) {
              ambiguous = true;
              break;
            }
            if (equal) {
              known = true;
              break;
            }
          }
          if (ambiguous) break;
          if (!known) addedHandles.push(after);
        }
        if (ambiguous) continue;
        if (addedHandles.length !== 1) {
          ambiguous = true;
          continue;
        }
        candidates.push(addedHandles[0]);
      }
    }
    if (!ambiguous && candidates.length === 1) return candidates[0];
    await page.waitForTimeout(150);
  }
  // Playwright frames expose locator.count(). This fallback exists only for
  // lightweight legacy mocks that expose the prior page.locator() surface;
  // a real unbaselined or unreadable frame remains fail-closed above.
  try {
    const legacyLocator = page.locator(DIALOG_FILE_INPUT_SELECTOR);
    if (typeof legacyLocator.count !== 'function' && typeof legacyLocator.first === 'function') {
      return legacyLocator.first() || null;
    }
  } catch {
    // No legacy locator is available.
  }
  return null;
}

/** Watch before the click: a SuccessFactors upload control may open the browser file chooser instead of a DOM dialog. */
function fileChooserAfterClick(page) {
  if (typeof page.waitForEvent !== 'function') return Promise.resolve(null);
  try {
    return Promise.resolve(page.waitForEvent('filechooser', { timeout: 8_000 })).catch(() => null);
  } catch {
    return Promise.resolve(null);
  }
}

/** The CV through the dialog the trigger opens: 'unavailable' when nothing went in. */
async function uploadThroughDialog(page, trigger, file, triggerFrame = 0, trace = null) {
  const finish = (status) => {
    if (trace) trace.status = status;
    return status;
  };
  const framesBeforeClick = page.frames();
  const preferredFrame = framesBeforeClick[triggerFrame] || page.mainFrame();
  const beforeCounts = new Map();
  const beforeDialogHandlesByFrame = new Map();
  for (const frame of framesBeforeClick) {
    const count = await dialogFileInputCount(frame);
    beforeCounts.set(frame, count);
    beforeDialogHandlesByFrame.set(frame, await dialogFileInputHandles(frame));
  }
  const beforeFileInputHandles = await fileInputHandles(preferredFrame);
  const triggerLocator = trigger.snapshot
    ? preferredFrame.locator(`[data-aa-id="${trigger.snapshot.id}"]`).first()
    : trigger;
  const readTriggerContext = () => typeof triggerLocator?.evaluateHandle === 'function'
    ? triggerLocator.evaluateHandle((element) => ({
      trigger: element || null,
      context: element?.closest(
        'form, [role="dialog"], [aria-modal="true"], dialog, fieldset, [data-upload-container]',
      ) || null,
    })).catch(() => null)
    : Promise.resolve(null);
  let triggerContext = await readTriggerContext();
  // An already-open picker is unrelated to this trigger; fail closed instead
  // of risking an upload into a stale dialog or a different document field.
  const preexistingDialog = [...beforeCounts.values()].some((count) => count > 0);
  if (trace) trace.preexistingDialog = preexistingDialog;
  if (preexistingDialog) {
    if (trace) trace.failure = 'preexisting_dialog';
    return finish('unavailable');
  }
  const chooserPromise = fileChooserAfterClick(page);
  try {
    if (trigger.snapshot) await clickButton(page, trigger.snapshot);
    else await trigger.click({ timeout: 6_000 });
    if (trace) trace.click = 'succeeded';
  } catch {
    // The control may open its picker and then detach while the click is
    // settling. Still inspect both upload paths before treating that click as
    // a failure.
    if (trace) trace.click = 'failed';
  }
  // A timeout from one strategy is not evidence that the other failed. In
  // particular, the chooser watcher starts before the click, so it can time
  // out while the dialog watcher is still in its post-click window. Keep
  // waiting for every still-running strategy after a null result and select
  // the first actual target instead of treating a timeout as a final answer.
  const waitForTarget = async (chooser) => {
    const pendingTargets = [
      { source: 'chooser', promise: chooser.then((value) => value ? { chooser: value } : null, () => null) },
      { source: 'dialog', promise: dialogFileInput(page, preferredFrame, beforeCounts, beforeDialogHandlesByFrame)
        .then((input) => input ? { input } : null, () => null) },
      { source: 'mounted', promise: newlyMountedFileInput(page, preferredFrame, beforeFileInputHandles, triggerContext)
        .then((input) => input ? { input } : null, () => null) },
    ];
    let firstTarget = { source: null, target: null };
    while (pendingTargets.length && !firstTarget.target) {
      const outcome = await Promise.race(pendingTargets.map((entry) => entry.promise
        .then((target) => ({ entry, target }), () => ({ entry, target: null }))));
      const index = pendingTargets.indexOf(outcome.entry);
      if (index >= 0) pendingTargets.splice(index, 1);
      if (outcome.target) firstTarget = { source: outcome.entry.source, target: outcome.target };
    }
    return firstTarget;
  };
  let firstTarget = await waitForTarget(chooserPromise);
  // Some SuccessFactors tenants expose the upload control as an inline
  // `onclick` handler on an icon-only span. Chromium's trusted locator click
  // can report success without dispatching that handler (the SIX tenant does
  // this after the form has been scanned for fields). A DOM click on the same
  // live control is a bounded fallback: it runs only after every normal upload
  // target stayed absent, and the same frame/dialog uniqueness checks are
  // applied before selecting a file input.
  if (!firstTarget.target && typeof triggerLocator?.evaluate === 'function') {
    try {
      // newlyMountedFileInput disposes its association handle when the first
      // bounded wait ends. Re-read it before the DOM retry so a global hidden
      // input can still be proven to belong to this control.
      triggerContext = await readTriggerContext();
      // Register the native chooser watcher before dispatching the DOM click.
      // Some tenants call input.click() synchronously from that handler; a
      // watcher created afterwards misses the one-shot filechooser event.
      const domChooserPromise = fileChooserAfterClick(page);
      await triggerLocator.evaluate((element) => element?.click?.());
      if (trace) trace.domClick = 'succeeded';
      firstTarget = await waitForTarget(domChooserPromise);
    } catch {
      if (trace) trace.domClick = 'failed';
    }
  }
  const target = firstTarget.target;
  if (target?.chooser) {
    if (trace) trace.target = 'chooser';
    try {
      const chooser = target.chooser;
      // SuccessFactors can replace the file input while handling the native
      // chooser's change event. Capture the triggering element before the
      // selection so the receipt check still has a stable reference when the
      // post-selection `chooser.element()` points at no node.
      const initialInput = await chooser.element().catch(() => null);
      if (trace) trace.chooserElementBeforeSelection = Boolean(initialInput);
      const receipt = await chooseChooserFiles(page, chooser, file);
      if (trace) trace.chooserResponse = receipt.accepted ? 'accepted' : 'not_confirmed';
      if (receipt.accepted) return finish('uploaded');
      const refreshedInput = await chooser.element().catch(() => null);
      const inputs = [...new Set([initialInput, refreshedInput].filter(Boolean))];
      if (trace) trace.chooserElement = inputs.length > 0;
      let received = false;
      for (const input of inputs) {
        if (await uploadReceipt(page, input, [file], { acceptedResponse: receipt.accepted })) {
          received = true;
          break;
        }
      }
      if (trace) trace.portalReceipt = received;
      return finish(received ? 'uploaded' : 'uploaded_unconfirmed');
    } catch (error) {
      if (trace) trace.failure = error?.message === 'upload_http_failed' ? 'upload_http_failed' : 'chooser_selection_failed';
      return finish('unavailable');
    }
  }
  // Some SuccessFactors tenants keep the attachment control and its modal in
  // an application iframe. `page.locator()` only queries the main frame, so
  // searching there can report a failed upload even after the dialog opened.
  // The dialog must be visible and contain a newly attached file input; this
  // prevents selecting a stale or unrelated document picker.
  const input = target?.input;
  if (!input) {
    if (trace) {
      trace.target = 'none';
      trace.failure = 'no_upload_target';
    }
    if (page.keyboard?.press) await page.keyboard.press('Escape').catch(() => {});
    return finish('unavailable');
  }
  if (trace) trace.target = firstTarget.source === 'mounted' ? 'mounted' : 'dialog';
  try {
    await input.setInputFiles(file);
  } catch {
    if (trace) trace.failure = 'dialog_selection_failed';
    if (page.keyboard?.press) await page.keyboard.press('Escape').catch(() => {});
    return finish('unavailable');
  }
  // The dialog closes once the portal holds the file (SuccessFactors reads it first).
  const closed = await waitForInputDetached(input);
  if (trace) {
    trace.dialogSelection = 'completed';
    trace.dialogClosed = closed;
  }
  await settle(page);
  return finish(closed ? 'uploaded' : 'uploaded_unconfirmed');
}

/** Dequeue an upload trigger that is still allowed after a portal redraw. */
function nextAllowedUploadTrigger(page, snapshot, kind, channelType, pending, tried) {
  // `pending` contains keys, not button objects. Re-resolve every queued key
  // against the current snapshot so a redraw cannot make us click a detached
  // or reidentified control from the previous snapshot.
  const discovered = uploadButtonCandidatesFor(snapshot, kind)
    .filter((button) => iconUploadAllowedForPage(page, button, kind, snapshot, channelType));
  for (;;) {
    let candidate = null;
    let boundedRetry = false;
    while (pending.length && !candidate) {
      const key = pending.shift();
      candidate = discovered.find((button) => uploadTriggerKey(button) === key) || null;
    }
    if (!candidate) {
      const nextIndex = discovered.findIndex((button) => !tried.has(uploadTriggerKey(button)));
      if (nextIndex < 0) {
        // A portal may drop the first click without redrawing the control
        // (the flaky SuccessFactors tenant does exactly this). Once every
        // distinct candidate has had one bounded attempt, return the first
        // still-allowed candidate so the caller can spend its remaining
        // per-action retry budget on the same control. Distinct candidates
        // are still exhausted in order before this fallback is reached.
        candidate = discovered[0] || null;
        if (!candidate) return null;
        boundedRetry = true;
      } else {
        candidate = discovered[nextIndex];
        pending.push(...discovered.slice(nextIndex + 1).map(uploadTriggerKey));
      }
    }
    const key = uploadTriggerKey(candidate);
    // The fallback above is the bounded retry budget for a portal that drops
    // a click without redrawing. Queued/discovered candidates must still be
    // skipped when already tried, but the fallback must be returned once so
    // the caller can account for that retry and then stop at its attempt cap.
    if (!boundedRetry && tried.has(key)) continue;
    if (!iconUploadAllowedForPage(page, candidate, kind, snapshot, channelType)) {
      // It may have become invalid while a previous trigger redrew the form.
      // Mark it before continuing so a fresh snapshot cannot select it again.
      tried.add(key);
      continue;
    }
    return candidate;
  }
}

/**
 * Before a page is planned: its closed sections opened, and the CV attached
 * through an upload control when the portal exposes no file field. A page is
 * done only once the action is seen to work (more fields in sight, the file
 * in); a failed try is tried again, at most MAX_SECTION_TRIES per page.
 * @returns {Promise<{snapshot: object, cv?: 'uploaded'|'uploaded_unconfirmed'|'unavailable', cvFieldKey?: string}>}
 */
export async function openFormSections(page, snapshot, { files = {}, done = new Set(), tries = new Map(), channelType = '' } = {}) {
  let current = snapshot;
  const where = anonymizePath(page.url());
  const cvUploadDiagnostics = [];
  const attempt = (key) => {
    const count = (tries.get(key) || 0) + 1;
    tries.set(key, count);
    return count <= MAX_SECTION_TRIES;
  };
  const expandKey = `expand|${where}`;
  while (!done.has(expandKey) && findButton(current.buttons, EXPAND_ALL_RE) && attempt(expandKey)) {
    const before = current.fields.length;
    await clickButton(page, findButton(current.buttons, EXPAND_ALL_RE)).catch(() => {});
    await settle(page);
    await page.waitForTimeout(1000);
    current = await extractFields(page);
    if (current.fields.length > before) done.add(expandKey);
  }
  // Legacy Rexx/Portal7 forms (including the Ticino IAS portal) do not expose
  // an "expand all" control. Their application groups are accordion legends
  // (`.group_head`) and the first group is the only one open on first load.
  // Reading only the visible group makes the runner press the final button
  // while required fields in the other groups are still blank; the portal
  // then returns the same page with `#errors` and the outcome is ambiguous.
  // Open each closed group before planning so all required fields, consents
  // and CV-derived answers take part in the same guarded plan.
  const legacyHeaders = page.locator('.group_head');
  const legacyCount = await legacyHeaders.count().catch(() => 0);
  for (let index = 0; index < legacyCount; index += 1) {
    const header = legacyHeaders.nth(index);
    const closed = await header.evaluate((element) => {
      if (element.getAttribute('aria-expanded') === 'true' || element.classList.contains('group_extended')) return false;
      if (element.getAttribute('aria-expanded') === 'false') return true;
      const group = element.nextElementSibling;
      if (!group) return false;
      const style = window.getComputedStyle(group);
      return style.display === 'none' || group.getBoundingClientRect().height === 0;
    }).catch(() => false);
    if (!closed) continue;
    const id = await header.getAttribute('id').catch(() => '') || String(index);
    if (!attempt(`legacy|${where}|${id}`)) continue;
    await header.click({ timeout: 6_000 }).catch(() => {});
    await settle(page);
    await page.waitForTimeout(1000);
    current = await extractFields(page);
  }
  const cvFile = Array.isArray(files.cv) ? files.cv[0] : files.cv;
  const cvKey = `cv|${where}`;
  let cv;
  let cvFieldKey;
  const triedCvTriggers = new Set();
  let pendingCvTriggers = [];
  // A discovered file field stays in the normal planning path. That path
  // removes an earlier upload before replacing it and records the receipt and
  // failure in the same evidence as other planned uploads.
  while (cvFile && !done.has(cvKey) && !current.fields.some(isCvFileField)) {
    const triggerButton = nextAllowedUploadTrigger(page, current, 'cv', channelType, pendingCvTriggers, triedCvTriggers);
    const triggerKey = triggerButton && uploadTriggerKey(triggerButton);
    if (triggerKey) triedCvTriggers.add(triggerKey);
    if (!triggerButton) {
      cvUploadDiagnostics.push({ attempt: tries.get(cvKey) || 0, failure: 'trigger_not_found' });
      break;
    }
    if (!attempt(cvKey)) break;
    const trigger = ICON_ONLY_BUTTON_RE.test(String(triggerButton.text || '').trim())
      ? { snapshot: triggerButton } : locatorFor(page, triggerButton);
    const attemptNumber = tries.get(cvKey);
    if (!trigger) {
      cvUploadDiagnostics.push({ attempt: attemptNumber, failure: 'trigger_not_allowed' });
      continue;
    }
    const visible = trigger?.snapshot ? true : await trigger?.isVisible().catch(() => false);
    if (!visible) {
      cvUploadDiagnostics.push({ attempt: attemptNumber, failure: 'trigger_not_visible' });
      continue;
    }
    const trace = { attempt: attemptNumber, trigger: trigger.snapshot ? 'snapshot' : 'locator' };
    cv = await uploadThroughDialog(page, trigger, cvFile, triggerButton.frame || 0, trace);
    current = await extractFields(page);
    const uploadedCvField = current.fields.find(isCvFileField);
    trace.portalFileFieldObserved = Boolean(uploadedCvField);
    cvUploadDiagnostics.push(trace);
    if (cv !== 'unavailable' && uploadedCvField) cvFieldKey = uploadedPortalFieldKey(page.url(), uploadedCvField);
    // A file that went in, confirmed or not, never goes in twice.
    if (cv !== 'unavailable') done.add(cvKey);
  }
  const coverLetterFile = Array.isArray(files.cover_letter) ? files.cover_letter[0] : files.cover_letter;
  const coverLetterKey = `cover-letter|${where}`;
  let coverLetter;
  const triedCoverLetterTriggers = new Set();
  let pendingCoverLetterTriggers = [];
  while (coverLetterFile && !done.has(coverLetterKey) && attempt(coverLetterKey)) {
    const triggerButton = nextAllowedUploadTrigger(page, current, 'cover_letter', channelType, pendingCoverLetterTriggers, triedCoverLetterTriggers);
    const triggerKey = triggerButton && uploadTriggerKey(triggerButton);
    if (triggerKey) triedCoverLetterTriggers.add(triggerKey);
    if (!triggerButton) break;
    const trigger = ICON_ONLY_BUTTON_RE.test(String(triggerButton.text || '').trim())
      ? { snapshot: triggerButton } : locatorFor(page, triggerButton);
    const visible = trigger?.snapshot ? true : await trigger?.isVisible().catch(() => false);
    if (!trigger || !visible) continue;
    coverLetter = await uploadThroughDialog(page, trigger, coverLetterFile, triggerButton.frame || 0);
    current = await extractFields(page);
    if (coverLetter !== 'unavailable') done.add(coverLetterKey);
  }
  return {
    snapshot: current,
    ...(cv ? { cv } : {}),
    ...(cvUploadDiagnostics.length ? { cvUploadDiagnostics } : {}),
    ...(cvFieldKey ? { cvFieldKey } : {}),
    ...(coverLetter ? { coverLetter } : {}),
  };
}

const PROFILE_ADD_RE = /^(?:\+\s*)?(?:add|hinzufügen|hinzufuegen|ajouter|ajouter une entrée|aggiungi|aggiungere)\b/i;
const PROFILE_SAVE_RE = /^(?:save|speichern|enregistrer|sauvegarder|salva|salvare)\b/i;
const PROFILE_CANCEL_RE = /^(?:cancel|abbrechen|annuler|annulla)\b/i;

function profileFields(snapshot, kind) {
  return (snapshot.fields || []).filter((field) => profileSectionKind(`${field.section || ''} ${field.label || ''}`) === kind);
}

function profileButtons(snapshot, kind, pattern) {
  return (snapshot.buttons || []).filter((button) => !button.disabled
    && profileSectionKind(button.section) === kind && pattern.test(String(button.text || '').trim()));
}

async function waitForProfileFields(page, kind, beforeIds, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  let snapshot = await extractFields(page);
  while (Date.now() < deadline) {
    const current = profileFields(snapshot, kind);
    if (current.some((field) => !beforeIds.has(field.id))) return { snapshot, fields: current.filter((field) => !beforeIds.has(field.id)) };
    await page.waitForTimeout(250);
    snapshot = await extractFields(page);
  }
  return { snapshot, fields: [] };
}

/**
 * Workday's profile history is not a normal planner page: rows exist only
 * after the matching section's Add control is pressed. Fill and save each
 * complete row in source order; incomplete or unfillable rows are cancelled,
 * never turned into invented dates or a reason to stop the application.
 */
export async function fillProfileSections(page, snapshot, { candidate, candidateLocale, codex, files = {}, done = new Set() } = {}) {
  let current = snapshot;
  const counts = [];
  for (const kind of ['experience', 'education']) {
    const entries = profileEntriesForSection(candidate, kind);
    if (!entries.length || done.has(`${page.url()}|${kind}`)) continue;
    if (!profileButtons(current, kind, PROFILE_ADD_RE).length) continue;
    let added = 0;
    let skipped = Math.max(0, (candidate?.profile?.[kind]?.length || 0) - entries.length);
    for (const entry of entries) {
      current = await extractFields(page);
      const add = profileButtons(current, kind, PROFILE_ADD_RE)[0];
      if (!add) return { snapshot: current, counts, handoff: 'profile_section_add_unavailable' };
      const beforeIds = new Set(profileFields(current, kind).map((field) => field.id));
      try {
        await clickButton(page, add);
      } catch {
        return { snapshot: current, counts, handoff: 'profile_section_add_failed' };
      }
      const opened = await waitForProfileFields(page, kind, beforeIds);
      current = opened.snapshot;
      const rowFields = opened.fields;
      if (!rowFields.length) return { snapshot: current, counts, handoff: 'profile_section_fields_unavailable' };

      const rowCandidate = {
        ...candidate,
        profile: {
          ...candidate.profile,
          experience: kind === 'experience' ? [entry] : [],
          education: kind === 'education' ? [entry] : [],
          currentEducation: {},
        },
      };
      let plan;
      try {
        plan = await planPage({ snapshot: { ...current, fields: rowFields }, candidate: rowCandidate, candidateLocale, codex });
      } catch {
        plan = null;
      }
      if (plan?.missingRequired.length) {
        const unresolved = [];
        const recoveredActions = [...plan.actions];
        for (const missing of plan.missingRequired) {
          const field = rowFields.find((item) => item.id === missing.fieldId);
          const answer = profileEntryAnswer(entry, kind, field);
          if (answer) recoveredActions.push({ fieldId: missing.fieldId, action: 'fill', ...answer, document: 'none', evidence: '' });
          else unresolved.push(missing);
        }
        plan = { ...plan, actions: recoveredActions, missingRequired: unresolved };
      }
      const cancel = async () => {
        current = await extractFields(page);
        const control = profileButtons(current, kind, PROFILE_CANCEL_RE)[0];
        if (!control) return false;
        try {
          await clickButton(page, control);
          await page.waitForTimeout(250);
          current = await extractFields(page);
          return !rowFields.some((field) => current.fields.some((item) => item.id === field.id));
        } catch {
          return false;
        }
      };
      if (!plan || plan.missingRequired.length) {
        if (!await cancel()) return { snapshot: current, counts, handoff: 'profile_section_row_incomplete' };
        skipped += 1;
        continue;
      }
      const results = await applyActions(page, rowFields, plan.actions, files);
      if (results.some((result) => !result.ok)) {
        if (!await cancel()) return { snapshot: current, counts, handoff: 'profile_section_row_fill_failed' };
        skipped += 1;
        continue;
      }
      current = await extractFields(page);
      const currentRows = current.fields.filter((field) => rowFields.some((row) => row.id === field.id));
      if (rowFields.some((field) => {
        if (!field.required) return false;
        const filled = currentRows.find((item) => item.id === field.id) || field;
        if (holdsValue(filled)) return false;
        // Work history dates are periods: a plain-text portal input may accept
        // the exact month precision in the CV even though a full calendar date
        // would invent a day. Calendar controls still need a valid full date.
        const dateLabel = /^(?:start|end) date\s*[＊*]?$/i.test(String(field.label || '').trim());
        const source = profileEntryAnswer(entry, kind, field)?.value;
        return !(dateLabel && field.inputType === 'text' && source && String(filled.value || '').trim() === source);
      })) {
        if (!await cancel()) return { snapshot: current, counts, handoff: 'profile_section_row_incomplete' };
        skipped += 1;
        continue;
      }
      const save = profileButtons(current, kind, PROFILE_SAVE_RE)[0];
      if (!save) {
        if (!await cancel()) return { snapshot: current, counts, handoff: 'profile_section_save_unavailable' };
        skipped += 1;
        continue;
      }
      try {
        await clickButton(page, save);
      } catch {
        if (!await cancel()) return { snapshot: current, counts, handoff: 'profile_section_save_failed' };
        skipped += 1;
        continue;
      }
      const deadline = Date.now() + 10_000;
      let closed = false;
      while (Date.now() < deadline) {
        await page.waitForTimeout(250);
        current = await extractFields(page);
        if (!rowFields.some((field) => current.fields.some((item) => item.id === field.id))) {
          closed = true;
          break;
        }
      }
      if (!closed) {
        if (!await cancel()) return { snapshot: current, counts, handoff: 'profile_section_save_unconfirmed' };
        skipped += 1;
        continue;
      }
      added += 1;
    }
    done.add(`${page.url()}|${kind}`);
    counts.push({ section: kind, added, skipped });
    current = await extractFields(page);
  }
  return { snapshot: current, counts };
}

/**
 * The page a registration or a sign-in leads to, once the portal has answered its click: another kind of
 * page, or the same form with its messages. A page application answers without loading a new document, so
 * «network idle» is long past and the page read at once is still the form: a real order of 2026-10-07
 * (Workday) was judged «registration refused» 1.9 s after its password was stored, while the request was
 * on its way, and the password of an account that may exist was thrown away.
 * The answer is a change: a message the page already showed before the click (the notice «your account has
 * been created» above the sign-in form) is not the answer to it.
 * @param {'create'|'sign_in'} before the page the click was made on
 * @param {string[]} [shown] the messages on the page right before the click
 */
const authFieldValidity = (fields) => JSON.stringify((fields || [])
  .map((field) => [String(field.id), Boolean(field.invalid)])
  .sort(([left], [right]) => left.localeCompare(right)));

async function awaitAuthOutcome(page, before, shown = [], shownFields = []) {
  await settle(page);
  // A page that is reloading cannot be read yet. Read without opening its listboxes while waiting (the form
  // behind a sign-in has several, and each reading would open and close them all); in full once it is there.
  const read = () => extractFields(page, NAVIGATION).catch(() => null);
  const told = JSON.stringify(shown || []);
  const toldFieldValidity = authFieldValidity(shownFields);
  const unanswered = (after) => !after || (authPageKind(after) === before
    && JSON.stringify(after.errors || []) === told
    && authFieldValidity(after.fields) === toldFieldValidity);
  const started = Date.now();
  const deadline = started + AUTH_OUTCOME_TIMEOUT_MS;
  let after = await read();
  let seen = '';
  // The answer is a page read twice the same, with something to fill: between the sign-in form and the form
  // behind it Workday shows a page with nothing on it for a second or two (measured 2026-10-07). A page that
  // stays empty that long is the answer (a «check your e-mail», an account's home).
  const settled = (view) => !unanswered(view) && authViewSignature(view) === seen
    && (view.fields.length > 0 || Date.now() - started > AUTH_VIEW_TIMEOUT_MS);
  while (!settled(after) && Date.now() < deadline) {
    seen = after ? authViewSignature(after) : '';
    await page.waitForTimeout(AUTH_OUTCOME_POLL_MS);
    after = await read();
  }
  return (await extractFields(page).catch(() => null)) || after || extractFields(page);
}

/** What tells one account page from another, and a page from the same one read a moment later. */
const authViewSignature = (view) => `${authPageKind(view)}|${view.fields.map((field) => field.label).join('|')}|${(view.errors || []).join('|')}|${authFieldValidity(view.fields)}`;

/**
 * The other account page, once the link to it has drawn it. Such a link changes the page in place: read at
 * once (0.2 s after the click, dry run of 2026-10-07 on Workday) it was still the page with the link, which
 * was pressed again; read between the two (0.8 s after, the next dry run) it had no field at all, and was
 * taken for the form. So: another page than before, with fields, read twice the same.
 * @param {object} before the page the link was pressed on
 */
async function awaitAuthView(page, before) {
  await settle(page);
  const read = () => extractFields(page, NAVIGATION).catch(() => null);
  const drawn = (after) => Boolean(after) && after.fields.length > 0 && authViewSignature(after) !== authViewSignature(before);
  const deadline = Date.now() + AUTH_VIEW_TIMEOUT_MS;
  let after = await read();
  let seen = '';
  while ((!drawn(after) || authViewSignature(after) !== seen) && Date.now() < deadline) {
    seen = after ? authViewSignature(after) : '';
    await page.waitForTimeout(AUTH_OUTCOME_POLL_MS);
    after = await read();
  }
  return (await extractFields(page).catch(() => null)) || after || extractFields(page);
}

/**
 * One login page (account.mjs): sign in with the order's account, or create
 * it on the alias, or verify it. Returns the next page, a handoff reason,
 * questions for the candidate, or `dryRun` (a dry run never creates an account).
 */
async function handleAuth({ page, snapshot, ctx, allowExistingRegistration = false, diagnostics = null, recreated = false }) {
  const host = new URL(page.url()).hostname;
  const kind = authPageKind(snapshot);
  const account = await ctx.accounts.load(host);

  if (kind === 'sign_in' && !account) {
    if (!await clickFirst(page, snapshot, [CREATE_ACCOUNT_RE])) return { handoff: 'account' };
    return { snapshot: await awaitAuthView(page, snapshot) };
  }

  // With SuccessFactors' OTP verification the candidate is not an account
  // yet until the code is accepted. A prior run may therefore have the
  // encrypted password and `verifiedAt: null`, while the portal quite
  // correctly answers a sign-in with its generic invalid-credentials page.
  // Restart the registration flow with the same password so the portal can
  // issue a fresh OTP; do not throw the credential away and try to create a
  // second one.
  if (kind === 'sign_in' && account && !account.verifiedAt && usesOtpAccountCreation(host) && !allowExistingRegistration) {
    if (!await clickFirst(page, snapshot, [CREATE_ACCOUNT_RE])) return { handoff: 'account_verification' };
    const registration = await awaitAuthView(page, snapshot);
    if (authPageKind(registration) !== 'create') return { handoff: 'account_verification' };
    return handleAuth({ page, snapshot: registration, ctx, allowExistingRegistration: true, diagnostics });
  }

  if (kind === 'sign_in') {
    // Typed, then read again: a form the portal draws anew meanwhile (Workday, when what it loads for the
    // page arrives late) has lost what was typed and its button is another element. It is typed once more,
    // and the button pressed is the one of the reading made right before the click.
    let form = snapshot;
    let typed = false;
    for (let attempt = 0; attempt < 2 && !typed; attempt += 1) {
      const { email, password } = loginFields(form);
      if (!email || !password) return { handoff: 'account' };
      await applyActions(page, form.fields, [
        { fieldId: email.id, action: 'fill', value: account.email },
        { fieldId: password.id, action: 'fill', value: account.password },
      ], {});
      await page.waitForTimeout(AUTH_TYPED_WAIT_MS);
      form = await extractFields(page, NAVIGATION);
      const now = loginFields(form);
      typed = Boolean(now.email?.value) && Boolean(now.password?.value);
    }
    if (!typed) return { handoff: 'account' };
    const shown = form.errors || [];
    diagnostics?.beforeClick('account');
    const pressed = await clickFirst(page, form, [SIGN_IN_RE, SUBMIT_RE, NEXT_RE]);
    if (!pressed) return { handoff: 'account' };
    const after = await awaitAuthOutcome(page, 'sign_in', shown, form.fields);
    diagnostics?.afterClick();
    if (!account.verifiedAt && (VERIFY_PAGE_RE.test(after.text) || codeField(after))) {
      return { ...await verifyAccount({ page, host, sinceMs: account.createdAt || 0, ctx, snapshot: after }), pressed };
    }
    // Two password fields after a sign-in are no account's home either (a dialog opened over the form).
    if (authPageKind(after) === 'create') return { handoff: 'account_sign_in_failed', pressed };
    if (authPageKind(after) === 'sign_in') {
      // A registration the portal never answered (status `unanswered`): the account was not created after
      // all. It is created now, once; any other account that cannot sign in is the owner's to look at.
      if (account.status !== 'unanswered' || recreated) return { handoff: 'account_sign_in_failed', pressed };
      await ctx.accounts.discard(host, 'never_created');
      if (!await clickFirst(page, after, [CREATE_ACCOUNT_RE])) return { handoff: 'account_sign_in_failed' };
      const registration = await awaitAuthView(page, after);
      if (authPageKind(registration) !== 'create') return { handoff: 'account_sign_in_failed' };
      return handleAuth({ page, snapshot: registration, ctx, diagnostics, recreated: true });
    }
    // Signed in: the account exists, whatever its registration left on record (`unanswered`, `pending`). A
    // later sign-in that fails is then no reason to create it again.
    await ctx.accounts.mark(host, { status: 'created', lastSignInAt: Date.now() });
    return { snapshot: after, reopen: true, pressed };
  }

  // Create-account page.
  const retryingUnverifiedAccount = Boolean(account && !account.verifiedAt && allowExistingRegistration);
  if (account && !retryingUnverifiedAccount) {
    // Created by an earlier run: sign in instead.
    if (!await clickFirst(page, snapshot, [SIGN_IN_RE])) return { handoff: 'account' };
    return { snapshot: await awaitAuthView(page, snapshot) };
  }
  if (ctx.dryRun) return { dryRun: true };
  const others = { ...snapshot, fields: snapshot.fields.filter((field) => field.inputType !== 'password') };
  const candidate = account
    ? { ...ctx.candidate, identity: { ...ctx.candidate.identity, email: account.email } }
    : ctx.candidate;
  const plan = await planPage({ snapshot: others, candidate, candidateLocale: ctx.candidateLocale, codex: ctx.codex });
  if (plan.missingRequired.length) return {
    questions: await localizePortalQuestions(portalRequirementsFromMissingRequired(others.fields, plan.missingRequired).questions, {
      candidateLocale: ctx.candidateLocale,
      applicationLocale: ctx.language,
      codex: ctx.codex,
      log: ctx.log,
    }),
  };
  const password = account?.password || newPortalPassword({ portal: host });
  const sinceMs = Date.now();
  if (retryingUnverifiedAccount) {
    // Keep the existing encrypted password: the registration retry is the
    // continuation of the same candidate account, not a new credential.
    await ctx.accounts.mark(host, { status: 'pending' });
  } else {
    // Stored (encrypted) before the click: a run that dies afterwards still knows it.
    await ctx.accounts.save(host, { email: candidate.identity.email, password });
  }
  let registrationSnapshot = snapshot;
  let registrationPlan = plan;
  let privacy = 'none';
  let repairAttempts = 0;
  const noted = (result) => (privacy === 'none' ? result : { ...result, privacy });
  while (true) {
    const passwordActions = registrationSnapshot.fields.filter((field) => field.inputType === 'password')
      .map((field) => ({ fieldId: field.id, action: 'fill', value: password }));
    await applyActions(page, registrationSnapshot.fields, [...registrationPlan.actions, ...passwordActions], ctx.files);
    // After the fields: SuccessFactors opens its statement only for a chosen country.
    const acceptedPrivacy = await acceptPrivacyStatement(page, await extractFields(page, NAVIGATION));
    if (acceptedPrivacy !== 'none') privacy = acceptedPrivacy;
    const filled = await extractFields(page, NAVIGATION);
    diagnostics?.beforeClick('account');
    if (!await clickFirst(page, filled, [CREATE_ACCOUNT_RE, SUBMIT_RE, NEXT_RE])) {
      // A retry is still the same unverified account: keep its encrypted
      // password so the owner can retry after the portal exposes its button.
      if (!retryingUnverifiedAccount) await ctx.accounts.discard(host, 'no_create_button');
      return noted({ handoff: 'account' });
    }
    const after = await awaitAuthOutcome(page, 'create', filled.errors, filled.fields);
    diagnostics?.afterClick();
    const outcome = registrationOutcome(after);
    if (outcome !== 'refused') {
      await ctx.accounts.mark(host, { status: 'created' });
      if (outcome === 'verify') return noted(await verifyAccount({ page, host, sinceMs, ctx, snapshot: after }));
      return noted({ snapshot: after, reopen: !after.passwordVisible });
    }
    if (JSON.stringify(after.errors || []) === JSON.stringify(filled.errors || [])
      && authFieldValidity(after.fields) === authFieldValidity(filled.fields)) {
      // Still the form, and no word from the portal: it did not answer in time. The registration may have
      // gone through, so the password stays; the next run signs in with it, and creates the account again
      // only if that sign-in fails.
      await ctx.accounts.mark(host, { status: 'unanswered' });
      return noted({ handoff: 'account_create_unanswered' });
    }

    // A form-level validation response can expose fields the first plan did
    // not recognize. Replan against that response before treating it as a
    // permanent refusal; the planner receives the invalid fields and messages.
    const repairSnapshot = { ...after, fields: after.fields.filter((field) => field.inputType !== 'password') };
    const repairPlan = await planPage({ snapshot: repairSnapshot, candidate, candidateLocale: ctx.candidateLocale, codex: ctx.codex });
    if (repairPlan.missingRequired.length) {
      const questions = await localizePortalQuestions(portalRequirementsFromMissingRequired(repairSnapshot.fields, repairPlan.missingRequired).questions, {
        candidateLocale: ctx.candidateLocale,
        applicationLocale: ctx.language,
        codex: ctx.codex,
        log: ctx.log,
      });
      if (questions.length) {
        // Keep the credential for this order: a candidate's answer resumes this
        // registration, while a generic account flow can recreate it if absent.
        await ctx.accounts.mark(host, { status: 'unanswered' });
        return noted({ questions });
      }
    }

    const retryableFields = after.fields.filter((field) => field.invalid || (field.required && !holdsValue(field)));
    const retryableIds = new Set(retryableFields.map((field) => field.id));
    const repairActions = repairPlan.actions.filter((action) => retryableIds.has(action.fieldId)
      && !['skip', 'uncheck'].includes(action.action));
    const openFields = retryableFields.filter((field) => field.inputType !== 'password'
      && !repairActions.some((action) => action.fieldId === field.id));
    if (openFields.length) {
      const why = ({ it: 'Il portale ha rifiutato questo dato. Controllalo o correggilo.', de: 'Das Portal hat diese Angabe abgelehnt. Bitte prüfe oder korrigiere sie.', fr: 'Le portail a refusé cette réponse. Veuillez la vérifier ou la corriger.', en: 'The portal rejected this entry. Please check or correct it.' })[ctx.candidateLocale] || 'Il portale ha rifiutato questo dato. Controllalo o correggilo.';
      const openQuestions = questionsFrom(openFields.filter((field) => String(field.label || '').trim()).map((field) => ({
        fieldId: field.id,
        question: String(field.label).trim(),
        applicationQuestion: String(field.label).trim(),
        ...(field.context ? { context: field.context } : {}),
        ...(field.section ? { section: field.section } : {}),
        ...(field.autocomplete ? { autocomplete: field.autocomplete } : {}),
        why,
        type: field.options?.length ? 'choice' : field.kind === 'date' || field.inputType === 'date' ? 'date' : field.inputType === 'number' ? 'number' : 'text',
        options: (field.options || []).map((option) => option.label).filter(Boolean),
      })));
      const questions = await localizePortalQuestions(openQuestions, {
        candidateLocale: ctx.candidateLocale,
        applicationLocale: ctx.language,
        codex: ctx.codex,
        log: ctx.log,
      });
      if (questions.length) {
        await ctx.accounts.mark(host, { status: 'unanswered' });
        return noted({ questions });
      }
    }

    const passwordNeedsRefill = retryableFields.some((field) => field.inputType === 'password');
    if (repairAttempts >= 2 || (!repairActions.length && !passwordNeedsRefill)) {
      if (retryingUnverifiedAccount) return noted({ handoff: 'account_verification_retry_refused' });
      // No candidate answer or concrete correction remains: do not keep
      // credentials for an account the portal explicitly rejected.
      await ctx.accounts.discard(host, 'registration_refused');
      return noted({ handoff: 'account_create_refused' });
    }

    repairAttempts += 1;
    registrationSnapshot = after;
    registrationPlan = { ...repairPlan, actions: repairActions };
  }
}

/**
 * The password of an application form that creates its own account
 * (ownAccountForm): the one this order already holds for the portal, else a
 * new one, stored (encrypted) BEFORE it is typed, as for a registration page:
 * a run that dies after the send click still knows it. A dry run types one it
 * never stores (its form is never sent, so no account comes of it).
 * @param {Map<string,string>} passwords the run's own, by host (re-typed when the page is planned again)
 * @returns {Promise<boolean>} every password field took it
 */
async function typeOwnPassword({ page, snapshot, ctx, passwords }) {
  const host = new URL(page.url()).hostname;
  let password = passwords.get(host) || (await ctx.accounts.load(host))?.password || '';
  if (!password) {
    password = newPortalPassword({ portal: host });
    if (ctx.dryRun) ctx.accounts.mask?.(password);
    else await ctx.accounts.save(host, { email: ctx.candidate.identity.email, password });
  }
  passwords.set(host, password);
  const fields = snapshot.fields.filter((field) => field.inputType === 'password');
  const results = await applyActions(page, snapshot.fields, fields.map((field) => ({ fieldId: field.id, action: 'fill', value: password })), {});
  // Only whether it went in: the filler's own message may quote what it typed.
  return results.length === fields.length && results.every((result) => result.ok);
}

/**
 * A required field of the page is still empty. A file input's value is never
 * read by the snapshot (`holdsValue` counts it empty), so its own `files` say
 * whether the CV went in; an upload widget that clears its input reads as empty.
 */
async function requiredLeftEmpty(page, uploaded = new Set()) {
  const url = page.url();
  const snapshot = await extractFields(page, NAVIGATION);
  const fields = snapshot.fields || [];
  for (const field of fields) {
    if (!field.required) continue;
    const uploadedKey = uploadedPortalFieldKey(url, field);
    const filled = field.kind === 'file' || field.inputType === 'file'
      ? uploaded.has(uploadedKey)
        || await locatorFor(page, field).evaluate((element) => (element.files?.length || 0) > 0, null, { timeout: 2000 }).catch(() => false)
      : holdsValue(field);
    if (!filled) return true;
  }
  return false;
}

/**
 * The page's send and step buttons: a usual name, or one a confirmed
 * submission on this portal taught (level 2) on this same page (review of
 * #10741: a label is a control of the page it was learned on, not of every
 * page of the host). A taught send button never counts next to a step button.
 */
export function pageControls(buttons, known, url) {
  const here = anonymizePath(url);
  const submit = findButton(buttons, SUBMIT_RE);
  const usualNext = findButton(buttons, NEXT_RE);
  const taughtNext = submit || usualNext ? null : learnedButton(buttons, labelsAt(known.nextButtons, here));
  return {
    submit: submit || (usualNext || taughtNext ? null : learnedButton(buttons, labelsAt(known.finalButtons, here))),
    next: usualNext || taughtNext,
  };
}

/**
 * After the final click: the same send button is still on the page, and the
 * portal loads an invisible reCAPTCHA (v3 badge or `api.js?render=`), the
 * kind that scores the browser and lets the portal drop a bot's submission
 * without a word.
 */
async function refusedSilently(page, label) {
  return (await sendButtonStill(page, label)) && invisibleRecaptcha(page);
}

/** After the final click the same send button is still on the page: nothing moved on. */
async function sendButtonStill(page, label) {
  const after = await extractFields(page, NAVIGATION).catch(() => null);
  return Boolean(after && learnedButton(after.buttons, [label]));
}

/** The page scores its visitors with an invisible reCAPTCHA (v3 badge or `api.js?render=`). */
function invisibleRecaptcha(page) {
  return page.evaluate(() => Boolean(document.querySelector('.grecaptcha-badge'))
    || [...document.scripts].some((script) => /recaptcha\/(api|enterprise)\.js\?[^#]*render=/.test(script.src)))
    .catch(() => false);
}

// An address that says the application went through; a review step
// ("review-and-confirm") is not one.
const DONE_URL_RE = /(thank|danke|grazie|merci|success|confirmation|submitted|received|complete)/i;
const REVIEW_URL_RE = /(review|preview|summary|riepilogo|zusammenfassung|überprüf|ueberpruef|vérif|verif|resume|récap)/i;

/** The address alone confirms only once the page holds no send button any more. */
export function urlConfirms(url, snapshot) {
  return DONE_URL_RE.test(url) && !REVIEW_URL_RE.test(url) && Boolean(snapshot) && !findButton(snapshot.buttons || [], SUBMIT_RE, { includeDisabled: true });
}

async function waitForOutcome(page, captchaEnabled = false) {
  const started = Date.now();
  const deadline = started + OUTCOME_TIMEOUT_MS + (captchaEnabled ? CAPTCHA_TIMEOUT_MS : 0);
  while (Date.now() < deadline) {
    await page.waitForTimeout(1000);
    const text = await page.evaluate(() => document.body?.innerText || '').catch(() => '');
    // The portal says it did not send: nothing left, by its own word.
    if (REFUSED_RE.test(text)) return 'refused';
    // Refusal takes precedence when an error page retains generic thank-you copy.
    if (CONFIRM_RE.test(text)) return 'confirmed';
    let snapshot = await extractFields(page, NAVIGATION).catch(() => null);
    if (snapshot?.captcha && captchaEnabled) {
      snapshot = await awaitCaptcha(page, snapshot, { enabled: true, timeoutMs: Math.max(0, deadline - Date.now()) });
      // Solving may have submitted the original request: observe its outcome,
      // never press the final button a second time.
      if (!snapshot.captcha) continue;
    }
    if (urlConfirms(page.url(), snapshot)) return 'confirmed';
    if (snapshot?.captcha) return 'captcha';
    if (Date.now() > started + 4000 && (VALIDATION_RE.test(text) || snapshot?.errors?.length)) return 'validation';
  }
  return 'ambiguous';
}

// Forms that can be read without creating an account or sending an
// application. Account ATSs are included because some tenants expose a guest
// form; when they expose only sign-in/create-account, hasApplicationForm below
// returns false and the reader stops without touching the account flow.
export const PREREAD_CHANNELS = new Set([
  'greenhouse', 'lever', 'smartrecruiters', 'personio', 'softgarden',
  'umantis', 'refline', 'jobs_ch', 'workday', 'successfactors',
]);

// Solique exposes a public multi-step application form without an account.
// Keep this an exact HTTPS host allowlist: an arbitrary employer site must not
// be opened during drafting just because it happens to have an apply link.
const SAFE_EMPLOYER_PREREAD_HOSTS = new Set(['live.solique.ch']);

export function isSafeEmployerSitePreread(url) {
  try {
    const parsed = new URL(String(url || ''));
    return parsed.protocol === 'https:'
      && SAFE_EMPLOYER_PREREAD_HOSTS.has(parsed.hostname.toLowerCase());
  } catch {
    return false;
  }
}

const CORE_DOCUMENT_LABEL_RE = /(?<![\p{L}\p{N}])(?:cv|resume|résumé|lebenslauf|curriculum(?: vitae)?|cover(?:ing)? letter|anschreiben|bewerbungsschreiben|motivations(?:schreiben|brief)|lettre de motivation|lettre de présentation|lettera di (?:motivazione|presentazione)|carta motivazionale)(?![\p{L}\p{N}])/iu;

function portalDocumentId(field, label, context) {
  let hash = 2166136261;
  for (const character of `${field?.id || ''}\u0000${label}\u0000${context}`) {
    hash ^= character.codePointAt(0);
    hash = Math.imul(hash, 16777619);
  }
  const fieldPart = slugId(field?.id || label).slice(0, 16) || 'document';
  return `portal_document_${fieldPart}_${(hash >>> 0).toString(36)}`;
}

/** A readable required file field that is not the CV or the cover letter. */
export function portalRequiredDocumentFromField(field) {
  if (!field || !field.required || (field.kind !== 'file' && field.inputType !== 'file')) return null;
  const label = String(field.label || '').replace(/\s+/g, ' ').trim();
  const descriptor = `${field.context || ''} ${label}`.trim();
  if (machineLabel(label) || CORE_DOCUMENT_LABEL_RE.test(descriptor)) return null;
  const keywords = [...new Set([
    label,
    ...label.split(/[^\p{L}\p{N}]+/u).filter((word) => word.length >= 3),
  ])].slice(0, 12);
  return {
    id: portalDocumentId(field, label, field.context || ''),
    label: label.slice(0, 160),
    kind: 'other',
    required: true,
    quote: label.slice(0, 300),
    keywords,
  };
}

/**
 * Split the required fields found on a live form into candidate questions and
 * upload requirements. A required file is an upload request, not a text
 * question: the review page must show it in the same document picker as the
 * posting's requested documents.
 */
export function portalRequirementsFromMissingRequired(fields, missingRequired) {
  const availableFields = Array.isArray(fields) ? fields : [];
  const byId = new Map(availableFields.map((field) => [field.id, field]));
  const folded = (value) => String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ').trim();
  const fieldFor = (item) => {
    const direct = byId.get(item?.fieldId);
    if (direct) return direct;
    const questions = [item?.applicationQuestion, item?.portalQuestion, item?.question].map(folded).filter(Boolean);
    if (!questions.length) return null;
    return availableFields.find((field) => {
      const label = folded(field?.label);
      return label && questions.some((question) => label === question || question.includes(label) || label.includes(question));
    }) || null;
  };
  const documents = [];
  const readable = [];
  for (const item of Array.isArray(missingRequired) ? missingRequired : []) {
    const field = fieldFor(item);
    const document = portalRequiredDocumentFromField(field);
    if (!document) {
      // A field with a generated name is no question for a person: the submit
      // run's agent reads it from the live page instead.
      // The CV and cover-letter fields are already supplied by the runner, so
      // they are neither candidate questions nor extra document requirements.
      if (!field || (field.kind !== 'file' && field.inputType !== 'file')) {
        // A live field is authoritative. An agent's candidate-language copy
        // must never replace the exact label/options read from the ATS.
        const applicationQuestion = String(field?.label || item.applicationQuestion || item.portalQuestion || item.question || '').trim();
        const applicationOptions = (field?.options?.length ? field.options : item.applicationOptions || item.options || [])
          .map((option) => typeof option === 'string' ? option : option?.label)
          .map((option) => String(option || '').trim())
          .filter(Boolean);
        readable.push({
          ...item,
          applicationQuestion,
          ...(applicationOptions.length ? { applicationOptions } : {}),
          ...(item.optionMap ? { optionMap: item.optionMap } : {}),
          ...(item.section || !field?.section ? {} : { section: field.section }),
          ...(item.autocomplete || !field?.autocomplete ? {} : { autocomplete: field.autocomplete }),
        });
      }
      continue;
    }
    if (!documents.some((candidate) => candidate.id === document.id)) documents.push(document);
  }
  return { questions: questionsFrom(readable), documents };
}

/**
 * The questions a portal will ask, read while drafting (career-ops apply.md:
 * identify ALL the questions before answering), so the candidate answers them
 * on the first review instead of in a second round at submit time. The form
 * is opened and read, never filled, and nothing is pressed but "apply".
 * Never fails the draft: any problem returns no questions.
 * @returns {Promise<{questions:Array<object>,documents:Array<object>}>} requirements for the review page
 */
export async function readPortalRequirements(ctx) {
  const entryUrl = portalEntryUrl(ctx);
  const channelType = portalChannelType(ctx);
  // Some employer sites expose a Jobs2Web application URL without using a
  // SuccessFactors hostname. Only pre-read those when the validated same-ID
  // posting route above proves that this is the matching application flow.
  const verifiedJobs2WebEntry = ctx.channelType === 'employer_site'
    && entryUrl !== String(ctx.applyUrl || '');
  const safeEmployerSite = channelType === 'employer_site' && isSafeEmployerSitePreread(entryUrl);
  if ((!PREREAD_CHANNELS.has(channelType) && !verifiedJobs2WebEntry && !safeEmployerSite)
    || !ctx.applyUrl || !ctx.codex) {
    return { questions: [], documents: [] };
  }
  const launch = ctx.launch || (() => launchChromium({ headless: !headedBrowser() }));
  let browser = null;
  try {
    browser = await launch();
    const context = await browser.newContext({
      userAgent: realisticUserAgent(typeof browser.version === 'function' ? browser.version() : ''),
      locale: INTL[ctx.language] || 'de-CH',
      timezoneId: 'Europe/Zurich',
      viewport: { width: 1366, height: 900 },
      acceptDownloads: false,
    });
    registerPortalChannelType(context, portalChannelType(ctx));
    let page = await context.newPage();
    await page.goto(entryUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await settle(page);
    let snapshot;
    ({ page, snapshot } = await openApplicationForm(context, page, await extractFields(page, NAVIGATION)));
    // Solique keeps the later steps mounted with zero-sized controls. The
    // exact host allowlist makes it safe to read those labels and required
    // flags now, without filling or advancing the live form.
    snapshot = await awaitFields(page, await extractFields(page, safeEmployerSite
      ? { ...NAVIGATION, includeHidden: true, listboxOptions: false }
      : NAVIGATION));
    const readableApplication = hasApplicationForm(snapshot)
      && (!snapshot.passwordVisible || snapshot.fields.some((field) => field.kind === 'file') || sendsApplication(snapshot));
    if (snapshot.captcha || !readableApplication) return { questions: [], documents: [] };
    const plan = await planPage({ snapshot, candidate: ctx.candidate, candidateLocale: ctx.candidateLocale, codex: ctx.codex });
    const requirements = portalRequirementsFromMissingRequired(snapshot.fields, plan.missingRequired);
    return {
      ...requirements,
      questions: await localizePortalQuestions(requirements.questions, {
        candidateLocale: ctx.candidateLocale,
        applicationLocale: ctx.language,
        codex: ctx.codex,
        log: ctx.log,
      }),
    };
  } catch (error) {
    (ctx.log || (() => {}))(`portal pre-read skipped: ${String(error?.message || error).split('\n')[0].slice(0, 120)}`);
    return { questions: [], documents: [] };
  } finally {
    await browser?.close().catch(() => {});
  }
}

/** Backwards-compatible question-only view for callers that do not need uploads. */
export async function readPortalQuestions(ctx) {
  return (await readPortalRequirements(ctx)).questions;
}

/**
 * @param {object} ctx
 * @param {string} ctx.applyUrl
 * @param {string} ctx.language posting language (browser locale)
 * @param {string} ctx.candidateLocale language of the questions to the candidate
 * @param {object} ctx.candidate candidateForForm(...)
 * @param {{cv:string, cover_letter:string}} ctx.files local file paths
 * @param {Function} ctx.codex broker call
 * @param {Function} [ctx.launch] browser launcher (tests)
 * @param {boolean} [ctx.dryRun] fill every page but never press submit (nor create an account)
 * @param {Function} [ctx.onBeforeSubmit] called right before the final submit click (submission guard),
 *   with what went into the form's file fields so far (`{ uploads }`)
 * @param {ReturnType<import('./account.mjs').portalAccountStore>} [ctx.accounts] the order's portal accounts; without it a login page is handed over
 * @returns {Promise<{event:object, evidence:object}>}
 */
export async function submitViaPortal(ctx) {
  const launch = ctx.launch || (() => launchChromium({ headless: !headedBrowser() }));
  const channelType = portalChannelType(ctx);
  const extensionPath = !ctx.launch && process.env.NOPECHA_EXTENSION_PATH;
  const log = ctx.log || (() => {});
  // JOIN asks one question per page (e-mail, CV, details, links, permit, salary,
  // start date, the employer's own questions, review): 8 pages were not enough.
  const maxSteps = ctx.maxSteps || 15;
  const evidence = { steps: [], applyUrl: ctx.applyUrl };
  const browser = extensionPath ? null : await launch();
  let context = null;
  let page = null;
  let diagnostics = null;
  // Where the runner stopped, for whoever takes over (encrypted with the rest of the evidence).
  const handoff = async (reason) => {
    if (page) {
      evidence.handoffScreenshot = (await page.screenshot({ fullPage: true }).catch(() => Buffer.from(''))).toString('base64');
      // What a fixer needs to teach the runner this page (level 3); a CAPTCHA is no code fix.
      if (reason !== 'captcha') {
        const seen = await extractFields(page, NAVIGATION).catch(() => null);
        evidence.stopReport = stopReportFrom({ url: page.url(), reason, step: evidence.steps.length, seen, agent: evidence.steps.at(-1)?.agent || [] });
      }
    }
    return { event: { type: 'submit_handoff', reason }, evidence };
  };
  // What each portal taught earlier runs (level 2), read once per host.
  const knowledge = new Map();
  const knownFor = async (url) => {
    let host = '';
    try {
      host = new URL(url).hostname;
    } catch {
      return NO_PORTAL_KNOWLEDGE;
    }
    if (!ctx.knowledge) return NO_PORTAL_KNOWLEDGE;
    if (!knowledge.has(host)) knowledge.set(host, await ctx.knowledge.load(host).catch(() => NO_PORTAL_KNOWLEDGE));
    return knowledge.get(host);
  };
  // Step buttons the agent named in this run, with their page: learned only once the portal confirms.
  const namedNext = [];
  try {
    const contextOptions = {
      locale: INTL[ctx.language] || 'de-CH',
      timezoneId: 'Europe/Zurich',
      viewport: { width: 1366, height: 900 },
      acceptDownloads: false,
    };
    context = extensionPath
      ? await launchNopechaContext(extensionPath, { ...contextOptions, headless: !headedBrowser() })
      : await browser.newContext({ ...contextOptions, userAgent: realisticUserAgent(typeof browser.version === 'function' ? browser.version() : '') });
    registerPortalChannelType(context, channelType);
    diagnostics = startPortalDiagnostics(context, (evidence.submitHttpFailures = []));
    evidence.diagnostics = diagnostics.data;
    await diagnostics.installFetchObserver().catch(() => { evidence.diagnostics.fetchObserverUnavailable = true; });
    page = await context.newPage();
    // Which browser the portal saw (the run's logs are deleted): headed on the
    // virtual screen or headless, and the user agent it sent.
    evidence.browser = { headed: headedBrowser(), userAgent: await page.evaluate(() => navigator.userAgent).catch(() => ''), nopecha: Boolean(extensionPath) };
    const entryUrl = portalEntryUrl(ctx);
    const enteredFromMatchingPosting = isVerifiedPostingEntry(ctx);
    const response = await page.goto(entryUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await settle(page);
    let snapshot = await extractFields(page, NAVIGATION);
    snapshot = await awaitCaptcha(page, snapshot, { enabled: Boolean(extensionPath) });
    // The posting as a browser renders it (career-ops liveness-browser): the
    // fetch before the run sees only the empty shell of a JavaScript portal.
    const rendered = classifyLiveness({
      status: response?.status() || 0,
      requestedUrl: entryUrl,
      finalUrl: page.url(),
      bodyText: await pageText(page),
      applyControls: snapshot.buttons.map((button) => button.text || button.label || ''),
    });
    evidence.liveness = { result: rendered.result, code: rendered.code };
    if (isHardClosed(rendered)) return { event: { type: 'posting_closed', reason: rendered.code }, evidence };
    // The posting itself, before its apply button: where the company is read
    // when the form behind the button names only the role (formPostingMatch).
    const postingUrl = page.url();
    const postingSeen = `${await page.title().catch(() => '')} ${await pageText(page)} ${postingUrl}`;
    // The posting's own data (its ATS's answer for this very address, posting-liveness.mjs) may name the
    // employer where the page shows only a brand: Workday's page for «Rituals Cosmetics Switzerland» says
    // «Rituals», its data «Rituals Cosmetics Germany GmbH». One employer's two entities, and the role on
    // the page: the posting is the order's.
    const namedByItsData = sameEmployerFamily(ctx.job?.organization, ctx.job?.company) && postingMatch(postingSeen, { title: ctx.job.title }, postingUrl) === 'match';
    const postingNamed = postingMatch(postingSeen, ctx.job, postingUrl) === 'match' || namedByItsData;
    ({ page, snapshot } = await openApplicationForm(context, page, snapshot));
    if (needsPortalOptionRead(snapshot)) snapshot = await extractFields(page);
    // The form must be the posting's: an address that lands on a list of jobs
    // with a "Bewerben" must not apply to another one. Valerie's retry, after
    // she looked at the screenshot, goes on.
    const formMatch = async () => {
      const pageUrl = page.url();
      const seen = `${await page.title().catch(() => '')}\n${await pageText(page)}\n${pageUrl}`;
      const result = formPostingMatch(seen, ctx.job, {
        postingMatched: enteredFromMatchingPosting || (postingNamed && page.url() !== postingUrl),
        postingEntry: enteredFromMatchingPosting,
        pageUrl,
      });
      // Said in the evidence: the company was read on the posting (or in its data), the form names only the role.
      if (result === 'match' && postingMatch(seen, ctx.job, pageUrl) === 'mismatch') evidence.postingMatchVia = namedByItsData ? 'posting_data' : 'posting_page';
      return result;
    };
    const pendingOtpAccount = async (current) => {
      if (!ctx.accounts || !codeField(current)) return null;
      let host = '';
      try {
        host = new URL(page.url()).hostname;
      } catch {
        return null;
      }
      const account = await ctx.accounts.load(host);
      return isOtpVerificationPage(current, host, account) ? { host, account } : null;
    };
    const match = await formMatch();
    evidence.postingMatch = match;
    // A generic careers landing page can mention the employer and therefore
    // pass postingMatch, while exposing only the site's Menu/Search controls.
    // Do not send that chrome to the agent as if it were an unanswered
    // candidate question; it is not the application form for this posting.
    if (!hasApplicationSurface(snapshot) && !ctx.skipPostingCheck) return await handoff('posting_mismatch');
    const initialOtpAccount = await pendingOtpAccount(snapshot);
    // A sign-in page often names neither the company nor the role
    // (SuccessFactors, Coop 2026-10-02): the check waits for the form behind it.
    // An application form with its own password field is the form: checked now.
    let postingCheckPending = match === 'mismatch'
      && (snapshot.passwordVisible || initialOtpAccount)
      && !ownAccountForm(snapshot, channelType)
      && !ctx.skipPostingCheck;
    if (match === 'mismatch' && !postingCheckPending && !ctx.skipPostingCheck) return await handoff('posting_mismatch');
    let validationRetries = 0;
    let stuckOnPage = 0;
    let authSteps = 0;
    // The passwords this run typed into application forms that create their own account, by host.
    const ownPasswords = new Map();
    const uploaded = new Set();
    const privacyAcceptedPages = new Set();
    // How often a page was planned again because a choice redrew it, by address.
    const redraws = new Map();
    // How often a page was loaded again because the portal asked for it, by address.
    const refreshes = new Map();
    const refreshed = async (current) => {
      const url = page.url();
      if (current.fields.length || (refreshes.get(url) || 0) >= MAX_REFRESHES_PER_PAGE || !REFRESH_ASKED_RE.test(await pageText(page))) return null;
      refreshes.set(url, (refreshes.get(url) || 0) + 1);
      await page.reload({ waitUntil: 'domcontentloaded', timeout: 60_000 });
      await settle(page);
      return awaitFields(page, await extractFields(page));
    };
    // Pages whose sections and CV dialog were opened (openFormSections), and the tries.
    const openedOnce = new Set();
    const openTries = new Map();
    const profileSectionsDone = new Set();
    // What went into the form, question by question (career-ops application-answers):
    // for the interview prep, and for Valerie when she finishes by hand. The last answer wins.
    const given = new Map();
    evidence.answers = [];
    // What went into the form's file fields, for the record of what left (submit.mjs `sent`): slots and counts only.
    evidence.uploads = [];
    const noteUpload = (document, files = 1) => {
      if (!document) return;
      const name = String(document);
      evidence.uploads.push({ document: name, files: Number(files) || 1 });
    };
    const record = (question, answer, source, context = '', section = '', autocomplete = '') => {
      if (!question || !String(answer ?? '').trim()) return;
      const label = String(question).slice(0, 200);
      const surrounding = String(context || '').slice(0, 240);
      const heading = String(section || '').slice(0, 240);
      const fieldAutocomplete = String(autocomplete || '').slice(0, 100);
      const item = { question: label, context: surrounding, section: heading, autocomplete: fieldAutocomplete };
      const key = portalQuestionKey(item) || portalQuestionId(item) || label;
      given.set(key, {
        question: label,
        answer: String(answer).slice(0, 2000),
        source: source || '',
        ...(surrounding ? { context: surrounding } : {}),
        ...(heading ? { section: heading } : {}),
        ...(fieldAutocomplete ? { autocomplete: fieldAutocomplete } : {}),
      });
      evidence.answers = [...given.values()].slice(0, 80);
    };
    const candidateWithRecordedAnswers = (candidate, current) => {
      const answerKey = (item) => portalQuestionKey(item) || portalQuestionId(item);
      const recorded = [...given.values()];
      const recordedKeys = new Set(recorded.map(answerKey));
      const fold = (value) => String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
      const isPhoneCode = (field) => /\b(?:country\s+phone\s+code|phone\s+code|country\s+code|dial(?:ing)?\s+code|indicativo|vorwahl|prefisso)\b/i.test(String(field?.label || ''));
      const visibleAnswers = (current?.fields || [])
        .filter((field) => field.inputType !== 'password' && field.kind !== 'file' && field.inputType !== 'file' && holdsValue(field))
        .map((field) => {
          const answer = field.kind === 'checkbox' ? (field.checked ? 'Yes' : '') : String(field.value ?? '').trim();
          // A portal may prefill a default country or phone code before the
          // planner sees the form. Keep an explicit candidate fact above that
          // default; phone-code defaults are never candidate answers.
          const candidateAnswer = candidateAnswerForField(candidate, field)?.value || '';
          if (isPhoneCode(field) || (candidateAnswer && fold(candidateAnswer) !== fold(answer))) return null;
          return {
            question: String(field.label || field.name || field.id || '').slice(0, 200),
            answer,
            context: String(field.context || '').slice(0, 240),
            section: String(field.section || '').slice(0, 240),
            autocomplete: String(field.autocomplete || '').slice(0, 100),
            source: 'answers',
          };
        })
        .filter((item) => item && item.question && item.answer && !recordedKeys.has(answerKey(item)));
      const currentAnswers = [...visibleAnswers, ...recorded];
      const currentKeys = new Set(currentAnswers.map(answerKey));
      const previous = (candidate?.portalQuestionsAnswered || [])
        .filter((item) => !currentKeys.has(answerKey(item)));
      return { ...candidate, portalQuestionsAnswered: [...previous, ...currentAnswers] };
    };
    // The agentic fallback: once per page and reason, within the run's budget.
    let agentCalls = 0;
    const agentTried = new Set();
    const runAgent = async (current, hint) => {
      const key = `${pageSignature(page, current)}|${hint}`;
      if (!ctx.codex || agentTried.has(key) || agentCalls >= MAX_AGENT_CALLS) return null;
      agentTried.add(key);
      let agent;
      try {
        agent = await completeWithAgent({
          page,
          hint,
          errors: current.errors || [],
          candidate: candidateWithRecordedAnswers(ctx.candidate, current),
          candidateLocale: ctx.candidateLocale,
          codex: ctx.codex,
          files: ctx.files,
          secrets: [...ownPasswords.values()],
          maxRounds: Math.min(AGENT_ROUNDS, MAX_AGENT_CALLS - agentCalls),
          log,
        });
      } catch (error) {
        // The fallback is optional: whatever it throws ends in the usual handoff, never a failed run.
        agent = { status: 'stuck', reason: `agent_error: ${String(error?.message || error).split('\n')[0].slice(0, 120)}`, calls: 1, evidence: { hint, rounds: [] } };
      }
      agentCalls += agent.calls;
      (evidence.steps.at(-1).agent ||= []).push({ ...agent.evidence, status: agent.status, ...(agent.reason ? { reason: agent.reason } : {}) });
      for (const item of agent.answers || []) record(item.question, item.answer, item.source, item.context);
      for (const item of (agent.evidence?.rounds || []).flatMap((round) => round.actions || [])) {
        if (item.action === 'upload' && item.ok) noteUpload(item.document, item.files);
      }
      return agent;
    };
    const askCandidate = async (questions) => {
      const requirements = portalRequirementsFromMissingRequired(snapshot.fields, questions);
      return {
        event: {
          type: 'submit_needs_candidate',
          questions: await localizePortalQuestions(requirements.questions, {
            candidateLocale: ctx.candidateLocale,
            applicationLocale: ctx.language,
            codex: ctx.codex,
            log,
          }),
          documents: requirements.documents,
        },
        evidence,
      };
    };

    for (let step = 1; step <= maxSteps; step += 1) {
      snapshot = await awaitCaptcha(page, snapshot, { enabled: Boolean(extensionPath) });
      evidence.steps.push({ step, url: page.url(), fields: snapshot.fields.length, errors: snapshot.errors || [] });
      log(`portal step ${step}: ${snapshot.fields.length} fields`);
      if (snapshot.captcha) return await handoff('captcha');
      // The portal's own «refresh the page and try again»: loaded again, as it asks.
      const again = await refreshed(snapshot);
      if (again) {
        evidence.steps.at(-1).refreshed = true;
        snapshot = again;
        step -= 1;
        continue;
      }
      // SuccessFactors can resume directly on its one-time-code page after a
      // previous run saved the password but did not consume the OTP. It has no
      // password field, so it must be handled before the application planner.
      const otpAccount = await pendingOtpAccount(snapshot);
      if (otpAccount) {
        if (++authSteps > MAX_AUTH_STEPS) return await handoff('account_verification');
        const auth = await verifyAccount({
          page,
          host: otpAccount.host,
          sinceMs: otpAccount.account.createdAt || 0,
          ctx,
          snapshot,
        });
        evidence.steps.at(-1).auth = {
          kind: 'otp_verification',
          outcome: auth.handoff || 'ok',
        };
        if (auth.handoff) return await handoff(auth.handoff);
        snapshot = auth.snapshot;
        if (auth.reopen && !hasApplicationForm(snapshot) && !findButton(snapshot.buttons, NEXT_RE) && !findButton(snapshot.buttons, SUBMIT_RE)) {
          await page.goto(entryUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
          await settle(page);
          ({ page, snapshot } = await openApplicationForm(context, page, await extractFields(page, NAVIGATION)));
          snapshot = await extractFields(page);
        }
        step -= 1;
        continue;
      }
      // Closed sections opened, and the CV put in a dialog's file input (openFormSections).
      const openSections = async () => {
        const opened = await openFormSections(page, snapshot, { files: ctx.files, done: openedOnce, tries: openTries, channelType });
        snapshot = opened.snapshot;
        if (opened.cvUploadDiagnostics?.length) evidence.steps.at(-1).cvUploadDiagnostics = opened.cvUploadDiagnostics;
        if (opened.cv) {
          evidence.steps.at(-1).cv = opened.cv;
          if (opened.cv === 'uploaded') {
            record('Lebenslauf', uploadLabel('cv', ctx.candidate), 'documents');
            noteUpload('cv');
          }
          if (opened.cv !== 'unavailable' && opened.cvFieldKey) uploaded.add(opened.cvFieldKey);
          if (opened.cv !== 'uploaded') return await handoff('cv_upload_failed');
        }
        if (opened.coverLetter) {
          evidence.steps.at(-1).coverLetter = opened.coverLetter;
          if (opened.coverLetter !== 'unavailable') noteUpload('cover_letter');
        }
      };
      // A password page whose button sends an application may be the form with its
      // sections still closed, the CV field inside one (review of #11033): it is the
      // form's page, so the posting is checked and the sections are opened BEFORE it
      // is taken for a login page.
      if (snapshot.passwordVisible && !ownAccountForm(snapshot, channelType) && sendsApplication(snapshot)) {
        if (postingCheckPending) {
          postingCheckPending = false;
          evidence.postingMatch = await formMatch();
          if (evidence.postingMatch === 'mismatch') return await handoff('posting_mismatch');
        }
        const sectionsResult = await openSections();
        if (sectionsResult) return sectionsResult;
      }
      // The form asks for its account's password itself (umantis): no login
      // page to get through, the password is typed with the rest of the form.
      let ownAccount = ownAccountForm(snapshot, channelType);
      if (ownAccount && !ctx.accounts) return await handoff('account');
      if (snapshot.passwordVisible && !ownAccount) {
        if (!ctx.accounts || ++authSteps > MAX_AUTH_STEPS) return await handoff('account');
        let auth;
        try {
          auth = await handleAuth({ page, snapshot, ctx, diagnostics });
        } catch (error) {
          // A control of the account page that could not be pressed or typed into (covered by a dialog,
          // redrawn away): another run finds the same page. Thrown, it ended the run with no page kept
          // and, read as a timeout, the run was started again twice; the owner gets the page instead.
          if (!/^locator\./.test(String(error?.message || ''))) throw error;
          evidence.steps.at(-1).auth = { kind: authPageKind(snapshot), outcome: 'control_error', error: String(error.message).split('\n')[0].slice(0, 160) };
          // A registration whose password was stored and whose button then could not be pressed: whether the
          // account exists is not known. Left `pending`, the next run would sign in, fail and stop there;
          // as `unanswered` it signs in and, when that fails, creates the account.
          const authHost = new URL(page.url()).hostname;
          const stored = await ctx.accounts.load(authHost).catch(() => null);
          if (stored?.status === 'pending') await ctx.accounts.mark(authHost, { status: 'unanswered' }).catch(() => {});
          return await handoff('account');
        }
        evidence.steps.at(-1).auth = {
          kind: authPageKind(snapshot),
          outcome: auth.handoff || (auth.questions ? 'questions' : auth.dryRun ? 'dry_run' : 'ok'),
          ...(auth.privacy ? { privacy: auth.privacy } : {}),
          // How the sign-in button was found (clickButton): by its id, again after a redraw, or by its text.
          ...(auth.pressed ? { pressed: auth.pressed } : {}),
        };
        if (auth.handoff) return await handoff(auth.handoff);
        if (auth.questions) return { event: { type: 'submit_needs_candidate', questions: auth.questions }, evidence };
        if (auth.dryRun) {
          evidence.dryRunScreenshot = (await page.screenshot({ fullPage: true })).toString('base64');
          return { event: { type: 'dry_run_ready', stage: 'account' }, evidence };
        }
        snapshot = auth.snapshot;
        // The page a sign-in lands on may be the portal's «refresh the page» (see REFRESH_ASKED_RE): loaded
        // again here, before it is taken for a home page and left for the posting.
        const signedInPage = await refreshed(snapshot);
        if (signedInPage) {
          evidence.steps.at(-1).refreshed = true;
          snapshot = signedInPage;
        }
        // After a sign-in or a verification link the portal may land on its
        // home page: back to the posting and its form.
        if (auth.reopen && !hasApplicationForm(snapshot) && !findButton(snapshot.buttons, NEXT_RE) && !findButton(snapshot.buttons, SUBMIT_RE)) {
          await page.goto(entryUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
          await settle(page);
          ({ page, snapshot } = await openApplicationForm(context, page, await extractFields(page, NAVIGATION)));
          snapshot = await extractFields(page);
        }
        step -= 1; // a login page is not a form page
        continue;
      }
      if (postingCheckPending) {
        postingCheckPending = false;
        evidence.postingMatch = await formMatch();
        if (evidence.postingMatch === 'mismatch') return await handoff('posting_mismatch');
      }
      const sectionsResult = await openSections();
      if (sectionsResult) return sectionsResult;
      const profile = await fillProfileSections(page, snapshot, {
        candidate: ctx.candidate,
        candidateLocale: ctx.candidateLocale,
        codex: ctx.codex,
        files: ctx.files,
        done: profileSectionsDone,
      });
      snapshot = profile.snapshot;
      if (profile.counts.length) evidence.steps.at(-1).profileSections = profile.counts;
      if (profile.handoff) return await handoff(profile.handoff);
      // A section just opened may hold the form’s own password field.
      if (!ownAccount && ctx.accounts) ownAccount = ownAccountForm(snapshot, channelType);
      // Inside the form, any page with a field is planned: a step with one
      // question and its Next disabled until it is answered (JOIN's work
      // authorization) is not a dead end. Nothing to fill and nowhere to go is.
      const workable = (current) => current.fields.length > 0 || hasApplicationForm(current)
        || findButton(current.buttons, SUBMIT_RE) || findButton(current.buttons, NEXT_RE);
      if (!workable(snapshot)) snapshot = await awaitFields(page, snapshot);
      // Nothing the filler can read (a page of custom widgets): straight to the agent.
      let agentHint = workable(snapshot) ? 'next_disabled' : 'no_form_controls';

      // A file an earlier run left on the page under the name of one of this run's (the run that stopped for
      // a question, a dry run) is taken away before the page is planned: the page asks for the file again and
      // this run's goes in. One CV on the application and the current one: never two, and never the one of a
      // draft written since (a planner that sees «successfully uploaded» leaves the field alone). What this
      // run uploaded itself stays.
      const sentNow = new Set(evidence.uploads.map((upload) => upload.document));
      const earlier = Object.keys(ctx.files || {}).filter((document) => !sentNow.has(document))
        .flatMap((document) => {
          const names = documentPaths(ctx.files, document).map((file) => path.basename(file));
          const removals = removalsOf(snapshot.buttons, names).map((button) => ({ document, button, names }));
          return removals;
        });
      for (const document of Object.keys(ctx.files || {}).filter((item) => !sentNow.has(item))) {
        const names = documentPaths(ctx.files, document).map((file) => path.basename(file));
        const matchingRemoval = earlier.some((item) => item.document === document);
        for (const name of names) {
          const visible = await page.getByText(name, { exact: false }).first().isVisible().catch(() => false);
          if (visible && !matchingRemoval) return await handoff('previous_file_not_removable');
        }
      }
      if (earlier.length) {
        for (const { button, names } of earlier) {
          try {
            await clickButton(page, button);
          } catch {
            return await handoff('previous_file_removal_failed');
          }
          let remains = false;
          for (const name of names) {
            remains ||= !await waitForFileRemoval(page, name);
          }
          if (remains) return await handoff('previous_file_removal_unconfirmed');
        }
        evidence.steps.at(-1).replaced = [...new Set(earlier.map((item) => item.document))];
        snapshot = await extractFields(page);
      }

      let after = snapshot;
      let unclearQuestions = [];
      if (workable(snapshot)) {
        // The planner never sees a password field, nor what a retry finds typed in it.
        const planned = ownAccount ? { ...snapshot, fields: snapshot.fields.filter((field) => field.inputType !== 'password') } : snapshot;
        const plan = await planPage({
          snapshot: planned,
          candidate: candidateWithRecordedAnswers(ctx.candidate, planned),
          candidateLocale: ctx.candidateLocale,
          codex: ctx.codex,
        });
        const cvField = snapshot.fields.find(isCvFileField);
        // This synthetic action is executed by applyActions below, which resolves
        // the extracted fieldId through data-aa-id; agent.mjs aria-ref actions
        // are a separate path and are not used for this deterministic upload.
        const automaticCvUpload = cvField && documentPaths(ctx.files, 'cv').length
          ? {
              fieldId: cvField.id,
              ref: cvField.ref,
              action: 'upload',
              value: '',
              document: 'cv',
              source: 'documents',
              evidence: '',
            }
          : null;
        const plannedActions = [...plan.actions];
        if (automaticCvUpload && !plannedActions.some((action) => action.fieldId === cvField.id
          && action.action === 'upload' && action.document === 'cv')) {
          const skipIndex = plannedActions.findIndex((action) => action.fieldId === cvField.id && action.action === 'skip');
          if (skipIndex >= 0) plannedActions.splice(skipIndex, 1);
          plannedActions.push(automaticCvUpload);
        }
        const missingRequired = plan.missingRequired.filter((item) => !(automaticCvUpload && item.fieldId === cvField.id));
        // A required field with no readable label is no question for the
        // candidate ("select-input-_r_p_"): the agent finds its question on the page.
        const unclear = missingRequired.some((item) => machineLabel(snapshot.fields.find((field) => field.id === item.fieldId)?.label));
        if (missingRequired.length && !unclear) return askCandidate(missingRequired);
        if (unclear) unclearQuestions = missingRequired;
        if (unclear) agentHint = 'unclear_fields';
        // A file already uploaded on this page is not uploaded again when the
        // page is planned a second time (Personio empties the input after the upload).
        const uploadKey = (fieldId) => uploadedPortalFieldKey(
          page.url(), snapshot.fields.find((field) => field.id === fieldId) || { id: fieldId },
        );
        const actions = plannedActions.filter((action) => action.action !== 'upload' || !uploaded.has(uploadKey(action.fieldId)));
        const plannedUrl = page.url();
        // Choices first: one of them may redraw the form (on Workday the name and address fields follow the
        // country), and what was typed before into fields that are no more is lost without a word (dry run of
        // 2026-10-07: the address went into «Address Line 1», the country was chosen last, and the form that
        // was saved had «Street Name» and «Postcode» empty). A choice the field already shows is not made again.
        const fieldOf = (action) => snapshot.fields.find((field) => field.id === action.fieldId);
        const tidy = (value) => String(value || '').toLowerCase().replace(/\s+/g, ' ').trim();
        const isChoice = (action) => action.action !== 'skip' && ['select', 'listbox'].includes(fieldOf(action)?.kind);
        const shown = (action) => isChoice(action) && Boolean(tidy(action.value)) && tidy(fieldOf(action)?.value) === tidy(action.value);
        const choices = actions.filter((action) => isChoice(action) && !shown(action));
        const selectedUploads = new Map();
        const results = [
          ...actions.filter(shown).map((action) => ({ fieldId: action.fieldId, ok: true })),
          ...await applyActions(page, snapshot.fields, choices, ctx.files),
        ];
        // The form after the choices: with other fields than the ones planned it is read and planned again
        // (twice at most for one page), and nothing is typed into what is no longer there.
        const labelsOf = (view) => view.fields.map((field) => field.label).join('|');
        let redrawn = false;
        if (choices.length && (redraws.get(plannedUrl) || 0) < MAX_REDRAWS_PER_PAGE) {
          for (let waited = 0; waited < REDRAW_WAIT_MS && !redrawn && page.url() === plannedUrl; waited += 500) {
            await page.waitForTimeout(500);
            const now = await extractFields(page, NAVIGATION).catch(() => null);
            redrawn = Boolean(now) && now.fields.length > 0 && labelsOf(now) !== labelsOf(snapshot);
          }
        }
        if (!redrawn) results.push(...await applyActions(page, snapshot.fields, actions.filter((action) => !isChoice(action)), ctx.files, {
          onUploadSelection: (fieldId, paths) => selectedUploads.set(fieldId, paths),
        }));
        if (!redrawn) {
          for (const action of actions.filter((item) => item.action === 'upload')) {
            const result = results.find((item) => item.fieldId === action.fieldId);
            const field = snapshot.fields.find((item) => item.id === action.fieldId);
            const files = selectedUploads.get(action.fieldId) || [];
            if (!result?.ok || !field || !await uploadReceipt(page, locatorFor(page, field), files, { acceptedResponse: result.uploadAccepted === true })) {
              if (result) {
                result.ok = false;
                result.error ||= 'upload_not_confirmed';
              } else results.push({ fieldId: action.fieldId, ok: false, error: 'upload_not_confirmed' });
              evidence.steps.at(-1).actions = actions.map(({ fieldId, action: kind, source, document }) => ({ fieldId, action: kind, source, document }));
              evidence.steps.at(-1).failures = results.filter((item) => !item.ok);
              return await handoff('upload_failed');
            }
          }
        }
        for (const result of results) {
          if (result.ok && actions.some((action) => action.fieldId === result.fieldId && action.action === 'upload')) uploaded.add(uploadKey(result.fieldId));
          const uploadAction = result.ok && actions.find((item) => item.fieldId === result.fieldId && item.action === 'upload');
          if (uploadAction) noteUpload(uploadAction.document, result.files);
          const action = result.ok && actions.find((item) => item.fieldId === result.fieldId);
          const field = action && snapshot.fields.find((item) => item.id === result.fieldId);
          if (!field || field.inputType === 'password') continue;
          const answer = { upload: uploadLabel(action.document, ctx.candidate), check: '✓', uncheck: '✗' }[action.action] ?? action.value;
          record(field.label || field.name || field.id, answer, action.source, field.context, field.section, field.autocomplete);
        }
        evidence.steps.at(-1).actions = actions.map(({ fieldId, action, source, document }) => ({ fieldId, action, source, document }));
        evidence.steps.at(-1).failures = results.filter((result) => !result.ok);
        // A consent checkbox is part of the submission contract. If the
        // browser did not register the check, do not press Next/Submit and
        // turn a failed consent into an ambiguous portal outcome. The filler
        // verifies the DOM state; this boundary makes that verification
        // fail-closed for both required and legacy technical-name consents.
        const failedConsent = results.find((result) => {
          if (result.ok) return false;
          const action = actions.find((item) => item.fieldId === result.fieldId);
          const field = action && snapshot.fields.find((item) => item.id === result.fieldId);
          return failedConsentRequiresHandoff(result, action, field);
        });
        if (failedConsent) {
          evidence.steps.at(-1).criticalFailure = failedConsent.error;
          return await handoff('portal_choice_not_registered');
        }
        if (redrawn && page.url() === plannedUrl) {
          redraws.set(plannedUrl, (redraws.get(plannedUrl) || 0) + 1);
          evidence.steps.at(-1).redrawn = true;
          snapshot = await awaitFields(page, await extractFields(page));
          step -= 1; // the same page, planned again
          continue;
        }
        if (ownAccount) {
          const typed = await typeOwnPassword({ page, snapshot, ctx, passwords: ownPasswords });
          evidence.steps.at(-1).auth = { kind: 'inline', outcome: !typed ? 'password_not_typed' : ctx.dryRun ? 'dry_run' : 'ok' };
          if (!typed) return await handoff('account');
        }

        after = await extractFields(page, NAVIGATION);
        // The portal moved to another page by itself (JOIN registers the e-mail
        // and shows the CV page a moment later): plan that page, instead of
        // judging it by the buttons of the one just filled. Giro di prova 2026-10-01.
        if (page.url() !== plannedUrl) {
          snapshot = await awaitFields(page, await extractFields(page));
          continue;
        }
        // No usable button yet: a form re-rendering after a choice (Workday
        // redraws the address for another country) or an uploaded CV still being
        // processed (Workday parses it). Up to 6 s, or 60 s after an upload.
        const buttonWaitMs = actions.some((action) => action.action === 'upload') ? 60_000 : 6_000;
        for (let waited = 0; waited < buttonWaitMs && !findButton(after.buttons, SUBMIT_RE) && !findButton(after.buttons, NEXT_RE); waited += 2000) {
          await page.waitForTimeout(2000);
          after = await extractFields(page, NAVIGATION);
        }
      }
      after = await awaitCaptcha(page, after, { enabled: Boolean(extensionPath) });
      if (after.captcha) return await handoff('captcha');
      // A usual name, or one this portal taught a confirmed submission (level 2).
      const known = await knownFor(page.url());
      let { submit, next } = pageControls(after.buttons, known, page.url());
      let advance = null;
      let finalByAgent = null;
      // The filler cannot move this page on (its Next stays disabled: JOIN's
      // calendar of "Quando sei nato?"), or left fields it could not name:
      // the agent completes the page, then the runner moves on as before.
      if ((!submit && !next) || agentHint === 'unclear_fields') {
        const agentUrl = page.url();
        const agent = await runAgent(after, agentHint);
        if (agent?.status === 'needs_candidate') return askCandidate(agent.questions);
        // Required fields left unanswered: the owner looks when the agent could
        // not answer them; without the agent, the planner's questions as before.
        if (unclearQuestions.length && agent?.status !== 'done') {
          return !agent || agent.status === 'unavailable' ? askCandidate(unclearQuestions) : await handoff('portal_needs_candidate');
        }
        if (agent?.status === 'done') {
          if (agent.moved || page.url() !== agentUrl) {
            snapshot = await awaitFields(page, await extractFields(page));
            continue;
          }
          after = await extractFields(page, NAVIGATION);
          for (let waited = 0; waited < 6000 && !findButton(after.buttons, SUBMIT_RE) && !findButton(after.buttons, NEXT_RE); waited += 2000) {
            await page.waitForTimeout(2000);
            after = await extractFields(page, NAVIGATION);
          }
          ({ submit, next } = pageControls(after.buttons, known, page.url()));
          // A step button with an unusual name ("Salva e prosegui"), never one that may send.
          if (!submit && !next && agent.advanceRef) advance = await advanceLocator(page, agent.advanceRef);
          // The last page's send button with an unusual name («Conferma e applica», level 1):
          // the agent names it, the runner presses it below, behind the submission guard,
          // only when nothing required is left empty on the page.
          if (!submit && !next && !advance && agent.submitRef) {
            if (!await requiredLeftEmpty(page, uploaded)) finalByAgent = await submitLocator(page, agent.submitRef);
          }
        }
      }
      // SuccessFactors' required data privacy statement is a link to a dialog,
      // not an ordinary checkbox. Accept only the application-specific notice,
      // and do it before either Next or the final submission.
      const privacyPage = page.url();
      if (!privacyAcceptedPages.has(privacyPage)) {
        const privacy = await acceptPrivacyStatement(page, after);
        if (privacy === 'unavailable') {
          evidence.steps.at(-1).privacy = 'unavailable';
          return await handoff('privacy_not_accepted');
        }
        if (privacy === 'accepted') {
          evidence.steps.at(-1).privacy = 'accepted';
          privacyAcceptedPages.add(privacyPage);
          privacyAcceptedPages.add(page.url());
          after = await extractFields(page, NAVIGATION);
          ({ submit, next } = pageControls(after.buttons, known, page.url()));
          advance = null;
          finalByAgent = null;
          if (!submit && !next) {
            snapshot = after;
            step -= 1;
            continue;
          }
        }
      }
      if ((next || advance) && !submit) {
        const before = pageSignature(page, after);
        if (next) await clickButton(page, next);
        else {
          const from = anonymizePath(page.url());
          await advance.locator.click({ timeout: 6_000 });
          namedNext.push({ path: from, label: advance.name });
        }
        await settle(page);
        snapshot = await extractFields(page);
        // A single-page form moves on after its own request (JOIN checks the
        // e-mail first): up to 10 s for the next page before calling it stuck.
        // The address may change before the content does (JOIN's professionalLinks
        // step was read with the previous page's fields): the same labels count as the same page.
        const labelsBefore = after.fields.map((field) => field.label).join('|');
        snapshot = await awaitFields(page, snapshot, (current) => pageSignature(page, current) === before
          || (current.fields.length > 0 && current.fields.map((field) => field.label).join('|') === labelsBefore));
        // Still the same page: the form refused a value. A correction by the
        // planner, one by the agent (it reads the page's own messages), then the owner.
        stuckOnPage = pageSignature(page, snapshot) === before ? stuckOnPage + 1 : 0;
        if (stuckOnPage >= 2) {
          const agent = await runAgent(snapshot, 'refused');
          if (agent?.status === 'needs_candidate') return askCandidate(agent.questions);
          if (agent?.status === 'done') snapshot = await extractFields(page);
          else if ((agent && agent.status !== 'unavailable') || stuckOnPage > 2) return await handoff('portal_needs_candidate');
        }
        continue;
      }
      // The final button: a usual or learned name (the runner's), or the one the agent named.
      let final = submit
        ? { label: submit.text, by: 'runner', click: () => clickButton(page, submit) }
        : finalByAgent && { label: finalByAgent.name, by: 'agent', click: () => clickSubmitButton(page, finalByAgent) };
      if (!final) {
        if (findButton(after.buttons, SUBMIT_RE, { includeDisabled: true }) && validationRetries < 1) {
          validationRetries += 1;
          snapshot = await extractFields(page);
          continue;
        }
        return await handoff('portal_needs_candidate');
      }
      // A normal send button is not evidence that the portal form is complete.
      // Let the agent repair any required fields the deterministic fill missed;
      // never click Send while a required answer or upload is still empty.
      if (await requiredLeftEmpty(page, uploaded)) {
        evidence.steps.at(-1).requiredFieldsUnfilled = true;
        const repairUrl = page.url();
        const repair = await runAgent(after, 'required_fields_unfilled');
        if (repair?.status === 'needs_candidate') return askCandidate(repair.questions);
        if (repair?.status !== 'done') return await handoff('portal_required_fields_unfilled');
        if (repair.moved || page.url() !== repairUrl) {
          snapshot = await awaitFields(page, await extractFields(page));
          step -= 1;
          continue;
        }
        after = await extractFields(page, NAVIGATION);
        if (await requiredLeftEmpty(page, uploaded)) return await handoff('portal_required_fields_unfilled');
        const repairedControls = pageControls(after.buttons, known, page.url());
        if (repairedControls.next && !repairedControls.submit) {
          snapshot = after;
          step -= 1;
          continue;
        }
        if (repairedControls.submit) {
          final = { label: repairedControls.submit.text, by: 'runner', click: () => clickButton(page, repairedControls.submit) };
        } else if (repair.submitRef) {
          const repairedSubmit = await submitLocator(page, repair.submitRef);
          if (!repairedSubmit) return await handoff('portal_required_fields_unfilled');
          final = { label: repairedSubmit.name || String(repair.submitRef), by: 'agent', click: () => clickSubmitButton(page, repairedSubmit) };
        } else {
          return await handoff('portal_required_fields_unfilled');
        }
      }
      if (ctx.dryRun) {
        evidence.dryRunScreenshot = (await page.screenshot({ fullPage: true })).toString('base64');
        evidence.finalButton = { label: final.label, by: final.by };
        return { event: { type: 'dry_run_ready' }, evidence };
      }
      evidence.beforeSubmit = (await page.screenshot({ fullPage: true })).toString('base64');
      evidence.finalButton = { label: final.label, by: final.by };
      const finalUrl = page.url();
      await diagnostics.beforeSubmit(page);
      // From here the outcome may be unknown: the submission guard records the click, and
      // submit.mjs what the form holds (the record of an attempt whose outcome may stay unknown).
      if (ctx.onBeforeSubmit) await ctx.onBeforeSubmit({ uploads: evidence.uploads });
      diagnostics.finalClick();
      await final.click();
      const outcome = await waitForOutcome(page, Boolean(extensionPath));
      (evidence.finalOutcomes ||= []).push(outcome);
      await diagnostics.afterSubmit(page, outcome);
      evidence.afterSubmit = (await page.screenshot({ fullPage: true }).catch(() => Buffer.from(''))).toString('base64');
      evidence.finalUrl = page.url();
      log(`portal outcome: ${outcome}`);
      if (outcome === 'confirmed') {
        // The application went, and with it the account its form asked a password for.
        for (const host of ownPasswords.keys()) await ctx.accounts.mark(host, { status: 'created' }).catch(() => {});
        // The portal confirmed: what this run had to learn is remembered for the next one (level 2).
        const learnedFinal = final.by === 'agent' || !SUBMIT_RE.test(final.label) ? { path: anonymizePath(finalUrl), label: final.label } : null;
        if (ctx.knowledge && (learnedFinal || namedNext.length)) {
          await ctx.knowledge.learn(new URL(finalUrl).hostname, { finalButton: learnedFinal, nextButtons: namedNext }).catch((error) => log(`portal knowledge not saved: ${String(error?.message || error).slice(0, 80)}`));
        }
        return { event: { type: 'submit_succeeded', channel: 'portal' }, evidence };
      }
      if (outcome === 'captcha') return await handoff('captcha');
      if (outcome === 'validation' && validationRetries < 1) {
        validationRetries += 1;
        // A server-side validation response can clear a required agreement
        // that was accepted in the same URL (SIX resets its data privacy
        // agreement after rejecting another field). Re-open required notices
        // on the fresh page before retrying the submission.
        privacyAcceptedPages.clear();
        snapshot = await extractFields(page);
        continue;
      }
      // Lever, TSMG 2026-10-01: SUBMIT APPLICATION opened an hCaptcha challenge
      // (getcaptcha after the click) that nobody passed and that was gone by
      // the end of the wait; the page kept its form and send button. The
      // application never left: a CAPTCHA stop for Valerie, as a challenge
      // still on screen is, not an unknown outcome.
      if (outcome === 'ambiguous' && page.url() === finalUrl && diagnostics.challengeAfterClick() && await sendButtonStill(page, final.label)) {
        evidence.challengeAfterClick = true;
        return await handoff('captcha');
      }
      // career-ops: an ambiguous submit is never re-submitted automatically.
      // The page did not move and still offers the same send button, on a
      // portal that scores visitors with an invisible reCAPTCHA (JOIN, giro di
      // prova 2026-10-01: nothing reached the employer): most likely refused as
      // a bot. Said to Valerie as such; still never re-sent automatically.
      const antibot = outcome === 'ambiguous' && page.url() === finalUrl && await refusedSilently(page, final.label);
      if (antibot) evidence.antibot = true;
      // The portal said the application did not go (JOIN, run 36846326334),
      // on the same page or on an error page it moved to (review of #10741):
      // not ambiguous. submit.mjs releases the guard, so Valerie's retry can
      // claim it again; the runner itself never re-sends.
      if (outcome === 'refused') {
        evidence.antibot = await invisibleRecaptcha(page);
        return { event: { type: 'submit_failed', error: 'portal_refused' }, evidence };
      }
      return { event: { type: 'submit_failed', error: outcome === 'validation' ? 'portal_validation' : antibot ? 'portal_antibot_ambiguous' : 'portal_ambiguous' }, evidence };
    }
    return await handoff('portal_needs_candidate');
  } finally {
    await diagnostics?.finish();
    await context?.close().catch(() => {});
    await browser?.close().catch(() => {});
  }
}

export { locatorFor };
