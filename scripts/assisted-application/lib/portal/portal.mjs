import { createHash, randomUUID } from 'node:crypto';
import { hasAddressContextOwnership } from '../../../../functions/src/lib/addressContextContract.js';
import { PORTAL_QUESTION_PLACEHOLDERS, readablePortalQuestionText, portalQuestionText } from '../../../../functions/src/lib/portalQuestionText.js';
import '../../extension/apply-control.js';
/**
 * Portal runner (fase 3b: portals without an account; fase 3c: accounts).
 *
 *   open the apply URL → reach the real form (career-ops: the application host
 *   may differ from the posting host) → per page: CAPTCHA / login check,
 *   Codex plan, deterministic fill, next → submit → confirmation.
 *
 * CAPTCHA challenges are detected and handed off to Valerie for the owner
 * fill extension; the live application runner never loads a solver.
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
import { launchChromium } from '../../../lib/ensure-chromium.mjs';
import { applicationReceipt, applicationStage, gravityFormsSubmissionOutcome, inPageApplicationOpeners, isApplicationRegionUnsupported, portalJobKey } from './stages.mjs';
import { COVER_LETTER_DOCUMENT_CONTEXT_RE, COVER_LETTER_DOCUMENT_TERMS, CV_DOCUMENT_CONTEXT_RE, CV_DOCUMENT_TERMS } from './document-labels.mjs';
import { advancedToFinalReview } from './final-review.mjs';
export { advancedToFinalReview } from './final-review.mjs';
import { AGENT_ROUNDS, advanceLocator, clickSubmitButton, completeWithAgent, isPreDispatchLocatorClickFailure, submitLocator } from './agent.mjs';
import { CREATE_ACCOUNT_RE, RESEND_VERIFICATION_RE, SIGN_IN_RE, VERIFY_PAGE_RE, accountResponseText, asksExistingPassword, authPageKind, codeField, hasExistingAccountPrompt, inlineAccountForm, isAccountVerificationResponse, isExplicitSignInNavigationLabel, loginFields, newPortalPassword, registrationOutcome, sameSite, successFactorsRegistrationTarget, successFactorsSignInTarget, usesOtpAccountCreation, verificationIsPending, verificationOutcome, verifiedSignInTarget } from './account.mjs';
import { extractFields as extractFieldsRaw, registerPortalChannelType } from './fields.mjs';
import { startPortalDiagnostics, portalHandoffReason } from './diagnostics.mjs';
import { applicationContractFromPreflight, applicationContractFromSubmission } from './application-contract.mjs';
import { NO_PORTAL_KNOWLEDGE, labelsAt, learnedButton } from './knowledge.mjs';
import { addressAnswerNeedsOwnership, candidateAnswerForField, expectedValueShape, holdsValue, isPermitHistoricalQuestion, ownConsent, planPage, questionTopic, targetEmployerNoOption } from './plan.mjs';
import { publicValueShape, readbackShape, reportedValueShape } from './value-shape.mjs';
import { registerCookieSessionRecovery } from './cookie-session.mjs';
import { portalAnswerForApplication, portalOptionMap, portalQuestionId, portalQuestionKey, slugId } from './question-key.mjs';
import { codexPrompt } from '../../../../functions/src/assistedApplicationAiPrompts.js';
import { splitName } from '../../../../functions/src/assistedApplicationAiDraftCore.js';
import { isFetchablePublicUrl, resolvesToPublicHost } from '../../../../functions/src/assistedApplicationAiJob.js';
import { sanitizeValidation } from '../../../../functions/src/lib/answerRules.js';
import { operationalAnswerForOption, operationalDefaultAnswer, operationalQuestionTopic } from '../../../../functions/src/assistedApplicationOperationalAnswers.js';
import { decideLiveQuestions } from '../decision-answers.mjs';
import { isoDateOf } from '../../../../functions/src/lib/cvPeriod.js';
import { asksHeldStatus, isPermitField, nationalityLabelOf, nationalityOf, permitOptions, permitStatusFromCandidate, permitStatusOf, permitStatement, permitStatusQuestion, permitStatusQuestionWhy, printedPermitText } from '../../../../functions/src/lib/permitStatus.js';
import { formatInternationalPhone, phoneCountryLabel } from '../../../../functions/src/lib/phoneNormalization.js';
import { serializeAccountFailure } from '../../../../functions/src/assistedApplicationSubmissionGuard.js';
import { aliasLocalPart } from '../../../../functions/src/assistedApplicationAlias.js';
import { addressQuestionAnswer, residenceCountryCode, resolveResidenceAddress } from './residence-address.mjs';
import { CONFIRM_RE, NEXT_RE, REFUSED_RE, SUBMIT_RE, VALIDATION_RE, applyActions, chooseChooserFiles, documentPaths, findButton, locatorFor, uploadReceipt } from './fill.mjs';
import { detectLanguageWithConfidence } from '../../../lib/detect-language.mjs';
import { classifyLiveness, isHardClosed } from '../liveness.mjs';
import { armFinalFormClickGuardInPage, clearFinalFormGuardInPage, installFinalFormGuardCaptureInPage, readFinalFormGuardStatusInPage } from './form-contract.mjs';
import { isWorkdayJobRouteBound, isWorkdayTenantUrl, sameWorkdayJobRoute, workdayJobRoute } from './workday-route.mjs';

function workdayPostingRouteMismatch(pageUrl, applyUrl) {
  return isWorkdayTenantUrl(applyUrl) && !isWorkdayJobRouteBound(pageUrl, applyUrl);
}

export const WAVE1_CHANNELS = new Set([
  'employer_site', 'lever', 'greenhouse', 'smartrecruiters', 'personio', 'softgarden', 'umantis', 'refline', 'jobs_ch', 'manatal',
  // Workday and SuccessFactors: a guest application where the tenant allows
  // it, otherwise an account on the order's alias (account.mjs).
  'workday', 'successfactors',
]);
// Login pages in one run: create, verify, sign in, and one retry.
const MAX_AUTH_STEPS = 5;
const ACCOUNT_VERIFY_RE = /^(verify|verifizieren|bestätigen|verifica|conferma|vérifier|confirmer)$/i;
const FORGOT_PASSWORD_RE = /(?:forgot(?:ten)?\s+(?:your\s+)?password|password\s+forgotten|passwort\s+vergessen|kennwort\s+vergessen|mot de passe\s+oublié|mot de passe\s+oublie|password\s+dimenticat[oa]|hai dimenticato la password|password dimenticata)/i;
const PASSWORD_RESET_REQUEST_RE = /^(?:send(?:\s+(?:a\s+)?(?:reset\s+)?(?:link|instructions))?|reset\s+password|request\s+(?:a\s+)?password\s+reset|continue|submit|passwort\s+zurücksetzen|kennwort\s+zurücksetzen|réinitialiser le mot de passe|reinitialiser le mot de passe|invia|continua|reimposta password)$/i;
const PASSWORD_RESET_CONFIRM_RE = /(?:reset|change|update|save|submit|continue|zurücksetzen|zuruecksetzen|speichern|ändern|aendern|modifier|enregistrer|réinitialiser|reinitialiser|salva|aggiorna|reimposta)/i;
const PASSWORD_RESET_REFUSED_RE = /(?:expired|invalid|not valid|cannot be used|could not be reset|abgelaufen|ungültig|nicht gültig|expiré|invalide|scadut[oa]|non valido|rifiutat[oa])/i;
const ALREADY_APPLIED_RE = /(?:already applied|application already (?:exists|submitted|received)|you have already applied|déjà postulé|déjà candidaté|bereits beworben|bereits eine bewerbung|già candid(?:at[oa]|at[oa])|hai già inviato la candidatura|già presentata la candidatura)/iu;
const APPLICATION_HISTORY_RE = /(?:my applications|mes candidatures|mes demandes de candidature|meine bewerbungen|le mie candidature|i miei invii)/iu;
const EMPTY_APPLICATION_HISTORY_RE = /(?:no applications(?: yet| found| to show)?|no submitted applications|you (?:have not|haven't) applied|aucune candidature|aucune demande de candidature|aucune application|vous n'avez pas de candidatures|keine bewerbungen|noch keine bewerbungen|keine bewerbungen vorhanden|nessuna candidatura|non hai ancora presentato la candidatura)/iu;
const INTL = { it: 'it-CH', de: 'de-CH', fr: 'fr-CH', en: 'en-GB' };
// The extension injects this same classic-script module before its filler.
export const { APPLY_RE, APPLY_LATER_RE, startsApplication, preferredDocumentControls, isNonCvDocumentLabel, residenceFieldRole, explicitResidence, isIdentityEmailCaption, addressContextContract } = globalThis.AssistedApplyControls;
const verifiedUmantisApplicantPages = new WeakMap();
// Umantis' verified Application/New surface can omit a semantic section around
// its base applicant fields. Bind only an otherwise ownerless address cluster
// when the same native form also exposes the applicant's name and email. A
// named native owner always wins and remains subject to the usual provenance
// checks.
const UMANTIS_APPLICANT_IDENTITY_RE = {
  givenName: /^(?:first name|given name|firstname|forename|vorname|prénom|prename|nome)$/i,
  familyName: /^(?:last name|family name|surname|lastname|nachname|nom de famille|nom|cognome|name)$/i,
};
const UMANTIS_PHONE_CONTEXT_RE = /\b(?:phone|telephone|mobile|tel(?:ephone)?|telefon|telefono|natel|country code|dialling code|dialing code|indicativo|prefisso|vorwahl)\b/i;
const umantisIdentityCaption = field => String(field?.label || '').normalize('NFKC').replace(/\s+/g, ' ')
  .replace(/\s*\((?:required|mandatory|obbligatorio|erforderlich|pflichtfeld|obligatoire)\)\s*$/i, '')
  .replace(/[＊*]/g, '').replace(/[:?]\s*$/, '').trim();

function verifiedUmantisApplicantContext(stageContext, currentUrl) {
  if (stageContext?.postingEntry !== true || !stageContext.applyUrl || !stageContext.postingUrl) return null;
  // A direct Umantis order can store the posting URL in `applyUrl` while the
  // verified application page is derived from its vacancy/description path.
  // Resolve that route before validating the native applicant form; otherwise
  // the address cluster stays ownerless and is correctly (but unnecessarily)
  // held as unreadable.
  const applicationUrl = stageContext.applicationUrl
    || umantisApplicationEntryUrl(stageContext)
    || stageContext.applyUrl;
  try {
    const application = new URL(String(applicationUrl));
    const posting = new URL(String(stageContext.postingUrl));
    const current = new URL(String(currentUrl || ''));
    if (application.protocol !== 'https:' || posting.protocol !== 'https:' || current.protocol !== 'https:'
      || application.username || application.password || posting.username || posting.password || current.username || current.password
      || !/(?:^|\.)umantis\.com$/i.test(application.hostname)
      || !isUmantisPostingEntry({ applyUrl: application.href, postingUrl: posting.href })
      || current.origin !== application.origin
      || current.pathname.replace(/\/+$/, '').toLowerCase() !== application.pathname.replace(/\/+$/, '').toLowerCase()
      || !/^\/vacancies\/\d+\/application\/new\/\d+\/?$/i.test(application.pathname)) return null;
    return { applyUrl: application.href, postingUrl: posting.href };
  } catch {
    return null;
  }
}

function verifiedUmantisApplicantAddressSnapshot(snapshot, pageUrl, context) {
  if (!context || !Array.isArray(snapshot?.fields)) return snapshot;
  const fields = snapshot.fields;
  let current;
  try { current = new URL(String(pageUrl || '')); } catch { return snapshot; }
  if (current.origin !== new URL(context.applyUrl).origin
    || current.pathname.replace(/\/+$/, '').toLowerCase() !== new URL(context.applyUrl).pathname.replace(/\/+$/, '').toLowerCase()) return snapshot;

  const fieldsByForm = new Map();
  for (const field of fields) {
    if (!Number.isSafeInteger(field?.form) || field.form < 0) continue;
    const group = fieldsByForm.get(field.form) || [];
    group.push(field);
    fieldsByForm.set(field.form, group);
  }
  const applicantForms = [...fieldsByForm.values()].map(group => {
    const hasEmail = group.some(field => field?.inputType === 'email' || field?.autocomplete === 'email'
      || isIdentityEmailCaption(umantisIdentityCaption(field)));
    const hasGivenName = group.some(field => field?.autocomplete === 'given-name'
      || UMANTIS_APPLICANT_IDENTITY_RE.givenName.test(umantisIdentityCaption(field)));
    const hasFamilyName = group.some(field => field?.autocomplete === 'family-name'
      || UMANTIS_APPLICANT_IDENTITY_RE.familyName.test(umantisIdentityCaption(field)));
    if (!hasEmail || !hasGivenName || !hasFamilyName) return null;
    let bestCluster = null;
    let ambiguousCluster = false;
    for (let street = 0; street < group.length; street += 1) {
      if (residenceFieldRole(group[street]?.label) !== 'street') continue;
      for (let city = 0; city < group.length; city += 1) {
        if (residenceFieldRole(group[city]?.label) !== 'city') continue;
        for (let country = 0; country < group.length; country += 1) {
          if (residenceFieldRole(group[country]?.label) !== 'country') continue;
          const start = Math.min(street, city, country);
          const end = Math.max(street, city, country);
          const span = end - start;
          if (span > 5) continue;
          if (!bestCluster || span < bestCluster.span) {
            bestCluster = { start, end, span, tuple: `${street}:${city}:${country}` };
            ambiguousCluster = false;
          } else if (span === bestCluster.span && bestCluster.tuple !== `${street}:${city}:${country}`) {
            ambiguousCluster = true;
          }
        }
      }
    }
    return bestCluster && !ambiguousCluster
      ? { fields: group.slice(bestCluster.start, bestCluster.end + 1) } : null;
  }).filter(Boolean);
  if (applicantForms.length !== 1) return snapshot;

  const applicantFields = new Set(applicantForms[0].fields);
  let changed = false;
  const applicantOwner = { section: 'Personal information', owners: ['Personal information'], unknown: false };
  const nextFields = fields.map(field => {
    if (!applicantFields.has(field)) return field;
    const owner = addressContextContract(field);
    if (!owner || owner.unknown || owner.section.trim() || owner.owners.length
      || !residenceFieldRole(field?.label)
      || /tel-country-code/i.test(String(field?.autocomplete || ''))
      || UMANTIS_PHONE_CONTEXT_RE.test(`${field?.label || ''} ${field?.context || ''}`)
      || /(?:employer|company|work history|work experience|employment|emergency|reference|contact person|birthplace|place of birth)/i
        .test(`${field?.label || ''} ${field?.section || ''} ${field?.context || ''}`)) return field;
    changed = true;
    return { ...field, addressContext: applicantOwner };
  });
  return changed ? { ...snapshot, fields: nextFields } : snapshot;
}

async function extractFields(page, options) {
  const snapshot = await extractFieldsRaw(page, options);
  const context = verifiedUmantisApplicantPages.get(page);
  return context ? verifiedUmantisApplicantAddressSnapshot(snapshot, page.url(), context) : snapshot;
}

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
// Conditional ATS forms can reveal one required answer per successful edit
// (for example country → city → postal code). Replan after each change, but
// keep a finite ceiling so an unstable portal still hands off safely.
const MAX_REDRAWS_PER_PAGE = 4;
const QUESTION_SURFACE_WAIT_MS = 10_000;
const QUESTION_SURFACE_MIN_OBSERVATION_MS = 6000;
const QUESTION_SURFACE_STABLE_MS = 1500;
const QUESTION_SURFACE_POLL_MS = 250;
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
/**
 * The page lists a file under exactly one of this run's own names as a file
 * control of its own (SuccessFactors' «My Documents»: «CV_….pdf (11/10/2026)»
 * and «* Curriculum Vitae Edit document CV_….pdf Opens a dialog», no remove
 * control). Only an earlier run of this order names a file so: the slot holds
 * our document already. A name merely quoted in the page text proves nothing.
 */
export function ownEarlierFileShown(buttons, names) {
  return (buttons || []).some((button) => {
    if (button.chrome) return false;
    const text = String(button.text || '');
    return names.some((name) => name && text.includes(String(name)));
  });
}

/**
 * The CV is on this application although this run did not upload it: the run kept, on this very page, the CV an
 * earlier run of the order put in the application's own document slot (keptEarlier), and a file control of the
 * page still carries this run's CV file name (SuccessFactors «My Documents»: «* Curriculum Vitae Edit document
 * CV_….pdf Opens a dialog», Damiani rg82P9MP 2026-11-10). The stage guard reads it as the uploaded CV
 * (`uploadedCv`): without it a complete form whose CV came from the earlier run, and with no job question, was
 * «unknown_apply» and handed off before its final Apply. A name in the page chrome, another file, or a CV kept on
 * another page proves nothing.
 */
export function earlierCvHeld(buttons, cvNames, keptHere) {
  const names = (cvNames || []).filter(Boolean).map(String);
  if (!keptHere || !names.length) return false;
  // The file name must sit in the CV's own slot: the control's caption, without the file name, names the CV and
  // not the cover letter (a letter kept under the same file name is no CV).
  return (buttons || []).some((button) => {
    if (button.chrome) return false;
    const text = String(button.text || '');
    const name = names.find((item) => text.includes(item));
    if (!name) return false;
    const caption = text.split(name).join(' ');
    return CV_DOCUMENT_CONTEXT_RE.test(caption) && !COVER_LETTER_DOCUMENT_CONTEXT_RE.test(caption);
  });
}

export function removalsOf(buttons, names) {
  return (buttons || []).filter((button) => {
    if (button.disabled || !REMOVE_FILE_RE.test(button.text || '')) return false;
    const context = `${button.text || ''} ${button.fileContext || ''}`.toLowerCase();
    return names.some((name) => name && context.includes(String(name).toLowerCase()));
  });
}

const PREVIOUS_FILE_REMOVAL_TIMEOUT_MS = 1500;
// A removal the portal confirms first (SuccessFactors «My Documents»: «Cover Letter Delete document <file> Opens
// a dialog», Damiani rg82P9MP 2026-11-10) goes to the server once confirmed and redraws the slot afterwards.
const CONFIRMED_FILE_REMOVAL_TIMEOUT_MS = 8000;
// In-page confirmation dialogs answered per removal click: the first, and one the portal may stack on it.
export const MAX_REMOVAL_CONFIRMATIONS = 2;

/** Wait for an asynchronously removed prior document to leave the rendered page. */
export async function waitForFileRemoval(page, name, timeout = PREVIOUS_FILE_REMOVAL_TIMEOUT_MS) {
  try {
    await page.getByText(name, { exact: false }).first()
      .waitFor({ state: 'hidden', timeout });
    return true;
  } catch {
    return false;
  }
}

// A question that asks to take a file away («Are you sure you want to delete this document?», «Möchten Sie das
// Dokument wirklich löschen?», «Vuoi eliminare il documento?», «Voulez-vous supprimer ce document ?»). One that
// takes away the application, the account or the profile is never answered for the runner.
const REMOVAL_CONFIRM_VERB_RE = /(delet|remov|l[oö]sch|entfern|elimin|rimuov|cancella|supprim|retir|efface)/i;
const NOT_A_FILE_REMOVAL_RE = /(withdraw|zur[uü]ck\s*(?:zu)?zieh|ritir|\baccount\b|\bkonto\b|\bcompte\b|candidature|bewerbung|candidatura|\bapplication\b|\bprofile?\b|\bprofilo\b)/i;
// The affirmative button of an in-page confirmation, never «Cancel» / «No» / «Abbrechen». The end of the word is
// read on Unicode letters: an ASCII \b never closes «Sì».
const REMOVAL_CONFIRM_ACCEPT_RE = /^\s*(?:ok|okay|yes|ja|s[iì]|oui|confirm|best[aä]tigen|conferma(?:re)?|confirmer|delete|remove|l[oö]schen|entfernen|elimina(?:re)?|rimuovi|supprimer|retirer)(?![\p{L}\p{N}_])/iu;
const REMOVAL_CONFIRM_DIALOG_SELECTOR = '[role="alertdialog"], [role="dialog"], [aria-modal="true"], dialog[open]';

/** The text of a confirmation that takes a file away, and nothing else. */
export function isFileRemovalConfirmation(text) {
  const value = String(text || '');
  return REMOVAL_CONFIRM_VERB_RE.test(value) && !NOT_A_FILE_REMOVAL_RE.test(value);
}

/** The visible in-page dialog in front of the page (the last one drawn), or null. */
async function visibleRemovalDialog(page) {
  if (typeof page?.locator !== 'function') return null;
  const dialogs = page.locator(REMOVAL_CONFIRM_DIALOG_SELECTOR);
  const count = await Promise.resolve(dialogs?.count?.()).catch(() => 0) || 0;
  for (let index = count - 1; index >= 0; index -= 1) {
    const dialog = dialogs.nth(index);
    if (await Promise.resolve(dialog.isVisible()).catch(() => false)) return dialog;
  }
  return null;
}

/**
 * Answer the in-page confirmation a removal click opened: its text must ask to take a file away and exactly one
 * of its buttons must say yes. 'none' when no dialog is in front of the page.
 * @returns {Promise<'none'|'refused'|'ambiguous'|'click_failed'|'clicked'>}
 */
export async function confirmRemovalInPage(page) {
  const dialog = await visibleRemovalDialog(page);
  if (!dialog) return 'none';
  const text = await Promise.resolve(dialog.innerText()).catch(() => '');
  if (!isFileRemovalConfirmation(text)) return 'refused';
  const accept = dialog.getByRole('button', { name: REMOVAL_CONFIRM_ACCEPT_RE });
  if (await Promise.resolve(accept.count()).catch(() => 0) !== 1) return 'ambiguous';
  try {
    await accept.first().click({ timeout: 6_000 });
    return 'clicked';
  } catch {
    return 'click_failed';
  }
}

/**
 * Take away the file an earlier run of this order left on the page, through its removal control.
 *
 * The portal may ask first. A browser confirm() is answered yes only while this click is in flight and only when it
 * asks to take a file away; any other browser dialog is dismissed (without a listener Playwright dismisses them
 * all, and the removal never happens: Damiani rg82P9MP, run 42849689238). An in-page confirmation is answered at
 * most MAX_REMOVAL_CONFIRMATIONS times. Nothing in the evidence carries the dialog's text.
 *
 * - 'removed': the file's name left the page;
 * - 'untouched': nothing was confirmed, no dialog is left open, the name is still there: the file is as it was;
 * - 'unconfirmed': a confirmation was given (or a dialog stays open) and the name is still there: unknown state;
 * - 'click_failed': the removal control could not be clicked.
 * @returns {Promise<{ status: 'removed'|'untouched'|'unconfirmed'|'click_failed', confirmations: object[] }>}
 */
export async function removeEarlierFile(page, button, names, {
  click = clickButton,
  maxConfirmations = MAX_REMOVAL_CONFIRMATIONS,
  shortTimeout = PREVIOUS_FILE_REMOVAL_TIMEOUT_MS,
  longTimeout = CONFIRMED_FILE_REMOVAL_TIMEOUT_MS,
} = {}) {
  const confirmations = [];
  const onDialog = (dialog) => {
    const type = typeof dialog?.type === 'function' ? dialog.type() : '';
    const message = typeof dialog?.message === 'function' ? dialog.message() : '';
    const accepted = type === 'confirm' && isFileRemovalConfirmation(message);
    confirmations.push({ source: 'browser', type, accepted });
    Promise.resolve(accepted ? dialog.accept() : dialog.dismiss()).catch(() => {});
  };
  const listening = typeof page?.on === 'function';
  if (listening) page.on('dialog', onDialog);
  const confirmed = () => confirmations.some((item) => item.accepted || item.result === 'clicked');
  const gone = async (timeout) => {
    for (const name of names) {
      if (!await waitForFileRemoval(page, name, timeout)) return false;
    }
    return true;
  };
  try {
    try {
      await click(page, button);
    } catch {
      return { status: 'click_failed', confirmations };
    }
    if (await gone(confirmed() ? longTimeout : shortTimeout)) return { status: 'removed', confirmations };
    for (let round = 0; round < maxConfirmations; round += 1) {
      const result = await confirmRemovalInPage(page);
      if (result === 'none') break;
      confirmations.push({ source: 'page', result });
      if (result !== 'clicked') break;
      if (await gone(longTimeout)) return { status: 'removed', confirmations };
    }
    // A removal that needs no confirmation can still be on its way to the server.
    if (await gone(longTimeout)) return { status: 'removed', confirmations };
    // A dialog this click opened and the runner did not answer is closed (Escape = its cancel).
    if (await visibleRemovalDialog(page) && page.keyboard?.press) await page.keyboard.press('Escape').catch(() => {});
    const dialogOpen = Boolean(await visibleRemovalDialog(page));
    return { status: confirmed() || dialogOpen ? 'unconfirmed' : 'untouched', confirmations };
  } finally {
    if (listening) (page.off || page.removeListener)?.call(page, 'dialog', onDialog);
  }
}

/**
 * The page has no second place for this document: no file input at all and no upload control for it. Only then
 * can an earlier file of ours, which the portal does not let us take away, stay as this run's: the run cannot put a
 * second copy of the document beside it.
 */
export function noSecondUploadPlace(snapshot, document) {
  if ((snapshot?.fields || []).some((field) => field?.kind === 'file' || field?.inputType === 'file')) return false;
  if (document !== 'cv' && document !== 'cover_letter') return true;
  return uploadButtonCandidatesFor(snapshot, document).length === 0;
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
// The account page's technical stops (handleAuth's `authStop`) that the agentic fallback may try
// to complete, once per page and stop and within MAX_AGENT_CALLS, before the owner gets the page.
// Each one is raised before any account button was pressed on this surface: the form simply did
// not converge (a value that did not stay, a surface that kept redrawing, replans exhausted). The
// agent fills fields only; the runner then re-reads the stable surface and walks its own guarded
// path again (privacy preflight, credential saved right before the create click, OTP after it).
// Deliberately NOT recoverable, so they still go straight to the owner:
// - a surface that moved by itself (`*_surface_moved`): a navigation the runner did not ask for
//   may have been a form submission, and nothing ambiguous is ever retried;
// - `privacy_not_accepted`, unreadable labels and unhandled required files: their own paths
//   (consent guard, candidate questions, uploads) decide them;
// - every stop after an account click (create refused/unanswered, sign-in failed, verification
//   without the e-mail, control errors): the account state is then unknown or needs the mailbox;
// - `no_create_button`/`no_sign_in_button`: the agent never presses account buttons;
// - submit-stage handoffs such as `portal_ambiguous`: they never come from the account page, and
//   an ambiguous send is never retried.
const AUTH_AGENT_RECOVERABLE_STOPS = new Set([
  'registration_replans_exhausted',
  'registration_answer_unconfirmed',
  'registration_surface_unstable',
  'privacy_question_surface_unstable',
  'privacy_question_answer_unconfirmed',
  'sign_in_typing_unconfirmed',
]);
/**
 * Whether handleAuth's result is a technical stop the agentic fallback may try (see above).
 * `portal_ambiguous` is refused even if some path ever tagged it: an ambiguous send is never retried.
 */
export function isAgentRecoverableAuthStop(result) {
  return Boolean(result?.handoff) && result.handoff !== 'portal_ambiguous' && AUTH_AGENT_RECOVERABLE_STOPS.has(result.authStop);
}
// Controls of the account page reserved to the runner while the agent fills it: creating the
// account, signing in, and the privacy statement with its dialog (registrationPrivacyPreflight).
const AUTH_AGENT_RESERVED_BUTTONS = [
  CREATE_ACCOUNT_RE,
  SIGN_IN_RE,
  /datenschutz|privacy|privacidad|confidentialit|riservatezza|protezione dei dati|einwilligung|einverst|consent|konto|account|profil|regist|anmeld|einlogg|log ?in|accedi|connexion|connecter|inscri/i,
  /^(akzeptieren|akzeptiere|ich akzeptiere|accept|i accept|agree|i agree|zustimmen|stimme zu|ich stimme zu|accetta|accetto|accettare|accepter|acceptez|j['’]accepte)\b/i,
];

function accountFailure(code, stage) {
  return serializeAccountFailure({ code, stage }) || { code: 'unknown', stage: 'unknown' };
}

function accountHandoff(handoff, code, stage) {
  return { handoff, accountFailure: accountFailure(code, stage) };
}

function accountStageFor(snapshot) {
  const kind = authPageKind(snapshot);
  return kind === 'create' ? 'registration' : kind === 'sign_in' ? 'login' : 'unknown';
}

function hasResendVerificationControl(snapshot = {}) {
  return Boolean(findButton(snapshot.buttons || [], RESEND_VERIFICATION_RE)
    || (snapshot.links || []).some((link) => [link.text, link.label, link.ariaLabel, link.title]
      .some((value) => RESEND_VERIFICATION_RE.test(String(value || '')))));
}

function successFactorsModuleIdentity(url) {
  if (!url || url.protocol !== 'https:' || url.username || url.password || url.hash
    || !SUCCESS_FACTORS_HOST_RE.test(url.hostname)
    || url.pathname.replace(/\/+$/, '') !== '/career') return null;
  const valuesFor = (key) => [...url.searchParams.entries()]
    .filter(([name]) => name.toLowerCase() === key)
    .map(([, value]) => value);
  const company = valuesFor('company');
  const requisition = valuesFor('career_job_req_id');
  const namespace = valuesFor('career_ns');
  if (!(company.length === 1 && /^[a-z0-9][a-z0-9 _-]{0,99}$/i.test(company[0])
    && requisition.length === 1 && /^[0-9]{1,20}$/.test(requisition[0])
    // Older SuccessFactors job routes omit career_ns; an explicit requisition
    // still makes that /career URL the application module. A present value
    // must remain the application namespace, and duplicates stay ambiguous.
    && (namespace.length === 0
      || (namespace.length === 1 && namespace[0].toLowerCase() === 'job_application')))) return null;
  return {
    origin: url.origin,
    path: url.pathname.replace(/\/+$/, ''),
    company: company[0].toLowerCase(),
    requisition: requisition[0],
    namespace: namespace[0]?.toLowerCase() || 'job_application',
  };
}

function isSuccessFactorsModuleRoute(url) {
  return Boolean(successFactorsModuleIdentity(url));
}

function isSuccessFactorsCareerPath(value) {
  try {
    const url = new URL(String(value || ''));
    return url.protocol === 'https:' && !url.username && !url.password && !url.hash
      && SUCCESS_FACTORS_HOST_RE.test(url.hostname)
      && ['/career', '/portalcareer'].includes(url.pathname.replace(/\/+$/, ''));
  } catch {
    return false;
  }
}

function sameSuccessFactorsModuleAddress(firstUrl, secondUrl) {
  try {
    const first = new URL(String(firstUrl || ''));
    const second = new URL(String(secondUrl || ''));
    const expected = successFactorsModuleIdentity(first);
    const actual = successFactorsModuleIdentity(second);
    if (!expected || !actual) return false;
    return expected.origin === actual.origin
      && expected.path === actual.path
      && expected.company === actual.company
      && expected.requisition === actual.requisition
      && expected.namespace === actual.namespace;
  } catch {
    return false;
  }
}

function isSuccessFactorsPortalCareerContinuation({ applyUrl, postingUrl, postingRouteProof } = {}) {
  try {
    const current = new URL(String(applyUrl || ''));
    const posting = new URL(String(postingUrl || ''));
    const source = successFactorsModuleIdentity(new URL(String(postingRouteProof?.applyUrl || '')));
    if (!source || postingRouteProof?.via !== 'successfactors'
      || !isSuccessFactorsCareerPath(current.href)
      || current.pathname.replace(/\/+$/, '') !== '/portalcareer'
      || current.origin !== source.origin
      || !samePostingAddress(postingRouteProof.postingUrl, posting.href)) return false;

    const valuesFor = (key) => [...current.searchParams.entries()]
      .filter(([name]) => name.toLowerCase() === key)
      .map(([, value]) => value);
    const company = valuesFor('company');
    const requisition = valuesFor('career_job_req_id');
    const namespace = valuesFor('career_ns');
    // A redirect may drop the module query entirely, but an identity it keeps
    // must still agree with the source module. Duplicate identity parameters
    // are ambiguous and therefore never inherit the source posting.
    if (company.length > 1 || requisition.length > 1 || namespace.length > 1) return false;
    if (company.length && (company[0].toLowerCase() !== source.company
      || !/^[a-z0-9][a-z0-9 _-]{0,99}$/i.test(company[0]))) return false;
    if (requisition.length && (requisition[0] !== source.requisition
      || !/^[0-9]{1,20}$/.test(requisition[0]))) return false;
    if (namespace.length && namespace[0].toLowerCase() !== source.namespace) return false;
    return true;
  } catch {
    return false;
  }
}

function isSuccessFactorsPostingEntry({ applyUrl, postingUrl, postingRouteProof } = {}) {
  try {
    const apply = new URL(String(applyUrl || ''));
    const posting = new URL(String(postingUrl || ''));
    const applyId = /^\/talentcommunity\/apply\/([^/]+)\/?$/i.exec(apply.pathname)?.[1];
    // SuccessFactors CSB tenants may prefix the canonical job route with one
    // tenant/locale segment (the shared crawler emits both `/job/...` and
    // `/<tenant>/job/...`). Keep the same single-segment boundary here so the
    // verified posting provenance survives on those tenants too.
    const postingId = /^(?:\/[a-zA-Z0-9%._-]+)?\/job\/[^/]+\/([^/]+)\/?$/i.exec(posting.pathname)?.[1];
    if (apply.origin === posting.origin && Boolean(applyId) && postingId === applyId) return true;
    // Career Site Builder may expose the actual SuccessFactors module on a
    // different origin. Its requisition id is not the public job id, so the
    // URL alone cannot bind it to this posting. Trust it only when the
    // resolver recorded that exact posting as the source of the module URL.
    return isSuccessFactorsModuleRoute(apply)
      && postingRouteProof?.via === 'successfactors'
      && sameSuccessFactorsModuleAddress(postingRouteProof.applyUrl, apply.href)
      && samePostingAddress(postingRouteProof.postingUrl, posting.href)
      || isSuccessFactorsPortalCareerContinuation({
        applyUrl: apply.href,
        postingUrl: posting.href,
        postingRouteProof,
      });
  } catch {
    return false;
  }
}

const LOCALE_PATH_SEGMENT_RE = /^(?:it|en|de|fr)(?:-[a-z]{2})?$/i;

/**
 * Read an employer-hosted `/jobs/<slug>` route, allowing one locale segment
 * before `jobs`. ALTEN can redirect an English/canonical posting to
 * `/de/jobs/<slug>/apply` while the stored posting URL remains `/jobs/<slug>/`;
 * the host and complete slug still bind the two URLs to one posting.
 */
function directJobRoute(pathname, isApply) {
  const rawSegments = String(pathname || '').split('/');
  const start = rawSegments[0] === '' ? 1 : 0;
  const end = rawSegments.at(-1) === '' ? -1 : rawSegments.length;
  const segments = rawSegments.slice(start, end);
  if (segments.some((segment) => segment === '')) return null;
  if (isApply && segments.pop()?.toLowerCase() !== 'apply') return null;
  if (segments.length < 2 || segments.at(-2)?.toLowerCase() !== 'jobs') return null;
  const prefix = segments.slice(0, -2);
  const slug = segments.at(-1);
  return slug ? { prefix, slug } : null;
}

function sameDirectJobPrefix(first, second) {
  if (first.length === second.length && first.every((segment, index) => segment === second[index])) return true;
  const withoutLeadingLocale = (prefix) => LOCALE_PATH_SEGMENT_RE.test(prefix[0] || '')
    ? prefix.slice(1)
    : prefix;
  const firstBase = withoutLeadingLocale(first);
  const secondBase = withoutLeadingLocale(second);
  return Boolean(firstBase && secondBase)
    && firstBase.length === secondBase.length
    && firstBase.every((segment, index) => segment === secondBase[index]);
}

/**
 * Employer-hosted job apply routes can redirect to a generic application page
 * when opened cold. Enter through the matching job detail page first so its
 * normal Apply link establishes the portal session. Match both origin and the
 * complete job slug: a stale or unrelated posting URL must never change which
 * application the runner opens. A single locale segment may differ between
 * the stored canonical URL and the localized apply route.
 */
function isDirectJobApplyEntry({ applyUrl, postingUrl } = {}) {
  try {
    const apply = new URL(String(applyUrl || ''));
    const posting = new URL(String(postingUrl || ''));
    const applyRoute = directJobRoute(apply.pathname, true);
    const postingRoute = directJobRoute(posting.pathname, false);
    return apply.origin === posting.origin
      && Boolean(applyRoute && postingRoute)
      && applyRoute.slug === postingRoute.slug
      && sameDirectJobPrefix(applyRoute.prefix, postingRoute.prefix);
  } catch {
    return false;
  }
}

function isWorkdayPostingEntry({ applyUrl, postingUrl } = {}) {
  const apply = workdayJobRoute(applyUrl);
  const posting = workdayJobRoute(postingUrl);
  return sameWorkdayJobRoute(apply, posting)
    && (apply.suffix === '' && posting.suffix === ''
      || apply.suffix === 'apply' || apply.suffix === 'manual'
      || posting.suffix === 'apply' || posting.suffix === 'manual');
}

function workdayManualApplyEntry(control, snapshot, context = {}) {
  const current = workdayJobRoute(snapshot?.url);
  const expected = workdayJobRoute(context.applyUrl);
  if (!current || !['', 'apply'].includes(current.suffix)
    || (current.suffix === '' && control?.dialog !== true)
    || control?.ariaHidden === true || control?.behindDialog === true
    || !sameWorkdayJobRoute(current, expected)
    || control?.disabled || control?.chrome || (Number(control?.frame) || 0) !== 0
    || !MANUAL_APPLY_RE.test(String(control?.text || control?.label || '').trim())) return false;
  if (!control?.href) return current.suffix === 'apply';
  let href;
  try { href = new URL(String(control.href), snapshot.url).href; } catch { return false; }
  const target = workdayJobRoute(href);
  return Boolean(target?.suffix === 'manual' && sameWorkdayJobRoute(current, target)
    && sameWorkdayJobRoute(expected, target));
}

function workdayManualApplicationTarget(currentUrl, expectedUrl, control = {}) {
  const current = workdayJobRoute(currentUrl);
  const expected = workdayJobRoute(expectedUrl);
  if (!current || !['', 'apply'].includes(current.suffix) || !sameWorkdayJobRoute(current, expected)) return '';
  if (control?.href) {
    try {
      const href = new URL(String(control.href), currentUrl);
      const target = workdayJobRoute(href.href);
      return target?.suffix === 'manual' && sameWorkdayJobRoute(current, target)
        && sameWorkdayJobRoute(expected, target) ? href.href : '';
    } catch {
      return '';
    }
  }
  if (current.suffix !== 'apply') return '';
  return `${current.origin}${current.basePath}/apply/applyManually${current.search}`;
}

function isUmantisUrl(value) {
  try {
    return /(?:^|\.)umantis\.com$/i.test(new URL(String(value || '')).hostname);
  } catch {
    return false;
  }
}

const UMANTIS_APPLICATION_NEW_ROUTE_RE = /^\/vacancies\/(\d+)\/application\/new\/(\d+)\/?$/i;

function umantisApplicationNewRoute(value) {
  try {
    const url = new URL(String(value || ''));
    const match = UMANTIS_APPLICATION_NEW_ROUTE_RE.exec(url.pathname);
    if (url.protocol !== 'https:' || url.username || url.password || url.hash
      || !isUmantisUrl(url.href) || !match) return null;
    return { origin: url.origin, vacancyId: match[1], stepId: match[2] };
  } catch {
    return null;
  }
}

function umantisPostingAddressFromApplication(value) {
  const route = umantisApplicationNewRoute(value);
  return route ? `${route.origin}/Vacancies/${route.vacancyId}/Description/${route.stepId}` : '';
}

function umantisVacancyRoute(value) {
  try {
    const url = new URL(String(value || ''));
    if (!isUmantisUrl(url.href)) return null;
    const vacancyId = /^\/vacancies\/(\d+)(?:\/|$)/i.exec(url.pathname)?.[1] || '';
    return vacancyId ? { origin: url.origin, vacancyId } : null;
  } catch {
    return null;
  }
}

function hasConflictingUmantisVacancyRoute(applyUrl, candidates) {
  const application = umantisVacancyRoute(applyUrl);
  if (!application) return false;
  return candidates.some((candidate) => {
    const route = umantisVacancyRoute(candidate);
    return route && (route.origin !== application.origin || route.vacancyId !== application.vacancyId);
  });
}

/**
 * A direct Umantis form still carries the selected vacancy in its own route.
 * Submit-time liveness can retain the published site URL (or the Application/New
 * URL itself) instead of the Description route, so recover the same-origin
 * posting address for route binding. An explicit different Umantis vacancy stays
 * authoritative and is never rewritten into a match.
 */
function umantisFormPostingUrl(pageUrl, postingUrl) {
  const inferred = umantisPostingAddressFromApplication(pageUrl);
  const saved = String(postingUrl || '').trim();
  if (!inferred || hasConflictingUmantisVacancyRoute(pageUrl, [saved])) return saved;
  return inferred;
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
    if (!isUmantisUrl(apply.href)) return false;
    const applyId = /\/vacancies\/(\d+)\/application(?:\/|$)/i.exec(apply.pathname)?.[1];
    const postingId = /\/vacancies\/(\d+)(?:\/description(?:\/[^/]+)?)?\/?$/i.exec(posting.pathname)?.[1];
    return apply.origin === posting.origin && Boolean(applyId && postingId && applyId === postingId);
  } catch {
    return false;
  }
}

/**
 * Umantis vacancy pages use the same tenant and vacancy id for their direct
 * application form. This route is used only when the saved apply URL is the
 * exact same posting address; a matching numeric id by itself is not enough.
 */
function umantisApplicationEntryUrl({ applyUrl, postingUrl } = {}) {
  try {
    const apply = new URL(String(applyUrl || ''));
    const posting = new URL(String(postingUrl || ''));
    if (apply.protocol !== 'https:' || posting.protocol !== 'https:'
      || !/(?:^|\.)umantis\.com$/i.test(apply.hostname)
      || apply.origin !== posting.origin
      || apply.pathname.replace(/\/+$/, '') !== posting.pathname.replace(/\/+$/, '')) return '';
    const match = /^\/vacancies\/(\d+)\/description\/(\d+)\/?$/i.exec(posting.pathname);
    if (!match) return '';
    return `${posting.origin}/Vacancies/${match[1]}/Application/New/${match[2]}`;
  } catch {
    return '';
  }
}

function verifiedPostingEntryFor(ctx = {}) {
  if (isVerifiedPostingEntry(ctx)) return true;
  const applicationUrl = umantisApplicationEntryUrl(ctx);
  return Boolean(applicationUrl && isVerifiedPostingEntry({
    applyUrl: applicationUrl,
    postingUrl: ctx.postingUrl,
  })) || (!String(ctx.postingUrl || '').trim() && (() => {
    const inferredPostingUrl = umantisPostingAddressFromApplication(ctx.applyUrl);
    return Boolean(inferredPostingUrl && isVerifiedPostingEntry({
      applyUrl: ctx.applyUrl,
      postingUrl: inferredPostingUrl,
    }));
  })());
}

/**
 * A URL pair that proves the application belongs to the selected posting.
 * This is stronger than the rendered posting text: Umantis can show a generic
 * application form without repeating the employer or vacancy title.
 */
export function isVerifiedPostingEntry({ applyUrl, postingUrl, postingRouteProof } = {}) {
  return isSuccessFactorsPostingEntry({ applyUrl, postingUrl, postingRouteProof })
    || isDirectJobApplyEntry({ applyUrl, postingUrl })
    || isWorkdayPostingEntry({ applyUrl, postingUrl })
    || isUmantisPostingEntry({ applyUrl, postingUrl });
}

/** The selected posting address, ignoring only its canonical trailing slash. */
function samePostingAddress(firstUrl, secondUrl) {
  try {
    const first = new URL(String(firstUrl || ''));
    const second = new URL(String(secondUrl || ''));
    return first.origin === second.origin
      && !first.username && !first.password && !second.username && !second.password
      && first.pathname.replace(/\/+$/, '') === second.pathname.replace(/\/+$/, '')
      && first.search === second.search
      && first.hash === second.hash;
  } catch {
    return false;
  }
}

const STADT_ZUERICH_PUBLIC_HOSTS = new Set(['stadt-zuerich.ch', 'www.stadt-zuerich.ch']);
const STADT_ZUERICH_PUBLIC_JOB_SEARCH_PATH = '/de/politik-und-verwaltung/arbeiten-bei-der-stadt/jobs.html';
const STADT_ZUERICH_PUBLIC_JOB_DETAIL_RE = [
  /^\/(?:content\/web\/)?(?:de|en|fr|it)\/politik-und-verwaltung\/arbeiten-bei-der-stadt\/jobs\/job-detailseite\.\d+\.html$/iu,
  /^\/jobs\/(?:de|en|fr|it)\/[^/]+-\d+\.html$/iu,
];
const STADT_ZUERICH_ATS_JOB_DETAIL_RE = /^\/job\/[^/]+\/\d+\/?$/iu;

function parsedSafeStadtZurichUrl(value, base = '') {
  try {
    const url = new URL(String(value || ''), base || undefined);
    if (url.protocol !== 'https:' || url.username || url.password || url.hash) return null;
    return url;
  } catch {
    return null;
  }
}

export function isStadtZurichPublicJobSearchRoute(value) {
  const url = parsedSafeStadtZurichUrl(value);
  return Boolean(url && STADT_ZUERICH_PUBLIC_HOSTS.has(url.hostname.toLowerCase())
    && url.pathname.replace(/\/+$/, '') === STADT_ZUERICH_PUBLIC_JOB_SEARCH_PATH.replace(/\/+$/, ''));
}

function isStadtZurichPublicJobDetailRoute(value) {
  const url = parsedSafeStadtZurichUrl(value);
  if (!url) return false;
  const host = url.hostname.toLowerCase();
  if (host === 'jobs.stadt-zuerich.ch') return STADT_ZUERICH_ATS_JOB_DETAIL_RE.test(url.pathname);
  return STADT_ZUERICH_PUBLIC_HOSTS.has(host)
    && STADT_ZUERICH_PUBLIC_JOB_DETAIL_RE.some((pattern) => pattern.test(url.pathname));
}

function stadtZurichAccessibleControlName(control) {
  return [control?.labelledBy, control?.label, control?.ariaLabel, control?.text, control?.title]
    .map((value) => String(value || '').replace(/\s+/g, ' ').trim())
    .find(Boolean) || '';
}

function stadtZurichPostingCandidateText(candidate) {
  const name = stadtZurichAccessibleControlName(candidate);
  return name ? [name] : [];
}

/**
 * Select a Stadt Zürich detail link only when the listing exposes exactly one
 * URL whose own accessible name is the selected role. A listing can contain
 * several «Bewerben»/role links, so neither DOM order nor a slug alone is
 * enough to bind the application to the order.
 */
export function stadtZurichPublicPostingTarget(snapshot = {}, title = '', currentUrl = snapshot?.url || '') {
  const roleTitle = String(title || '').replace(/\b\d{1,3}(?:\s*[-–]\s*\d{1,3})?\s*%/g, ' ').replace(/\s+/g, ' ').trim();
  if (!isStadtZurichPublicJobSearchRoute(currentUrl) || !roleTitle) return '';
  const controls = [
    ...(Array.isArray(snapshot.links) ? snapshot.links : []),
    ...(Array.isArray(snapshot.buttons) ? snapshot.buttons : []),
  ];
  const candidates = new Map();
  for (const control of controls) {
    const href = String(control?.href || '').trim();
    const url = parsedSafeStadtZurichUrl(href, currentUrl);
    if (!url || !isStadtZurichPublicJobDetailRoute(url.href)) continue;
    if (!stadtZurichPostingCandidateText(control).some((text) => isRoleHeading(text, roleTitle))) continue;
    const key = `${url.origin}${url.pathname.replace(/\/+$/, '')}${url.search}`;
    if (!candidates.has(key)) candidates.set(key, url.href);
  }
  return candidates.size === 1 ? [...candidates.values()][0] : '';
}

export function isStadtZurichPublicSearchButton(button = {}) {
  return !button?.chrome && !button?.disabled
    && /^(?:search|suche)\b/iu.test(stadtZurichAccessibleControlName(button));
}

/**
 * Stadt Zürich's Jobs2Web detail shell can stay on the selected posting while
 * its application widget is mounting. Other hosts need an actual form surface
 * or a verified same-requisition apply route before they count as bound.
 */
function isStadtZurichPostingRoute({ pageUrl, postingUrl } = {}) {
  try {
    const page = new URL(String(pageUrl || ''));
    const posting = new URL(String(postingUrl || ''));
    return page.hostname === 'jobs.stadt-zuerich.ch'
      && posting.hostname === page.hostname
      && samePostingAddress(page.href, posting.href);
  } catch {
    return false;
  }
}

export function isPostingRouteBound({ pageUrl, postingUrl, postingRouteProof } = {}) {
  return isStadtZurichPostingRoute({ pageUrl, postingUrl })
    || isVerifiedPostingEntry({ applyUrl: pageUrl, postingUrl, postingRouteProof });
}

export function portalEntryUrl({ applyUrl, postingUrl, postingRouteProof } = {}) {
  const directUrl = String(applyUrl || '');
  try {
    const apply = new URL(directUrl);
    const posting = new URL(String(postingUrl || ''));
    if (isVerifiedPostingEntry({ applyUrl: apply.href, postingUrl: posting.href, postingRouteProof })) return posting.href;
  } catch {
    // Keep the given application URL when either address is absent or invalid.
  }
  if (!String(postingUrl || '').trim()) {
    const inferredPostingUrl = umantisPostingAddressFromApplication(directUrl);
    if (inferredPostingUrl) return inferredPostingUrl;
  }
  return umantisApplicationEntryUrl({ applyUrl: directUrl, postingUrl }) || directUrl;
}

/** A saved Umantis vacancy address, only when it proves the current application route. */
export function verifiedUmantisPostingAddress({ applyUrl, postingUrls = [] } = {}) {
  const candidates = Array.isArray(postingUrls) ? postingUrls : [];
  for (const postingUrl of [...new Set(candidates.map((value) => String(value || '').trim()).filter(Boolean))]) {
    if (isUmantisPostingEntry({ applyUrl, postingUrl })) return postingUrl;
    const entryUrl = portalEntryUrl({ applyUrl, postingUrl });
    if (isUmantisPostingEntry({ applyUrl: entryUrl, postingUrl })) return postingUrl;
  }
  return '';
}

/** Use an Umantis fallback only when its vacancy route is proven against the application URL. */
export function postingAddressForPortal({ applyUrl, postingUrls = [], fallback = '' } = {}) {
  const verified = verifiedUmantisPostingAddress({ applyUrl, postingUrls });
  if (verified) return verified;
  const candidates = [
    ...(Array.isArray(postingUrls) ? postingUrls : []),
    fallback,
  ].map((value) => String(value || '').trim()).filter(Boolean);
  const inferred = umantisPostingAddressFromApplication(applyUrl);
  if (Array.isArray(postingUrls) && inferred && !hasConflictingUmantisVacancyRoute(applyUrl, candidates)) return inferred;
  return isUmantisUrl(applyUrl) ? '' : String(fallback || '');
}

function portalChannelType(ctx = {}) {
  if (ctx.channelType === 'successfactors') return ctx.channelType;
  // A branded SuccessFactors tenant has an employer hostname, so the draft's
  // hostname classifier can call it `employer_site`. The exact same-origin,
  // same-requisition Jobs2Web route proves which ATS rules apply.
  if (isSuccessFactorsPostingEntry(ctx)) return 'successfactors';
  return ctx.channelType || '';
}

/** Launch stock Playwright Chromium; Valerie handles challenges later in her own Chrome extension session. */
export function launchPortalBrowser() {
  return launchChromium({
    headless: !headedBrowser(),
    // Match the deterministic form viewport configured for this portal.
    args: ['--window-size=1366,900'],
  });
}

/** Set form locale and geometry without overriding the browser's identity. */
export function portalContextOptions(ctx = {}) {
  return {
    locale: INTL[ctx.language] || 'de-CH',
    timezoneId: 'Europe/Zurich',
    viewport: { width: 1366, height: 900 },
    acceptDownloads: false,
  };
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
 * Each free-text field carries its value's shape instead (value-shape.mjs:
 * `empty`, `email`, `name`, `mismatch:name`…), and `readback` the runner's
 * own comparison of what it typed with what the page kept (`truncated`).
 */
export function stopReportFrom({ url, reason, step, seen, agent = [], readback = [] }) {
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
    fields: (seen?.fields || []).slice(0, 30).map((field) => {
      const valueShape = stopReportValueShape(field, readback);
      return { label: String(field.label || '').slice(0, 120), kind: field.kind, required: Boolean(field.required), ...(valueShape ? { valueShape } : {}) };
    }),
    errors: (seen?.errors || []).slice(0, 8),
    agent: agent.map((item) => ({ hint: item.hint, status: item.status })),
  };
}

const FREE_TEXT_KINDS = new Set(['text', 'textarea', 'date', 'email', 'tel']);

/**
 * The public shape of one field's value (never the value): the runner's
 * read-back finding for that control when it has one, otherwise the shape of
 * what the page holds, `mismatch:<expected>` when it contradicts the field.
 * Choice, checkbox, file and password controls carry none.
 */
export function stopReportValueShape(field, readback = []) {
  if (!field || field.inputType === 'password' || field.inputType === 'file') return '';
  const finding = (Array.isArray(readback) ? readback : []).find((item) => item && (
    (item.fieldId && item.fieldId === field.id)
    || (!item.fieldId && item.label && item.label === String(field.label || '').slice(0, 120))));
  const fromReadback = publicValueShape(finding?.shape);
  if (fromReadback) return fromReadback;
  if (Array.isArray(field.options) && field.options.length) return '';
  if (field.kind && !FREE_TEXT_KINDS.has(String(field.kind))) return '';
  // An optional field that constrains no shape (a «Note») says nothing a
  // fixer needs: only identity-shaped or required fields carry one.
  const expected = expectedValueShape(field);
  if (!expected && !field.required) return '';
  return publicValueShape(reportedValueShape({ expected, value: field.value }));
}

/**
 * The runner's comparison of a typed value with what the control kept, for
 * the encrypted diagnostics and the public stop report: label, expected
 * shape, `truncated` (the control kept a prefix within its maxLength) or
 * `changed` (it kept something else), the control's maxLength. Never a value.
 */
export function registrationReadbackFindings(actions = [], fields = []) {
  const findings = [];
  for (const action of actions) {
    if (action?.action !== 'fill') continue;
    const field = fields.find((item) => item.id === action.fieldId);
    if (!field || field.inputType === 'password' || field.inputType === 'file') continue;
    const shape = readbackShape({ planned: action.value, read: field.value, maxLength: field.maxLength });
    if (!['truncated', 'mismatch'].includes(shape)) continue;
    findings.push({
      fieldId: field.id,
      label: String(field.label || '').slice(0, 120),
      expected: expectedValueShape(field),
      shape: shape === 'mismatch' ? 'changed' : shape,
      ...(Number.isSafeInteger(Number(field.maxLength)) && Number(field.maxLength) > 0 ? { maxLength: Number(field.maxLength) } : {}),
    });
  }
  return findings;
}

/** Headful mode is opt-in; the assisted-application workflow enables it on Xvfb. */
export const headedBrowser = () => process.env.ASSISTED_APPLICATION_HEADED === '1';

/** A label that is a generated name, not a question ("select-input-_r_p_", "file:_r_3_:input"). */
export function machineLabel(label) {
  // Required markers are presentation, not part of an ATS-generated control
  // name (for example `textarea_123 *`). Strip them before classifying the
  // label so a live description can still replace the machine label.
  const text = String(label || '').trim().replace(/\s*\*+\s*$/, '').trim();
  return !text || (/^[\w:.-]+$/.test(text) && /[_:\d]/.test(text));
}

export { portalQuestionId, portalQuestionKey, slugId };

/**
 * What the planner may use, with the alias as the e-mail (candidateIdentity).
 * `language`: the form's, for the candidate's Swiss status as a full sentence.
 */
export function candidateForForm({ identity, profile = {}, answers = {}, draft = {}, portalQuestions = [], extraDocuments = [], language = 'it', personal = {}, job = {}, currentAnswerIds = [], answerSources = {}, platformFacts = null, suppressedQuestionIds = [], suppressedAnswerContracts = [] }) {
  // The split the candidate chose on the review page, else the surname with its particles (splitName).
  const names = typeof identity.firstName === 'string' ? identity : splitName(identity.name);
  const latest = (profile.experience || [])[0] || {};
  const motivation = Object.fromEntries((draft.formAnswers || []).map((field) => [field.key, field.value]));
  // The status the candidate chose, else the cross-border permit the platform deduced from the CV (owner decision
  // 2026-11-10, platformCandidateFacts `permitStatusSource: 'deduced'`): never over an answer of theirs.
  const status = permitStatusOf(profile.permitStatus) || permitStatusOf(answers.work_permit)
    || (platformFacts?.permitStatusSource === 'deduced' && !String(answers.work_permit ?? '').trim() ? permitStatusOf(platformFacts.permitStatus) : '');
  const suppressedQuestionIdSet = new Set(Array.isArray(suppressedQuestionIds) ? suppressedQuestionIds : []);
  const suppressedAnswersById = new Map((Array.isArray(suppressedAnswerContracts) ? suppressedAnswerContracts : [])
    .filter(contract => typeof contract?.id === 'string').map(contract => [contract.id, contract]));
  const portalQuestionsAnswered = portalAnswersForQuestions(portalQuestions, answers, draft.portalAnswers?.answers, currentAnswerIds, answerSources, suppressedQuestionIdSet);
  const suppressedQuestionContracts = portalQuestions.filter(question => suppressedQuestionIdSet.has(question?.id)).map(question => ({
    id: String(question.id),
    labels: [...new Set([question.applicationQuestion, question.portalQuestion, question.question]
      .filter(value => typeof value === 'string' && value.trim()).map(value => value.trim().slice(0, 520)))],
    topic: questionTopic(question.applicationQuestion || question.question, question.context || '', question),
    status: suppressedAnswersById.get(question.id)?.status || 'unknown',
    ...(suppressedAnswersById.get(question.id)?.status === 'answered'
      && Object.hasOwn(suppressedAnswersById.get(question.id), 'answer')
      ? { answer: suppressedAnswersById.get(question.id).answer } : {}),
    allowLiveMapping: suppressedAnswersById.get(question.id)?.allowLiveMapping === true,
  }));
  // Older drafts may predate the profile enrichment done during draft mode;
  // resolve once more at the browser boundary without an external geocoder.
  const resolved = resolveResidenceAddress(profile.address, profile.location);
  // Owner decision 2026-11-09 (functions/src/assistedApplicationPlatformDefaults.js): what the CV does not
  // say, a form receives from the platform: the town's postal code and country, and a street when a form
  // requires one. Form-only: the letter and the CV are written from `profile`, never from this object.
  // With the form's language: the posting's, for the correspondence-language rule (assistedApplicationPlatformDefaults.js).
  const facts = platformFacts && typeof platformFacts === 'object'
    ? { ...platformFacts, applicationLanguage: String(language || '').slice(0, 2).toLowerCase() } : null;
  const factAddress = facts?.address?.city ? facts.address : null;
  const address = factAddress ? {
    ...resolved,
    street: resolved.street || factAddress.street,
    postalCode: resolved.postalCode || factAddress.postalCode,
    city: resolved.city || factAddress.city,
    country: resolved.country || factAddress.countryName,
  } : {
    ...resolved,
    // No town: the country the platform still knows (the CV's or the order's, else the upload answers).
    country: resolved.country || facts?.address?.countryName || '',
  };
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
      dateOfBirth: isoDateOf(profile.dateOfBirth) || profile.dateOfBirth || facts?.dateOfBirth || '',
      // The candidate's own, else the one the CV text declares or the platform deduced from the CV (owner
      // decisions 2026-11-11, platformCandidateFacts `nationalitySource: 'cv'` or 'deduced'): a nationality field
      // of the form takes it.
      nationality: profile.nationality || (['cv', 'deduced'].includes(facts?.nationalitySource) ? facts.nationality || '' : ''),
      // What the CV says in its own words, or the candidate corrected (candidateWithEdits `personal`): a
      // portal that asks the civil status is answered from it, not by a question to the candidate. The form
      // of address the CV states is in `answers.salutation` already.
      civilStatus: personal?.civilStatus || facts?.civilStatusLabel || '',
    },
    platformFacts: facts,
    suppressedQuestionContracts,
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
const addressMetadata = (field) => Object.hasOwn(field || {}, 'addressContext') ? { addressContext: addressContextContract(field) } : {};
// When a radio group has no accessible group caption, the field extractor
// falls back to the first option as its label. That option can contain a
// place name (for example, an employer's city) without making the control a
// candidate-address field. Do not turn this structural fallback into an
// unreadable-owner handoff; the planner still keeps the unknown choice as a
// candidate question when no answer is present.
const radioCaptionIsOption = (field) => {
  if (field?.kind !== 'radio' || !Array.isArray(field.options)) return false;
  const normalize = (value) => String(value || '').normalize('NFKC').replace(/\s+/g, ' ').trim();
  const caption = normalize(field.label || field.applicationQuestion || field.question);
  return Boolean(caption && field.options.some((option) => normalize(typeof option === 'string' ? option : option?.label) === caption));
};
const unreadableNativeOwner = field => (field?.kind === 'checkbox' && field?.consentOwnershipUnknown === true)
  || (addressAnswerNeedsOwnership(field?.label || field?.applicationQuestion || field?.question, field)
    && !radioCaptionIsOption(field)
    && Object.hasOwn(field || {}, 'addressContext') && !hasAddressContextOwnership(field));

// An account-creation form is the candidate's own profile surface. Some ATSes
// expose an explicit residence caption (for example «Land/Region des
// Wohnorts») without a semantic personal-information container, so the native
// reader quite correctly reports an empty owner contract. Bind only those
// positive residence-role captions here; a generic «City» or an ambiguous
// address remains a technical handoff.
export const accountRegistrationField = (field) => {
  const context = addressContextContract(field);
  if (!context || context.unknown || hasAddressContextOwnership(field) || !residenceFieldRole(field?.label) || !explicitResidence(field?.label)) return field;
  return {
    ...field,
    addressContext: { section: 'Personal information', owners: ['Personal information'], unknown: false },
  };
};

const accountRegistrationSnapshot = (snapshot) => ({
  ...snapshot,
  fields: (snapshot?.fields || []).map(accountRegistrationField),
});

function portalAnswersForQuestions(questions, answers, previousAnswers = [], currentAnswerIds = [], answerSources = {}, suppressedQuestionIds = new Set()) {
  const attestedIds = new Set(currentAnswerIds);
  const items = questions.filter(question => !suppressedQuestionIds.has(question?.id)).map((question) => {
    const raw = String(answers[question.id] ?? '').trim();
    const projected = operationalAnswerForOption(question, raw) || raw;
    const mapped = portalAnswerForApplication(question, projected);
    // Preserve an explicit operational statement even when today's catalogue
    // cannot express it. Its presence vetoes a policy fallback; it is not a
    // claim that the native control accepts the value.
    const answer = mapped || (operationalQuestionTopic(question) ? raw : '');
    return {
      answerId: answer !== raw ? question.id : undefined,
      question: question.applicationQuestion || question.question,
      ...(question.applicationQuestion ? { applicationQuestion: question.applicationQuestion } : {}),
      ...(question.applicationQuestion ? { candidateQuestion: question.question } : {}),
      context: question.context || '',
      section: question.section || '',
      autocomplete: question.autocomplete || '',
      ...addressMetadata(question),
      answer,
      source: Object.hasOwn(answerSources, question.id) ? answerSources[question.id] : 'answers',
      current: true,
      attested: attestedIds.has(question.id) && (!Object.hasOwn(answerSources, question.id) || answerSources[question.id] === 'answers'),
    };
  }).filter((item) => String(item.answer ?? '').trim());
  const keyFor = (item) => portalQuestionKey(item) || portalQuestionId(item);
  const currentKeys = new Set(questions
    // An empty value under a regenerated field id is not an answer; keep the
    // previous semantic answer eligible for that same question.
    .filter((question) => question?.id && (suppressedQuestionIds.has(question.id) || String(answers[question.id] ?? '').trim()
      || (addressAnswerNeedsOwnership(question.applicationQuestion || question.question, question) && Object.hasOwn(answers, question.id))))
    .map((question) => keyFor({ applicationQuestion: question.applicationQuestion, question: question.question, context: question.context || '', section: question.section || '', autocomplete: question.autocomplete || '', ...addressMetadata(question) })));
  const priorGroups = new Map();
  for (const item of Array.isArray(previousAnswers) ? previousAnswers : []) {
    const question = String(item?.question || '').trim();
    const answer = String(item?.answer ?? '').trim();
    if (!question || !answer) continue;
    const prior = { answerId: String(item?.answerId || '').trim() || undefined, question, context: String(item?.context || ''), section: String(item?.section || ''), autocomplete: String(item?.autocomplete || ''), ...addressMetadata(item), answer, source: String(item?.source || 'answers') };
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
  return [...seen.values()].map(({ answerId, question, applicationQuestion, candidateQuestion, answer, context, section, autocomplete, source, current, attested, ...metadata }) => ({
    ...(attested === true && Object.hasOwn(metadata, 'addressContext') && addressAnswerNeedsOwnership(question, { ...metadata, autocomplete }) ? { current: true } : {}), ...addressMetadata(metadata), ...(answerId ? { answerId } : {}), question, ...(applicationQuestion ? { applicationQuestion } : {}), ...(candidateQuestion ? { candidateQuestion } : {}), answer, source, ...(context ? { context: context.slice(0, 240) } : {}), ...(section ? { section: section.slice(0, 240) } : {}), ...(autocomplete ? { autocomplete: autocomplete.slice(0, 100) } : {}),
  }));
}

/** Resolve required portal questions from the candidate data before the submit gate. */
export function autoAnswersForPortalQuestions({ questions = [], candidate, answers = {}, sources = null, suppressedQuestionIds = [] } = {}) {
  const out = {};
  const suppressed = new Set(Array.isArray(suppressedQuestionIds) ? suppressedQuestionIds : []);
  for (const question of questions) {
    if (question?.source !== 'portal' || !question.required || suppressed.has(question.id) || String(answers?.[question.id] ?? '').trim()) continue;
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
      ...addressMetadata(question),
      required: true,
      options,
    };
    const answer = candidateAnswerForField(candidate, field)
      || (() => {
        const no = targetEmployerNoOption(field, candidate);
        return no ? { value: no.label, source: 'rule' } : null;
      })();
    // Policy defaults belong to live form filling, never to confirmed CV facts.
    if (answer?.value && answer.source !== 'policy_default') {
      out[question.id] = answer.value;
      if (sources) sources[question.id] = answer.source;
    }
  }
  return out;
}

/** How an upload reads in the evidence: [CV], [lettera di presentazione], [documento: Bulletins scolaires]. */
function uploadLabel(document, candidate) {
  if (document === 'cover_letter') return '[lettera di presentazione]';
  const extra = (candidate?.documents?.extra || []).find((item) => item.slot === document);
  return extra ? `[documento: ${extra.label}]` : '[CV]';
}

const GALLERY_PREVIOUS_RE = /^(?:previous|prev(?:ious)?|vorherig(?:e|er|es|en)|pr[ée]c[ée]dent(?:e)?|precedent[ei]?|indietro)\b/i;
const GALLERY_NEXT_RE = /^(?:next|nächst(?:e|er|es|en)?|suivant(?:e)?|successiv[oa]?)\b/i;
const GALLERY_VIEW_RE = /(?:grossansicht|full[-\s]?size|large view|schermo intero|en grand)/i;
const GALLERY_PRINT_RE = /(?:seite drucken|print page|stampa pagina|imprimer la page)/i;
const GENERIC_ATTACHMENT_RE = /(?:eine oder mehrere dateien auswählen|select (?:one or more )?files?|choose (?:one or more )?files?|file upload|attachment|anhang|allegato|pi[èe]ce jointe)/iu;
const APPLICATION_CONTROL_RE = /(?:application|bewerb(?:ung)?|candidat(?:ure|ura)?|postul|resume|r[ée]sum[ée]|lebenslauf|\bcv\b|curriculum(?:\s+vitae)?|anschreiben|cover\s+letter|work\s+permit|salary|starting\s+date|notice\s+period|workload|motivation)/iu;
const PUBLIC_JOB_KEYWORD_RE = /(?:keyword|suchbegriff|stichw[öo]rter|search\s+(?:for\s+)?jobs?|suche\s+nach)/iu;
const PUBLIC_JOB_FILTER_PATTERNS = [
  ['category', /(?:tätigkeitsbereich|job\s+categor(?:y|ies)|job\s+type|category|bereich)/iu],
  ['employment', /(?:anstellung|employment(?:\s+type)?|contract\s+type|beschäftigungsart)/iu],
  ['department', /(?:dienstabteilung|department|organizational\s+unit|organisationseinheit)/iu],
  ['workload', /(?:pensum|workload|beschäftigungsumfang|arbeitspensum)/iu],
];
const PUBLIC_JOB_ACTION_RE = /^(?:search|suche|reset|zurücksetzen|mehr\s+anzeigen|show\s+more|load\s+more|seite\s+drucken|print\s+page)\b/iu;
const APPLICATION_IDENTITY_FIELD_RE = /(?:e-?mail|vorname|nachname|first\s+name|last\s+name|telefon|phone|adresse|address|geburts|birth|nationality|staatsangehörigkeit|bewilligung|permit|lebenslauf|resume|\bcv\b|anschreiben|cover\s+letter|motivation)/iu;
const PUBLIC_JOB_RESULTS_BACK_RE = /^(?:tornare ai risultati(?: della ricerca)?|back to search results|zurück zu den suchergebnissen|retour aux résultats de recherche)\b/iu;
const PUBLIC_JOB_DETAIL_INFO_RE = /^(?:informazioni sul posto|job information|stelleninformationen|informations sur le poste)\b/iu;
const PUBLIC_JOB_DETAIL_TOOL_RE = /^(?:copiare il link|copy link|link kopieren|copier le lien|invia link|send link|link senden|stampare(?: la pagina)?|print(?: page)?|drucken|imprimer(?: la page)?)\b/iu;
const JOB_ROOM_HOSTS = new Set(['job-room.ch', 'www.job-room.ch']);
const JOB_ROOM_PUBLIC_DETAIL_PATH_RE = /^\/job-search\/[^/]+\/?$/iu;
const JOB_ROOM_EXTERNAL_APPLICATION_RE = /^(?:andare all['’]annuncio esterno|go to (?:the )?external (?:job )?(?:posting|listing|offer)|zum externen (?:stellen|job)angebot|zur externen (?:stellenausschreibung|stellenanzeige|jobanzeige|jobangebot)|aller à l['’](?:offre|annonce) externe|accéder à l['’](?:offre|annonce) externe)\b/iu;
const PUBLIC_JOB_ALERT_ACTION_RE = /^(?:create(?:\s+(?:an|a))?(?:\s+job)?\s+alert|créer\s+une\s+alerte|benachrichtigung\s+erstellen|crea(?:re)?\s+un\s+avviso)\b/iu;
const PUBLIC_JOB_ALERT_FIELD_RE = new RegExp([
  String.raw`\b(?:frequency|how\s+often|fréquence|frequenz|frequenza|day(?:s)?|jour(?:s)?|tag(?:e|en)?|giorn(?:o|i))\b.{0,160}\b(?:alert(?:s)?|alerte(?:s)?|notification(?:s)?|benachrichtigung(?:en)?|avvis(?:o|i))\b`,
  String.raw`\b(?:alert(?:s)?|alerte(?:s)?|notification(?:s)?|benachrichtigung(?:en)?|avvis(?:o|i))\b.{0,160}\b(?:frequency|how\s+often|fréquence|frequenz|frequenza|day(?:s)?|jour(?:s)?|tag(?:e|en)?|giorn(?:o|i))\b`,
].join('|'), 'iu');

const isGalleryPagingButton = (button, pattern) => !button?.chrome && pattern.test(String(button.text || ''));
const isGalleryNavigationButton = (button) => isGalleryPagingButton(button, GALLERY_PREVIOUS_RE)
  || isGalleryPagingButton(button, GALLERY_NEXT_RE);
const isGalleryToolButton = (button) => !button?.chrome
  && (GALLERY_VIEW_RE.test(String(button.text || '')) || GALLERY_PRINT_RE.test(String(button.text || '')));
const portalControlScope = (control) => `${control?.frame || 0}\u0000${String(control?.formId || '')}`;
const portalControlIdentity = (control) => {
  const controlId = String(control?.id || control?.domId || '').trim();
  // Real snapshots carry the generated data-aa-id. Minimal contract fixtures
  // may omit it; retaining the record itself keeps those exact objects
  // distinguishable without inventing an array-position fallback.
  return controlId ? `${portalControlScope(control)}\u0000${controlId}` : control;
};
const isGenericOptionalAttachment = (field) => isFileField(field)
  && field.required !== true
  && GENERIC_ATTACHMENT_RE.test([field.label, field.name, field.id, field.context].filter(Boolean).join(' '));

// A page heading or an ancestor's descriptive context is not ownership proof:
// Stadt Zürich's public «Bewerbungstipps» gallery puts that word into the
// section/context of every pager button. Keep those broad fields out of the
// gallery-vs-application decision; the control's own identity and label are
// the evidence that can safely distinguish a mixed surface.
const controlOwnershipText = (button) => [
  button?.text,
  button?.id,
  button?.domId,
  button?.name,
  button?.label,
  button?.title,
  button?.ariaLabel,
  button?.dataAutomationId,
  button?.href,
].filter(Boolean).join(' ');
const isApplicationControl = (button) => APPLICATION_CONTROL_RE.test(controlOwnershipText(button));
const galleryToolScopes = (buttons) => new Set(buttons.filter(isGalleryToolButton).map(portalControlScope));

function isPublicJobAlertField(field) {
  const inputType = String(field?.inputType || '').toLowerCase();
  if (field?.chrome || (inputType && !['number', 'text'].includes(inputType)) || field?.kind !== 'text') return false;
  const text = [field?.label, field?.ariaLabel, field?.description]
    .filter(Boolean).join(' ').normalize('NFKC').replace(/\s+/gu, ' ').trim();
  return Boolean(text && PUBLIC_JOB_ALERT_FIELD_RE.test(text));
}

function publicJobDetailFieldsAreOnlyAlert(snapshot = {}) {
  if (!Array.isArray(snapshot.fields)) return false;
  const fields = snapshot.fields;
  if (!fields.length) return true;
  const controls = [
    ...(Array.isArray(snapshot.buttons) ? snapshot.buttons : []),
    ...(Array.isArray(snapshot.links) ? snapshot.links : []),
  ];
  const hasAlertAction = controls.some((control) => !control?.disabled && PUBLIC_JOB_ALERT_ACTION_RE.test([
    control?.text, control?.label, control?.ariaLabel, control?.title,
  ].filter(Boolean).join(' ').replace(/\s+/gu, ' ').trim()));
  return hasAlertAction && fields.every(isPublicJobAlertField);
}

function galleryNavigationButtons(buttons) {
  const galleryTools = galleryToolScopes(buttons);
  return new Set(buttons.filter((button) => isGalleryNavigationButton(button)
    && !isApplicationControl(button)
    && galleryTools.has(portalControlScope(button))).map(portalControlIdentity));
}

/**
 * Stadt Zürich's public content pages expose a gallery with «Vorheriges» /
 * «Nächstes», full-size-image and print controls. A generic optional upload
 * field is also present, so labels alone make the gallery look like a wizard.
 * Keep a real application step when its control is distinct from the
 * gallery-owned records or its fields carry application vocabulary; otherwise
 * fail closed before clicking it.
 */
function isNonApplicationGallerySurface(snapshot = {}) {
  const buttons = Array.isArray(snapshot.buttons) ? snapshot.buttons : [];
  const fields = Array.isArray(snapshot.fields) ? snapshot.fields : [];
  const galleryTools = galleryToolScopes(buttons);
  const galleryButtons = galleryNavigationButtons(buttons);
  const hasPaging = galleryButtons.size > 0;
  const hasGalleryTools = buttons.some((button) => !button?.chrome && GALLERY_VIEW_RE.test(String(button.text || '')))
    && buttons.some((button) => !button?.chrome && GALLERY_PRINT_RE.test(String(button.text || '')));
  if (!hasPaging || !hasGalleryTools) return false;

  const fieldText = fields.map((field) => [field.label, field.name, field.id, field.context, field.section].filter(Boolean).join(' ')).join(' ');
  const hasApplicationField = APPLICATION_CONTROL_RE.test(fieldText)
    || fields.some((field) => isCvFileField(field) || COVER_LETTER_DOCUMENT_CONTEXT_RE.test(String(field.label || '')));
  const hasApplicationControl = buttons.some((button) => {
    // A public gallery may wrap its pager and generic optional attachment in
    // one HTML form. The shared form id is not application ownership when the
    // control itself is the gallery's «Vorheriges»/«Nächstes» navigation.
    if (button?.chrome || button?.disabled || galleryButtons.has(portalControlIdentity(button))) return false;
    if (galleryTools.has(portalControlScope(button)) && !isApplicationControl(button)) return false;
    const text = String(button.text || '');
    if (!(NEXT_RE.test(text) || SUBMIT_RE.test(text))) return false;
    return true;
  }) || buttons.some((button) => !button?.chrome
    && (NEXT_RE.test(String(button.text || '')) || SUBMIT_RE.test(String(button.text || '')))
    && isApplicationControl(button));
  if (hasApplicationField || hasApplicationControl) return false;
  return fields.length === 0 || fields.every(isGenericOptionalAttachment);
}

/**
 * Public job indexes are forms too, but their controls search and filter
 * vacancies rather than answer an application. Stadt Zürich's branded
 * SuccessFactors page exposes both a native select and a combobox for each
 * filter, plus «Suche», «Zurücksetzen», «Mehr anzeigen» and «Seite drucken».
 * Require the whole search-shaped fingerprint and no candidate/application
 * evidence so a real application question about a department or workload is
 * never discarded on a single label.
 */
function isNonApplicationJobSearchSurface(snapshot = {}, { applicationEvidence = false } = {}) {
  const buttons = Array.isArray(snapshot.buttons) ? snapshot.buttons : [];
  const fields = Array.isArray(snapshot.fields) ? snapshot.fields : [];
  const fieldText = field => [field?.label, field?.name, field?.id, field?.context, field?.section]
    .filter(Boolean).join(' ');
  const keywordField = fields.some(field => PUBLIC_JOB_KEYWORD_RE.test(fieldText(field)));
  const filterKinds = new Set();
  for (const field of fields) {
    const text = fieldText(field);
    for (const [kind, pattern] of PUBLIC_JOB_FILTER_PATTERNS) {
      if (pattern.test(text)) filterKinds.add(kind);
    }
  }
  const publicActions = buttons
    .filter(button => !button?.chrome && !button?.disabled)
    .map(stadtZurichAccessibleControlName)
    .filter(text => PUBLIC_JOB_ACTION_RE.test(text));
  const hasSearchControls = publicActions.some(text => /^(?:search|suche|reset|zurücksetzen)\b/iu.test(text));
  const hasResultsControls = publicActions.some(text => /^(?:mehr\s+anzeigen|show\s+more|load\s+more|seite\s+drucken|print\s+page)\b/iu.test(text));
  const hasCandidateField = fields.some(field => field.kind === 'file'
    || ['email', 'password'].includes(String(field.inputType || '').toLowerCase())
    || APPLICATION_IDENTITY_FIELD_RE.test(fieldText(field)));
  const hasApplicationButton = buttons.some(button => !button?.chrome && !button?.disabled
    && (NEXT_RE.test(stadtZurichAccessibleControlName(button)) || SUBMIT_RE.test(stadtZurichAccessibleControlName(button))));
  return keywordField && filterKinds.size >= 2 && hasSearchControls && hasResultsControls
    && !hasCandidateField && !hasApplicationButton && !applicationEvidence;
}

/**
 * Job-Room exposes a public posting shell with back-to-results, job-info,
 * share and print controls but no fields. Those controls are navigation and
 * sharing for the posting, not an application surface; keep the fingerprint
 * narrow so a field-less application widget still reaches the agent.
 */
function isNonApplicationJobDetailSurface(snapshot = {}, { applicationEvidence = false } = {}) {
  const buttons = Array.isArray(snapshot.buttons) ? snapshot.buttons : [];
  const fields = Array.isArray(snapshot.fields) ? snapshot.fields : [];
  if (fields.length || applicationEvidence) return false;

  const publicButtons = buttons
    .filter(button => !button?.chrome && !button?.disabled)
    .map(button => String(button.text || '').replace(/\s+/g, ' ').trim());
  const hasBackToResults = publicButtons.some(text => PUBLIC_JOB_RESULTS_BACK_RE.test(text));
  const hasJobInfo = publicButtons.some(text => PUBLIC_JOB_DETAIL_INFO_RE.test(text));
  const hasDetailTool = publicButtons.some(text => PUBLIC_JOB_DETAIL_TOOL_RE.test(text));
  // Disabled application controls still identify an application surface.
  const hasApplicationButton = buttons.some(button => !button?.chrome
    && (NEXT_RE.test(String(button.text || '')) || SUBMIT_RE.test(String(button.text || ''))));
  return hasBackToResults && hasJobInfo && hasDetailTool && !hasApplicationButton;
}

function isNonApplicationSurface(snapshot = {}, options = {}) {
  return isNonApplicationGallerySurface(snapshot)
    || isNonApplicationJobDetailSurface(snapshot, options)
    || isNonApplicationJobSearchSurface(snapshot, options);
}

function jobRoomControlText(control) {
  return [control?.text, control?.label, control?.ariaLabel, control?.title]
    .map((value) => String(value || '').replace(/\s+/gu, ' ').trim())
    .find(Boolean) || '';
}

function isJobRoomExternalApplicationLabel(control) {
  return JOB_ROOM_EXTERNAL_APPLICATION_RE.test(jobRoomControlText(control));
}

function isJobRoomPublicPostingRoute(value) {
  try {
    const url = new URL(String(value || ''));
    return url.protocol === 'https:' && !url.username && !url.password && !url.hash
      && JOB_ROOM_HOSTS.has(url.hostname.toLowerCase())
      && JOB_ROOM_PUBLIC_DETAIL_PATH_RE.test(url.pathname);
  } catch {
    return false;
  }
}

// Job-Room's public detail route calls the official employer handoff «external
// posting», not «Apply». Keep that vocabulary out of the shared Apply matcher:
// only this exact host, route fingerprint and one external HTTPS target may use it.
function isJobRoomExternalApplicationEntry(control, snapshot = {}, context = {}) {
  if (context?.allowSingleExternalApplicationEntry !== true || control?.disabled || control?.chrome
    || control?.ariaHidden === true || control?.behindDialog === true
    || !isJobRoomExternalApplicationLabel(control)) return false;
  const pageUrl = String(snapshot?.url || '');
  if (!isJobRoomPublicPostingRoute(pageUrl)
    || !samePostingAddress(pageUrl, context.postingUrl)
    || !samePostingAddress(pageUrl, context.applyUrl)
    || !isNonApplicationJobDetailSurface(snapshot)) return false;
  if (!control?.href) return true;
  try {
    const target = new URL(String(control.href), pageUrl);
    return target.protocol === 'https:' && !target.username && !target.password && !target.hash
      && !JOB_ROOM_HOSTS.has(target.hostname.toLowerCase())
      && !samePostingAddress(target.href, pageUrl);
  } catch {
    return false;
  }
}

function jobRoomExternalApplicationEntryProven(snapshot = {}, context = {}) {
  const controls = [
    ...(Array.isArray(snapshot.buttons) ? snapshot.buttons : []),
    ...(Array.isArray(snapshot.links) ? snapshot.links : []),
  ].filter((control) => control?.ariaHidden !== true && control?.behindDialog !== true);
  const entries = controls.filter((control) => isJobRoomExternalApplicationEntry(control, snapshot, context));
  const competingApplicationControl = controls.some((control) => !isJobRoomExternalApplicationLabel(control)
    && !control?.disabled && !control?.chrome && startsApplication(control?.text || control?.label));
  return entries.length === 1 && !competingApplicationControl;
}

function learnedApplicationControls(buttons, known, path) {
  return {
    next: learnedButton(buttons, labelsAt(known?.nextButtons || [], path)),
    submit: learnedButton(buttons, labelsAt(known?.finalButtons || [], path)),
  };
}

function hasApplicationForm(snapshot) {
  if (isNonApplicationSurface(snapshot)) return false;
  const fields = Array.isArray(snapshot?.fields) ? snapshot.fields : [];
  const kinds = fields.map((field) => field.kind);
  const textish = fields.filter((field) => field.kind === 'text' || field.kind === 'textarea').length;
  const email = fields.some((field) => field.inputType === 'email' || /e-?mail/i.test(field.label));
  return kinds.includes('file') || (textish >= 3 && email);
}

function hasApplicationFormInCookieScope(snapshot, button) {
  const fields = Array.isArray(snapshot?.fields) ? snapshot.fields : [];
  const frame = Number(button?.frame) || 0;
  const formId = String(button?.formId || '');
  const roleFormId = String(button?.roleFormId || '');
  const dialogId = String(button?.dialogId || '');
  const scopedFields = fields.filter((field) => {
    if ((Number(field?.frame) || 0) !== frame) return false;
    const sameForm = (formId && String(field?.formId || '') === formId)
      || (roleFormId && String(field?.roleFormId || '') === roleFormId);
    const sameDialog = dialogId && String(field?.dialogId || '') === dialogId;
    return sameForm || sameDialog;
  });
  return scopedFields.length > 0 && hasApplicationForm({ ...snapshot, fields: scopedFields });
}

function comparablePortalRoute(value, base = '') {
  try {
    const url = new URL(String(value || ''), base || undefined);
    return {
      origin: url.origin,
      pathname: url.pathname.replace(/\/+$/, '') || '/',
      search: url.search,
    };
  } catch {
    return null;
  }
}

function samePortalRoute(one, other, base = '') {
  const left = comparablePortalRoute(one, base);
  const right = comparablePortalRoute(other, base);
  return Boolean(left && right && left.origin === right.origin
    && left.pathname === right.pathname && left.search === right.search);
}

const POSTING_ID_FIELDS = [
  'postingId', 'postingKey', 'jobId', 'jobKey', 'requisitionId', 'requisitionKey', 'careerJobReqId',
  'dataPostingId', 'dataJobId', 'dataRequisitionId', 'dataCareerJobReqId',
];
const POSTING_ID_MARKER_RE = /(?:^|[\s([{"'·|,;:/?&#])(?:career[_ -]?job[_ -]?req(?:uisition)?|job|posting|requisition|req)[\s_-]*(?:id|key)\s*(?:[:=#]|is)?\s*([a-z0-9][a-z0-9_-]{0,99})(?=$|[\s)\]}"'·|,;/?&#])/giu;

function normalizedPostingIdentity(value) {
  const marker = String(value ?? '').normalize('NFKC').trim();
  return /^[a-z0-9_-]{1,100}$/i.test(marker) ? marker.toLowerCase() : '';
}

function uniquePostingIdentity(values) {
  const markers = [...new Set(values.map(normalizedPostingIdentity).filter(Boolean))];
  return markers.length === 1 ? markers[0] : '';
}

function postingIdentityMarkers(value) {
  const text = String(value || '');
  const markers = [];
  for (const url of text.match(/https?:\/\/[^\s<>"')]+/giu) || []) {
    const key = portalJobKey(url);
    if (key) markers.push(key);
  }
  for (const match of text.matchAll(POSTING_ID_MARKER_RE)) markers.push(match[1]);
  return markers;
}

function expectedPostingIdentity({ applyUrl = '', postingUrl = '', sourceProtocol = null, job = {} } = {}) {
  return uniquePostingIdentity([
    portalJobKey(postingUrl, sourceProtocol),
    portalJobKey(applyUrl, sourceProtocol),
    ...POSTING_ID_FIELDS.map((field) => job?.[field]),
  ]);
}

function controlPostingIdentity(control) {
  const direct = POSTING_ID_FIELDS.flatMap((field) => {
    const value = control?.[field];
    const explicit = normalizedPostingIdentity(value);
    return explicit ? [explicit] : postingIdentityMarkers(value);
  });
  const context = [control?.vacancyContext, control?.section, control?.context].flatMap(postingIdentityMarkers);
  const markers = [...new Set([...direct, ...context].map(normalizedPostingIdentity).filter(Boolean))];
  return markers.length > 1 ? null : markers[0] || '';
}

function applicationEntryBelongsToPosting(control, {
  applyUrl = '',
  postingUrl = '',
  postingRouteProof = null,
  sourceProtocol = null,
  job = {},
} = {}) {
  const href = String(control?.href || '').trim();
  if (href && samePortalRoute(href, applyUrl, applyUrl)) return true;
  if (href && samePortalRoute(href, postingUrl, postingUrl)) return true;
  if (href && isVerifiedPostingEntry({ applyUrl: href, postingUrl, postingRouteProof })) return true;
  if (href && isVerifiedPostingEntry({ applyUrl: href, postingUrl: applyUrl })) return true;

  // A posting can use a button with no URL (Yellowshark). Its nearest heading
  // or explicit section must contain the selected role and a unique posting
  // identity; a title alone can be shared by distinct neighbouring cards.
  const localContext = [control?.section, control?.context].filter(Boolean).join(' ');
  const expectedIdentity = expectedPostingIdentity({ applyUrl, postingUrl, sourceProtocol, job });
  return Boolean(expectedIdentity && controlPostingIdentity(control) === expectedIdentity
    && localContext && job?.title
    && postingMatch(localContext, { title: job.title }, postingUrl) === 'match');
}

const MAX_APPLICATION_ENTRY_CONTEXT_LENGTH = 700;

function applicationEntryContextText(control) {
  const rawContext = String(control?.vacancyContext || '');
  if (rawContext.length > MAX_APPLICATION_ENTRY_CONTEXT_LENGTH) return '';
  let text = rawContext.normalize('NFKC').replace(/\s+/g, ' ').trim();
  if (text.length > MAX_APPLICATION_ENTRY_CONTEXT_LENGTH) return '';
  const ownLabels = [control?.text, control?.label, control?.ariaLabel, control?.title]
    .map((value) => String(value || ''))
    .filter((value) => value.length <= MAX_APPLICATION_ENTRY_CONTEXT_LENGTH)
    .map((value) => value.normalize('NFKC').replace(/\s+/g, ' ').trim())
    .filter((value) => value && value.length <= MAX_APPLICATION_ENTRY_CONTEXT_LENGTH)
    .sort((left, right) => right.length - left.length);
  for (const label of ownLabels) {
    const pattern = new RegExp(`(^|[^\\p{L}\\p{N}])(${escapeRegex(label)})(?=$|[^\\p{L}\\p{N}])`, 'giu');
    let match;
    let lastMatch;
    while ((match = pattern.exec(text))) lastMatch = match;
    if (lastMatch) text = `${text.slice(0, lastMatch.index)}${lastMatch[1]}${text.slice(lastMatch.index + lastMatch[0].length)}`;
  }
  return text.replace(/\s+/g, ' ').trim();
}

function applicationEntryContextMatchesPosting(control, context = {}) {
  const localContext = applicationEntryContextText(control);
  const job = context.job || {};
  return Boolean(localContext && job.title
    && titleMatches(localContext, job.title)
    && postingMatch(localContext, job, context.postingUrl) === 'match'
    && !namesAnotherEmployer(localContext, job, { allowPostingLocation: true }));
}

function fieldlessApplicationEntryContextMatchesPosting(control, context = {}) {
  const localContext = [control?.vacancyContext, control?.section, control?.context]
    .filter(Boolean)
    .join(' ')
    .trim();
  const job = context.job || {};
  if (controlPostingIdentity(control) !== '') return false;
  if (!localContext || !job.title) return true;
  if (postingMatch(localContext, job, context.postingUrl) !== 'match') return false;
  if (namesAnotherEmployer(localContext, job)) return false;
  return titleMatches(localContext, job.title);
}

// An Apply dropdown on the verified posting route sits under the vacancy's
// own heading, which names the role but rarely the employer (Helsana's
// Career Site Builder page). The page-level posting check already bound the
// employer. Locally, a posting/requisition marker must be this posting's own
// (any other one, or an ambiguous pair, rejects the control), the heading
// must name no other employer, and it must pass the posting match on the
// role.
function disclosureEntryContextMatchesPosting(control, context = {}) {
  const identity = controlPostingIdentity(control);
  if (identity === null) return false;
  if (identity !== '' && identity !== expectedPostingIdentity(context)) return false;
  // The control's own label («Apply to Google») is the entry, not context
  // naming another employer: only the text around it is checked.
  const ownLabels = [control?.text, control?.label, control?.ariaLabel, control?.title]
    .map((value) => String(value || '').trim()).filter(Boolean);
  const localContext = [control?.vacancyContext, control?.section, control?.context]
    .filter(Boolean)
    .map((value) => ownLabels.reduce((text, label) => text.replace(new RegExp(escapeRegex(label), 'ig'), ' '), String(value)))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
  const job = context.job || {};
  if (!localContext || !job.title) return true;
  if (namesAnotherEmployer(localContext, job)) return false;
  return postingMatch(localContext, { title: job.title }, context.postingUrl) === 'match';
}

// A few legacy employer pages render the only application opener as a native
// button whose value is deliberately generic («cliccando qui», «click here»).
// That label is not provenance by itself: it is accepted only when the
// browser is on the exact Umantis vacancy route, the derived Application/New
// route carries the same vacancy id, the page names the selected role, and
// there is no competing semantic Apply control. This keeps the security gate
// closed for generic buttons on listings and for neighbouring roles.
const GENERIC_APPLICATION_ENTRY_RE = /^(?:clicca(?:ndo)?\s+qui|click\s+here|cliquez?\s+ici|hier\s+klicken|hier\s+bewerben|apply\s+here|candidarsi\s+qui|fare\s+clic\s+qui)$/iu;

// Social sign-in entries hand the application to a third-party account. A
// brand name alone is not one («Apply to Google» is a posting at Google):
// the label must say the entry goes *through* the provider («Apply with
// LinkedIn», «Bewerbung mit LinkedIn starten», «Sign in with Google»), or the
// control's own id must name the provider as its sign-in option (Career Site
// Builder: `applyOption-top-linkedin`).
const SOCIAL_PROVIDER = String.raw`(?:linked\s?in|xing|indeed|facebook|google|apple|seek)`;
const SOCIAL_APPLICATION_LABEL_RE = new RegExp(String.raw`\b(?:with|using|via|through|mit|über|ueber|con|tramite|avec|par)\s+(?:(?:your|my|ihrem|deinem|il\s+tuo|votre)\s+)?${SOCIAL_PROVIDER}\b`, 'iu');
const SOCIAL_APPLICATION_ID_RE = new RegExp(String.raw`(?:^|[-_])(?:apply|sign[-_]?in|login|social)?[-_]?option[-_](?:[a-z]+[-_])?${SOCIAL_PROVIDER}$|(?:^|[-_])(?:apply|sign[-_]?in|login)[-_](?:with[-_])?${SOCIAL_PROVIDER}$`, 'iu');

function applicationEntryLabel(control) {
  return String(control?.text || control?.label || '').normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();
}

function socialApplicationEntry(control) {
  return [control?.text, control?.label, control?.ariaLabel, control?.title]
    .some((value) => SOCIAL_APPLICATION_LABEL_RE.test(String(value || '').replace(/\s+/g, ' ')))
    || SOCIAL_APPLICATION_ID_RE.test(String(control?.domId || ''));
}

function genericApplicationEntryLabel(value) {
  const text = String(value || '').normalize('NFKC').replace(/\s+/g, ' ').trim()
    .replace(/^[([{«»“”‘’"'›•*-]+|[.!?:,;)\]}«»“”‘’"']+$/gu, '').trim();
  return Boolean(text && GENERIC_APPLICATION_ENTRY_RE.test(text));
}

function genericUmantisApplicationEntryBelongsToPosting(control, snapshot, context = {}) {
  if (!context?.allowSingleExternalApplicationEntry || !genericApplicationEntryLabel(control?.text || control?.label)
    || control?.disabled || control?.chrome || control?.href || (Number(control?.frame) || 0) !== 0) return false;
  if (!samePostingAddress(snapshot?.url, context.postingUrl)
    || (Array.isArray(snapshot?.fields) && snapshot.fields.length > 0)) return false;
  const applicationUrl = umantisApplicationEntryUrl({ applyUrl: context.applyUrl, postingUrl: context.postingUrl })
    || String(context.applyUrl || '').trim();
  if (!isUmantisPostingEntry({ applyUrl: applicationUrl, postingUrl: context.postingUrl })) return false;
  return Boolean(context.job?.title
    && titleMatches(`${snapshot?.text || ''}\n${snapshot?.title || ''}\n${context.pageTitle || ''}`, context.job.title));
}

export function applicationEntryControls(snapshot = {}, context = {}) {
  const controls = [
    ...(Array.isArray(snapshot.buttons) ? snapshot.buttons : []),
    ...(Array.isArray(snapshot.links) ? snapshot.links : []),
  ].filter((control) => control?.ariaHidden !== true && control?.behindDialog !== true);
  // A third-party sign-in («Apply with LinkedIn») cannot be completed by the
  // runner. A social item of an opened Apply menu is never an entry, and an
  // own entry always wins over a social one that merely comes first.
  const matching = controls.filter((control) => !control?.disabled && !control?.chrome
    && startsApplication(control?.text || control?.label)
    && !(control?.menuItem === true && socialApplicationEntry(control))
    // An opened menu item usually links to `#`, which matches the posting
    // route by construction: it must also carry this posting's context.
    && !(control?.menuItem === true && !disclosureEntryContextMatchesPosting(control, context))
    && applicationEntryBelongsToPosting(control, context));
  const workdayManualEntries = controls.filter((control) => workdayManualApplyEntry(control, snapshot, context));
  if (workdayManualEntries.length === 1) return workdayManualEntries;
  if (workdayManualEntries.length > 1) return [];
  const workdayRoutePair = [context.applyUrl, context.postingUrl, snapshot.url].map(workdayJobRoute);
  const [workdayApply, workdayPosting, workdayCurrent] = workdayRoutePair;
  const workdayRouteBound = workdayApply && workdayPosting && workdayCurrent
    && sameWorkdayJobRoute(workdayApply, workdayPosting)
    && sameWorkdayJobRoute(workdayCurrent, workdayPosting);
  const workdayEntries = controls.filter((control) => !control?.disabled && !control?.chrome
    && startsApplication(control?.text || control?.label));
  const workdayScriptEntries = workdayEntries.filter((control) => !control?.href && !control?.formId
    && (control.frame || 0) === 0);
  // Workday's posting can keep its Apply opener on the exact same requisition
  // route. The `_R-...` route proves the posting; a sole visible Apply control
  // on that fieldless page is the popup opener, while the profile's “Start”
  // control does not match `startsApplication` and cannot compete.
  if (workdayRouteBound && Array.isArray(snapshot.fields) && snapshot.fields.length === 0
    && workdayScriptEntries.length === 1 && workdayEntries.length === 1) return workdayScriptEntries;
  const ownMatching = matching.filter((control) => !socialApplicationEntry(control));
  if (ownMatching.length) return ownMatching;
  if (matching.length || context.allowSingleExternalApplicationEntry !== true) return matching;

  if (jobRoomExternalApplicationEntryProven(snapshot, context)) {
    return controls.filter((control) => isJobRoomExternalApplicationEntry(control, snapshot, context));
  }

  const genericEntries = controls.filter((control) => genericUmantisApplicationEntryBelongsToPosting(control, snapshot, context));
  const competingSemanticEntry = controls.some((control) => !genericApplicationEntryLabel(control?.text || control?.label)
    && startsApplication(control?.text || control?.label));
  if (genericEntries.length === 1 && !competingSemanticEntry) return genericEntries;

  // A verified posting can hand off to an ATS on another route or origin
  // without a URL that carries the vacancy id (common on employer career
  // pages). A single explicit Apply link is enough provenance; a listing with
  // several such links remains unresolved rather than choosing one by position.
  const posting = comparablePortalRoute(context.postingUrl);
  // A verified single-job detail may expose Apply as a script button, with
  // neither href nor local posting markers. Never borrow this provenance on
  // forms, listings, redirected pages, or ambiguous multiple-entry surfaces.
  const current = comparablePortalRoute(snapshot.url);
  const scriptEntries = controls.filter(control => !control?.disabled && !control?.chrome
    && !control?.href && !control?.formId && (control.frame || 0) === 0
    && startsApplication(stadtZurichAccessibleControlName(control) || control?.text || control?.label)
    && controlPostingIdentity(control) === ''
    && fieldlessApplicationEntryContextMatchesPosting(control, context));
  const allEntries = controls.filter(control => !control?.disabled && !control?.chrome
    && startsApplication(stadtZurichAccessibleControlName(control) || control?.text || control?.label));
  // The official Stadt Zürich detail page is selected by its unique role link
  // before this loop reaches it. On that exact, fieldless detail route a sole
  // explicit Apply control is the only remaining handoff proof; a duplicate
  // or social choice stays unresolved instead of being chosen by position.
  const publicDetailEntries = allEntries.filter((control) => !socialApplicationEntry(control));
  if (context.publicPostingTarget === true
    && posting && current
    && isStadtZurichPublicJobDetailRoute(snapshot.url)
    && current.origin === posting.origin
    && current.pathname === posting.pathname
    && Array.isArray(snapshot.fields) && snapshot.fields.length === 0
    && allEntries.length === 1 && publicDetailEntries.length === 1) return publicDetailEntries;
  if (posting && current && current.origin === posting.origin
    && current.pathname === posting.pathname && current.search === posting.search
    && /^(?:\/[a-zA-Z0-9%._-]+)?\/job\/[^/]+(?:\/[^/]+)?\/?$/i.test(posting.pathname)
    && isSuccessFactorsPostingEntry(context)
    // Jobs2Web detail pages can expose the required alert-frequency input
    // beside their sole script Apply button. The route shape alone is shared
    // by arbitrary portals, so the verified Jobs2Web identity must also bind
    // the apply route to this posting before the alert-only exception applies.
    && publicJobDetailFieldsAreOnlyAlert(snapshot)
    && scriptEntries.length === 1 && allEntries.length === 1) return scriptEntries;
  // SuccessFactors Career Site Builder repeats one Apply dropdown above and
  // below the vacancy. Identical disclosure toggles are one entry: open the
  // first. Once its menu is open, the single own (non-social) menu item is
  // the entry; the toggles that opened it are not alternatives to it. The
  // page is the verified posting route without fields, so the controls'
  // heading may name only the role: it must not name another posting or
  // employer.
  const ownEntries = allEntries.filter((control) => !(control.menuItem === true && socialApplicationEntry(control)));
  const disclosureEntries = ownEntries.filter((control) => (control.popup === true || control.menuItem === true)
    && !control.formId && (Number(control.frame) || 0) === 0
    && (!control.href || samePortalRoute(control.href, context.postingUrl, context.postingUrl))
    && disclosureEntryContextMatchesPosting(control, context));
  if (posting && current && current.origin === posting.origin
    && current.pathname === posting.pathname && current.search === posting.search
    && /^(?:\/[a-zA-Z0-9%._-]+)?\/job\/[^/]+(?:\/[^/]+)?\/?$/i.test(posting.pathname)
    && Array.isArray(snapshot.fields) && snapshot.fields.length === 0
    && disclosureEntries.length > 0 && disclosureEntries.length === ownEntries.length) {
    const menuEntries = disclosureEntries.filter((control) => control.menuItem === true);
    if (menuEntries.length === 1) return menuEntries;
    const toggles = disclosureEntries.filter((control) => control.popup === true);
    const toggleLabels = new Set(toggles.map((control) => applicationEntryLabel(control)));
    if (!allEntries.some((control) => control.menuItem === true) && toggles.length >= 1 && toggleLabels.size === 1) return toggles.slice(0, 1);
  }
  // The page that hosts a posting document (postingDocumentHostBound, with the document read and found to be
  // the order's): its one application control, whatever host it opens, is the posting's. Several application
  // controls, or a social one, stay unresolved.
  const documentHost = context.postingDocumentHost === true
    ? comparablePortalRoute(context.postingDocumentHostUrl) : null;
  if (documentHost && current && current.origin === documentHost.origin
    && current.pathname === documentHost.pathname && current.search === documentHost.search
    && allEntries.length === 1 && !socialApplicationEntry(allEntries[0])) return allEntries;
  const unbound = controls.filter((control) => {
    if (control?.disabled || control?.chrome || !startsApplication(control?.text || control?.label)) return false;
    const target = comparablePortalRoute(control?.href);
    return Boolean(target && posting
      && (target.origin !== posting.origin || target.pathname !== posting.pathname || target.search !== posting.search));
  });
  // A single external Apply link can identify an ATS handoff only when it is
  // in a bounded card that names this role and employer. Once the resolver
  // has bound a SuccessFactors module to this posting, only the proven target
  // may be used; local text cannot override a conflicting route proof.
  const proofBound = context.postingRouteProof
    ? unbound.filter((control) => isVerifiedPostingEntry({
      applyUrl: control?.href,
      postingUrl: context.postingUrl,
      postingRouteProof: context.postingRouteProof,
    }))
    : unbound.filter((control) => applicationEntryContextMatchesPosting(control, context));
  if (proofBound.length === 1) return proofBound;
  // On the posting page itself, Apply links that all open one route carrying the posting's own id
  // (applicationEntryCarriesPostingId) are that posting's entry, repeated above and below the text. A link
  // without the id, or to another route, among them keeps the page unresolved.
  if (!context.postingRouteProof && !proofBound.length && unbound.length > 0 && current && posting
    && current.origin === posting.origin && current.pathname === posting.pathname && current.search === posting.search
    && unbound.every((control) => applicationEntryCarriesPostingId(control?.href, context.postingUrl))
    && new Set(unbound.map((control) => {
      const target = comparablePortalRoute(control.href);
      return `${target.origin}${target.pathname}${target.search}`;
    })).size === 1) return unbound.slice(0, 1);
  return [];
}

// A posting may show an informational region notice and still expose its own
// application entry. Keep the notice terminal only when no proved entry
// control remains; an unrelated job button must not count as an escape hatch.
function hasApplicationEntryControl(snapshot = {}, context = {}) {
  return applicationEntryControls(snapshot, context).length > 0;
}

/**
 * A page with only the employer site's header/footer controls is not an
 * application form. The thin-shell exception is limited to Stadt Zürich's
 * exact posting route; a verified apply URL alone still needs a form surface.
 * Custom widgets may have no native fields yet, but their own buttons are
 * actionable and must reach the agentic fallback.
 */
export function hasApplicationSurface(snapshot, { pageUrl = '', postingUrl = '', postingMatch = '' } = {}) {
  if (isNonApplicationSurface(snapshot)) return false;
  return Boolean(snapshot?.fields?.length || snapshot?.buttons?.some((button) => !button.chrome)
    || (postingMatch === 'match' && isStadtZurichPostingRoute({ pageUrl, postingUrl })));
}

/**
 * An anti-bot interstitial or a body-confirmed runner IP block is not evidence
 * that the application belongs to a different posting. Challenges take the
 * CAPTCHA handoff; only the confirmed IP block takes the egress recovery lane.
 */
export function initialPortalHandoffReason({ snapshot = {}, liveness = {} } = {}) {
  if (liveness?.code === 'runner_ip_blocked') return 'application_region_unsupported';
  return snapshot?.captcha || liveness?.code === 'bot_challenge' ? 'captcha' : null;
}

const portalUsableChoiceOption = (option) => typeof option === 'string'
  ? Boolean(option.trim())
  : Boolean(option && option.placeholder !== true && option.disabled !== true && String(option.label || '').trim());

const portalHasChoiceCatalogue = (field) => Array.isArray(field?.options)
  && field.options.some(portalUsableChoiceOption);

const editableCombobox = (field) => String(field?.kind || '').toLowerCase() === 'combobox'
  && field?.selectLike === false && !field?.nativeSelectId;

const fieldHasNativeOptions = (field) => ['combobox', 'select', 'radio', 'listbox'].includes(String(field?.kind || '').toLowerCase())
  || field?.selectLike === true
  || Boolean(field?.nativeSelectId);

const fieldRequiresNativeOptions = (field) => fieldHasNativeOptions(field) && !editableCombobox(field);

export function needsPortalOptionRead(snapshot = {}) {
  return snapshot.fields?.some((field) => {
    if (!fieldHasNativeOptions(field)) return false;
    return !portalHasChoiceCatalogue(field);
  }) || false;
}

const choiceField = field => ['combobox', 'listbox', 'radio', 'select'].includes(field?.kind) || field?.selectLike === true;
const usableChoiceOption = option => {
  if (typeof option === 'string') return Boolean(option.trim());
  return Boolean(option && option.disabled !== true && option.placeholder !== true
    && String(option.label || option.value || '').trim());
};
const hasChoiceCatalogue = field => Array.isArray(field?.options) && field.options.some(usableChoiceOption);
const fieldFrame = field => Number.isInteger(field?.frame) ? field.frame : 0;
const fieldFrameUrl = (snapshot, field) => {
  const index = fieldFrame(field);
  const frame = (Array.isArray(snapshot?.frames) ? snapshot.frames : [])
    .find((item) => item?.index === index);
  return String(frame?.url || (index === 0 ? snapshot?.url : '') || '').trim();
};
const fieldKey = (snapshot, field) => {
  const id = String(field?.id || '').trim();
  const url = fieldFrameUrl(snapshot, field);
  return id && url ? JSON.stringify([fieldFrame(field), url, id]) : '';
};
const fieldsByIdentity = (snapshot) => {
  const fields = Array.isArray(snapshot?.fields) ? snapshot.fields : [];
  const byIdentity = new Map();
  const ambiguous = new Set();
  for (const field of fields) {
    const key = fieldKey(snapshot, field);
    if (!key) continue;
    if (byIdentity.has(key)) {
      byIdentity.delete(key);
      ambiguous.add(key);
    } else if (!ambiguous.has(key)) byIdentity.set(key, field);
  }
  return byIdentity;
};

/** Merge a lazy catalogue only when both snapshots identify the same page and exact control. */
export function mergePortalChoiceOptions(current, refreshed) {
  const currentUrl = String(current?.url || '').trim();
  if (!currentUrl || String(refreshed?.url || '').trim() !== currentUrl) return current;
  const refreshedByIdentity = fieldsByIdentity(refreshed);
  const currentFields = Array.isArray(current?.fields) ? current.fields : [];
  let changed = false;
  const fields = currentFields.map((field) => {
    if (portalHasChoiceCatalogue(field)) return field;
    const live = refreshedByIdentity.get(fieldKey(current, field));
    if (!portalHasChoiceCatalogue(live)) return field;
    changed = true;
    return { ...field, options: live.options };
  });
  return changed ? { ...current, fields } : current;
}

/**
 * A portal can expose a choice control before its native options have been
 * attached to the first snapshot. Re-read the live page only for that exact
 * control and carry over its catalogue; labels, ids, values and field set
 * remain owned by the original snapshot. An empty or ambiguous reread stays
 * empty and therefore fails closed in the deterministic filler.
 */
async function refreshChoiceCatalogues(page, snapshot) {
  const fields = Array.isArray(snapshot?.fields) ? snapshot.fields : [];
  if (!fields.some(field => choiceField(field) && !hasChoiceCatalogue(field))) return snapshot;
  const live = await extractFields(page).catch(() => null);
  const expectedUrl = String(snapshot?.url || page.url() || '');
  if (!live?.fields?.length || String(live.url || '') !== expectedUrl || String(page.url() || '') !== expectedUrl) return snapshot;
  const liveByKey = fieldsByIdentity(live);
  let changed = false;
  const nextFields = fields.map((field) => {
    if (!choiceField(field) || hasChoiceCatalogue(field)) return field;
    const observed = liveByKey.get(fieldKey(snapshot, field));
    if (!hasChoiceCatalogue(observed)) return field;
    changed = true;
    return { ...field, options: observed.options };
  });
  return changed ? { ...snapshot, fields: nextFields } : snapshot;
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

/**
 * A page is the same page when its URL and controls are the same.  Workday's
 * steps share one URL, and a few single-page ATS flows also reuse the labels;
 * the stable DOM control ids distinguish a replaced wizard step from a redraw
 * of the current one without treating a typed value as navigation.
 */
function pageSignature(page, snapshot) {
  return `${page.url()}|${snapshot.pageMarker || ''}|${snapshot.fields.map((field) => [
    Number.isInteger(field.frame) ? field.frame : '', field.id || '', field.kind || '', field.inputType || '', field.label || '', field.name || '',
  ].join(':')).join('|')}`;
}

/**
 * The visible question contract, without values the runner has just filled.
 *
 * SuccessFactors validates a registration password asynchronously. During
 * that request it may repaint only the password field's accessibility
 * metadata, error state, or value mirror. Those are not candidate questions,
 * but the field's identity, type, and required state still are: a redraw that
 * removes or replaces the password control must remain unsafe.
 */
function questionSurfaceSignature(snapshot = {}, { ignorePasswordPolicy = false } = {}) {
  const fields = Array.isArray(snapshot.fields) ? snapshot.fields : [];
  const errors = Array.isArray(snapshot.errors) ? snapshot.errors : [];
  return JSON.stringify({
    pageMarker: String(snapshot.pageMarker || ''),
    fields: fields.map((field) => {
      const passwordPolicyField = ignorePasswordPolicy && field.inputType === 'password';
      return [
        Number.isInteger(field.frame) ? field.frame : '',
        // SuccessFactors can replace the password input while its policy
        // validator runs. The generated data-aa-id belongs to the DOM node,
        // not to the password control; keep a native/semantic identity when
        // one exists and let the stable name/label/type contract below catch
        // an actual field replacement.
        passwordPolicyField ? String(field.domId || field.controlId || field.semanticId || field.id || '').trim() : field.id || '',
        field.kind || '', field.inputType || '', field.label || '', field.name || '',
        field.context || '', field.section || '',
        passwordPolicyField ? '' : String(field.ariaLabel || '').replace(/\s+/g, ' ').trim(),
        passwordPolicyField ? '' : String(field.description || '').replace(/\s+/g, ' ').trim(),
        passwordPolicyField ? '' : String(field.ariaDescription || '').replace(/\s+/g, ' ').trim(),
        passwordPolicyField ? '' : String(field.title || '').replace(/\s+/g, ' ').trim(),
        passwordPolicyField ? '' : String(field.placeholder || '').replace(/\s+/g, ' ').trim(),
        passwordPolicyField ? [] : (Array.isArray(field.labels) ? field.labels : []).map((label) => String(label || '').replace(/\s+/g, ' ').trim()),
        passwordPolicyField ? false : field.privacyMetadataIncomplete === true,
        passwordPolicyField ? '' : String(field.autocomplete || '').replace(/\s+/g, ' ').trim(),
        passwordPolicyField ? null : (Number.isFinite(field.maxLength) ? field.maxLength : null),
        passwordPolicyField ? '' : String(field.accept || '').replace(/\s+/g, ' ').trim(),
        passwordPolicyField ? null : (Object.hasOwn(field, 'addressContext') ? addressContextContract(field) : null),
        passwordPolicyField ? null : createHash('sha256').update(String(field.value ?? '')).digest('hex'),
        field.checked === true,
        field.required === true, passwordPolicyField ? false : field.invalid === true,
        (Array.isArray(field.options) ? field.options : []).map((option) => [
          String(typeof option === 'string' ? option : option?.label || ''),
          String(typeof option === 'string' ? '' : option?.value || ''),
          typeof option === 'string' ? false : option?.disabled === true,
          typeof option === 'string' ? false : option?.placeholder === true,
        ]),
      ];
    }),
    errors: errors.map((error) => String(error?.message || error?.text || error || '')),
  });
}

/** Registration stability ignores only SuccessFactors' password-policy repaint. */
export function registrationQuestionSurfaceSignature(snapshot = {}) {
  return questionSurfaceSignature(snapshot, { ignorePasswordPolicy: true });
}

/** The planned question shape plus whether each required answer is still present. */
function registrationSurfaceSignature(snapshot = {}) {
  const fields = (Array.isArray(snapshot.fields) ? snapshot.fields : [])
    .filter((field) => field.inputType !== 'password');
  const questionSurface = { ...snapshot, fields };
  return JSON.stringify({
    questions: questionSurfaceSignature(questionSurface),
    required: fields
      .filter((field) => field.required === true || field.invalid === true)
      .map((field) => [field.id || '', field.kind || '', field.inputType || '', field.required === true,
        field.invalid === true, field.checked === true, holdsValue(field)]),
  });
}

/** Wait for the fields exposed by known answers to settle before asking for missing facts. */
async function waitForStableQuestionSurface(page, snapshot, expectedUrl, { registration = false } = {}) {
  let current = snapshot;
  const signatureFor = currentSnapshot => registration
    ? registrationQuestionSurfaceSignature(currentSnapshot)
    : questionSurfaceSignature(currentSnapshot);
  let signature = signatureFor(snapshot);
  let quietMs = 0;
  let observedMs = 0;
  while (observedMs < QUESTION_SURFACE_WAIT_MS
    && (observedMs < QUESTION_SURFACE_MIN_OBSERVATION_MS || quietMs < QUESTION_SURFACE_STABLE_MS)) {
    await page.waitForTimeout(QUESTION_SURFACE_POLL_MS);
    observedMs += QUESTION_SURFACE_POLL_MS;
    const next = await extractFields(page, NAVIGATION).catch(() => null);
    if (!next) {
      quietMs = 0;
      if (page.url() !== expectedUrl) return { status: 'unstable', snapshot: current };
      continue;
    }
    current = next;
    if (page.url() !== expectedUrl || next.url !== expectedUrl) return { status: 'moved', snapshot: current };
    const nextSignature = signatureFor(next);
    if (nextSignature === signature) quietMs += QUESTION_SURFACE_POLL_MS;
    else {
      signature = nextSignature;
      quietMs = 0;
    }
  }
  return {
    status: observedMs >= QUESTION_SURFACE_MIN_OBSERVATION_MS && quietMs >= QUESTION_SURFACE_STABLE_MS ? 'stable' : 'unstable',
    snapshot: current,
  };
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

/** The uniquely matching visible control from a fresh snapshot, in the same frame and ownership scope. */
async function sameControl(page, button) {
  const fresh = await extractFields(page, NAVIGATION).catch(() => null);
  const matches = fresh?.buttons.filter((candidate) => candidate.text === button.text && !candidate.disabled
    && Boolean(candidate.chrome) === Boolean(button.chrome) && Boolean(candidate.dialog) === Boolean(button.dialog)
    && String(candidate.dialogId || '') === String(button.dialogId || '')
    && String(candidate.formId || '') === String(button.formId || '')
    && String(candidate.href || '') === String(button.href || '')
    && (candidate.frame || 0) === (button.frame || 0)) || null;
  return matches?.length === 1 ? matches[0] : null;
}

/** A unique, visible semantic match survives a portal replacing its generated DOM id. */
async function clickUniqueNamedControl(frame, button) {
  if (!button.text) return null;
  const formId = String(button.formId || '');
  const dialogId = String(button.dialogId || '');
  if (formId && !/^[\w-]{1,80}$/.test(formId)) return null;
  if (button.dialog && !/^[\w-]{1,80}$/.test(dialogId)) return null;
  if (!formId && !button.dialog) return null;
  if (typeof frame?.getByRole !== 'function') return null;
  const matches = [];
  for (const role of ['button', 'link']) {
    const candidates = frame.getByRole(role, { name: button.text, exact: true });
    const count = await candidates.count().catch(() => 0);
    for (let index = 0; index < count; index += 1) {
      const candidate = candidates.nth(index);
      if (!await candidate.isVisible().catch(() => false)) continue;
      if (!await candidate.isEnabled({ timeout: 2_000 }).catch(() => false)) continue;
      const owner = await candidate.evaluate((element) => {
        const form = element.form || element.closest?.('form');
        const dialog = element.closest?.('dialog, [role="dialog"], [aria-modal="true"]');
        return {
          formId: form?.getAttribute('data-aa-id') || '',
          dialogId: dialog?.getAttribute('data-aa-dialog-id') || '',
          href: element.tagName === 'A' && /^https?:/.test(element.href || '') ? element.href : '',
        };
      }).catch(() => null);
      if (!owner || owner.formId !== formId || owner.dialogId !== dialogId) continue;
      if (Object.hasOwn(button, 'href') && owner.href !== String(button.href || '')) continue;
      matches.push(candidate);
      if (matches.length > 1) return null;
    }
  }
  if (matches.length !== 1) return null;
  await matches[0].click({ timeout: 6_000 });
  return 'role';
}

function unresolvedPreDispatchControlClick() {
  const error = new Error('portal_control_click_unresolved');
  error.code = 'portal_control_click_unresolved';
  return error;
}

async function clickUniqueNamedControlAfterTimeout(frame, button) {
  try {
    return await clickUniqueNamedControl(frame, button);
  } catch (error) {
    // A timed-out locator can be retried only when Playwright proves that it
    // never dispatched. Once the scoped fallback also proves that, stop here:
    // the portal runner will hand the page to the owner with encrypted evidence.
    if (isPreDispatchLocatorClickFailure(error)) throw unresolvedPreDispatchControlClick();
    throw error;
  }
}

/** Presses a control from a snapshot; recovery must preserve the control's click handler. */
export async function clickButton(page, button) {
  const frameNumber = Number(button.frame) || 0;
  const frames = typeof page.frames === 'function' ? page.frames() : [];
  const frame = frames[frameNumber]
    || (frameNumber === 0 ? (typeof page.mainFrame === 'function' ? page.mainFrame() : page) : null);
  if (typeof frame?.locator !== 'function') throw new Error('portal_frame_unavailable');
  try {
    await frame.locator(`[data-aa-id="${button.id}"]`).first().click({ timeout: 6_000 });
    return 'id';
  } catch (error) {
    // Workday animates its apply modal and re-renders its forms, dropping our data-aa-id: the same control
    // is found again in a fresh reading. A text-only selector can find the header's «Sign In» instead of
    // the form's and open a dialog over the form (dry run of 2026-10-07). A role retry needs a unique match
    // inside the same form or dialog; without a verified scope, nothing else is pressed in its place.
    if (!isPreDispatchLocatorClickFailure(error)) throw error;
    if (!button.text) throw unresolvedPreDispatchControlClick();
    const again = await sameControl(page, button);
    if (again) {
      const retryFrames = typeof page.frames === 'function' ? page.frames() : [];
      const retryFrameNumber = Number(again.frame) || 0;
      const retryFrame = retryFrames[retryFrameNumber]
        || (retryFrameNumber === 0 ? (typeof page.mainFrame === 'function' ? page.mainFrame() : page) : null);
      if (typeof retryFrame?.locator !== 'function') throw unresolvedPreDispatchControlClick();
      try {
        await retryFrame.locator(`[data-aa-id="${again.id}"]`).first().click({ timeout: 6_000 });
        return 'again';
      } catch (retryError) {
        if (!isPreDispatchLocatorClickFailure(retryError)) throw retryError;
        const recovered = await clickUniqueNamedControlAfterTimeout(retryFrame, again);
        if (recovered) return recovered;
        throw unresolvedPreDispatchControlClick();
      }
    }
    const recovered = await clickUniqueNamedControlAfterTimeout(frame, button);
    if (recovered) return recovered;
    throw unresolvedPreDispatchControlClick();
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
  const before = page.url();
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
  const opened = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), POPUP_GRACE_MS);
    popup.then((opened) => {
      clearTimeout(timer);
      resolve(opened);
    });
  });
  if (opened) return opened;
  // The browser announces a new window only once its address has answered. A
  // link that opens another window (target="_blank") and left none, with this
  // page where it was, has no answer from its address yet: ECAM's DocuWare
  // form accepts no connection from the GitHub runner's country (CVRDEqJ3,
  // run 42990206160, 2026-11-11), and the runner read the career page again
  // as the application form (posting_mismatch). The address is opened in this
  // page, where it loads or fails as a navigation (net::ERR_*, timeout:
  // navigation_unavailable in submit.mjs, retried by the transport ladder).
  if (page.url() !== before) return null;
  const linkTarget = await link.getAttribute('target', { timeout: 2_000 }).catch(() => null);
  const target = opensAnotherWindow(linkTarget) ? linkNavigationTarget(href, before) : '';
  if (target && target !== before) await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  return null;
}

/** A link target that opens another browsing context: `_blank` or a named window, not this page or its parents. */
function opensAnotherWindow(target) {
  const name = String(target || '').trim().toLowerCase();
  return Boolean(name) && !['_self', '_parent', '_top'].includes(name);
}

/** The absolute http(s) address a link's href opens from `base`, or '' (fragment, script, mail, phone, other scheme). */
function linkNavigationTarget(href, base) {
  const value = String(href || '').trim();
  if (!value || /^(?:#|javascript:|mailto:|tel:)/i.test(value)) return '';
  try {
    const url = new URL(value, base);
    return /^https?:$/.test(url.protocol) ? url.href : '';
  } catch {
    return '';
  }
}

// Cookie banners: refuse the non-essential cookies when the banner offers it,
// otherwise accept (the runner's own browser session, no candidate data).
// SuccessFactors' own cookie manager (Rolex, 2026-10-03) names the cookies in
// each button — «Refuser tous les cookies», «Alle Cookies ablehnen», «Reject
// All Cookies» and «Rifiuta tutti i cookie» — and, left open, takes every
// click on the sign-in page behind it. Deloitte's manager says «Decline
// optional cookies» / «Accept optional cookies»; optional is still the
// manager's decision, not its preferences control.
export const COOKIE_REJECT_RE = /^(ablehnen|alle( cookies)? ablehnen|nur (notwendige|erforderliche)( cookies)?|reject( all| optional)?( cookies)?|decline( all| optional)?( cookies)?|only necessary|rifiuta( tutti| tutto)?( i cookie)?|solo necessari|refuser( tout| tous les cookies)?|tout refuser|continuer sans accepter)$/i;
export const COOKIE_ACCEPT_RE = /^(cookies akzeptieren|alle( cookies)? akzeptieren|akzeptieren|accept( all| optional)?( cookies)?|accetta( tutti)?( i cookie)?|tout accepter|accepter( tout| tous les cookies)?|ok)$/i;
export const COOKIE_CUSTOMIZE_RE = /^(?:customi[sz]e cookies|cookie[- ](?:settings|preferences|options)|manage cookies|modify cookie preferences|cookie[- ]einstellungen(?: (?:ändern|bearbeiten))?|einstellungen (?:für )?cookies?|cookies? (?:anpassen|verwalten)|(?:impostazioni|preferenze) (?:dei )?cookies?|gestisci (?:le )?(?:impostazioni|preferenze) (?:dei )?cookies?|personalizza (?:i )?cookies?|(?:paramètres?|préférences?) (?:des )?cookies?|gérer (?:les )?cookies?|modifier (?:les )?(?:paramètres?|préférences?) (?:des )?cookies?|cookie[- ]?(?:instellingen|voorkeuren)|cookies? beheren)$/i;
// Yellowshark exposes this bare label without the word "cookie". Keep it out
// of the general preference vocabulary: it is accepted only after the live
// control has proved that it belongs to a cookie manager surface.
export const COOKIE_MANAGE_CONSENT_RE = /^manage consent$/i;
const COOKIE_GENERIC_PREFERENCES_RE = /^(?:manage|change|modify|adjust|customi[sz]e) (?:your )?(?:preferences|settings)$/i;
// A preference centre (opened by «Einstellungen anzeigen», «Manage options»,
// or shown in place of the banner) can offer no reject control at all: only
// its category toggles and a control that saves them. With every optional
// category withdrawn first, saving is the necessary-only choice. These labels
// carry no «cookie» word: the control still needs the same cookie context (a
// cookie dialog or banner) as every other cookie choice.
export const COOKIE_SAVE_RE = /^(?:(?:save|confirm|submit)(?: my| your| the)? (?:cookie )?(?:preferences|settings|choices?|selection|consent)|(?:allow|accept) (?:the )?selection|(?:einstellungen|auswahl|präferenzen|cookie-einstellungen) (?:speichern|bestätigen|übernehmen)|auswahl (?:erlauben|akzeptieren)|(?:salva|conferma)(?: le| la)? (?:preferenze|impostazioni|scelte|selezione)|(?:enregistrer|confirmer|valider|sauvegarder)(?: mes| les| ma)? (?:préférences|paramètres|choix|sélection))$/i;
// A category the manager keeps on by itself: its toggle is left as the
// manager set it. The status marker («Immer aktiv») may sit anywhere in the
// category's row; the necessary/essential name is read only from the toggle's
// own name and the row's title, never from a category description (Complianz
// describes its optional «Preferences» as storage «necessary for» a purpose).
const COOKIE_ALWAYS_ACTIVE_RE = /(?:always active|immer aktiv|sempre attiv|toujours actif|siempre activ)/i;
const COOKIE_REQUIRED_CATEGORY_RE = /(?:necessary|essential|notwendig|erforderlich|essenziell|necessari|nécessaire|indispensable|unbedingt)/i;
// At most this many toggles of one cookie surface are withdrawn.
const COOKIE_TOGGLE_LIMIT = 40;
const COOKIE_WORD_RE = /\bcookies?\b/i;
const COOKIE_ACTIVE_SURFACE_RE = /\b(?:banner|notice|overlay|modal|dialog)\b|\bcookie[-_ ]?(?:policy|manager)\b/i;
// Generic banner/modal markers are not proof that a bare Manage consent
// control belongs to a cookie manager. Require a cookie-specific live surface
// identity and cookie copy; `cookie-consent` is deliberately not included
// because application privacy sections reuse that marker.
const COOKIE_MANAGER_SURFACE_RE = /\b(?:cookie[-_ ]?(?:banner|manager|policy|settings?|preferences?|notice|overlay|modal|dialog)|consent[-_ ]?manager|(?:onetrust|usercentrics|didomi|trustarc|cookiebot|quantcast|complianz|cmplz|iubenda|sourcepoint|cmpbox|sp_message|cky[-_ ]?consent|cookie[-_ ]?script))\b/i;
const COOKIE_DIALOG_CONTEXT_RE = COOKIE_WORD_RE;
const COOKIE_GENERIC_ACCEPT_LABEL_RE = /^(?:ok|accept|akzeptieren|accetta|accepter)$/i;
// Some employer-hosted SuccessFactors pages expose the cookie statement and
// its generic controls without a cookie-specific landmark. Keep the fallback
// narrow: a consent sentence must be visible together with a separate close
// control, so an application privacy dialog cannot borrow a generic "Accept".
const COOKIE_CONSENT_COPY_RE = /(?:\bcookies?\b.{0,240}\b(?:website|webseite|nutzung|navigation|verwendung|use|using|brows(?:e|ing)|navigat|utilis|utilizz|consent)\b|\b(?:website|webseite|nutzung|navigation|verwendung|use|using|brows(?:e|ing)|navigat|utilis|utilizz|consent)\b.{0,240}\bcookies?\b)/i;
const COOKIE_DISMISS_RE = /^(?:schlie(?:ß|ss)en|close|dismiss|chiudi|fermer|cerrar|sluiten|fechar)$/i;
const normalizeCookieText = value => String(value || '').replace(/\s+/g, ' ').trim();
const cookieControlLabel = (button) => [button?.text, button?.label, button?.ariaLabel, button?.title]
  .map(value => String(value || '').trim()).find(Boolean) || '';
const escapeRegex = value => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const cookieSupportingContext = (button) => {
  const ownLabels = [button.text, button.label, button.title, button.ariaLabel]
    .filter(Boolean).map(value => String(value).trim()).filter(Boolean);
  return [button.context, button.section, button.title]
    .filter(Boolean)
    .map(value => ownLabels.reduce((context, label) => context.replace(new RegExp(escapeRegex(label), 'ig'), ' '), String(value)))
    .join(' ');
};
const cookieContextIdentity = (button) => {
  const frame = Number(button?.frame) || 0;
  for (const key of [
    'cookieContainerId', 'cookieSurfaceId', 'cookieContextId', 'containerId', 'containerContext',
    'overlayId', 'overlayContext', 'surfaceId', 'surfaceContext', 'contextId', 'dialogId',
  ]) {
    const value = String(button?.[key] || '').trim();
    if (value) return `${frame}:${key}:${value}`;
  }
  const supportingContext = normalizeCookieText(cookieSupportingContext(button));
  return supportingContext ? `${frame}:supporting:${supportingContext}` : '';
};
// Workday offers autofill, "use my last application" or a manual application: manual is the predictable one.
const MANUAL_APPLY_RE = /^(manuell bewerben|apply manually|candidarsi manualmente|candidati manualmente|candidatura manuale|postuler manuellement)$/i;

async function genericCookieControlsShareContainer(page, button, closeControls) {
  const scope = cookieContextIdentity(button);
  const sameScope = closeControls.some(candidate => cookieContextIdentity(candidate) === scope);
  const frameNumber = Number(button.frame) || 0;
  const frames = typeof page?.frames === 'function' ? page.frames() : [];
  const frame = frames[frameNumber]
    || (frameNumber === 0 ? (typeof page?.mainFrame === 'function' ? page.mainFrame() : page) : null);
  const closeIds = closeControls.map(candidate => String(candidate.id || '').trim()).filter(Boolean);
  if (button.id && closeIds.length && typeof frame?.evaluate === 'function') {
    const domResult = await frame.evaluate(({ acceptId, closeIds: ids, copyPattern }) => {
      const normalize = value => String(value || '').replace(/\s+/g, ' ').trim();
      const copyRe = new RegExp(copyPattern, 'i');
      const controlFor = id => [...document.querySelectorAll('[data-aa-id]')]
        .find(element => element.getAttribute('data-aa-id') === id) || null;
      const accept = controlFor(acceptId);
      const closes = ids.map(controlFor).filter(Boolean);
      if (!accept || !closes.length) return false;
      const markerRe = /\b(?:banner|notice|overlay|modal|dialog)\b|\bcookie[-_]?(?:policy|manager)\b/i;
      const explicitSurfaceFor = (element) => {
        for (let node = element; node && node !== document.body; node = node.parentElement) {
          const marker = [node.id, typeof node.className === 'string' ? node.className : '', node.getAttribute('role'), node.getAttribute('aria-label')]
            .filter(Boolean).join(' ');
          if (node.matches('dialog, [role="dialog"], [aria-modal="true"], [role="banner"], [role="region"]')
            || markerRe.test(marker)) return node;
        }
        return null;
      };
      const isPageRoot = node => node === document.body || node === document.documentElement
        || node.matches('main, [role="main"]');
      const isBoundedGenericSurface = (node, text) => !isPageRoot(node)
        && !node.matches('form, [role="form"]')
        && !node.querySelector('form, main, [role="main"]')
        && node.querySelectorAll('button, input[type="submit"], a[role="button"], a[href], [role="button"]').length <= 12
        && text.length <= 2_400;
      const genericSurfaceFor = (element) => {
        for (let node = element; node && node !== document.body; node = node.parentElement) {
          const text = normalize(node.innerText || node.textContent || '');
          if (copyRe.test(text) && isBoundedGenericSurface(node, text)) return node;
        }
        return null;
      };
      const acceptSurface = explicitSurfaceFor(accept);
      for (const close of closes) {
        const closeSurface = explicitSurfaceFor(close);
        if (acceptSurface || closeSurface) {
          if (acceptSurface && acceptSurface === closeSurface
            && copyRe.test(normalize(acceptSurface.innerText || acceptSurface.textContent || ''))) return true;
          continue;
        }
        const acceptGenericSurface = genericSurfaceFor(accept);
        const closeGenericSurface = genericSurfaceFor(close);
        if (acceptGenericSurface && acceptGenericSurface === closeGenericSurface) return true;
      }
      return false;
    }, { acceptId: String(button.id), closeIds, copyPattern: COOKIE_CONSENT_COPY_RE.source }).catch(() => null);
    if (typeof domResult === 'boolean') return domResult;
  }
  // Snapshot fixtures and older producers may carry a stable container identity
  // without exposing the live DOM. Require copy from that same bounded context;
  // a bare page-wide cookie copy never authorizes a generic control.
  const scopedCopyEvidence = [button, ...closeControls]
    .flatMap(candidate => [candidate.cookieContainerText, candidate.cookieContextText, candidate.containerText,
      candidate.context, candidate.section])
    .some(value => COOKIE_CONSENT_COPY_RE.test(normalizeCookieText(value)));
  return Boolean(scope && sameScope && scopedCopyEvidence);
}

async function isPageCookieConsentControl(page, snapshot, button) {
  const label = cookieControlLabel(button);
  const activeCookieSurface = button.cookieSurface === 'banner';
  if (button.disabled || (button.chrome && !activeCookieSurface) || button.dialog || !COOKIE_ACCEPT_RE.test(label)) return false;
  const frame = Number(button.frame) || 0;
  const closeControls = (snapshot?.buttons || []).filter(candidate => (Number(candidate.frame) || 0) === frame
    && !candidate.disabled && (!candidate.chrome || candidate.cookieSurface === 'banner')
    && COOKIE_DISMISS_RE.test(cookieControlLabel(candidate)));
  if (!closeControls.length) return false;
  const frames = typeof page?.frames === 'function' ? page.frames() : [];
  const ownerFrame = frames[frame]
    || (frame === 0 ? (typeof page?.mainFrame === 'function' ? page.mainFrame() : page) : null);
  const ownerText = await ownerFrame?.evaluate?.(() => document.body?.innerText || '').catch(() => '') || '';
  const consentText = ownerText || (frame === 0 ? snapshot?.text : '');
  if (!COOKIE_CONSENT_COPY_RE.test(normalizeCookieText(consentText))) return false;
  return genericCookieControlsShareContainer(page, button, closeControls);
}

async function hasLiveCookieManagerSurface(page, button) {
  if (!button?.id) return false;
  const frameNumber = Number(button.frame) || 0;
  const frames = typeof page?.frames === 'function' ? page.frames() : [];
  const frame = frames[frameNumber]
    || (frameNumber === 0 ? (typeof page?.mainFrame === 'function' ? page.mainFrame() : page) : null);
  const surfaceIsLive = await frame?.evaluate?.(({ controlId, surfacePattern }) => {
    const control = [...document.querySelectorAll('[data-aa-id]')]
      .find(element => element.getAttribute('data-aa-id') === controlId);
    if (!control) return false;
    if (control.closest('form, [role="form"]')) return false;
    const managerSurface = new RegExp(surfacePattern, 'i');
    const cookieCopy = /\bcookies?\b/i;
    for (let node = control.parentElement; node && node !== document.documentElement; node = node.parentElement) {
      const marker = [node.id, typeof node.className === 'string' ? node.className : '', node.getAttribute('role'), node.getAttribute('aria-label')]
        .filter(Boolean).join(' ');
      if (!managerSurface.test(marker)) continue;
      if (node.matches('form, [role="form"]')) continue;
      if (!cookieCopy.test(node.innerText || node.textContent || '')) continue;
      return true;
    }
    return false;
  }, { controlId: String(button.id), surfacePattern: COOKIE_MANAGER_SURFACE_RE.source }).catch(() => false);
  return surfaceIsLive === true;
}

function isYellowsharkJobCookiePreference(page, button, snapshot = {}) {
  if (!COOKIE_MANAGE_CONSENT_RE.test(cookieControlLabel(button))
    || button?.formId || button?.roleFormId) return false;
  const fields = Array.isArray(snapshot?.fields) ? snapshot.fields : null;
  if (!fields || fields.length) return false;
  const frameNumber = Number(button.frame) || 0;
  // The post-choice origin check is page-level. Keep this fallback on the
  // main document so an embedded frame cannot change origins between checks.
  if (frameNumber !== 0) return false;
  const hasJobApply = (snapshot.buttons || []).some((candidate) => !candidate.disabled
    && (Number(candidate.frame) || 0) === frameNumber
    && /^jetzt bewerben$/i.test(cookieControlLabel(candidate)));
  if (!hasJobApply) return false;
  const frames = typeof page?.frames === 'function' ? page.frames() : [];
  const pageUrl = frames[frameNumber]?.url?.() || (frameNumber === 0 ? page?.url?.() : '');
  try {
    const url = new URL(String(pageUrl || ''));
    return url.protocol === 'https:' && url.hostname === 'jobs.yellowshark.com'
      && url.pathname.startsWith('/job/');
  } catch {
    return false;
  }
}

async function cookieControlHasCookieContext(page, button, snapshot = {}, { allowYellowsharkFallback = true } = {}) {
  const label = cookieControlLabel(button);
  const isPreferenceControl = COOKIE_CUSTOMIZE_RE.test(label)
    || COOKIE_GENERIC_PREFERENCES_RE.test(label)
    || COOKIE_MANAGE_CONSENT_RE.test(label);
  // An ATS registration dialog can expose a persistent cookie-settings link
  // next to its application fields. The form contract is stronger evidence
  // of application ownership than the shared word "cookie" in that dialog.
  if (isPreferenceControl && hasApplicationFormInCookieScope(snapshot, button)) return false;
  // A privacy/consent action can use the same bare label inside the
  // application form. It is never a cookie-manager entry point there.
  const manageConsent = COOKIE_MANAGE_CONSENT_RE.test(label);
  if (manageConsent && (button.formId || button.roleFormId)) return false;
  // The live manager check is affirmative proof for this label. Do not fall
  // through to the generic Accept control check, which rejects "Manage consent".
  if (manageConsent) return await hasLiveCookieManagerSurface(page, button)
    || (allowYellowsharkFallback && isYellowsharkJobCookiePreference(page, button, snapshot));
  if (button.dialog && /^d\d+$/.test(String(button.dialogId || ''))) {
    const frame = page.frames()[button.frame || 0] || page.mainFrame();
    try {
      const dialogText = await frame.locator(`[data-aa-dialog-id="${button.dialogId}"]`).innerText({ timeout: 1_000 });
      if (COOKIE_WORD_RE.test(dialogText)) return true;
    } catch {
      // Fall through to the non-dialog banner context below.
    }
  }
  const supportingContext = cookieSupportingContext(button);
  if (button.cookieSurface === 'banner'
    && COOKIE_WORD_RE.test(`${supportingContext} ${button.text || ''} ${button.label || ''} ${button.ariaLabel || ''}`)) return true;
  return isPageCookieConsentControl(page, snapshot, button);
}

async function findCookieControls(page, snapshot, pattern, {
  genericPreferences = false, manageConsent = false, allowYellowsharkFallback = true,
} = {}) {
  const controls = [];
  for (const button of snapshot?.buttons || []) {
    if (button.disabled || (button.chrome && button.cookieSurface !== 'banner')) continue;
    const label = cookieControlLabel(button);
    if (!pattern.test(label)
      && !(genericPreferences && COOKIE_GENERIC_PREFERENCES_RE.test(label))
      && !(manageConsent && COOKIE_MANAGE_CONSENT_RE.test(label))) continue;
    if (!await cookieControlHasCookieContext(page, button, snapshot, { allowYellowsharkFallback })) continue;
    const identity = cookieControlIdentity(button);
    controls.push(identity ? { ...button, cookieControlIdentity: identity } : button);
  }
  return controls;
}

async function findCookieControl(page, snapshot, pattern, options = {}) {
  return (await findCookieControls(page, snapshot, pattern, options))[0] || null;
}

async function cookieChoice(page, snapshot) {
  return await findCookieControl(page, snapshot, COOKIE_REJECT_RE)
    || await findCookieControl(page, snapshot, COOKIE_SAVE_RE)
    || await findCookieControl(page, snapshot, COOKIE_ACCEPT_RE);
}

function cookieControlFrame(page, control) {
  const frameNumber = Number(control?.frame) || 0;
  const frames = typeof page?.frames === 'function' ? page.frames() : [];
  return frames[frameNumber]
    || (frameNumber === 0 ? (typeof page?.mainFrame === 'function' ? page.mainFrame() : page) : null);
}

/**
 * A cookie preference opener that only reopens a manager already closed: the
 * floating «Manage consent» tab of Complianz, a «Cookie settings» button that
 * outlives every choice. The live DOM must prove it collapsed: outside any
 * form or dialog, no cookie dialog open on the page, and its own ARIA state
 * says the surface it controls is closed (aria-expanded="false", or every
 * aria-controls target present and not rendered). Without that proof the
 * control may be the manager itself and keeps the page unresolved.
 */
async function isCollapsedCookieReopener(page, control) {
  if (!control?.id || control.dialog || control.disabled) return false;
  const frame = cookieControlFrame(page, control);
  if (typeof frame?.evaluate !== 'function') return false;
  const proof = await frame.evaluate(({ reopenerId }) => {
    const element = [...document.querySelectorAll('[data-aa-id]')].find((node) => node.getAttribute('data-aa-id') === reopenerId);
    if (!element) return 'missing';
    if (element.closest('form, [role="form"], dialog, [role="dialog"], [aria-modal="true"]')) return 'scoped';
    const rendered = (node) => {
      if (!node || node.closest('[hidden]')) return false;
      for (let current = node; current && current.nodeType === 1; current = current.parentElement) {
        const style = window.getComputedStyle(current);
        if (style.display === 'none' || ['hidden', 'collapse'].includes(style.visibility)) return false;
      }
      const rect = node.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };
    if (!rendered(element)) return 'hidden';
    const cookieCopy = /\bcookies?\b/i;
    const openCookieDialog = [...document.querySelectorAll('dialog[open], [role="dialog"], [aria-modal="true"]')]
      .slice(0, 50).some((node) => rendered(node) && cookieCopy.test(node.innerText || node.textContent || ''));
    if (openCookieDialog) return 'surface_open';
    const expanded = element.getAttribute('aria-expanded');
    if (expanded === 'true') return 'expanded';
    const targets = String(element.getAttribute('aria-controls') || '').split(/\s+/).filter(Boolean).slice(0, 5)
      .map((id) => document.getElementById(id));
    if (targets.length && targets.every(Boolean)) return targets.some(rendered) ? 'surface_open' : 'collapsed';
    return expanded === 'false' ? 'collapsed' : 'unproven';
  }, { reopenerId: String(control.id) }).catch(() => null);
  return proof === 'collapsed';
}

/**
 * Before a save: switch off every optional category of the cookie surface
 * that owns the save control (checkboxes and ARIA switches), leaving disabled
 * toggles and the categories the manager keeps on (necessary, functional).
 * Returns how many were withdrawn, or -1 when the control has no cookie surface.
 */
async function withdrawOptionalCookieToggles(page, control) {
  const frame = cookieControlFrame(page, control);
  if (!control?.id || typeof frame?.evaluate !== 'function') return -1;
  const withdrawn = await frame.evaluate(({ controlId, surfacePattern, alwaysActivePattern, requiredPattern, limit }) => {
    const control = [...document.querySelectorAll('[data-aa-id]')].find((node) => node.getAttribute('data-aa-id') === controlId);
    if (!control) return -1;
    const managerSurface = new RegExp(surfacePattern, 'i');
    const alwaysActive = new RegExp(alwaysActivePattern, 'i');
    const required = new RegExp(requiredPattern, 'i');
    let surface = null;
    for (let node = control.parentElement; node && node !== document.body; node = node.parentElement) {
      const marker = [node.id, typeof node.className === 'string' ? node.className : '', node.getAttribute('aria-label')]
        .filter(Boolean).join(' ');
      if (!node.matches('dialog, [role="dialog"], [aria-modal="true"]') && !managerSurface.test(marker)) continue;
      if (!/\bcookies?\b/i.test(node.innerText || node.textContent || '')) continue;
      surface = node;
      break;
    }
    if (!surface || surface.matches('form, [role="form"]')) return -1;
    const toggleSelector = 'input[type="checkbox"], [role="switch"], [role="checkbox"]';
    let count = 0;
    for (const toggle of [...surface.querySelectorAll(toggleSelector)].slice(0, limit)) {
      const native = toggle.tagName === 'INPUT';
      const on = () => (native ? toggle.checked : toggle.getAttribute('aria-checked') === 'true');
      if (!on() || toggle.disabled || toggle.getAttribute('aria-disabled') === 'true') continue;
      // The toggle's own row: the largest ancestor that holds no other toggle.
      let row = toggle;
      while (row.parentElement && row.parentElement !== surface && row.parentElement.querySelectorAll(toggleSelector).length === 1) row = row.parentElement;
      if (alwaysActive.test(row.innerText || row.textContent || '')) continue;
      const label = toggle.id ? document.querySelector(`label[for="${CSS.escape(toggle.id)}"]`) : toggle.closest('label');
      const labelledBy = String(toggle.getAttribute('aria-labelledby') || '').split(/\s+/).filter(Boolean)
        .map((id) => document.getElementById(id)?.textContent || '');
      const titles = [...row.querySelectorAll('h1, h2, h3, h4, h5, h6, legend, summary, strong, b, [class*="title" i], [class*="name" i]')]
        .map((node) => String(node.textContent || '').trim()).filter((text) => text && text.length <= 80);
      const name = [label?.textContent, toggle.getAttribute('aria-label'), toggle.getAttribute('title'), ...labelledBy, ...titles].join(' ');
      if (required.test(name)) continue;
      toggle.click();
      if (!on()) count += 1;
    }
    return count;
  }, {
    controlId: String(control.id),
    surfacePattern: COOKIE_MANAGER_SURFACE_RE.source,
    alwaysActivePattern: COOKIE_ALWAYS_ACTIVE_RE.source,
    requiredPattern: COOKIE_REQUIRED_CATEGORY_RE.source,
    limit: COOKIE_TOGGLE_LIMIT,
  }).catch(() => -1);
  return Number.isInteger(withdrawn) ? withdrawn : -1;
}

/**
 * The cookie preference controls still waiting for an answer after a choice.
 * Not waiting: a site-chrome opener outside any dialog (header/footer «Cookie
 * settings»), the very opener the runner used, unchanged and outside a dialog,
 * and an opener the live DOM proves collapsed (isCollapsedCookieReopener).
 */
async function blockingCookiePreferences(page, current, openedBy = null) {
  const remaining = (await findCookieControls(page, current, COOKIE_CUSTOMIZE_RE, {
    genericPreferences: true, manageConsent: true,
  })).filter((control) => !(control.chrome === true && !control.dialog && !control.dialogId));
  const blocking = [];
  for (const control of remaining) {
    if (openedBy && sameCookieControl(control, openedBy) && !control.dialog && !cookieDialogRemains(current, openedBy)) continue;
    if (await isCollapsedCookieReopener(page, control)) continue;
    blocking.push(control);
  }
  return blocking;
}

function pageOrigin(page) {
  try { return new URL(page.url()).origin; } catch { return ''; }
}

function cookieDialogRemains(snapshot, button) {
  return Boolean(button.dialogId && (snapshot?.dialogs || []).some((dialog) => dialog.dialogId === button.dialogId));
}

function cookieControlIdentity(control) {
  const documentInstance = String(control?.documentInstance || '').trim();
  const controlInstance = String(control?.controlInstance || '').trim();
  return documentInstance && controlInstance ? `${documentInstance}\u0000${controlInstance}` : '';
}

function sameCookieControl(first, second) {
  if (!first || !second || (Number(first.frame) || 0) !== (Number(second.frame) || 0)) return false;
  const firstIdentity = String(first.cookieControlIdentity || '').trim();
  const secondIdentity = String(second.cookieControlIdentity || '').trim();
  return Boolean(firstIdentity && firstIdentity === secondIdentity);
}

async function cookiePageSnapshot(page) {
  return extractFields(page, NAVIGATION).catch(() => null);
}

async function clickCookieChoice(page, snapshot, button, { openedBy = null } = {}) {
  const origin = pageOrigin(page);
  if (COOKIE_SAVE_RE.test(cookieControlLabel(button))) await withdrawOptionalCookieToggles(page, button);
  try {
    await clickButton(page, button);
  } catch {
    return { status: 'unresolved', snapshot };
  }
  return confirmCookieChoiceDismissed(page, snapshot, origin, button, { openedBy });
}

// The frame whose shadow root holds the marked cookie control, per page (the
// page itself for the main document).
const shadowCookieTargets = new WeakMap();
const COOKIE_SHADOW_FRAME_LIMIT = 10;

function shadowCookieTarget(page) {
  return shadowCookieTargets.get(page) || page;
}

async function clearShadowCookieMarker(page) {
  await shadowCookieTarget(page).locator('[data-aa-cookie="1"]').first().evaluate((element) => element.removeAttribute('data-aa-cookie')).catch(() => {});
}

async function clickMarkedShadowCookie(page) {
  try {
    await shadowCookieTarget(page).locator('[data-aa-cookie="1"]').first().click({ timeout: 6_000 });
    return true;
  } catch {
    return false;
  } finally {
    await clearShadowCookieMarker(page);
  }
}

/**
 * Marks the first cookie control of a shadow root, in the main document and
 * then in up to COOKIE_SHADOW_FRAME_LIMIT embedded frames. `act` is set only
 * when the caller clicks the mark: a save control then has its shadow root's
 * optional categories withdrawn first; a read-only check changes nothing.
 */
async function markShadowCookieButton(page, { includePreferences = false, act = false } = {}) {
  const args = [COOKIE_REJECT_RE.source, COOKIE_ACCEPT_RE.source, COOKIE_CUSTOMIZE_RE.source, COOKIE_MANAGE_CONSENT_RE.source,
    COOKIE_GENERIC_PREFERENCES_RE.source, COOKIE_MANAGER_SURFACE_RE.source, includePreferences,
    COOKIE_SAVE_RE.source, COOKIE_ALWAYS_ACTIVE_RE.source, COOKIE_REQUIRED_CATEGORY_RE.source, act, COOKIE_TOGGLE_LIMIT];
  const frames = typeof page?.frames === 'function' ? page.frames() : [];
  for (const target of [page, ...frames.slice(1, 1 + COOKIE_SHADOW_FRAME_LIMIT)]) {
    if (typeof target?.evaluate !== 'function' || typeof target?.locator !== 'function') continue;
    let kind = '';
    try {
      kind = await target.evaluate(markShadowCookieInPage, args);
    } catch {
      kind = '';
    }
    if (typeof kind !== 'string' || !kind) continue;
    if (target === page) shadowCookieTargets.delete(page);
    else shadowCookieTargets.set(page, target);
    return kind;
  }
  return '';
}

function markShadowCookieInPage([reject, accept, customize, manageConsent, genericPreferences, managerSurfacePattern, include,
  save, alwaysActivePattern, requiredPattern, act, toggleLimit]) {
  const roots = [document];
  const shadows = [];
  for (let index = 0; index < roots.length && index < 50; index += 1) {
    for (const element of roots[index].querySelectorAll('*')) {
      if (!element.shadowRoot) continue;
      roots.push(element.shadowRoot);
      shadows.push(element.shadowRoot);
    }
  }
  const cookieShadowSurfaceIsActive = (host, manageConsentAction = false) => {
    for (let node = host; node && node !== document.body; node = node.parentElement) {
      const marker = [node.id, node.className, node.getAttribute('role'), node.getAttribute('aria-label')]
        .filter(Boolean).join(' ');
      if (node.matches('dialog, [role="dialog"], [aria-modal="true"]')
        || /\b(?:banner|notice|overlay|modal|dialog)\b/i.test(marker)) return true;
    }
    return false;
  };
  const cookieShadowManagerSurfaceIsActive = (host) => {
    const managerSurface = new RegExp(managerSurfacePattern, 'i');
    for (let node = host; node && node !== document.documentElement; node = node.parentElement) {
      const marker = [node.id, node.className, node.getAttribute('role'), node.getAttribute('aria-label')]
        .filter(Boolean).join(' ');
      if (!managerSurface.test(marker)) continue;
      if (node.matches('form, [role="form"]')) continue;
      if (!/\bcookies?\b/i.test(`${node.innerText || node.textContent || ''} ${host.textContent || ''}`)) continue;
      return true;
    }
    return false;
  };
  const withdrawOptional = (shadow) => {
    const alwaysActive = new RegExp(alwaysActivePattern, 'i');
    const required = new RegExp(requiredPattern, 'i');
    const toggleSelector = 'input[type="checkbox"], [role="switch"], [role="checkbox"]';
    for (const toggle of [...shadow.querySelectorAll(toggleSelector)].slice(0, toggleLimit)) {
      const native = toggle.tagName === 'INPUT';
      const on = native ? toggle.checked : toggle.getAttribute('aria-checked') === 'true';
      if (!on || toggle.disabled || toggle.getAttribute('aria-disabled') === 'true') continue;
      let row = toggle;
      while (row.parentElement && row.parentElement.querySelectorAll(toggleSelector).length === 1) row = row.parentElement;
      if (alwaysActive.test(row.textContent || '')) continue;
      const titles = [...row.querySelectorAll('h1, h2, h3, h4, h5, h6, legend, summary, strong, b, label, [class*="title" i], [class*="name" i]')]
        .map((node) => String(node.textContent || '').trim()).filter((text) => text && text.length <= 80);
      // The toggle's associated names count as much as the row's titles: an `aria-labelledby` name or a
      // `<label for>` elsewhere in the shadow root («Necessary») keeps a required category on.
      const byId = (id) => (shadow.getElementById ? shadow.getElementById(id) : shadow.querySelector(`#${CSS.escape(id)}`))
        || document.getElementById(id);
      const associated = [
        ...String(toggle.getAttribute('aria-labelledby') || '').split(/\s+/).filter(Boolean)
          .map((id) => String(byId(id)?.textContent || '').trim()),
        ...[...(toggle.labels || [])].map((node) => String(node.textContent || '').trim()),
        ...(toggle.id ? [...shadow.querySelectorAll(`label[for="${CSS.escape(toggle.id)}"]`)].map((node) => String(node.textContent || '').trim()) : []),
      ].filter(Boolean);
      if (required.test([toggle.getAttribute('aria-label'), toggle.getAttribute('title'), ...associated, ...titles].join(' '))) continue;
      toggle.click();
    }
  };
  const actions = [{ kind: 'decision', source: reject }, { kind: 'decision', source: save, save: true }, { kind: 'decision', source: accept }];
  if (include) actions.push({ kind: 'preferences', source: customize }, { kind: 'preferences', source: manageConsent }, { kind: 'preferences', source: genericPreferences });
  for (const action of actions) {
    const pattern = new RegExp(action.source, 'i');
    const isManageConsent = action.source === manageConsent;
    for (const shadow of shadows) {
      const manageConsentAction = action.kind === 'preferences' && action.source === manageConsent;
      if (action.kind === 'preferences' && (shadow.host.closest('header, nav, footer, [role="banner"], [role="navigation"], [role="contentinfo"]')
        || (manageConsentAction
          ? !cookieShadowManagerSurfaceIsActive(shadow.host)
          : !cookieShadowSurfaceIsActive(shadow.host)))) continue;
      const button = [...shadow.querySelectorAll('button, [role="button"]')]
        .find((element) => {
          const label = String(element.innerText || element.textContent || '').trim();
          return element.getBoundingClientRect().width > 0
            && !element.disabled && element.getAttribute('aria-disabled') !== 'true'
            && !(action.kind === 'preferences' && isManageConsent
              && (element.closest('form, [role="form"]')
                || shadow.host.closest('form, [role="form"]')))
            && pattern.test(label) && /\bcookies?\b/i.test(`${label} ${shadow.textContent || ''}`);
        });
      if (button) {
        if (action.save && act) withdrawOptional(shadow);
        button.setAttribute('data-aa-cookie', '1');
        return action.kind;
      }
    }
  }
  return '';
}

async function confirmCookieChoiceDismissed(page, snapshot, origin, blockingControl = null, { verifyShadow = false, openedBy = null } = {}) {
  await page.waitForTimeout(800);
  const current = await cookiePageSnapshot(page);
  if (!current || !origin || pageOrigin(page) !== origin) return { status: 'unresolved', snapshot: current || snapshot };
  // Consent law keeps an opener after every choice: a «Cookie settings» link
  // in the site's header or footer, or a floating tab such as Complianz's
  // «Manage consent» (order 1EpmkrDu: «Ablehnen» closed the banner, the tab
  // appeared, and the run stopped on cookie_preferences_unresolved). Once the
  // decision controls are gone, such an opener is the persistent entry point,
  // not the banner still waiting for an answer (blockingCookiePreferences).
  if (await cookieChoice(page, current)
    || (await blockingCookiePreferences(page, current, openedBy)).length > 0
    || cookieDialogRemains(current, blockingControl)) return { status: 'unresolved', snapshot: current };
  if (verifyShadow) {
    let shadowAction = await markShadowCookieButton(page);
    if (shadowAction) {
      await clearShadowCookieMarker(page);
      return { status: 'unresolved', snapshot: current };
    }
    shadowAction = await markShadowCookieButton(page, { includePreferences: true });
    if (shadowAction) {
      await clearShadowCookieMarker(page);
      return { status: 'unresolved', snapshot: current };
    }
  }
  return { status: 'dismissed', snapshot: current };
}

export async function dismissCookieBanner(page, snapshot) {
  let choice = await cookieChoice(page, snapshot);
  if (choice) return clickCookieChoice(page, snapshot, choice);

  // A collapsed reopener (a consent already given, or a region without a
  // banner) is no banner waiting for an answer: opening it would only ask the
  // same question again on every hop.
  let preferences = null;
  for (const control of await findCookieControls(page, snapshot, COOKIE_CUSTOMIZE_RE, { genericPreferences: true, manageConsent: true })) {
    if (await isCollapsedCookieReopener(page, control)) continue;
    preferences = control;
    break;
  }
  if (preferences) {
    const origin = pageOrigin(page);
    try {
      await clickButton(page, preferences);
    } catch {
      return { status: 'unresolved', snapshot };
    }
    await page.waitForTimeout(800);
    let current = await cookiePageSnapshot(page);
    if (!current || !origin || pageOrigin(page) !== origin) return { status: 'unresolved', snapshot: current || snapshot };
    choice = await cookieChoice(page, current);
    if (!choice) {
      // Manage consent can open a shadow-root preference center whose explicit
      // Reject/Accept controls are absent from the regular DOM snapshot.
      const shadowDecision = await markShadowCookieButton(page, { act: true });
      if (shadowDecision !== 'decision') return { status: 'unresolved', snapshot: current };
      if (!await clickMarkedShadowCookie(page)) return { status: 'unresolved', snapshot: current };
      return confirmCookieChoiceDismissed(page, current, origin, preferences, {
        verifyShadow: true, openedBy: preferences,
      });
    }
    return clickCookieChoice(page, current, choice, { openedBy: preferences });
  }

  // A banner inside a shadow root (Usercentrics on Coop's career pages,
  // 2026-10-02) is out of the page scan's reach while its overlay takes every
  // click. Only a shadow root's own cookie controls are marked and clicked.
  let shadowAction = await markShadowCookieButton(page, { act: true });
  if (shadowAction === 'decision') {
    if (!await clickMarkedShadowCookie(page)) return { status: 'unresolved', snapshot };
    await page.waitForTimeout(800);
    const current = await cookiePageSnapshot(page);
    if (!current || await cookieChoice(page, current)
      || (await blockingCookiePreferences(page, current)).length > 0) return { status: 'unresolved', snapshot: current || snapshot };
    shadowAction = await markShadowCookieButton(page, { includePreferences: true });
    if (shadowAction) {
      await clearShadowCookieMarker(page);
      return { status: 'unresolved', snapshot: current };
    }
    return { status: 'dismissed', snapshot: current };
  }

  shadowAction = await markShadowCookieButton(page, { includePreferences: true, act: true });
  if (shadowAction !== 'preferences') return { status: 'none', snapshot };
  const origin = pageOrigin(page);
  if (!await clickMarkedShadowCookie(page)) return { status: 'unresolved', snapshot };
  await page.waitForTimeout(800);
  let current = await cookiePageSnapshot(page);
  if (!current || !origin || pageOrigin(page) !== origin) return { status: 'unresolved', snapshot: current || snapshot };
  choice = await cookieChoice(page, current);
  if (choice) return clickCookieChoice(page, current, choice);
  shadowAction = await markShadowCookieButton(page, { act: true });
  if (shadowAction !== 'decision') return { status: 'unresolved', snapshot: current };
  if (!await clickMarkedShadowCookie(page)) return { status: 'unresolved', snapshot: current };
  await page.waitForTimeout(800);
  current = await cookiePageSnapshot(page);
  if (!current || await cookieChoice(page, current)
    || (await blockingCookiePreferences(page, current)).length > 0) return { status: 'unresolved', snapshot: current || snapshot };
  shadowAction = await markShadowCookieButton(page, { includePreferences: true });
  if (shadowAction) {
    await clearShadowCookieMarker(page);
    return { status: 'unresolved', snapshot: current };
  }
  return { status: 'dismissed', snapshot: current };
}

// Deterministic passes over one page before the agentic fallback: a manager
// can redraw or animate between the reads, and a second pass may find the
// opener's layer (open the preferences, then reject). Each choice is
// idempotent: refusing optional cookies twice never sends an application.
const COOKIE_RESOLUTION_ATTEMPTS = 3;
const COOKIE_RESOLUTION_BACKOFF_MS = 700;
// The cookie agent: at most this many pages per run, this many rounds each.
const COOKIE_AGENT_MAX_PAGES = 2;
const COOKIE_AGENT_ROUNDS = 3;
// Never the cookie agent's to press (agent.mjs refusal() also keeps every
// final submit, apply and navigation control): the application's own entry,
// the account's sign-in and registration.
export const COOKIE_AGENT_RESERVED_BUTTONS = [
  /\b(?:apply|bewerb\w*|candid\w*|postul\w*|application|bewerbung)\b/i,
  SIGN_IN_RE,
  CREATE_ACCOUNT_RE,
  /\b(?:log ?in|anmelden|einloggen|accedi|connexion|regist\w*|konto|account)\b/i,
];

/**
 * Closes the cookie manager in front of the page: up to
 * COOKIE_RESOLUTION_ATTEMPTS deterministic passes (dismissCookieBanner) with a
 * growing pause, then, when the caller passes `agent`, one agentic attempt.
 * The agent's work counts only when a fresh deterministic pass then finds no
 * manager left (`none`) or closes what remains (`dismissed`).
 * @returns {Promise<{status:'none'|'dismissed'|'unresolved', snapshot:object, attempts:string[], agent?:string}>}
 */
export async function resolveCookieConsent(page, snapshot, { agent = null } = {}) {
  const origin = pageOrigin(page);
  const attempts = [];
  let current = snapshot;
  let result = { status: 'none', snapshot };
  for (let attempt = 1; attempt <= COOKIE_RESOLUTION_ATTEMPTS; attempt += 1) {
    result = await dismissCookieBanner(page, current);
    attempts.push(result.status);
    if (result.status !== 'unresolved') return { ...result, attempts };
    // A choice that left the site is never retried there.
    if (!origin || pageOrigin(page) !== origin || attempt === COOKIE_RESOLUTION_ATTEMPTS) break;
    if (typeof page.waitForTimeout === 'function') await page.waitForTimeout(COOKIE_RESOLUTION_BACKOFF_MS * attempt);
    current = await cookiePageSnapshot(page) || result.snapshot || current;
  }
  if (typeof agent !== 'function' || !origin || pageOrigin(page) !== origin) return { ...result, attempts };
  let outcome = null;
  try {
    outcome = await agent(page, result.snapshot || current);
  } catch {
    outcome = { status: 'stuck', acted: false };
  }
  const agentStatus = String(outcome?.status || 'unavailable');
  if (!outcome?.acted || pageOrigin(page) !== origin) return { ...result, attempts, agent: agentStatus };
  const fresh = await cookiePageSnapshot(page);
  if (!fresh) return { ...result, attempts, agent: agentStatus };
  const verified = await dismissCookieBanner(page, fresh);
  attempts.push(verified.status);
  return { ...verified, attempts, agent: agentStatus };
}

async function visibleStadtZurichPostingLinks(page) {
  const frames = typeof page?.frames === 'function' ? page.frames() : [];
  const links = [];
  for (const frame of frames.slice(0, 5)) {
    const found = await frame.evaluate(() => [...document.querySelectorAll('a[href]')]
      .filter((element) => {
        const rect = element.getBoundingClientRect();
        const style = window.getComputedStyle(element);
        return rect.width > 0 && rect.height > 0
          && style.display !== 'none' && style.visibility !== 'hidden'
          && element.getAttribute('aria-hidden') !== 'true';
      })
      .slice(0, 200)
      .map((element) => ({
        labelledBy: (element.getAttribute('aria-labelledby') || '').split(/\s+/).filter(Boolean)
          .map((id) => document.getElementById(id)?.innerText || document.getElementById(id)?.textContent || '')
          .join(' ').replace(/\s+/g, ' ').trim(),
        text: String(element.innerText || element.textContent || '').replace(/\s+/g, ' ').trim(),
        label: String(element.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim(),
        title: String(element.getAttribute('title') || '').replace(/\s+/g, ' ').trim(),
        ariaLabel: String(element.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim(),
        href: element.href || '',
      }))).catch(() => []);
    links.push(...(Array.isArray(found) ? found : []));
  }
  return links;
}

async function recoverStadtZurichPublicJobSearch(page, snapshot, stageContext, { searched = false } = {}) {
  const title = String(stageContext?.job?.title || '').trim();
  if (!title || !isStadtZurichPublicJobSearchRoute(page.url())
    || !isNonApplicationJobSearchSurface(snapshot)) return { snapshot, searched, target: '' };

  const liveLinks = await visibleStadtZurichPostingLinks(page);
  const target = stadtZurichPublicPostingTarget({
    ...snapshot,
    url: page.url(),
    links: [...(Array.isArray(snapshot.links) ? snapshot.links : []), ...liveLinks],
  }, title, page.url());
  if (target) {
    await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await settle(page);
    await page.waitForTimeout(1200);
    return { snapshot: await extractFields(page, NAVIGATION), searched, target };
  }
  if (searched) return { snapshot, searched, target: '' };

  const keywordFields = (Array.isArray(snapshot.fields) ? snapshot.fields : []).filter((field) => {
    const text = [field?.label, field?.name, field?.id, field?.context, field?.section].filter(Boolean).join(' ');
    return field?.kind === 'text' && !field?.disabled && !field?.readOnly && PUBLIC_JOB_KEYWORD_RE.test(text);
  });
  const searchButtons = (Array.isArray(snapshot.buttons) ? snapshot.buttons : []).filter(isStadtZurichPublicSearchButton);
  if (keywordFields.length !== 1 || searchButtons.length !== 1) return { snapshot, searched, target: '' };
  const keywordField = keywordFields[0];
  const searchButton = searchButtons[0];
  const sameFrame = (Number(keywordField.frame) || 0) === (Number(searchButton.frame) || 0);
  const sameForm = keywordField.formId && searchButton.formId && keywordField.formId === searchButton.formId;
  if (!sameFrame || (keywordField.formId && searchButton.formId && !sameForm)) return { snapshot, searched, target: '' };

  try {
    const input = locatorFor(page, keywordField);
    await input.fill(title, { timeout: 6_000 });
    if (await input.inputValue().catch(() => '') !== title) return { snapshot, searched: true, target: '' };
    await clickButton(page, searchButton);
    await settle(page);
    await page.waitForTimeout(1200);
    return { snapshot: await extractFields(page, NAVIGATION), searched: true, target: '' };
  } catch {
    return { snapshot, searched: true, target: '' };
  }
}

/**
 * From the posting to the form, up to three hops (Workday: "Bewerben", then
 * "Manuell bewerben"; a cookie banner can come back on each page). A new tab
 * opened by the apply button is followed.
 */
async function openApplicationForm(context, page, snapshot, stageContext = null) {
  // Keep provenance separate from URL binding. A posting can legitimately
  // open a generic ATS form that names neither the role nor the employer, but
  // only when the runner actually followed that posting's owned Apply control.
  // The caller still needs a matching posting before this flag can authorize
  // the generic form; it is not a blanket fallback for a direct apply URL.
  let enteredThroughApplicationEntry = false;
  let resolvedPostingUrl = '';
  let publicSearchTarget = false;
  let publicSearchSearched = false;
  const result = (extra = {}) => ({
    page,
    snapshot,
    enteredThroughApplicationEntry,
    ...(resolvedPostingUrl ? { resolvedPostingUrl } : {}),
    ...(publicSearchTarget ? { publicSearchTarget: true } : {}),
    ...extra,
  });
  const reportNavigation = ({ hop, phase, cookieStatus, controls = [], ownedEntries = [], entryResolution = null, selectedControlKind = 'none', linkVisible = false }) => {
    if (typeof stageContext?.onPortalNavigationDiagnostic !== 'function') return;
    let location = null;
    try {
      const url = new URL(page.url());
      location = { host: url.hostname.slice(0, 253), path: url.pathname.slice(0, 180) };
    } catch {
      // A location is optional; never pass the raw URL to the observer.
    }
    const boundedCount = (value, max) => Math.min(max, Math.max(0, Number.isInteger(value) ? value : 0));
    try {
      stageContext.onPortalNavigationDiagnostic({
        hop: boundedCount(hop, 3),
        phase: ['cookie_check', 'entry_selection', 'after_click', 'direct_route'].includes(phase) ? phase : 'cookie_check',
        cookieStatus: ['none', 'dismissed', 'unresolved'].includes(cookieStatus) ? cookieStatus : 'unresolved',
        location,
        applicationControlCandidateCount: boundedCount(controls.length, 50),
        applicationEntryControlCount: boundedCount(ownedEntries.length, 20),
        ...(entryResolution ? { entryResolution } : {}),
        selectedControlKind: ['none', 'button', 'manual_button', 'link'].includes(selectedControlKind) ? selectedControlKind : 'none',
        linkVisible: linkVisible === true,
      });
    } catch {
      // A test-only observer must not change the portal runner's behavior.
    }
  };
  for (let hop = 0; hop < 3; hop += 1) {
    if (stageContext && workdayPostingRouteMismatch(page.url(), stageContext.applyUrl)) {
      return result({ handoff: 'posting_mismatch' });
    }
    const cookies = await resolveCookieConsent(page, snapshot, { agent: stageContext?.cookieAgent || null });
    snapshot = cookies.snapshot || snapshot;
    const publicRecovery = await recoverStadtZurichPublicJobSearch(page, snapshot, stageContext, {
      searched: publicSearchSearched,
    });
    if (publicRecovery.target) {
      resolvedPostingUrl = publicRecovery.target;
      publicSearchTarget = true;
      publicSearchSearched = publicRecovery.searched;
      stageContext = {
        ...(stageContext || {}),
        postingUrl: publicRecovery.target,
        allowSingleExternalApplicationEntry: true,
        publicPostingTarget: true,
      };
      snapshot = publicRecovery.snapshot || snapshot;
      continue;
    }
    if (publicRecovery.searched && !publicSearchSearched) publicSearchSearched = true;
    snapshot = publicRecovery.snapshot || snapshot;
    const allControls = [
      ...(Array.isArray(snapshot.buttons) ? snapshot.buttons : []),
      ...(Array.isArray(snapshot.links) ? snapshot.links : []),
    ];
    const applicationControls = allControls.filter((control) => !control?.disabled && !control?.chrome
      && (startsApplication(control?.text || control?.label) || isJobRoomExternalApplicationLabel(control)));
    const ownedEntries = applicationEntryControls(snapshot, stageContext);
    const entryContextChecks = applicationControls.map((control) => {
      const context = String(control?.vacancyContext || '').trim();
      return {
        hasBoundedContext: Boolean(context),
        roleMatches: Boolean(context && stageContext?.job?.title && titleMatches(context, stageContext.job.title)),
        employerMatches: Boolean(context && postingMatch(context, stageContext?.job || {}, stageContext?.postingUrl) === 'match'),
        otherEmployerDetected: Boolean(context && namesAnotherEmployer(context, stageContext?.job || {}, { allowPostingLocation: true })),
        contextMatches: applicationEntryContextMatchesPosting(control, stageContext),
      };
    });
    const entryResolution = {
      externalFallbackAllowed: stageContext?.allowSingleExternalApplicationEntry === true,
      candidateCount: Math.min(20, entryContextChecks.length),
      boundedVacancyContextCount: Math.min(20, entryContextChecks.filter((item) => item.hasBoundedContext).length),
      vacancyRoleMatchCount: Math.min(20, entryContextChecks.filter((item) => item.roleMatches).length),
      vacancyEmployerMatchCount: Math.min(20, entryContextChecks.filter((item) => item.employerMatches).length),
      vacancyEmployerConflictCount: Math.min(20, entryContextChecks.filter((item) => item.otherEmployerDetected).length),
      vacancyContextMatchCount: Math.min(20, entryContextChecks.filter((item) => item.contextMatches).length),
    };
    const cookieStatus = ['none', 'dismissed', 'unresolved'].includes(cookies.status) ? cookies.status : 'unresolved';
    reportNavigation({ hop: hop + 1, phase: 'cookie_check', cookieStatus, controls: applicationControls, ownedEntries, entryResolution });
    if (cookies.status === 'unresolved') return result({ handoff: 'cookie_preferences_unresolved' });
    let workdayStage = null;
    if (stageContext && isWorkdayTenantUrl(stageContext.applyUrl)) {
      workdayStage = applicationStage({ ...snapshot, text: await pageText(page) }, { ...stageContext, url: page.url() });
      // Reject a Workday profile/talent-pool route before its generic fields
      // can be mistaken for the selected requisition's application form.
      if (workdayStage.kind === 'posting_mismatch') return result({ handoff: 'posting_mismatch' });
      // A resumed account/review page is already inside the application.
      // Its Apply belongs to the stage classifier and final guard below.
      if (['receipt', 'review_navigation', 'final_review'].includes(workdayStage.kind) || workdayStage.prefinal
        || (REVIEW_URL_RE.test(new URL(page.url()).pathname) && findButton(snapshot.buttons, SUBMIT_RE))) return result();
    }
    if (hasApplicationForm(snapshot)) {
      const applicantContext = verifiedUmantisApplicantContext(stageContext, page.url());
      if (applicantContext) {
        verifiedUmantisApplicantPages.set(page, applicantContext);
        snapshot = verifiedUmantisApplicantAddressSnapshot(snapshot, page.url(), applicantContext);
      }
      return result();
    }
    if (stageContext) {
      const stage = workdayStage || applicationStage({ ...snapshot, text: await pageText(page) }, { ...stageContext, url: page.url() });
      // A resumed account/review page is already inside the application. Its
      // Apply belongs to the stage classifier and final guard below.
      if (['receipt', 'review_navigation', 'final_review', 'posting_mismatch'].includes(stage.kind) || stage.prefinal
        || (REVIEW_URL_RE.test(new URL(page.url()).pathname) && findButton(snapshot.buttons, SUBMIT_RE))) return result();
    }
    // A verified same-requisition SuccessFactors module route binds the
    // vacancy more strongly than a Career Site Builder Apply dropdown, whose
    // menu leads to the tenant's generic sign-in. Keep that route first.
    const disclosureOnly = ownedEntries.length > 0 && ownedEntries.every((control) => control.popup === true);
    const verifiedModuleRoute = disclosureOnly && hop === 0 && stageContext?.postingEntry === true
      && isSuccessFactorsPostingEntry({
        applyUrl: stageContext.applyUrl,
        postingUrl: page.url(),
        postingRouteProof: stageContext.postingRouteProof,
      });
    const selectableEntries = verifiedModuleRoute ? [] : ownedEntries;
    const buttonEntries = selectableEntries.filter((control) => (snapshot.buttons || []).includes(control));
    const manual = selectableEntries.find((control) => MANUAL_APPLY_RE.test(control.text || control.label || '')) || null;
    const apply = manual ? null : buttonEntries[0] || null;
    const linkEntry = manual || apply
      ? null
      : selectableEntries.find((control) => (snapshot.links || []).includes(control)) || null;
    const link = linkEntry ? locatorFor(page, linkEntry) : null;
    const linkVisible = link
      ? await link.waitFor({ state: 'visible', timeout: 6_000 }).then(() => true, () => false)
      : false;
    const selectedControlKind = manual ? 'manual_button' : apply ? 'button' : linkVisible ? 'link' : 'none';
    reportNavigation({
      hop: hop + 1, phase: 'entry_selection', cookieStatus, controls: applicationControls, ownedEntries,
      entryResolution,
      selectedControlKind, linkVisible,
    });
    if (!manual && !apply && !linkVisible) {
      // Some Jobs2Web postings render an empty shell (often only the language
      // selector) while their same-ID apply route is ready. Warm the posting
      // first, then open that exact verified endpoint; a redirect or mismatched
      // form is still checked below and handed off without a final click.
      if (hop === 0 && stageContext?.postingEntry
        && isSuccessFactorsPostingEntry({
          applyUrl: stageContext.applyUrl,
          postingUrl: page.url(),
          postingRouteProof: stageContext.postingRouteProof,
        })) {
        const applicationUrl = new URL(stageContext.applyUrl).toString();
        if (applicationUrl !== page.url()) {
          await page.goto(applicationUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
          await settle(page);
          await page.waitForTimeout(1200);
          snapshot = await extractFields(page, NAVIGATION);
          reportNavigation({ hop: hop + 1, phase: 'direct_route', cookieStatus, controls: applicationControls, ownedEntries });
          if (!isSuccessFactorsPostingEntry({
            applyUrl: page.url(),
            postingUrl: stageContext.postingUrl,
            postingRouteProof: stageContext.postingRouteProof,
          })) {
            return result({ handoff: 'posting_mismatch' });
          }
          continue;
        }
      }
      const directApplicationUrl = verifiedDirectApplicationUrl(stageContext, page.url());
      if (directApplicationUrl) {
        await page.goto(directApplicationUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
        await settle(page);
        await page.waitForTimeout(1200);
        snapshot = await extractFields(page, NAVIGATION);
        reportNavigation({ hop: hop + 1, phase: 'direct_route', cookieStatus, controls: applicationControls, ownedEntries });
        continue;
      }
      return result();
    }
    if (manual || apply) {
      enteredThroughApplicationEntry = true;
      const workdayManualTarget = manual
        ? workdayManualApplicationTarget(page.url(), stageContext?.applyUrl, manual)
        : '';
      if (workdayManualTarget) {
        await page.goto(workdayManualTarget, { waitUntil: 'domcontentloaded', timeout: 60_000 });
      } else {
        const popup = context.waitForEvent('page', { timeout: POPUP_GRACE_MS }).catch(() => null);
        await clickButton(page, manual || apply);
        page = (await popup) || page;
      }
    } else {
      enteredThroughApplicationEntry = true;
      page = (await clickPortalLink(page, link, { context })) || page;
    }
    await settle(page);
    await page.waitForTimeout(1200); // a modal (Workday's apply dialog) finishes its animation
    snapshot = await extractFields(page, NAVIGATION);
    reportNavigation({
      hop: hop + 1, phase: 'after_click', cookieStatus, controls: applicationControls, ownedEntries,
      selectedControlKind, linkVisible,
    });
  }
  return result();
}

function verifiedDirectApplicationUrl(stageContext, currentUrl) {
  if (stageContext?.postingEntry !== true || !stageContext.applyUrl) return '';
  try {
    const current = new URL(String(currentUrl || ''));
    const application = new URL(String(stageContext.applyUrl));
    if (current.protocol !== 'https:' || application.protocol !== 'https:'
      || current.username || current.password || application.username || application.password
      || current.href === application.href
      || !isVerifiedPostingEntry({
        applyUrl: application.href,
        postingUrl: current.href,
        postingRouteProof: stageContext.postingRouteProof,
      })) return '';
    return application.href;
  } catch {
    return '';
  }
}

const normalizeWords = (text) => String(text || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ');
// Legal forms and short words name no company: "Ospedale ABC SA" is "ospedale abc",
// "Coop Genossenschaft" is "coop" (its SuccessFactors pages say only "Coop").
const NOT_A_NAME = new Set(['sa', 'ag', 'gmbh', 'sagl', 'srl', 'spa', 'sarl', 'ltd', 'inc', 'llc', 'kg', 'genossenschaft', 'cooperativa', 'cooperative', 'the', 'und', 'and', 'del', 'della', 'des', 'les', 'der', 'die', 'das']);
const nameWords = (text) => normalizeWords(text).split(' ').filter((word) => word.length >= 3 && !NOT_A_NAME.has(word) && !/^\d+$/.test(word));
const TALENTSOFT_HOST_RE = /(?:^|\.)talent-soft\.com$/i;

/** The company's name words without a bracketed short form, when it has one and a distinctive name remains. */
function companyLongFormWords(company) {
  const raw = String(company || '');
  if (!/\([^)]*\)/.test(raw)) return [];
  const words = nameWords(raw.replace(/\([^)]*\)/g, ' '));
  return words.length >= 2 && hasDistinctiveCompanyIdentity(raw.replace(/\([^)]*\)/g, ' ')) ? words : [];
}

/** The company's short forms in brackets («(ECAM)», «(RhB)»), each as its name words. */
function companyShortForms(company) {
  return [...String(company || '').matchAll(/\(([^)]+)\)/g)]
    .map(([, alias]) => nameWords(alias))
    .filter((words) => words.length > 0);
}

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
    // The whole name without the short form the order adds in brackets is the same employer, written out:
    // «Ente Case Anziani Mendrisiotto (ECAM)» signs its notice «Ente Case Anziani Mendrisiotto» (CVRDEqJ3,
    // 2026-11-11). The short form alone stays no match (an «ECAM» or an «EOC» on a page is initials).
    const longForm = companyLongFormWords(job.company);
    return named.includes(` ${company.join(' ')} `)
      || (longForm.length > 0 && named.includes(` ${longForm.join(' ')} `))
      || talentSoftEmployerAliasMatches(pageText, job, pageUrl) ? 'match' : 'mismatch';
  }
  return titleMatches(pageText, job.title) ? 'match' : 'mismatch';
}

// A page's own vocabulary names no employer («Hotel application», «Bewerbung im Hotel Bereich»).
const FORM_VOCABULARY = new Set([
  'application', 'applications', 'apply', 'jetzt', 'now', 'maintenant', 'ora', 'subito', 'spater', 'bewerbung', 'bewerbungen', 'bewerben', 'candidatura', 'candidature', 'candidati', 'postuler',
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
  // Keep `one` out: next to an employer token it can be a proper-name suffix
  // (`Coop One`), while the adjacent `select` token still neutralizes «Select one».
  'select', 'selected',
]);
const POSTING_LOCATION_LABEL_WORDS = new Set([
  'region', 'regione', 'location', 'standort', 'sede', 'lieu',
  'address', 'adresse', 'indirizzo', 'city', 'ort', 'citta', 'ville',
  'canton', 'kanton', 'cantone', 'province', 'provincia',
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

function hasDistinctiveCompanyIdentity(company) {
  return nameWords(company).some((word) => !EMPLOYER_KIND_WORDS.has(word)
    && !FORM_VOCABULARY.has(word) && !BRANCH_WORDS.has(word));
}

function currentVacancyIdentityContexts(snapshot = {}) {
  const controls = [
    ...(Array.isArray(snapshot.buttons) ? snapshot.buttons : []),
    ...(Array.isArray(snapshot.links) ? snapshot.links : []),
  ];
  return [...new Set(controls.filter((control) => control && !control.disabled && !control.chrome
    && startsApplication(control.text || control.label))
    .map((control) => String(control.vacancyContext || '').trim())
    .filter((context) => context && context.length <= 700))];
}
// The kind of employer, alone in a title, names nobody: «Hotel application» is a hotel's form, whoever
// the hotel is (review of #11064). Next to a word of the order's company it is a name, though:
// «Esempio Resort» is not «Grand Hotel Esempio» (the neighbour rule does not take these for neutral).
const EMPLOYER_KIND_WORDS = new Set([
  'hotel', 'hotels', 'hotellerie', 'resort', 'restaurant', 'ristorante', 'gastronomie', 'spital', 'hospital', 'ospedale', 'hopital',
  'klinik', 'clinica', 'clinique', 'bank', 'banca', 'banque', 'group', 'gruppe', 'gruppo', 'groupe',
]);
// One kind of employer in the languages of a Swiss page. Next to a word of the order's company, the kind
// its own name carries, in another language, is still its name: «Bank Cler» writes «la Banca Cler» on its
// Italian postings (8BhQom09, 2026-11-11). Another kind stays another name: «Esempio Resort» is not
// «Grand Hotel Esempio».
const EMPLOYER_KIND_CLASS = new Map([
  ...['hotel', 'hotels', 'hotellerie'].map((word) => [word, 'hotel']),
  ...['restaurant', 'ristorante'].map((word) => [word, 'restaurant']),
  ...['spital', 'hospital', 'ospedale', 'hopital'].map((word) => [word, 'hospital']),
  ...['klinik', 'clinica', 'clinique'].map((word) => [word, 'clinic']),
  ...['bank', 'banca', 'banque'].map((word) => [word, 'bank']),
  ...['group', 'gruppe', 'gruppo', 'groupe'].map((word) => [word, 'group']),
]);
const employerKindsOf = (words) => new Set(words.map((word) => EMPLOYER_KIND_CLASS.get(word)).filter(Boolean));
// Filler that only joins two names («Muster und Hotel …»): skipping it can still reach a word of a name.
const JOINING_WORDS = new Set(['and', 'und', 'e', 'ed', 'et', 'o', 'or', 'oder', 'ou', 'sowie']);
// Filler between two words: skipped when looking for the word next to a company word.
const FILLER_WORDS = new Set([
  'the', 'and', 'for', 'our', 'your', 'with', 'at', 'this', 'that', 'und', 'der', 'die', 'das', 'den', 'dem', 'des', 'ein', 'eine', 'bei', 'beim',
  'als', 'von', 'vom', 'zum', 'zur', 'mit', 'per', 'con', 'una', 'uno', 'nel', 'nella', 'dei', 'del', 'della', 'degli', 'gli', 'les', 'pour',
  'chez', 'avec', 'aux', 'une',
]);
const filler = (word) => word.length < 3 || FILLER_WORDS.has(word) || /^\d+$/.test(word);
// What ends a phrase: a line, a dash between spaces, a bar, a dot, a colon… never a hyphen inside a word («Other-Hotel»).
const PHRASE_END_RE = /[\n\r—–|·•:;,.()\/]|\s-\s/;
// `one` is neutral only as the second token of the UI placeholder «Select one».
// Keep it significant elsewhere because it can be part of an employer name («Coop One»).
const isSelectOneLabelToken = (words, index) => (words[index] === 'select' && words[index + 1] === 'one')
  || (words[index] === 'one' && words[index - 1] === 'select');

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
function postingLocationSuffixWords(formText, ours, locationWords) {
  if (!locationWords.size) return new Set();
  const lines = String(formText || '').split(/\r?\n/).map((line) => normalizeWords(line).split(' ').filter(Boolean));
  const employerLines = lines.map((words) => words.some((word) => ours.has(word)));
  const neutral = new Set();
  for (const [lineIndex, words] of lines.entries()) {
    const locationIndexes = words.flatMap((word, index) => locationWords.has(word) ? [index] : []);
    if (!locationIndexes.length) continue;
    const employerBefore = employerLines.slice(Math.max(0, lineIndex - 2), lineIndex + 1).some(Boolean);
    if (!employerBefore) continue;
    const lastEmployer = Math.max(-1, ...words.map((word, index) => ours.has(word) ? index : -1));
    const locationIndex = locationIndexes.find((index) => lastEmployer < 0 || index > lastEmployer);
    if (locationIndex === undefined) continue;
    locationIndexes.forEach((index) => neutral.add(words[index]));
    const labelStart = lastEmployer >= 0 ? lastEmployer + 1 : Math.max(0, locationIndex - 1);
    words.slice(labelStart, locationIndex)
      .filter((word) => POSTING_LOCATION_LABEL_WORDS.has(word))
      .forEach((word) => neutral.add(word));
  }
  return neutral;
}

const NAVIGATION_TITLE_LINE_RE = /^(?:(?:open|close)(?: main)? navigation(?: menu)?|(?:open|close) menu|(?:main )?menu|navigation menu|skip(?: to)? (?:main )?(?:content|navigation)|jump to (?:main )?content|(?:salta|vai) al contenuto(?: (?:principale|generale))?|(?:weiter )?zum (?:haupt)?inhalt(?: springen)?|(?:springe|springen) zum (?:haupt)?inhalt|(?:aller|passer) au contenu(?: principal)?|accéder au contenu(?: principal)?)[.!…:]*$/i;

export function namesAnotherEmployer(formText, job = {}, { allowPostingLocation = false } = {}) {
  // With the name the posting's own data gives the employer (`organization`), when it is the same employer's.
  const ours = new Set([...nameWords(job.company), ...(sameEmployerFamily(job.organization, job.company) ? nameWords(job.organization) : [])]);
  if (!ours.size) return false;
  const text = String(formText || '');
  const postingLocationWords = allowPostingLocation
    ? new Set([
      ...nameWords(job.location),
      ...nameWords(job.addressLocality),
      ...nameWords(job.city),
      ...nameWords(job.workplace),
    ])
    : new Set();
  // A bounded posting card can put its own place after the employer (for
  // example «Coop Genossenschaft, Rickenbach»). Neutralize only that
  // employer-bound suffix; an unbound employer named like the place remains a
  // mismatch («Zurich AG» is not Coop's posting).
  const neutral = new Set([
    ...ours,
    ...nameWords(job.title),
    ...postingLocationSuffixWords(text, ours, postingLocationWords),
    ...NOT_A_NAME,
    // Vacancy cards can flatten their rows into one line («Coop Genossenschaft Standort Rickenbach»).
    // On an already-bound posting, the location-field label is metadata, not another employer name.
    ...(allowPostingLocation ? FIELD_LABEL_WORDS : []),
    ...FORM_VOCABULARY,
  ]);
  const titleLine = text.split(/\r?\n/).map((line) => line.trim())
    .find((line) => line && !NAVIGATION_TITLE_LINE_RE.test(line)) || '';
  // Page chrome may precede the posting's own heading. Ignore only known
  // navigation labels as a title candidate; the employer check below still
  // reads every phrase in the full page text.
  const title = normalizeWords(titleLine).split(' ').filter(Boolean);
  if (title.some((word, index) => !filler(word) && !neutral.has(word)
    && !EMPLOYER_KIND_WORDS.has(word) && !isSelectOneLabelToken(title, index))) return true;
  const ourKinds = employerKindsOf([...ours]);
  // The order's employer named whole: its name, its name without the short form in brackets, or that short form.
  const identities = [nameWords(job.company), companyLongFormWords(job.company), ...companyShortForms(job.company)]
    .filter((words) => words.length > 0);
  for (const phrase of text.split(PHRASE_END_RE)) {
    const words = normalizeWords(phrase).split(' ').filter(Boolean);
    // The same words with their case, when they line up one to one: a phrase in normal case (upper and lower
    // letters, no web address) writes a name with a capital and the sentence around it in lower case.
    const raw = String(phrase).normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^A-Za-z0-9]+/g, ' ').trim().split(' ').filter(Boolean);
    const cased = raw.length === words.length && /[a-z]/.test(phrase) && /[A-Z]/.test(phrase)
      && !/[a-z0-9-]+\.[a-z]{2,}/i.test(phrase);
    const proseWord = (at) => cased && /^[a-z]+$/.test(raw[at] || '');
    // Where the employer stands named whole (legal forms and filler between its words allowed).
    const wholeStarts = new Set();
    const wholeEnds = new Set();
    for (let index = 0; index < words.length; index += 1) {
      for (const identity of identities) {
        let at = index;
        let matched = 0;
        while (at < words.length && matched < identity.length) {
          if (words[at] === identity[matched]) matched += 1;
          else if (!(matched > 0 && (filler(words[at]) || NOT_A_NAME.has(words[at])))) break;
          at += 1;
        }
        if (matched === identity.length) {
          wholeStarts.add(index);
          wholeEnds.add(at - 1);
        }
      }
    }
    for (const [index, word] of words.entries()) {
      if (!ours.has(word)) continue;
      // The country of the order's company is on any form as a country too: next to it, the word that labels
      // the field says nothing about the employer. Next to any other word of the company, it still would.
      const labels = BRANCH_WORDS.has(word) ? FIELD_LABEL_WORDS : null;
      for (const step of [-1, 1]) {
        let at = index + step;
        let separated = false;
        // A legal form is skipped like filler: «Rituals Cosmetics Germany GmbH» ends in no one's name.
        while (words[at] !== undefined && (filler(words[at]) || NOT_A_NAME.has(words[at]))) {
          if (filler(words[at]) && !/^\d+$/.test(words[at]) && !JOINING_WORDS.has(words[at])) separated = true;
          at += step;
        }
        if (words[at] === undefined) continue;
        // Around the employer named whole, a sentence is not another name: an article or a preposition before
        // it («Rapporto di lavoro con l'ECAM», «oder die Bank Cler AG»: ECAM's form, CVRDEqJ3, 2026-11-11),
        // or a word in lower case next to it in a phrase in normal case («Die Bank Cler ist eine
        // Tochtergesellschaft …», Bank Cler's posting, 8BhQom09). A capitalised word there («Acme GmbH
        // Partners», «Coop One»), and any word next to a part of the name («Other Hotel», «other hotel»),
        // still declare someone else.
        const whole = step === -1 ? wholeStarts.has(index) : wholeEnds.has(index);
        if (whole && ((step === -1 && separated) || proseWord(at))) continue;
        if (!neutral.has(words[at]) && !labels?.has(words[at])
          && !(EMPLOYER_KIND_CLASS.has(words[at]) && ourKinds.has(EMPLOYER_KIND_CLASS.get(words[at])))
          && !isSelectOneLabelToken(words, at)) return true;
      }
    }
  }
  return false;
}

// The exact Stadt Zürich detail shell can put its tenant marker and the
// posting URL in the form text. They are route evidence, not a second
// employer; remove only those proven shell tokens before the conflict guard.
function boundPostingConflictText(formText, job, { pageUrl = '', postingUrl = '' } = {}) {
  const text = String(formText || '');
  const firstLine = text.split(/\r?\n/, 1)[0];
  if (!isStadtZurichPostingRoute({ pageUrl, postingUrl })
    || !/\bSTZH\b/iu.test(firstLine)
    || !titleMatches(firstLine, job?.title)) return text;
  const routeEvidence = [pageUrl, postingUrl].map(value => String(value || '')).filter(Boolean);
  return routeEvidence.reduce((current, value) => current.split(value).join(' '), text)
    .replace(/\b(?:Stellendetails|STZH)\b/giu, ' ');
}

/**
 * A company match alone can describe a careers landing page with an unrelated
 * single Apply control. Trust that control for a generic ATS form only when
 * the page title or selected route identifies the vacancy; a related-job card
 * in the body does not bind a separate Apply control to that vacancy.
 */
export function hasVacancySpecificPostingEvidence(pageText, job = {}, {
  pageUrl = '',
  pageTitle = '',
  pageHeading = '',
  postingUrl = '',
  postingRouteProof = null,
  vacancyIdentityContexts = [],
  uniqueApplicationEntryProven = false,
} = {}) {
  const sourceText = `${pageTitle}\n${pageText}`;
  const contexts = Array.isArray(vacancyIdentityContexts)
    ? vacancyIdentityContexts.filter((context) => typeof context === 'string' && context.trim() && context.length <= 700)
    : [];
  const company = String(job?.company || '').trim();
  if (company && !hasDistinctiveCompanyIdentity(company)) return false;
  const organizationCompatible = !job?.company || !job?.organization
    || sameEmployerFamily(job.organization, job.company);
  const routeBound = samePostingAddress(pageUrl, postingUrl)
    || isPostingRouteBound({ pageUrl, postingUrl, postingRouteProof });
  // On an exact selected-posting route the rendered text may start with
  // navigation chrome. The page's H1 remains authoritative when present. With
  // no H1, accept the role/employer in the page snapshot only when one owned
  // application entry is already bound to this vacancy. The conflict guard
  // below still checks the title and full page.
  const renderedHeading = String(pageHeading || '').trim();
  const documentTitle = String(pageTitle || '').trim();
  if (routeBound && pageHeading === null) return false;
  // A unique Apply control can stand in for an absent H1, but it cannot
  // override a visible heading that proves only part of a different role.
  if (routeBound && renderedHeading && !isRoleHeading(renderedHeading, job?.title)) return false;
  const noHeadingPostingIdentityProven = Boolean(uniqueApplicationEntryProven === true && job?.title && company
    && titleMatches(`${documentTitle}\n${pageText}`, job.title)
    && hasDistinctiveCompanyIdentity(company)
    && postingMatch(`${documentTitle}\n${pageText}`, job, pageUrl) === 'match');
  if (routeBound && !renderedHeading && !noHeadingPostingIdentityProven) return false;
  const routeTitleLine = routeBound
    ? (renderedHeading || (noHeadingPostingIdentityProven ? documentTitle : ''))
    : '';
  const conflictText = routeBound ? (routeTitleLine ? `${routeTitleLine}\n${pageText}` : pageText) : sourceText;
  if (!organizationCompatible || namesAnotherEmployer(conflictText, job, { allowPostingLocation: routeBound })) return false;
  if (routeBound) return true;
  const titleMatched = Boolean(job?.title && titleMatches(pageTitle, job.title));
  // The source page must identify the role in its title. Its employer may be
  // in the Apply control's bounded vacancy card. Arbitrary page text can also
  // contain a related vacancy, so it cannot prove this posting's employer.
  const matchesCurrentIdentity = (text) => titleMatches(text, job.title)
    && (!company || (hasDistinctiveCompanyIdentity(company) && postingMatch(text, job, pageUrl) === 'match'));
  const sourceIdentityMatched = matchesCurrentIdentity(pageTitle)
    || contexts.some(matchesCurrentIdentity);
  return titleMatched && sourceIdentityMatched;
}

/** Read-only reconciliation cannot use an Apply control or a persisted route proof. */
export function hasReadOnlyVacancyEvidence(pageText, job = {}, { pageTitle = '' } = {}) {
  const sourceText = `${pageTitle}\n${pageText}`;
  const company = String(job?.company || '').trim();
  if (!company || !hasDistinctiveCompanyIdentity(company)) return false;
  const organizationCompatible = !job?.organization || sameEmployerFamily(job.organization, company);
  return Boolean(organizationCompatible && job?.title
    && !namesAnotherEmployer(sourceText, job)
    && titleMatches(pageTitle, job.title)
    // Host aliases are acceptable for an application form reached from a
    // proven posting, but read-only reconciliation has no such provenance.
    && postingMatch(pageTitle, { ...job, company }) === 'match');
}

/**
 * A posting published as a document, not as a page: an official PDF notice
 * (ECAM's «Concorso generale permanente», CVRDEqJ3, 2026-11-11). A browser
 * shows it in its PDF viewer, with no text the runner can read and no Apply
 * control: the notice itself says to apply «tramite l'apposito modulo online»
 * on the employer's site.
 */
export function isPostingDocumentUrl(value) {
  try {
    const url = new URL(String(value || ''));
    return url.protocol === 'https:' && !url.username && !url.password && /\.pdf$/i.test(url.pathname);
  } catch {
    return false;
  }
}

function sameDocumentAddress(first, second) {
  try {
    const one = new URL(String(first || ''));
    const other = new URL(String(second || ''));
    return one.origin === other.origin && one.pathname === other.pathname && one.search === other.search;
  } catch {
    return false;
  }
}

// Any link to a PDF, over any scheme: a second document on the host page may be another notice.
function linksPdfDocument(href) {
  try {
    return /\.pdf$/i.test(new URL(String(href || '')).pathname);
  } catch {
    return false;
  }
}

/**
 * The posting document is the order's: one of its first lines (where a notice
 * puts its heading, after the letterhead) holds every word of the role and
 * every number of it but the workload («2026» in «Concorso generale
 * permanente 2026» is not last year's notice), and the document names the
 * employer whole (postingMatch, its bracketed short form left out).
 */
export function postingDocumentIdentity(documentText, job = {}) {
  const text = String(documentText || '');
  const title = String(job?.title || '');
  if (!title.trim() || !text.trim()) return false;
  const company = String(job?.company || '').trim();
  if (company && (!hasDistinctiveCompanyIdentity(company) || postingMatch(text, job) !== 'match')) return false;
  const numbers = (value) => (String(value || '').replace(/\b\d{1,3}(?:\s*[-–]\s*\d{1,3})?\s*%/g, ' ').match(/\d+/g) || []);
  const wanted = numbers(title);
  return text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).slice(0, 15)
    .some((line) => line.length <= 200 && titleMatches(line, title) && wanted.every((number) => numbers(line).includes(number)));
}

/**
 * The page that hosts the posting document: the employer's own page the
 * order's data names for applications (the runner opened it and stayed on it),
 * on the document's site, linking that exact document, and linking no other
 * PDF at all. A page that lists several notices is a list of postings: its
 * application control could be anyone's. A second PDF is never told apart by
 * its name or its link text: an opaque «Apri» or «other.pdf» can be another
 * notice (review of #18092), so any other PDF leaves the page unbound.
 */
export function postingDocumentHostBound(snapshot = {}, { pageUrl = '', postingUrl = '', applyUrl = '' } = {}) {
  if (!isPostingDocumentUrl(postingUrl) || !samePostingAddress(pageUrl, applyUrl)) return false;
  let documentHost = '';
  try {
    documentHost = new URL(postingUrl).hostname;
  } catch {
    return false;
  }
  if (!sameSite(pageUrl, documentHost)) return false;
  const documents = (Array.isArray(snapshot?.links) ? snapshot.links : [])
    .filter((link) => linksPdfDocument(link?.href));
  return documents.length > 0 && documents.every((link) => sameDocumentAddress(link.href, postingUrl));
}

/** The posting document's text, read as the crawler reads it (pdf-job-content.mjs); null when it has none. */
export async function readPostingDocument(url, { fetchImpl = fetch } = {}) {
  if (!isPostingDocumentUrl(url)) return null;
  const { extractPdfJobContentFromUrl } = await import('../../../lib/pdf-job-content.mjs');
  const result = await extractPdfJobContentFromUrl(url, { fetchImpl, proxyRescue: false, timeoutMs: 30_000 });
  const text = String(result?.rawText || result?.text || '');
  return text.trim() ? { text } : null;
}

/**
 * The page the runner opened is the posting document's host, and the
 * document read now is the order's posting: the page stands for the posting
 * (its single application control is the posting's, applicationEntryControls).
 * Recorded in the evidence without the document's text.
 */
async function postingDocumentHostMatch(snapshot, ctx = {}, pageUrl = '') {
  if (!isPostingDocumentUrl(ctx.postingUrl) || samePostingAddress(pageUrl, ctx.postingUrl)
    || !postingDocumentHostBound(snapshot, { pageUrl, postingUrl: ctx.postingUrl, applyUrl: ctx.applyUrl })) return null;
  const document = await (ctx.readPostingDocument || readPostingDocument)(ctx.postingUrl).catch(() => null);
  return { read: Boolean(document?.text), identity: postingDocumentIdentity(document?.text, ctx.job) };
}

/**
 * The posting's own id in its address: the number its last path segment ends
 * with («…-lugano-f-m-2779», «/stellen/2779»), the final path segment when it
 * is a whole UUID, or its posting-id parameter.
 */
const MAX_POSTING_ID_URL_LENGTH = 16_384;
const MAX_POSTING_ID_PATH_LENGTH = 8_192;
const MAX_POSTING_ID_PATH_SEGMENTS = 128;

function boundedPostingIdPathSegments(pathname) {
  const path = String(pathname || '');
  if (path.length > MAX_POSTING_ID_PATH_LENGTH) return null;
  let count = 0;
  let insideSegment = false;
  for (const character of path) {
    if (character === '/') {
      insideSegment = false;
    } else if (!insideSegment) {
      count += 1;
      if (count > MAX_POSTING_ID_PATH_SEGMENTS) return null;
      insideSegment = true;
    }
  }
  return path.split('/').filter(Boolean);
}

function postingAddressIds(postingUrl) {
  const ids = new Set();
  try {
    const address = String(postingUrl || '');
    if (!address || address.length > MAX_POSTING_ID_URL_LENGTH) return ids;
    const url = new URL(address);
    const key = portalJobKey(url.href);
    if (key) ids.add(String(key).toLowerCase());
    const segments = boundedPostingIdPathSegments(url.pathname);
    if (!segments) return ids;
    const lastSegment = segments[segments.length - 1] || '';
    const last = (() => {
      try {
        return decodeURIComponent(lastSegment);
      } catch {
        return lastSegment;
      }
    })();
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(last);
    if (isUuid) ids.add(last.toLowerCase());
    const tail = isUuid ? null : /(?:^|[-_])(\d{3,12})(?:\.[a-z0-9]{2,5})?$/i.exec(last)?.[1];
    if (tail) ids.add(tail);
  } catch {
    // No address, no id.
  }
  return ids;
}

/**
 * An Apply link on the posting page that carries the posting's own id as a
 * whole segment of its route or a whole parameter value: Bank Cler's
 * «…/offene-stellen/consulente-…-2779» opens «recruitingapp-2839.umantis.com/
 * Vacancies/2779/Application/CheckLogin/1» (8BhQom09, 2026-11-11). The id is
 * the requisition both addresses name; the ATS host alone is not.
 */
export function applicationEntryCarriesPostingId(href, postingUrl) {
  const ids = postingAddressIds(postingUrl);
  if (!ids.size) return false;
  try {
    const address = String(href || '');
    if (!address || address.length > MAX_POSTING_ID_URL_LENGTH) return false;
    const url = new URL(address);
    if (url.protocol !== 'https:' || url.username || url.password) return false;
    const rawSegments = boundedPostingIdPathSegments(url.pathname);
    if (!rawSegments) return false;
    const segments = rawSegments.map((segment) => decodeURIComponent(segment));
    return [...segments, ...url.searchParams.values()].some((value) => ids.has(String(value).toLowerCase()));
  } catch {
    return false;
  }
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
/**
 * The SuccessFactors application the runner asked for, read on the page itself (Stellenportal Bund eHSYErA1,
 * 2026-11-10). After sign-in SuccessFactors serves the form at `/portalcareer?_s.crb=…`, with neither the company
 * nor the requisition in its address, and a federal tenant names no employer the order's data names («Swiss Armed
 * Forces (VTG)» against «Schweizerische Eidgenossenschaft»): the company check alone said `mismatch` on the right
 * form. What binds it is the heading SuccessFactors writes on every application, the role and its requisition
 * («Application Manager/-in (20604)»), on the same tenant host as the module address the runner entered
 * (`/career?company=…&career_ns=job_application&career_job_req_id=20604`). Another requisition, another role, a
 * requisition away from the role's own line or another host is not this posting.
 */
export function successFactorsRequisitionShown(formText, job = {}, { pageUrl = '', applyUrl = '' } = {}) {
  let module;
  let page;
  try {
    module = successFactorsModuleIdentity(new URL(String(applyUrl || '')));
    page = new URL(String(pageUrl || ''));
  } catch {
    return false;
  }
  if (!module || !job?.title || page.origin !== module.origin
    || !['/portalcareer', '/career'].includes(page.pathname.replace(/\/+$/, ''))) return false;
  const requisition = new RegExp(`\\(\\s*${module.requisition}\\s*\\)`);
  const otherRequisition = /\(\s*\d{1,20}\s*\)/g;
  return String(formText || '').split(/\r?\n/).some((line) => requisition.test(line)
    && [...line.matchAll(otherRequisition)].every((found) => found[0].replace(/\D/g, '') === module.requisition)
    && titleMatches(line.replace(otherRequisition, ' '), job.title)
    && titleWordsOnly(line.replace(otherRequisition, ' '), job.title));
}

/**
 * The page's main heading is the order's role and nothing else: every word of
 * the role, and around it only gender markers or a workload («(m/w/d)»,
 * «80-100%»). Another role, an employer or a slogan in it is not this role.
 */
export function isRoleHeading(heading, title) {
  const text = String(heading || '').trim();
  if (!text || text.length > 200 || !title || !titleMatches(text, title)) return false;
  // A workload («80-100%», «100 %») is the only number allowed around the role; it is taken out before the
  // words, of the heading and of the order's title alike: a title that carries its own workload («Consulente …
  // Lugano (f/m) 50%», Bank Cler 8BhQom09, 2026-11-11) otherwise wants a «50» no heading can show any more.
  const withoutWorkload = (value) => String(value || '').replace(/\b\d{1,3}(?:\s*[-–]\s*\d{1,3})?\s*%/g, ' ');
  const wanted = new Set(normalizeWords(withoutWorkload(title)).split(' ').filter(Boolean));
  const seen = normalizeWords(withoutWorkload(text)).split(' ').filter(Boolean);
  const shown = new Set(seen);
  // Every word of the role is there («Product Manager» is not «IT Product Manager»), the gender markers of
  // the title aside, and nothing but those markers or a workload around it.
  return seen.length > 0 && [...wanted].every((word) => shown.has(word) || TITLE_GENDER_MARKERS.has(word))
    && seen.every((word) => wanted.has(word) || TITLE_GENDER_MARKERS.has(word));
}

/** The single main heading, '' when absent, or null when unavailable/ambiguous. */
export async function postingMainHeading(page) {
  if (typeof page?.evaluate !== 'function') return null;
  const headings = await page.evaluate(() => [...document.querySelectorAll('h1, [role="heading"][aria-level="1"]')]
    .filter((node) => {
      const rect = node.getBoundingClientRect();
      const style = window.getComputedStyle(node);
      return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
    })
    .map((node) => String(node.innerText || node.textContent || '').replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .slice(0, 201)).catch(() => null);
  // Distinct across every visible main heading: a different one after ten copies of the role still counts. A page
  // with more main headings than that is no single-heading posting.
  if (!Array.isArray(headings) || headings.length > 200) return null;
  const distinct = [...new Set(headings)];
  if (distinct.length > 1) return null;
  // The whole heading: isRoleHeading refuses one longer than a title, never a cut that hides «… at Other Employer».
  return distinct[0] || '';
}

/** The line names the role and nothing else of substance (no second role or employer around it). */
// Gender markers a portal adds to a title («m/w/d», «(a)», «-in»): no other role.
const TITLE_GENDER_MARKERS = new Set(['m', 'w', 'd', 'f', 'x', 'h', 'a', 'e', 'r', 'in', 'innen', 'div', 'divers']);
function titleWordsOnly(line, title) {
  const wanted = new Set(normalizeWords(title).split(' ').filter(Boolean));
  const seen = normalizeWords(line).split(' ').filter(Boolean);
  // Every other word is a different role or an employer («Senior …», «… bei X»).
  return seen.length > 0 && seen.every((word) => wanted.has(word) || TITLE_GENDER_MARKERS.has(word));
}

export function formPostingMatch(formText, job = {}, {
  postingMatched = false,
  postingEntry = false,
  applicationEntry = false,
  pageUrl = '',
  postingUrl = '',
  postingRouteProof = null,
  applyUrl = '',
} = {}) {
  const direct = postingMatch(formText, job, pageUrl);
  const formPostingUrl = umantisFormPostingUrl(pageUrl, postingUrl);
  const bound = isPostingRouteBound({ pageUrl, postingUrl: formPostingUrl, postingRouteProof });
  // A source-backed SuccessFactors module must still carry the requisition
  // captured from that posting. Do not let its employer query alone turn a
  // different or incomplete `/career` route into a generic form match.
  if (postingRouteProof?.via === 'successfactors' && isSuccessFactorsCareerPath(pageUrl) && !bound) return 'mismatch';
  // Umantis application forms can repeat the selected employer inside their
  // own questions (the EOC form asks about EOC collaborators and acquaintances).
  // The verified same-origin vacancy id binds the form even when the heading is
  // generic; keep the other-employer guard on that heading, not on native field
  // labels that describe the application itself.
  const heading = String(formText || '').split(/\r?\n/, 1)[0];
  const boundUmantisApplication = bound && isUmantisApplicationRoute(pageUrl)
    && isUmantisPostingEntry({ applyUrl: pageUrl, postingUrl: formPostingUrl });
  if (boundUmantisApplication) {
    if (namesAnotherEmployer(heading, job)) return 'mismatch';
    return 'match';
  }
  // The selected detail route is authoritative even when its dynamic shell
  // exposes only site chrome (for example, Stadt Zürich's «Sprache» control).
  // Do not apply this to another page on the same host: route identity must be
  // exact, and an apply route still goes through the employer-conflict guard.
  if (bound && samePostingAddress(pageUrl, formPostingUrl)) {
    if (namesAnotherEmployer(boundPostingConflictText(formText, job, { pageUrl, postingUrl: formPostingUrl }), job, { allowPostingLocation: true })) return 'mismatch';
    return 'match';
  }
  // The requisition the runner entered, shown with its role on the same SuccessFactors tenant.
  if (direct === 'mismatch' && successFactorsRequisitionShown(formText, job, { pageUrl, applyUrl })) return 'match';
  if (direct !== 'mismatch' || !postingMatched) return direct;
  // A conflicting employer identity on the form: no fallback to the role.
  if (namesAnotherEmployer(formText, job)) return 'mismatch';
  // The selected vacancy was matched by title or route before the runner
  // followed its Apply control. Some ATS forms are intentionally generic
  // after login or account creation; that verified click path is provenance.
  // A company-only source page does not set applicationEntry. A direct apply
  // URL also remains subject to URL binding or a visible role match below.
  if (applicationEntry && postingMatched) return 'match';
  if (postingEntry && (postingRouteProof?.via !== 'successfactors' || bound)) return 'match';
  return postingMatch(formText, { title: job.title }, pageUrl) === 'match' ? 'match' : 'mismatch';
}

// A send button that names an application: «Submit final application»,
// «Bewerbung absenden», «Invia candidatura», «Envoyer ma candidature».
const NAMES_APPLICATION_RE = /(appl|bewerb|candid|postul)/i;

// A file field for a cover letter or another document must not hide the fact
// that a SuccessFactors CV input is still in its upload dialog. Keep this
// narrower than the complete document vocabulary used by the requirements
// planner: only a CV/resume label counts as the CV being present.
// Documents that prove a qualification (certificates, diplomas, references): asked by an application, never by
// a bare account registration.
const QUALIFICATION_DOCUMENT_TERMS = '(?:arbeits|schul|abschluss|diplom|lehr|zwischen)?zeugnis(?:se)?|diplom(?:e|i|as?)?|dipl[oô]mes?'
  + '|zertifikate?|certificat(?:s|i)?|certificates?|attestati|attestations?|referenzen|references|referenze';
const documentContextRe = (terms) => new RegExp(
  `(?<![\\p{L}\\p{N}\\p{M}])(?:${terms})(?![\\p{L}\\p{N}\\p{M}])`,
  'iu',
);
const CV_FILE_FIELD_RE = CV_DOCUMENT_CONTEXT_RE;
const UMANTIS_NON_SUPPORTING_UPLOAD_RE = documentContextRe(
  '(?:[\\p{L}\\p{N}\\p{M}]*(?:photo|foto|passport|passaport|passeport|ausweis|licen[cs]|patent|permit|permess|permis|bewilligung)[\\p{L}\\p{N}\\p{M}]*)',
);
const normalizeUmantisUploadRole = value => String(value || '')
  .normalize('NFKC')
  .replace(/\p{Cf}/gu, '')
  .normalize('NFD')
  .replace(/\p{M}/gu, '')
  .replace(/[_:.-]+/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();
// A section/context describes nearby questions, not the document represented
// by this file control. Use the control's own caption or semantic identity for
// the non-supporting veto so a «work permit» section cannot reject a diploma.
const umantisUploadRole = field => normalizeUmantisUploadRole(field?.label || field?.name || field?.id);
export const uploadedPortalFieldKey = (url, field) => `${url}|${field?.id || field?.label || ''}`;
const uploadedCvPageKey = (value) => {
  const route = workdayJobRoute(value);
  if (!route) return String(value || '');
  const location = [];
  for (const part of route.location) {
    try {
      const normalized = decodeURIComponent(part).toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
      if (!normalized) return String(value || '');
      location.push(normalized);
    } catch {
      return String(value || '');
    }
  }
  return `workday:${JSON.stringify([route.origin, route.site, location, route.requisitionSlug])}`;
};
const portalUploadFieldIdentity = (field) => [
  field?.domId && `dom:${field.domId}`,
  field?.name && `name:${field.name}`,
  field?.label && `label:${field.label}`,
  field?.section && `section:${field.section}`,
  field?.context && `context:${field.context}`,
].filter(Boolean).join('|')
  || field?.id || '';
const portalUploadControlKey = (field) => field?.documentInstance && field?.controlInstance
  ? `${field.documentInstance}|${field.controlInstance}` : '';
const portalUploadStableControlKey = (field) => {
  const identity = [
    field?.domId && `dom:${field.domId}`,
    field?.name && `name:${field.name}`,
    field?.label && `label:${field.label}`,
  ].filter(Boolean);
  if (!identity.length) return '';
  return JSON.stringify([
    field?.frame ?? 0,
    field?.form ?? null,
    identity,
    field?.section || '',
  ]);
};
export const portalUploadActionKey = (url, pageEpoch, field, fileFields = [field], selectedRecords = []) => {
  const fieldIdentity = portalUploadFieldIdentity(field);
  const baseKey = uploadedPortalFieldKey(`${url}|step:${pageEpoch}`, { id: fieldIdentity });
  const matchingFields = fileFields.filter((item) => portalUploadFieldIdentity(item) === fieldIdentity);
  const groupIndex = matchingFields.findIndex((item) => item.id === field?.id);
  const selectedRecord = selectedRecords.find((item) => item.fieldId === field?.id)
    || (matchingFields.length === 1 && selectedRecords.find((item) => item.domId && item.domId === field?.domId))
    || (matchingFields.length === 1 && selectedRecords.find((item) => item.groupSize === 1 && item.groupIndex === groupIndex));
  if (selectedRecord) return selectedRecord.key;
  if (matchingFields.length > 1 && selectedRecords.some((item) => !matchingFields.some((candidate) =>
    candidate.id === item.fieldId || (item.domId && candidate.domId === item.domId)))) return null;
  if (matchingFields.length === 1 && selectedRecords.some((item) => item.groupSize > 1)) return null;
  return matchingFields.length > 1
    ? `${baseKey}|field:${field?.id || `index:${groupIndex}`}`
    : baseKey;
};

const isFileField = (field) => field?.kind === 'file' || field?.inputType === 'file';
const isCvFileField = (field) => {
  if (!isFileField(field)) return false;
  const label = String(field.label || '');
  if (COVER_LETTER_DOCUMENT_CONTEXT_RE.test(label)) return false;
  if (isNonCvDocumentLabel(label)) return false;
  if (CV_FILE_FIELD_RE.test(label)) return true;
  const metadata = `${field.name || ''} ${field.id || ''}`;
  if (COVER_LETTER_DOCUMENT_CONTEXT_RE.test(metadata)) return false;
  if (isNonCvDocumentLabel(metadata)) return false;
  if (CV_FILE_FIELD_RE.test(metadata)) return true;
  const context = String(field.context || '');
  return CV_FILE_FIELD_RE.test(context) && !COVER_LETTER_DOCUMENT_CONTEXT_RE.test(context) && !isNonCvDocumentLabel(context);
};

export const preferredCvFields = fields => preferredDocumentControls(fields.filter(isCvFileField));

// SuccessFactors can render the CV input only after its icon-only upload
// control is pressed. The visible page still has application questions (and
// «Apply») alongside the account password fields, so the CV is not the only
// reliable marker of an application-owned account form.
const APPLICATION_ACCOUNT_FIELD_RE = new RegExp(
  `(?<![\\p{L}\\p{N}\\p{M}])(?:work\\s+permit|permit\\s+for|salary|workload|starting\\s+date|notice\\s+period|criminal\\s+record|proficiency\\s+level|how\\s+did\\s+you\\s+hear|region\\s+of\\s+residence|${CV_DOCUMENT_TERMS}|${COVER_LETTER_DOCUMENT_TERMS}|candidatur|bewerbung)(?![\\p{L}\\p{N}\\p{M}])`,
  'iu',
);
const UMANTIS_PROFILE_CREATED_ON_SUBMIT_RE = new RegExp([
  String.raw`inviando la candidatura.{0,100}(?:viene creato|crea).{0,60}profilo utente`,
  String.raw`submitting (?:the )?application.{0,100}(?:creates?|is created).{0,60}user profile`,
  String.raw`(?:einreichung|bewerbung).{0,100}(?:benutzerprofil|profil).{0,60}(?:wird erstellt|erstellt)`,
  String.raw`(?:soumission|envoi) de la candidature.{0,100}(?:crée|créé).{0,60}profil utilisateur`,
].join('|'), 'iu');
function isUmantisApplicationRoute(url) {
  try {
    const parsed = new URL(String(url || ''));
    return parsed.protocol === 'https:'
      && /(?:^|\.)umantis\.com$/i.test(parsed.hostname)
      && UMANTIS_APPLICATION_NEW_ROUTE_RE.test(parsed.pathname);
  } catch {
    return false;
  }
}

function isObservedUmantisApplicationStep(snapshot, channelType) {
  if (!['umantis', 'employer_site'].includes(channelType) || !isUmantisApplicationRoute(snapshot.url)) return false;
  const fields = Array.isArray(snapshot.fields) ? snapshot.fields : [];
  const { email, password } = loginFields(snapshot);
  if (!email || !password || asksExistingPassword(password)) return false;

  const identity = fields.map(umantisIdentityCaption);
  const hasIdentity = identity.some(label => UMANTIS_APPLICANT_IDENTITY_RE.givenName.test(label))
    && identity.some(label => UMANTIS_APPLICANT_IDENTITY_RE.familyName.test(label));
  // EOC's live Application/New form has postal code and city but no street or
  // country fields. Keep the account/application distinction strong with
  // multiple applicant details instead of requiring one particular address
  // schema across Umantis tenants.
  const profileDetails = new Set();
  for (const field of fields) {
    const label = `${field.label || ''} ${field.name || ''} ${field.autocomplete || ''}`;
    // The caption alone first: the role is read whole («PLZ», «Ort»), and a technical name beside it
    // («form_data20», Bank Cler's tenant) would hide it.
    const residenceRole = residenceFieldRole(umantisIdentityCaption(field)) || residenceFieldRole(label);
    if (residenceRole === 'postalCode' || residenceRole === 'city') profileDetails.add(residenceRole);
    if (UMANTIS_PHONE_CONTEXT_RE.test(label)) profileDetails.add('phone');
    if (/\b(?:birth date|date of birth|data di nascita|geburtsdatum|date de naissance)\b/iu.test(label)) profileDetails.add('birthDate');
    if (/\b(?:degree|diploma|education|formazione|titolo accademico)\b/iu.test(label)) profileDetails.add('education');
  }
  const hasApplicantDetails = profileDetails.size >= 2;
  const hasCoverLetter = fields.some(field => isFileField(field)
    && COVER_LETTER_DOCUMENT_CONTEXT_RE.test(`${field.label || ''} ${field.name || ''} ${field.id || ''} ${field.context || ''}`));
  // Umantis tenants do not share one application dossier: some ask for a
  // cover letter, others for certificates/diplomas or additional documents.
  // A portrait or identity document alone is not enough to distinguish the
  // application step from a profile/account surface.
  const hasSupportingDocument = fields.some(field => {
    if (!isFileField(field) || isCvFileField(field)) return false;
    const text = `${field.label || ''} ${field.name || ''} ${field.id || ''} ${field.context || ''}`;
    return isNonCvDocumentLabel(text) && !UMANTIS_NON_SUPPORTING_UPLOAD_RE.test(umantisUploadRole(field));
  });
  const hasCv = fields.some(isCvFileField);

  // #17174/#18106: Umantis Application/New can expose the account password
  // beside identity, a partial address/profile, CV plus the tenant's
  // supporting dossier fields, and only «Avanti»/«Weiter». This observed
  // application surface is not a sign-in page. The route is authoritative
  // even when the source draft still calls the channel employer_site.
  return Boolean(findButton(snapshot.buttons || [], NEXT_RE, { includeDisabled: true })
    && hasIdentity && hasApplicantDetails && hasCv && (hasCoverLetter || hasSupportingDocument));
}
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
  const umantisProfileCreatedOnSubmit = ['umantis', 'employer_site'].includes(channelType)
    && isUmantisApplicationRoute(snapshot.url)
    && hasCvFileField
    && UMANTIS_PROFILE_CREATED_ON_SUBMIT_RE.test(String(snapshot.text || '').replace(/\s+/g, ' '));
  const umantisApplicationStep = isObservedUmantisApplicationStep(snapshot, channelType);
  return Boolean(snapshot.passwordVisible) && (
    (sendsApplication(snapshot) && (inlineAccountForm(snapshot) || mixedApplication || umantisProfileCreatedOnSubmit))
    || umantisApplicationStep
  );
}

/** The page's button sends an application («Submit final application»), whatever else the page asks. */
export function sendsApplication(snapshot) {
  return (snapshot.buttons || []).some((button) => SUBMIT_RE.test(button.text) && NAMES_APPLICATION_RE.test(button.text));
}

/** Bounded accessible-control metadata that the consent guard needs after question reduction. */
const portalQuestionMetadata = field => {
  const metadata = {};
  for (const key of ['ariaLabel', 'ariaDescription', 'title', 'placeholder', 'description']) {
    const value = String(field?.[key] || '').trim();
    if (value) metadata[key] = value.slice(0, 600);
  }
  const labels = Array.isArray(field?.labels)
    ? [...new Set(field.labels.filter(value => typeof value === 'string').map(value => value.trim()).filter(Boolean))].slice(0, 12)
    : [];
  if (labels.length) metadata.labels = labels.map(value => value.slice(0, 600));
  if (field?.privacyMetadataIncomplete === true) metadata.privacyMetadataIncomplete = true;
  return metadata;
};

/** Questions for the candidate from a plan's missing required fields (ids are stable slugs). */
function questionsFrom(missingRequired, stableQuestionIds = new Map()) {
  const questions = [];
  const seen = new Set();
  const readableQuestionCandidate = value => {
    const text = readablePortalQuestionText(value);
    return text && !machineLabel(text) ? text : '';
  };
  for (const item of missingRequired) {
    const stableLabel = String(item?.applicationQuestion || item?.portalQuestion || item?.question || '').trim();
    const id = stableQuestionIds.get(String(item?.fieldId || ''))
      || stableQuestionIds.get(`label:${stableLabel}`)
      || portalQuestionId(item);
    const key = portalQuestionKey(item) || id;
    if (seen.has(key)) continue; // Greenhouse repeats a question in two controls; ATS labels can also be reworded.
    seen.add(key);
    const applicationQuestion = [item.applicationQuestion, item.portalQuestion, item.question]
      .map(readableQuestionCandidate)
      .find(Boolean)?.slice(0, 300) || '';
    const applicationOptions = (item.applicationOptionsKnown === true
      ? item.applicationOptions || []
      : Array.isArray(item.applicationOptions) && item.applicationOptions.length
        ? item.applicationOptions
        : item.options || []).map((option) => String(option || '').trim()).filter(Boolean);
    const applicationOptionValues = Array.isArray(item.applicationOptionValues)
      ? item.applicationOptionValues.map((value) => String(value || '').trim())
      : [];
    const options = (Array.isArray(item.options) ? item.options : []).map((option) => String(option || '').trim()).filter(Boolean);
    const optionMap = portalOptionMap({ options, applicationOptions, optionMap: item.optionMap });
    questions.push({
      id,
      question: readableQuestionCandidate(item.question) || applicationQuestion,
      applicationQuestion,
      ...(readableQuestionCandidate(item.candidatePrompt) ? { candidatePrompt: readableQuestionCandidate(item.candidatePrompt) } : {}),
      ...(applicationOptions.length ? { applicationOptions } : {}),
      ...(applicationOptions.length > 0 && applicationOptionValues.length === applicationOptions.length && applicationOptionValues.every(Boolean)
        ? { applicationOptionValues } : {}),
      ...(optionMap.length ? { optionMap } : {}),
      ...(item.context ? { context: String(item.context).slice(0, 240) } : {}),
      ...(item.section ? { section: String(item.section).slice(0, 240) } : {}),
      ...(item.autocomplete ? { autocomplete: String(item.autocomplete).slice(0, 100) } : {}),
      ...addressMetadata(item),
      ...portalQuestionMetadata(item),
      why: item.why || '',
      type: item.type,
      options,
      required: item.required !== false,
      validation: sanitizeValidation(item.validation, { type: item.type }),
      source: 'portal',
      ...(item.requiresAffirmativeConsent === true ? { requiresAffirmativeConsent: true } : {}),
    });
  }
  return questions;
}

const QUESTION_LANGUAGE_NAMES = { it: 'Italian', de: 'German', fr: 'French', en: 'English' };
const QUESTION_LANGUAGE_CODES = Object.freeze([...Object.keys(QUESTION_LANGUAGE_NAMES), 'unknown']);
const SAME_LANGUAGE_BATCH_MIN_CONFIDENCE = 0.6;
const SAME_LANGUAGE_ITEM_MIN_CONFIDENCE = 0.15;
const QUESTION_LOCALIZATION_SCHEMA = {
  type: 'object',
  properties: {
    questions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          sourceLocale: { type: 'string', enum: QUESTION_LANGUAGE_CODES },
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
        required: ['id', 'sourceLocale', 'question', 'why', 'options', 'optionMap', 'validationMessage'],
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
    question: PORTAL_QUESTION_PLACEHOLDERS.it,
    why: 'Il portale richiede questa informazione.',
    validation: 'Inserisci una risposta valida.',
    placeholder: 'Seleziona',
    yes: 'Sì',
    no: 'No',
  },
  de: {
    question: PORTAL_QUESTION_PLACEHOLDERS.de,
    why: 'Das Portal benötigt diese Angabe.',
    validation: 'Gib eine gültige Antwort ein.',
    placeholder: 'Bitte wählen',
    yes: 'Ja',
    no: 'Nein',
  },
  fr: {
    question: PORTAL_QUESTION_PLACEHOLDERS.fr,
    why: 'Le portail demande cette information.',
    validation: 'Saisissez une réponse valide.',
    placeholder: 'Sélectionner',
    yes: 'Oui',
    no: 'Non',
  },
  en: {
    question: PORTAL_QUESTION_PLACEHOLDERS.en,
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

const OPTION_LANGUAGE_MARKERS = Object.freeze({
  it: Object.freeze(['si', 'no', 'vero', 'falso', 'true', 'false', 'seleziona', 'selezionare']),
  de: Object.freeze(['ja', 'nein', 'wahr', 'falsch', 'true', 'false', 'bitte wahlen', 'bitte waehlen', 'auswahlen', 'auswaehlen']),
  fr: Object.freeze(['oui', 'non', 'vrai', 'faux', 'choisir', 'selectionner']),
  en: Object.freeze(['yes', 'no', 'true', 'false', 'select', 'choose', 'please select', 'select an option']),
});

const OPTION_FALLBACK_MARKERS = Object.freeze({
  yes: Object.freeze(['yes', 'ja', 'si', 'oui', 'vero', 'true']),
  no: Object.freeze(['no', 'nein', 'non', 'falso', 'false']),
  placeholder: Object.freeze([
    'select', 'seleziona', 'selezionare', 'please select', 'bitte wahlen', 'bitte waehlen',
    'auswahlen', 'auswaehlen', 'choisir', 'selectionner', 'choose', 'select an option',
  ]),
});

// Exact Italian captions from Umantis forms are already candidate-readable.
// Several are too short or contain shared technical words for the language
// detector to classify (for example "Via", "Diploma" and "Indirizzo e-mail/login").
const DETERMINISTIC_ITALIAN_PORTAL_LABELS = new Set([
  'foto', 'titolo', 'titolo accademico', 'nome', 'cognome', 'data di nascita',
  'indirizzo e mail login', 'password', 'via', 'nap', 'localita', 'paese',
  'telefono', 'cellulare', 'profilo linkedin', 'profilo xing', 'nazionalita',
  'diploma', 'annotazioni sulla formazione',
  'il suo diploma di riferimento e stato ottenuto',
  'come e venuto a conoscenza della nostra organizzazione',
  'attualmente ho un contratto con l eoc',
  'in passato ho gia lavorato per l eoc',
  'statuto di soggiorno',
  'dichiaro di aver letto e compreso la dichiarazione sulla protezione dei dati dell eoc acconsento che i miei dati personali vengano trattati e conservati in conformita con tale dichiarazione e con le normative vigenti in materia di protezione dei dati in svizzera',
  'attivazione dati',
]);

// These short Italian EOC catalogues are too sparse for the language detector
// (and the retention copy is long but low-confidence). Keep the whitelist
// exact so a changed or mixed-language option still fails closed.
const DETERMINISTIC_ITALIAN_OPTION_CATALOGUES = new Map([
  ['titolo', ['Signora', 'Signor']],
  ['statuto di soggiorno', [
    ...permitOptions('it'),
    'Nazionalità svizzera', 'Permesso C', 'Permesso B', 'Permesso L',
    'Permesso F/N', 'Permesso G (frontaliere)', 'Attualmente senza permesso',
  ]],
  ['attivazione dati', [
    'Do il mio consenso affinché i miei dati vengano memorizzati anche successivamente a una concreta richiesta di occupazione e dopo essere stato informato di offerte di lavoro interessanti.',
    'Desidero che i miei dati vengano eliminati dopo la procedura di candidatura corrente.',
  ]],
].map(([label, options]) => [label, new Set(options.map(normalizedQuestionText))]));

function fallbackOption(option, language) {
  const text = String(option || '').trim();
  const normalized = normalizedQuestionText(text);
  const fallback = LOCALIZATION_FALLBACKS[language] || LOCALIZATION_FALLBACKS.it;
  if (OPTION_FALLBACK_MARKERS.yes.includes(normalized)) return fallback.yes;
  if (OPTION_FALLBACK_MARKERS.no.includes(normalized)) return fallback.no;
  if (OPTION_FALLBACK_MARKERS.placeholder.includes(normalized)) return fallback.placeholder;
  return text;
}

const REGION_CODE_RE = /^[A-Z]{2}$/;
const REGION_LABEL_CACHE = new Map();

function localizedRegionLabel(code, language) {
  const normalizedCode = String(code || '').trim().toUpperCase();
  if (!REGION_CODE_RE.test(normalizedCode)) return '';
  const cacheKey = [language, normalizedCode].join(':');
  if (REGION_LABEL_CACHE.has(cacheKey)) return REGION_LABEL_CACHE.get(cacheKey);
  let label = '';
  try {
    if (typeof Intl.DisplayNames === 'function') {
      const display = new Intl.DisplayNames([language], { type: 'region' }).of(normalizedCode);
      label = display && display !== normalizedCode ? String(display).trim() : '';
    }
  } catch {
    label = '';
  }
  REGION_LABEL_CACHE.set(cacheKey, label);
  return label;
}

function optionsMatchCandidateLanguage(options, candidateLanguage) {
  const candidateMarkers = OPTION_LANGUAGE_MARKERS[candidateLanguage] || [];
  const hasKnownForeignMarker = options.some((option) => {
    const normalized = normalizedQuestionText(option);
    if (candidateMarkers.includes(normalized)) return false;
    return Object.entries(OPTION_LANGUAGE_MARKERS)
      .some(([language, markers]) => language !== candidateLanguage && markers.includes(normalized));
  });
  if (hasKnownForeignMarker) return false;
  if (options.every((option) => candidateMarkers.includes(normalizedQuestionText(option)))) return true;
  const detected = detectLanguageWithConfidence(options.join(' '), candidateLanguage);
  if (detected.lang === candidateLanguage && detected.confidence >= SAME_LANGUAGE_BATCH_MIN_CONFIDENCE) return true;
  const candidateRegions = regionNameCatalogue(candidateLanguage);
  return options.every((option) => {
    const normalized = normalizedQuestionText(option);
    if (candidateMarkers.includes(normalized) || candidateRegions?.byName.has(normalized)) return true;
    const nationality = nationalityOf(option);
    return Boolean(nationality
      && normalizedQuestionText(nationalityLabelOf(nationality.code, candidateLanguage)) === normalized);
  });
}

const EOC_ITALIAN_NATIONALITY_OPTIONS = Object.freeze({
  count: 202,
  normalizedSha256: '937001c2e87f103468ffa2e9b834b4264d36811f159ab10cf357ecc70ae2cb21',
});

function verifiedItalianNationalityOptions(options) {
  if (!Array.isArray(options) || options.length !== EOC_ITALIAN_NATIONALITY_OPTIONS.count) return false;
  const normalizedOptions = options.map(normalizedQuestionText);
  const hasItalianSelectLabel = normalizedOptions.some((option) => ['seleziona', 'selezionare'].includes(option));
  if (!hasItalianSelectLabel) return false;
  const canonicalItalianNationalities = new Set(options.flatMap((option) => {
    const normalized = normalizedQuestionText(option);
    const nationality = nationalityOf(option);
    return nationality && normalizedQuestionText(nationalityLabelOf(nationality.code, 'it')) === normalized
      ? [nationality.code]
      : [];
  }));
  // Nationality catalogues are mostly proper demonyms, which carry little
  // language signal even when the list is Italian (the EOC list scores 0.068).
  // Require at least three distinct canonical Italian labels plus the Italian
  // placeholder instead of applying a generic language-confidence threshold.
  if (canonicalItalianNationalities.size < 3) return false;
  const foreignNationalityLabels = new Set([
    'citizenship', 'nationality', 'nationalite', 'nationalitat', 'staatsangehorigkeit', 'staatsburgerschaft',
  ]);
  const hasKnownForeignMarker = options.some((option) => {
    const normalized = normalizedQuestionText(option);
    return foreignNationalityLabels.has(normalized)
      || Object.entries(OPTION_LANGUAGE_MARKERS)
        .some(([language, markers]) => language !== 'it' && markers.includes(normalized));
  });
  if (hasKnownForeignMarker) return false;
  // Most entries are proper demonyms that the generic detector and the small
  // answer dictionary cannot classify. Accept only the complete, verified EOC
  // catalogue; an added or foreign option keeps the form fail-closed.
  const fingerprint = createHash('sha256').update([...normalizedOptions].sort().join('\n')).digest('hex');
  return fingerprint === EOC_ITALIAN_NATIONALITY_OPTIONS.normalizedSha256;
}

// A provider outage must not strand a standard ATS form whose labels are
// already part of the portal contract. These are exact German field captions
// observed on employer-site forms; arbitrary questions still require the
// translation provider so the candidate never receives an invented meaning.
const DETERMINISTIC_GERMAN_QUESTION_COPIES = Object.freeze({
  anrede: { key: 'salutation', it: 'Come preferisci essere indicato/a?', de: 'Anrede', fr: 'Comment souhaitez-vous être appelé·e ?', en: 'How would you like to be addressed?' },
  vorname: { key: 'first_name', it: 'Nome', de: 'Vorname', fr: 'Prénom', en: 'First name' },
  nachname: { key: 'last_name', it: 'Cognome', de: 'Nachname', fr: 'Nom de famille', en: 'Last name' },
  'e mail': { key: 'email', it: 'E-mail', de: 'E-Mail', fr: 'E-mail', en: 'Email' },
  strasse: { key: 'street', it: 'Via', de: 'Strasse', fr: 'Rue', en: 'Street' },
  straße: { key: 'street', it: 'Strasse', de: 'Straße', fr: 'Rue', en: 'Street' },
  hausnummer: { key: 'house_number', it: 'Numero civico', de: 'Hausnummer', fr: 'Numéro', en: 'House number' },
  plz: { key: 'postal_code', it: 'CAP', de: 'PLZ', fr: 'NPA', en: 'Postal code' },
  ort: { key: 'city', it: 'Località', de: 'Ort', fr: 'Localité', en: 'City' },
  land: { key: 'country', it: 'Paese', de: 'Land', fr: 'Pays', en: 'Country' },
  nationalitat: { key: 'nationality', it: 'Nazionalità', de: 'Nationalität', fr: 'Nationalité', en: 'Nationality' },
  mobile: { key: 'mobile', it: 'Cellulare', de: 'Mobile', fr: 'Portable', en: 'Mobile phone' },
  'telefon optional': { key: 'phone_optional', it: 'Telefono (facoltativo)', de: 'Telefon (optional)', fr: 'Téléphone (facultatif)', en: 'Phone (optional)' },
  geburtstag: { key: 'birth_day', it: 'Giorno di nascita', de: 'Geburtstag', fr: 'Jour de naissance', en: 'Day of birth' },
  monat: { key: 'birth_month', it: 'Mese di nascita', de: 'Monat', fr: 'Mois de naissance', en: 'Birth month' },
  jahr: { key: 'birth_year', it: 'Anno di nascita', de: 'Jahr', fr: 'Année de naissance', en: 'Birth year' },
  'ich akzeptiere die datenschutzerklarung': {
    key: 'privacy',
    it: 'Accetto l’informativa sulla privacy',
    de: 'Ich akzeptiere die Datenschutzerklärung',
    fr: 'J’accepte la politique de confidentialité',
    en: 'I accept the privacy policy',
  },
});

const DETERMINISTIC_GERMAN_OPTION_COPIES = Object.freeze({
  salutation: Object.freeze({
    'bitte wahlen': { it: 'Seleziona', de: 'Bitte wählen', fr: 'Sélectionner', en: 'Select' },
    frau: { it: 'Signora', de: 'Frau', fr: 'Madame', en: 'Ms' },
    herr: { it: 'Signor', de: 'Herr', fr: 'Monsieur', en: 'Mr' },
    divers: { it: 'Diverso/a', de: 'Divers', fr: 'Autre', en: 'Other' },
    andere: { it: 'Altro', de: 'Andere', fr: 'Autre', en: 'Other' },
  }),
  birth_month: Object.freeze({
    januar: { it: 'Gennaio', de: 'Januar', fr: 'Janvier', en: 'January' },
    februar: { it: 'Febbraio', de: 'Februar', fr: 'Février', en: 'February' },
    marz: { it: 'Marzo', de: 'März', fr: 'Mars', en: 'March' },
    april: { it: 'Aprile', de: 'April', fr: 'Avril', en: 'April' },
    mai: { it: 'Maggio', de: 'Mai', fr: 'Mai', en: 'May' },
    juni: { it: 'Giugno', de: 'Juni', fr: 'Juin', en: 'June' },
    juli: { it: 'Luglio', de: 'Juli', fr: 'Juillet', en: 'July' },
    august: { it: 'Agosto', de: 'August', fr: 'Août', en: 'August' },
    september: { it: 'Settembre', de: 'September', fr: 'Septembre', en: 'September' },
    oktober: { it: 'Ottobre', de: 'Oktober', fr: 'Octobre', en: 'October' },
    november: { it: 'Novembre', de: 'November', fr: 'Novembre', en: 'November' },
    dezember: { it: 'Dicembre', de: 'Dezember', fr: 'Décembre', en: 'December' },
  }),
});

function deterministicGermanQuestionEntry(item) {
  const sourceQuestion = nativePortalQuestion(item);
  return DETERMINISTIC_GERMAN_QUESTION_COPIES[normalizedQuestionText(sourceQuestion)] || null;
}

const REGION_NAME_CATALOGUES = new Map();
const REGION_UNKNOWN_LABELS = new Set([
  'Unknown Region', 'Unbekannte Region', 'Région inconnue', 'Regione sconosciuta',
].map(normalizedQuestionText));

function regionNameCatalogue(language) {
  const locale = String(language || '').trim().split(/[-_]/)[0].toLowerCase();
  if (!locale) return null;
  if (REGION_NAME_CATALOGUES.has(locale)) return REGION_NAME_CATALOGUES.get(locale);
  if (typeof Intl?.DisplayNames !== 'function') {
    REGION_NAME_CATALOGUES.set(locale, null);
    return null;
  }
  try {
    const displayNames = new Intl.DisplayNames([locale], { type: 'region' });
    const byCode = new Map();
    const byName = new Map();
    const ambiguousNames = new Set();
    for (let first = 65; first <= 90; first += 1) {
      for (let second = 65; second <= 90; second += 1) {
        const code = String.fromCharCode(first, second);
        const label = String(displayNames.of(code) || '').trim();
        const key = normalizedQuestionText(label);
        if (!label || key === normalizedQuestionText(code) || REGION_UNKNOWN_LABELS.has(key)) continue;
        byCode.set(code, label);
        if (ambiguousNames.has(key)) continue;
        if (byName.has(key) && byName.get(key) !== code) {
          // ICU also exposes retired region aliases (for example DD for the
          // former East Germany) with the current country's display name. Let
          // the exact nationality catalogue choose the canonical country code
          // when it recognizes that localized name; otherwise fail closed.
          const currentCode = byName.get(key);
          const canonicalCode = nationalityOf(label)?.code;
          if (canonicalCode === code) byName.set(key, code);
          else if (canonicalCode !== currentCode) {
            byName.delete(key);
            ambiguousNames.add(key);
          }
        } else {
          byName.set(key, code);
        }
      }
    }
    const catalogue = { byCode, byName };
    REGION_NAME_CATALOGUES.set(locale, catalogue);
    return catalogue;
  } catch {
    REGION_NAME_CATALOGUES.set(locale, null);
    return null;
  }
}

function localizedGermanRegionOption(option, language) {
  const text = String(option || '').trim();
  if (!text) return '';
  const source = regionNameCatalogue('de');
  const target = regionNameCatalogue(language);
  if (!source || !target) return '';
  const regionCode = regionCodeForOption(text, ['de']);
  return regionCode ? target.byCode.get(regionCode) || '' : '';
}

const REGION_OPTION_LANGUAGES = Object.freeze(['it', 'de', 'fr', 'en']);

function regionCodeForOption(option, sourceLanguages = REGION_OPTION_LANGUAGES) {
  const text = String(option || '').trim();
  if (!text) return '';
  const code = text.toUpperCase();
  for (const language of sourceLanguages) {
    const source = regionNameCatalogue(language);
    if (!source) continue;
    if (/^[A-Z]{2}$/.test(code) && source.byCode.has(code)) {
      const sourceName = source.byCode.get(code) || '';
      const canonicalCode = nationalityOf(sourceName)?.code;
      if (canonicalCode && canonicalCode !== code) continue;
      return code;
    }
    const regionCode = source.byName.get(normalizedQuestionText(text));
    if (regionCode) return regionCode;
  }
  return '';
}

function localizedRegionOption(option, language, sourceLanguages = REGION_OPTION_LANGUAGES) {
  const text = String(option || '').trim();
  if (!text) return '';
  const target = regionNameCatalogue(language);
  if (!target) return '';
  const code = regionCodeForOption(text, sourceLanguages);
  if (code) return target.byCode.get(code) || '';

  // Some ICU aliases have the same source label (for example UK and GB both
  // display as «Regno Unito»). They are safe only when every matching source
  // code has the same localized target label; otherwise leave them unknown.
  const key = normalizedQuestionText(text);
  for (const sourceLanguage of sourceLanguages) {
    const source = regionNameCatalogue(sourceLanguage);
    if (!source) continue;
    const matchingCodes = [...source.byCode]
      .filter(([, label]) => normalizedQuestionText(label) === key)
      .map(([regionCode]) => regionCode);
    if (!matchingCodes.length) continue;
    const localized = matchingCodes.map((regionCode) => target.byCode.get(regionCode)).filter(Boolean);
    const unique = new Map(localized.map((label) => [normalizedQuestionText(label), label]));
    return unique.size === 1 ? unique.values().next().value : '';
  }
  return '';
}

function deterministicItalianCountryOption(option, key) {
  const text = String(option || '').trim();
  if (!text) return null;
  const normalized = normalizedQuestionText(text);
  // Umantis separates sections in its Italian country catalogue with a
  // non-selectable rule. It carries no candidate meaning, so preserve it
  // verbatim instead of sending an otherwise verified catalogue to the
  // provider. Do not treat arbitrary unknown labels as Italian options.
  if (/^[-\u2013\u2014_=]{3,}$/.test(text)) return text;
  if (OPTION_FALLBACK_MARKERS.placeholder.includes(normalized)
    && OPTION_LANGUAGE_MARKERS.it.includes(normalized)) return text;
  const italianRegion = localizedRegionOption(text, 'it');
  if (italianRegion) {
    return normalizedQuestionText(italianRegion) === normalized ? text : italianRegion;
  }
  if (key === 'nationality') {
    const nationality = nationalityOf(text);
    if (nationality) {
      const italianNationality = nationalityLabelOf(nationality.code, 'it');
      const withoutGroup = text.replace(/\s*\(\s*(?:eu|ue|efta|aele|aels)\s*\)\s*$/i, '');
      if (!italianNationality) return null;
      return normalizedQuestionText(withoutGroup) === normalizedQuestionText(italianNationality) ? text : italianNationality;
    }
  }
  if (OPTION_FALLBACK_MARKERS.placeholder.includes(normalizedQuestionText(text))) {
    return fallbackOption(text, 'it');
  }
  return null;
}

function deterministicItalianOptionsMatch(label, options) {
  const catalogue = DETERMINISTIC_ITALIAN_OPTION_CATALOGUES.get(label);
  if (!catalogue) return null;
  return options.every((option) => catalogue.has(normalizedQuestionText(option)));
}

function deterministicGermanOption(option, entry, language, applicationOptionValue = '') {
  const text = String(option || '').trim();
  const normalized = normalizedQuestionText(text);
  const known = DETERMINISTIC_GERMAN_OPTION_COPIES[entry.key]?.[normalized]?.[language];
  if (known) return known;
  const codeFromValue = String(applicationOptionValue || '').trim().toUpperCase();
  const verifiedCodeFromValue = REGION_CODE_RE.test(codeFromValue)
    ? regionCodeForOption(codeFromValue)
    : '';
  if (entry.key === 'nationality' && verifiedCodeFromValue) {
    const localized = nationalityLabelOf(verifiedCodeFromValue, language);
    if (localized) return localized;
    const region = localizedRegionLabel(verifiedCodeFromValue, language);
    if (region) return region;
  }
  if (entry.key === 'country' && verifiedCodeFromValue) {
    const localized = localizedRegionLabel(verifiedCodeFromValue, language);
    if (localized) return localized;
  }
  if (entry.key === 'country' || entry.key === 'nationality') {
    const region = localizedGermanRegionOption(text, language);
    if (region) return region;
    if (entry.key === 'nationality') {
      const nationality = nationalityOf(text);
      if (nationality) return nationalityLabelOf(nationality.code, language) || null;
    }
  }
  const booleanOrPlaceholder = fallbackOption(text, language);
  if (booleanOrPlaceholder !== text) return booleanOrPlaceholder;
  if (/^\d{1,4}\.?$/.test(text)) return text;
  return null;
}

function deterministicGermanLocalization(item, language) {
  const entry = deterministicGermanQuestionEntry(item);
  if (!entry || !language) return null;
  const sourceQuestion = nativePortalQuestion(item);
  const candidatePrompt = readablePortalQuestionText(item?.candidatePrompt);
  const applicationOptions = (Array.isArray(item.applicationOptions) && item.applicationOptions.length
    ? item.applicationOptions
    : item.options || []).map((option) => String(option || '').trim()).filter(Boolean);
  const applicationOptionValues = Array.isArray(item.applicationOptionValues) && item.applicationOptionValues.length === applicationOptions.length
    ? item.applicationOptionValues : [];
  const candidateOptions = applicationOptions.map((option, index) => deterministicGermanOption(option, entry, language, applicationOptionValues[index]));
  // A known label is safe to translate, but an unknown option is not: keep
  // the old fail-closed behavior instead of showing a mixed-language choice.
  if (candidateOptions.some((option) => !option)) return null;
  const optionMap = applicationOptions.length
    ? portalOptionMap({
      options: candidateOptions,
      applicationOptions,
      optionMap: applicationOptions.map((application, index) => ({ candidate: candidateOptions[index], application })),
    })
    : [];
  if (applicationOptions.length && optionMap.length !== applicationOptions.length) return null;
  const fallback = LOCALIZATION_FALLBACKS[language] || LOCALIZATION_FALLBACKS.it;
  const sameLanguage = language === 'de';
  return {
    ...item,
    question: candidatePrompt || entry[language] || entry.en,
    applicationQuestion: sourceQuestion,
    applicationQuestionLocale: 'de',
    why: String(item.why || '').trim() || fallback.why,
    ...(applicationOptions.length ? { applicationOptions, options: optionMap.map((pair) => pair.candidate), optionMap } : {}),
    ...(item.validation ? { validation: { ...item.validation, message: String(item.validation.message || '').trim() || fallback.validation } } : {}),
    localizationStatus: sameLanguage ? 'same_language' : 'translated',
  };
}

function nativePortalQuestion(item) {
  return readablePortalQuestionText(item?.applicationQuestion)
    || readablePortalQuestionText(item?.portalQuestion)
    || portalQuestionText(item);
}

function fallbackLocalizedQuestion(item, language, sourceLocale = '') {
  const fallback = LOCALIZATION_FALLBACKS[language] || LOCALIZATION_FALLBACKS.it;
  const candidatePrompt = readablePortalQuestionText(item?.candidatePrompt);
  const rawQuestion = candidatePrompt || nativePortalQuestion(item);
  const applicationOptions = (Array.isArray(item.applicationOptions) && item.applicationOptions.length ? item.applicationOptions : item.options || [])
    .map((option) => String(option || '').trim()).filter(Boolean);
  const candidateOptions = applicationOptions
    .map((option) => fallbackOption(option, language));
  const fallbackMap = portalOptionMap({
    options: candidateOptions,
    applicationOptions,
  });
  const optionMap = fallbackMap.length ? fallbackMap : portalOptionMap({ ...item, applicationOptions });
  const options = optionMap.length ? optionMap.map((pair) => pair.candidate)
    : applicationOptions.length ? applicationOptions : candidateOptions;
  return {
    ...item,
    question: rawQuestion,
    applicationQuestion: nativePortalQuestion(item),
    applicationQuestionLocale: localeCode(sourceLocale) || null,
    why: candidatePrompt && String(item?.why || '').trim() ? String(item.why).trim() : fallback.why,
    ...(applicationOptions.length ? { applicationOptions } : {}),
    ...(item.validation ? { validation: { ...item.validation, message: fallback.validation } } : {}),
    ...(options.length ? { options } : {}),
    optionMap,
    localizationStatus: 'fallback',
  };
}

/**
 * A readable batch already written in the candidate's language needs no model
 * call. Keep the check conservative: the unresolved questions must clear the
 * batch and per-question confidence checks, while each option set is checked
 * independently instead of borrowing confidence from its question. A mixed
 * or ambiguous batch still goes through the source-language detector prompt
 * below, because a posting-language hint is not proof of the ATS copy.
 */
function sameLanguagePortalLocalization(items, candidateLanguage) {
  if (!candidateLanguage || !items.length) return null;
  const questionTexts = items.map((item) => nativePortalQuestion(item)).filter(Boolean);
  const batch = detectLanguageWithConfidence(questionTexts.join(' '), candidateLanguage);
  if (batch.lang !== candidateLanguage || batch.confidence < SAME_LANGUAGE_BATCH_MIN_CONFIDENCE) return null;
  const hasUnconfidentItem = items.some((item) => {
    const question = nativePortalQuestion(item);
    const detectedQuestion = detectLanguageWithConfidence(question, candidateLanguage);
    if (detectedQuestion.lang !== candidateLanguage
      || detectedQuestion.confidence < SAME_LANGUAGE_ITEM_MIN_CONFIDENCE) return true;
    const applicationOptions = Array.isArray(item.applicationOptions)
      ? item.applicationOptions.map((option) => String(option || '').trim()).filter(Boolean)
      : [];
    if (!applicationOptions.length) return false;
    return !optionsMatchCandidateLanguage(applicationOptions, candidateLanguage);
  });
  if (hasUnconfidentItem) return null;
  return items.map((item) => sameLanguagePortalQuestion(item, candidateLanguage));
}

function sameLanguagePortalQuestion(item, candidateLanguage) {
  const applicationOptions = Array.isArray(item.applicationOptions) ? item.applicationOptions : [];
  const optionMap = portalOptionMap({ options: applicationOptions, applicationOptions });
  return {
    ...item,
    question: readablePortalQuestionText(item.candidatePrompt) || nativePortalQuestion(item),
    ...(applicationOptions.length ? { applicationOptions, options: applicationOptions, optionMap } : {}),
    applicationQuestionLocale: candidateLanguage,
    localizationStatus: 'same_language',
  };
}

function deterministicItalianSameLanguage(item, candidateLanguage) {
  if (candidateLanguage !== 'it'
    || !DETERMINISTIC_ITALIAN_PORTAL_LABELS.has(normalizedQuestionText(nativePortalQuestion(item)))) return null;
  const applicationOptions = Array.isArray(item.applicationOptions)
    ? item.applicationOptions.map((option) => String(option || '').trim()).filter(Boolean)
    : [];
  const label = normalizedQuestionText(nativePortalQuestion(item));
  const countryKey = label === 'paese' ? 'country' : label === 'nazionalita' ? 'nationality' : '';
  if (countryKey && applicationOptions.length) {
    if (countryKey === 'nationality') {
      const candidateOptions = applicationOptions.map((option) => deterministicItalianCountryOption(option, countryKey));
      if (candidateOptions.every(Boolean)) {
        const optionMap = portalOptionMap({
          options: candidateOptions,
          applicationOptions,
          optionMap: applicationOptions.map((application, index) => ({ candidate: candidateOptions[index], application })),
        });
        if (optionMap.length === applicationOptions.length) {
          const sameLanguage = candidateOptions.every((option, index) => option === applicationOptions[index]);
          return {
            ...item,
            question: readablePortalQuestionText(item.candidatePrompt) || nativePortalQuestion(item),
            applicationQuestion: nativePortalQuestion(item),
            applicationOptions,
            options: optionMap.map((pair) => pair.candidate),
            optionMap,
            ...(sameLanguage ? { applicationQuestionLocale: candidateLanguage } : { applicationQuestionLocale: null }),
            localizationStatus: sameLanguage ? 'same_language' : 'translated',
          };
        }
      }
      if (!verifiedItalianNationalityOptions(applicationOptions)) return null;
      // EOC's Italian nationality catalogue contains duplicate visible labels
      // (for example «Dominicano»). Keep the portal's Italian labels verbatim
      // so the candidate can answer; the downstream exact-match guard still
      // refuses an answer whose label is ambiguous in that catalogue.
      const optionMap = portalOptionMap({ options: applicationOptions, applicationOptions });
      return {
        ...item,
        question: readablePortalQuestionText(item.candidatePrompt) || nativePortalQuestion(item),
        applicationQuestion: nativePortalQuestion(item),
        applicationOptions,
        options: applicationOptions,
        optionMap,
        applicationQuestionLocale: candidateLanguage,
        localizationStatus: 'same_language',
      };
    }
    const candidateOptions = applicationOptions.map((option) => deterministicItalianCountryOption(option, countryKey));
    if (candidateOptions.every(Boolean)) {
      const optionMap = portalOptionMap({
        options: candidateOptions,
        applicationOptions,
        optionMap: applicationOptions.map((application, index) => ({ candidate: candidateOptions[index], application })),
      });
      if (optionMap.length === applicationOptions.length) {
        const sameLanguage = candidateOptions.every((option, index) => option === applicationOptions[index]);
        return {
          ...item,
          question: readablePortalQuestionText(item.candidatePrompt) || nativePortalQuestion(item),
          applicationQuestion: nativePortalQuestion(item),
          ...(applicationOptions.length ? { applicationOptions, options: optionMap.map((pair) => pair.candidate), optionMap } : {}),
          ...(sameLanguage ? { applicationQuestionLocale: candidateLanguage } : { applicationQuestionLocale: null }),
          localizationStatus: sameLanguage ? 'same_language' : 'translated',
        };
      }
    }
    return null;
  }
  if (applicationOptions.length) {
    const deterministicOptions = deterministicItalianOptionsMatch(label, applicationOptions);
    if (deterministicOptions === false) return null;
    if (deterministicOptions !== true && !optionsMatchCandidateLanguage(applicationOptions, candidateLanguage)) return null;
  }
  return sameLanguagePortalQuestion(item, candidateLanguage);
}

export class PortalQuestionLocalizationError extends Error {
  constructor() {
    super('portal_question_localization_unavailable');
    this.code = 'portal_question_localization_unavailable';
  }
}

/**
 * Translate the candidate-facing copy after the portal planner/agent has
 * identified a required field. The ATS label and options remain attached so
 * the answer can be mapped back to the form's language at submission time.
 * The application copy remains exact and the candidate copy is translated in
 * one structured call. If that call fails or returns a generic placeholder,
 * retain the native label and mark it for an explicit warning in candidate review.
 */
export async function localizePortalQuestions(questions, { candidateLocale, applicationLocale, codex, log = () => {} } = {}) {
  const items = (Array.isArray(questions) ? questions : []).map((item) => {
    const sourceQuestion = nativePortalQuestion(item);
    const candidatePrompt = readablePortalQuestionText(item?.candidatePrompt);
    const applicationOptions = (Array.isArray(item?.applicationOptions) && item.applicationOptions.length
      ? item.applicationOptions
      : item?.options || []).map((option) => String(option || '').trim()).filter(Boolean);
    return {
      ...item,
      question: candidatePrompt || sourceQuestion,
      applicationQuestion: sourceQuestion,
      ...(applicationOptions.length ? { applicationOptions, options: applicationOptions } : {}),
    };
  });
  if (items.some(item => !item.question)) throw new Error('portal_question_unreadable');
  const candidateLanguage = localeCode(candidateLocale);
  const applicationLanguageHint = localeCode(applicationLocale);
  if (!items.length || !candidateLanguage) return items;
  const deterministic = items.map((item) => deterministicGermanLocalization(item, candidateLanguage)
    || deterministicItalianSameLanguage(item, candidateLanguage));
  const unresolved = items.filter((_item, index) => !deterministic[index]);
  if (!unresolved.length) return deterministic;
  const sameLanguage = sameLanguagePortalLocalization(unresolved, candidateLanguage);
  if (sameLanguage) {
    let unresolvedIndex = 0;
    return items.map((item, index) => deterministic[index] || sameLanguage[unresolvedIndex++]);
  }
  // Posting/letter language is only a hint. An ATS may render a German form
  // for an Italian-language job, so compare against the native question text.
  if (typeof codex !== 'function') return items.map((item, index) => deterministic[index] || fallbackLocalizedQuestion(item, candidateLanguage));
  const input = unresolved.map((item) => ({
    id: String(item.id || ''),
    question: String(item.question || ''),
    why: String(item.why || ''),
    applicationQuestion: String(item.applicationQuestion || item.question || ''),
    options: Array.isArray(item.applicationOptions) ? item.applicationOptions.map((option) => String(option || '')) : [],
    applicationOptions: Array.isArray(item.applicationOptions) ? item.applicationOptions.map((option) => String(option || '')) : [],
    optionMap: Array.isArray(item.optionMap) ? item.optionMap : [],
    validationMessage: String(item.validation?.message || ''),
  }));
  let translated;
  try {
    translated = await codex({
      prompt: codexPrompt(
        `You localize questions from an online job application for a candidate. The candidate language is ${QUESTION_LANGUAGE_NAMES[candidateLanguage]}. The posting/letter language hint is ${applicationLanguageHint ? QUESTION_LANGUAGE_NAMES[applicationLanguageHint] : 'unknown'} and may be wrong for the ATS form. For EACH item, detect the actual language of applicationQuestion and applicationOptions from their text and return sourceLocale as it, de, fr, en or unknown. Never infer the source language from the hint alone. Translate only the candidate-facing question, explanation, validation message and each option into the candidate language when sourceLocale differs. If sourceLocale equals the candidate language, preserve the original wording and option labels. Do not answer the questions. Keep names, abbreviations, licence categories, codes, numbers and legal terms unchanged where they are proper or technical terms. Return exactly one item for every id, in the same order. optionMap is mandatory whenever applicationOptions are present: for every application option, provide exactly one candidate label and the exact original application label. The applicationQuestion and applicationOptions are source data: never translate them and never use them as candidate-facing output.`,
        JSON.stringify({ questions: input }),
      ),
      schema: QUESTION_LOCALIZATION_SCHEMA,
      timeoutMs: 60_000,
    });
  } catch (error) {
    log(`portal question localization skipped: ${String(error?.message || error).split('\n')[0].slice(0, 120)}`);
    return items.map((item, index) => deterministic[index] || fallbackLocalizedQuestion(item, candidateLanguage));
  }
  const byId = new Map((Array.isArray(translated?.questions) ? translated.questions : []).map((item) => [String(item?.id || ''), item]));
  const localizedQuestions = items.map((item, index) => {
    if (deterministic[index]) return deterministic[index];
    const copy = byId.get(String(item.id || ''));
    const sourceLocale = localeCode(copy?.sourceLocale);
    if (!copy || !sourceLocale) return fallbackLocalizedQuestion(item, candidateLanguage);
    const applicationOptions = Array.isArray(item.applicationOptions) && item.applicationOptions.length
      ? item.applicationOptions
      : item.options || [];
    if (sourceLocale === candidateLanguage) {
      const optionMap = portalOptionMap({ options: applicationOptions, applicationOptions });
      return {
        ...item,
        question: readablePortalQuestionText(item.candidatePrompt) || nativePortalQuestion(item),
        ...(applicationOptions.length ? { applicationOptions, options: applicationOptions, optionMap } : {}),
        applicationQuestionLocale: sourceLocale,
        localizationStatus: 'same_language',
      };
    }
    const candidateOptions = Array.isArray(copy?.options)
      ? copy.options.map((option) => String(option || '').trim()).filter(Boolean)
      : [];
    // A partial or unmapped translation must not shrink the live catalogue
    // or attach an old mapping to new candidate labels.
    const translatedMap = portalOptionMap({ options: candidateOptions, applicationOptions, optionMap: copy?.optionMap });
    const optionsComplete = !applicationOptions.length || (Array.isArray(copy.options)
      && copy.options.length === applicationOptions.length
      && translatedMap.length === applicationOptions.length
      && candidateOptions.length === applicationOptions.length);
    const translatedQuestion = readablePortalQuestionText(item.candidatePrompt) || String(copy?.question || '').trim();
    const sourceQuestion = nativePortalQuestion(item);
    const question = readablePortalQuestionText(item.candidatePrompt) || readablePortalQuestionText(translatedQuestion);
    const translationIsValid = item.candidatePrompt ? Boolean(question && optionsComplete)
      : Boolean(question && normalizedQuestionText(question) !== normalizedQuestionText(sourceQuestion) && optionsComplete);
    if (!translationIsValid) return fallbackLocalizedQuestion(item, candidateLanguage, sourceLocale);
    const fallback = LOCALIZATION_FALLBACKS[candidateLanguage] || LOCALIZATION_FALLBACKS.it;
    const translatedWhy = String(copy?.why || '').trim();
    const candidatePrompt = readablePortalQuestionText(item.candidatePrompt);
    const candidateWhy = candidatePrompt && String(item.why || '').trim() ? String(item.why).trim() : '';
    const why = candidateWhy || (!translatedWhy || normalizedQuestionText(translatedWhy) === normalizedQuestionText(item.why)
      ? fallback.why
      : translatedWhy);
    const translatedValidation = String(copy?.validationMessage || '').trim();
    const validationMessage = !translatedValidation
      || normalizedQuestionText(translatedValidation) === normalizedQuestionText(item.validation?.message)
      ? fallback.validation
      : translatedValidation;
    const options = translatedMap.length ? translatedMap.map((pair) => pair.candidate) : candidateOptions;
    return {
      ...item,
      question,
      why,
      options,
      ...(applicationOptions.length ? { applicationOptions } : {}),
      optionMap: translatedMap,
      ...(item.validation ? { validation: { ...item.validation, ...(validationMessage ? { message: validationMessage } : {}) } } : {}),
      applicationQuestionLocale: sourceLocale,
      localizationStatus: 'translated',
    };
  });
  return localizedQuestions;
}

/** A zeroed portal requirement must stop automation instead of looking absent. */
export function portalQuestionReductionHandoff() {
  return { handoff: 'portal_question_reduction' };
}

export async function portalRequirementsForCandidate(requirements, localization = {}) {
  if (requirements?.unreadableFields?.length) throw new Error('portal_question_unreadable');
  const questions = requirements?.questions || [];
  const documents = requirements?.documents || [];
  if (!questions.length && !documents.length) return requirements?.reduction?.kind === 'empty' ? portalQuestionReductionHandoff() : null;
  const localized = await localizePortalQuestions(questions, localization);
  if (localized.some((question) => question.localizationStatus === 'fallback')) {
    throw new PortalQuestionLocalizationError();
  }
  return { questions: localized, documents };
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

function authFormIdentity(snapshot) {
  const fields = Array.isArray(snapshot?.fields) ? snapshot.fields : [];
  const password = fields.find((field) => field.inputType === 'password');
  const anchor = password || codeField(snapshot);
  if (!anchor) return null;
  const frame = Number(anchor.frame);
  if (!Number.isSafeInteger(frame) || frame < 0) return null;
  return { frame, formId: String(anchor.formId || '').trim() };
}

/** Presses the first control one of the patterns names; false when there is none, else how it was found. */
async function clickFirst(page, snapshot, patterns) {
  const frames = typeof page.frames === 'function' ? page.frames() : [];
  for (const pattern of patterns) {
    const button = findButton(snapshot.buttons, pattern);
    if (button) return clickButton(page, button);
    const snapshotLink = (snapshot.links || []).find((link) => !link.disabled
      && [link.text, link.label, link.title, link.ariaLabel].some((value) => pattern.test(String(value || ''))));
    if (snapshotLink) {
      const id = String(snapshotLink.id || '');
      if (/^[\w-]{1,80}$/.test(id)) {
        const frameNumber = Number(snapshotLink.frame) || 0;
        const frame = frames[frameNumber]
          || (frameNumber === 0 ? (typeof page.mainFrame === 'function' ? page.mainFrame() : page) : null);
        if (typeof frame?.locator === 'function') {
          const locator = frame.locator(`[data-aa-id="${id}"]`).first();
          const linkVisible = await locator.waitFor({ state: 'visible', timeout: 6_000 }).then(() => true, () => false);
          if (linkVisible) {
            await clickPortalLink(page, locator);
            return 'link';
          }
        }
      }
    }
    // A SuccessFactors account link can be drawn after the snapshot, or be
    // filtered from it as site chrome while the login fields remain in an
    // embedded form frame. Page.getByRole only searches the main frame; keep
    // this lookup explicit and frame-scoped so a generic header control is
    // never promoted to an auth action.
    const authForm = authFormIdentity(snapshot);
    const formFrameNumbers = [...new Set([
      ...(snapshot.fields || []), ...(snapshot.buttons || []),
    ].filter((control) => {
      const frame = Number(control.frame);
      return authForm && frame === authForm.frame
        && (!authForm.formId || String(control.formId || '').trim() === authForm.formId);
    }).map((control) => Number(control.frame)).filter((frame) => Number.isSafeInteger(frame) && frame >= 0))];
    const formFrames = formFrameNumbers.map((frame) => frames[frame]).filter(Boolean);
    const lateRoles = pattern === CREATE_ACCOUNT_RE ? ['link', 'button'] : ['link'];
    const firstVisibleRole = (root, role) => root.getByRole(role, { name: pattern })
      .filter({ visible: true })
      .first();
    for (const frame of formFrames) {
      if (typeof frame?.getByRole !== 'function') continue;
      for (const role of lateRoles) {
        const frameControl = firstVisibleRole(frame, role);
        const frameControlVisible = await frameControl.waitFor({ state: 'visible', timeout: 6_000 }).then(() => true, () => false);
        if (frameControlVisible) {
          await clickPortalLink(page, frameControl);
          return role;
        }
      }
    }
    // Once the snapshot identifies an auth form in a child frame, a same-named
    // main-frame control is site chrome, not the auth action we are looking for.
    if (!authForm || authForm.frame === 0) {
      for (const role of lateRoles) {
        const control = firstVisibleRole(page, role);
        const controlVisible = await control.waitFor({ state: 'visible', timeout: 6_000 }).then(() => true, () => false);
        if (controlVisible) {
          await clickPortalLink(page, control);
          return role;
        }
      }
    }
  }
  return false;
}

/** SuccessFactors leaves the OTP field and a loading live-region in place while the code is checked. */
async function waitForVerificationOutcome(page) {
  // After «Weiter» the federal SuccessFactors tenant posts two documents
  // (`/career`, then `/portalcareer`) and draws the application form in its
  // UI5 shell (2026-11-10): a read can fail between them, and a page with
  // nothing to act on is still drawing, not an unconfirmed verification.
  const read = () => extractFields(page).catch(() => null);
  const actionable = (view) => Boolean(view?.fields?.length) || (view?.buttons || []).some((button) => !button.disabled);
  const unsettled = (view, result) => !view || result === 'pending' || verificationIsPending(view)
    || (result === 'unconfirmed' && !actionable(view));
  let after = await read();
  let outcome = after ? verificationOutcome(after) : 'pending';
  const deadline = Date.now() + OUTCOME_TIMEOUT_MS;
  while (unsettled(after, outcome) && Date.now() < deadline) {
    await page.waitForTimeout(Math.min(1000, deadline - Date.now()));
    after = await read();
    outcome = after ? verificationOutcome(after) : 'pending';
  }
  // The same non-throwing read: a page still unreadable at the deadline is a
  // pending outcome, answered by a bounded handoff, never an uncaught rejection.
  after ||= await read();
  if (!after) return { after: null, outcome: 'pending' };
  return { after, outcome: outcome === 'pending' && !verificationIsPending(after) ? verificationOutcome(after) : outcome };
}

/**
 * The candidate's own session on the job's form: no sign-in or registration
 * form, no code field, and the application itself (a CV field, the usual
 * fields, or its send control). SBB after its OTP (2026-11-10): `/portalcareer`
 * with «Bewerbung abschicken» and «Abmelden», its sections closed (one visible
 * field); Damiani right after a registration that asked for no OTP.
 */
// A positive mark of the candidate's own session: a guest application view has
// a CV field and a submit button too, but no way to sign out or reach a profile.
const SESSION_MARKER_RE = /\b(?:abmelden|ausloggen|log ?out|sign ?out|esci|disconnetti|d[ée]connexion|se d[ée]connecter|mein profil|my profile|mon profil|il mio profilo|mein konto|my account|mon compte|il mio account|meine dokumente|my documents|mes documents|i miei documenti)\b/i;
function showsCandidateSession(view) {
  const controls = [...(Array.isArray(view?.buttons) ? view.buttons : []), ...(Array.isArray(view?.links) ? view.links : [])];
  return controls.some((control) => SESSION_MARKER_RE.test([control?.text, control?.label, control?.ariaLabel].filter(Boolean).join(' ')));
}

export function signedInApplicationSurface(view) {
  return Boolean(view) && Array.isArray(view.fields) && authPageKind(view) === 'none' && !codeField(view)
    && (hasApplicationForm(view) || sendsApplication(view)) && showsCandidateSession(view);
}

/** The verification e-mail's link (on the portal's own site) or code, read from the order's inbox. */
export async function verifyAccount({ page, host, sinceMs, ctx, snapshot }) {
  let current = snapshot || await extractFields(page);
  const existingVerificationIds = typeof ctx.accounts.verificationMessageIds === 'function'
    ? await ctx.accounts.verificationMessageIds()
    : [];
  const account = typeof ctx.accounts.load === 'function' ? await ctx.accounts.load(host).catch(() => null) : null;
  if (typeof account?.recoveryRequestedAt === 'number' && Number.isFinite(account.recoveryRequestedAt)) {
    sinceMs = Math.max(Number(sinceMs) || 0, account.recoveryRequestedAt + 1);
  }
  let verification = Number(account?.recoveryRequestedAt) > 0
    && typeof ctx.accounts.recoveryActivation === 'function'
    ? await ctx.accounts.recoveryActivation({ host, sinceMs: Number(account.recoveryRequestedAt) })
    : null;
  const requestedAt = Date.now();
  let resendRequested = false;
  try {
    // Use only a recovery-window activation link already bound to this exact
    // account; otherwise ask the portal to send a fresh verification.
    if (!verification && await clickFirst(page, current, [RESEND_VERIFICATION_RE])) {
      await settle(page);
      current = await extractFields(page);
      sinceMs = requestedAt;
      resendRequested = true;
    }
  } catch {
    // A portal may remove the resend control while processing the request;
    // the existing message is still a valid fallback for this run.
  }
  if (!verification) verification = await ctx.accounts.waitForVerification({
    host,
    sinceMs,
    ...(resendRequested ? { excludeMessageIds: existingVerificationIds } : {}),
  });
  if (!verification) return accountHandoff('account_verification_timeout', 'verification_timeout', 'verification');
  const submittedAt = Date.now();
  if (verification.url) {
    await page.goto(verification.url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await settle(page);
  } else {
    const field = codeField(current);
    if (!field) return accountHandoff('account', 'verification_unobserved', 'verification');
    await applyActions(page, current.fields, [{ fieldId: field.id, action: 'fill', value: verification.code }], {});
    if (!await clickFirst(page, current, [SUBMIT_RE, NEXT_RE, ACCOUNT_VERIFY_RE])) return accountHandoff('account', 'verification_unobserved', 'verification');
    await settle(page);
  }
  let { after, outcome } = await waitForVerificationOutcome(page);
  // The portal took the code and opened the job's form in the candidate's own
  // session (SBB: «Bewerbung abschicken», «Abmelden», one visible field, which
  // the generic reading leaves `unconfirmed`). That page is the answer.
  if (outcome === 'unconfirmed' && signedInApplicationSurface(after)) outcome = 'accepted';
  // The federal SuccessFactors tenant can redirect a verified code to the
  // source-proven `/portalcareer` shell before its UI5 controls are readable.
  // The same posting-bound route proof used by the application guard is
  // sufficient continuation evidence here; an unbound or generic empty page
  // must remain unconfirmed.
  if ((outcome === 'unconfirmed' || outcome === 'pending')
    && isSuccessFactorsPortalCareerContinuation({
      applyUrl: page.url(),
      postingUrl: ctx?.postingUrl || ctx?.postingRouteProof?.postingUrl,
      postingRouteProof: ctx?.postingRouteProof,
    })) outcome = 'accepted';
  // The page may never settle on something the runner can read, while the
  // portal itself mails that the account now exists (the federal tenant's
  // «Ihr Bewerbungskonto wurde erfolgreich erstellt», bound to this host by the
  // inbound handler). That notice, received after the code was sent, is the
  // portal's own word; a refused or expired code is never overridden by it.
  // A page still loading at the deadline (`pending`) is as open as an unconfirmed one.
  if ((outcome === 'unconfirmed' || outcome === 'pending') && typeof ctx.accounts.waitForAccountNotice === 'function'
    && await ctx.accounts.waitForAccountNotice({ host, sinceMs: submittedAt })) {
    outcome = 'accepted';
  }
  // Verified only when the portal says so: an expired or refused token never
  // marks the account verified for the next runs.
  if (outcome !== 'accepted') {
    const code = outcome === 'pending' ? 'verification_timeout' : outcome === 'rejected' ? 'verification_rejected' : 'verification_unobserved';
    return accountHandoff(`account_verification_${outcome}`, code, 'verification');
  }
  await ctx.accounts.mark(host, { verifiedAt: Date.now() });
  // Accepted on the portal's notice while the page stayed unreadable: the job is reopened anyway.
  const snapshotAfter = after || await extractFields(page).catch(() => null)
    || { url: page.url(), fields: [], buttons: [], links: [], errors: [] };
  return { snapshot: snapshotAfter, reopen: true };
}

// SuccessFactors' required privacy statement (Coop, 2026-10-02) starts as a
// link, only once the country is chosen. Its dialog can require a separate
// “I have reviewed…” checkbox before «Akzeptieren» becomes enabled. This is
// the application's own required consent (plan.mjs), never a newsletter or a
// job alert.
//
// The wording is the tenant's: infinitive («lesen und akzeptieren», Coop),
// imperative («Lese und akzeptiere», 2026-10-30), a button or a plain link. The
// consent guard reads it, with the same grammar it reads a required box with.
const noticeControls = (snapshot) => [...(Array.isArray(snapshot.buttons) ? snapshot.buttons : []), ...(Array.isArray(snapshot.links) ? snapshot.links : [])];
const optionalNotice = (control) => ownConsent.isOptionalPurpose(control.text, control.ownLabel, control.label, control.title, control.ariaLabel);
/** Opened by the runner: the notice this application needs, in a control that keeps the page on the form. */
const privacyStatementControl = (control) => !control.disabled && !control.chrome && !control.leavesDocument && ownConsent.isRequiredNotice(control);

export const PRIVACY_REVIEW_RE = /(dpcs|data[\s_-]*privacy.*(?:review|read|accept)|privacy.*(?:review|read|accept)|datenschutz.*(?:gelesen|akzept|zustimm)|(?:ich habe|i have|j['’]ai|ho)\s+.*(?:gelesen|reviewed|read|lu|letto)|(?:presa|preso|prise|pris)\s+visione|consent.*(?:review|read|accept|gelesen|lu|letto))/i;
// «Zur Kenntnis genommen» (SBB, 2026-11-10) and the other acknowledgements close the statement as accepted.
export const PRIVACY_ACCEPT_RE = /^(akzeptieren|akzeptiere|ich akzeptiere|accept|i accept|agree|i agree|zustimmen|stimme zu|ich stimme zu|accetta|accetto|accettare|accepter|acceptez|j['’]accepte|(?:zur )?kenntnis genommen|ich habe (?:es )?zur kenntnis genommen|gelesen und akzeptiert|einverstanden|ich bin einverstanden|acknowledged?|i acknowledge|read and accepted|(?:ho )?pres[ao] visione|letto e accettato|(?:j['’]ai )?pris connaissance|lu et accept[ée])(?:\s+(?:und|and|et|e)\s+(?:weiter|fortfahren|continue|proceed|continuer|continuare|continua|schlie(?:ss|ß)en|close|fermer|chiudi))?\W*$/i;
// How long a form gets to free its button after the notice was accepted.
const PRIVACY_ENABLE_TIMEOUT_MS = 8_000;

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
    ...(Array.isArray(snapshot.dialogs) ? snapshot.dialogs : []),
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
  const reviewCandidate = field => field.kind === 'checkbox' && (field.required || ownConsent(field)
    || PRIVACY_REVIEW_RE.test(`${field.label || ''} ${field.name || ''} ${field.autocomplete || ''}`));
  const reviewFields = dialogFields.filter((field) => reviewCandidate(field)
    && !ownConsent.isOptionalPurpose(field.label, field.name, field.autocomplete)
    && ownConsent.isNoticeReview(field.label, field.name, field.autocomplete, field.domId, field));
  const candidateTokens = new Set([
    ...reviewFields.map(dialogToken),
    ...dialogButtons.map(dialogToken),
  ].filter(Boolean));
  const candidates = [...candidateTokens].map((token) => {
    const reviews = reviewFields.filter((field) => dialogToken(field) === token);
    const review = reviews[0] || null;
    const buttonsInDialog = dialogButtons.filter((button) => dialogToken(button) === token && !optionalNotice(button));
    // An enabled Accept must not bypass an unrecognised factual or negated review box.
    const unknownReview = dialogFields.some((field) => dialogToken(field) === token && reviewCandidate(field)
      && !ownConsent.isNoticeReview(field.label, field.name, field.autocomplete, field.domId, field)
      && (!ownConsent.isOptionalPurpose(field.label, field.name, field.autocomplete) || !review || field.required));
    return { token, review, reviews, accept: unknownReview ? null : findButton(buttonsInDialog, PRIVACY_ACCEPT_RE, { includeDisabled: true }) };
  });
  const preferred = preferredDialogToken
    ? candidates.find((candidate) => candidate.token === preferredDialogToken) || null
    : null;
  const candidate = preferred || candidates
    .map((item, index) => ({ item, index }))
    .sort((left, right) => candidateScore(right.item) - candidateScore(left.item) || right.index - left.index)[0]?.item || null;
  const review = candidate?.review || null;
  const controls = noticeControls(snapshot);
  const notices = controls.filter((control) => !control.chrome && ownConsent.isNoticeRequest(control.text));
  return {
    trigger: controls.find(privacyStatementControl) || null,
    // Asks to read and accept something the runner may not open or accept for
    // the candidate. Never pressed: the caller can only name it.
    notice: notices.find((control) => !optionalNotice(control)) || notices[0] || null,
    review,
    reviews: candidate?.reviews || [],
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

/**
 * The dialog names the notice itself. Its title is read in its own document: the
 * snapshot's `section` of a control in a dialog is whatever heading the page has above it.
 */
async function ownPrivacyDialog(page, token, review) {
  const separator = token.indexOf(':');
  const frame = page.frames()[Number(token.slice(0, separator))] || page.mainFrame();
  const title = await frame.evaluate((key) => {
    const dialog = document.querySelector(`[data-aa-dialog-id="${CSS.escape(key)}"]`);
    if (!dialog) return '';
    const labelledBy = (dialog.getAttribute('aria-labelledby') || '').split(/\s+/).filter(Boolean)
      .map((id) => document.getElementById(id)?.textContent || '');
    return [dialog.getAttribute('aria-label') || '', ...labelledBy, dialog.querySelector('h1, h2, h3, h4, [role="heading"]')?.textContent || ''].join(' ');
  }, token.slice(separator + 1)).catch(() => '');
  return ownConsent.isNoticeDialog(title, review?.label);
}

/** @returns {Promise<'none'|'accepted'|'unavailable'>} */
export async function acceptPrivacyStatement(page, snapshot, { targetControl = registrationButton(snapshot) } = {}) {
  const controlFrame = control => Number.isInteger(control?.frame) ? control.frame : 0;
  const controlForm = control => Number.isInteger(control?.form) ? control.form : null;
  const targetForm = controlForm(targetControl);
  const sameTargetFrame = control => Boolean(targetControl) && controlFrame(control) === controlFrame(targetControl);
  // SuccessFactors places its required privacy notice outside the registration
  // form. Bind it to the CTA's frame and allow only that form or page-level controls.
  const belongsToTarget = control => targetForm !== null && targetForm >= 0 && sameTargetFrame(control)
    && (controlForm(control) === targetForm || controlForm(control) === -1);
  const targetControls = current => privacyConsentControls({ ...current,
    buttons: (current.buttons || []).filter(belongsToTarget), links: (current.links || []).filter(belongsToTarget) });
  if (!targetControls(snapshot).trigger) return privacyConsentControls(snapshot).trigger ? 'unavailable' : 'none';
  // The last field filled (the password repeat) checks itself on blur:
  // SuccessFactors asks its password policy and a click on the statement's
  // link meanwhile is lost. Blur first, wait for that request, then open the
  // dialog; retry once if the portal redraws the form during the first click.
  await page.evaluate(() => document.activeElement?.blur?.()).catch(() => {});
  await settle(page);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const deadline = Date.now() + 8_000;
    const currentSnapshot = await extractFields(page, NAVIGATION).catch(() => snapshot);
    const trigger = targetControls(currentSnapshot).trigger;
    if (!trigger) break;
    const beforeDialogTokens = visibleDialogTokens(currentSnapshot);
    // The statement opens in the document of its link; a dialog that appears
    // meanwhile in another frame is someone else's.
    const triggerFrame = `${trigger.frame || 0}:`;
    let openedDialogToken = '';
    const controlsForOpenedDialog = (current) => {
      const currentDialogTokens = visibleDialogTokens(current);
      const newlyOpened = [...currentDialogTokens].filter((token) => token.startsWith(triggerFrame) && !beforeDialogTokens.has(token));
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
      const controls = current ? controlsForOpenedDialog(current) : {};
      // Nothing is touched in a dialog that does not name this notice: it may still be loading, or be another's.
      if (controls.dialogToken && await ownPrivacyDialog(page, controls.dialogToken, controls.review)) {
        const expectedReviews = controls.reviews || [];
        const uncheckedReviews = expectedReviews.filter(review => !review.checked);
        if (uncheckedReviews.length) {
          // A box that does not register is an unfinished notice, not a crash.
          await applyActions(page, current.fields, uncheckedReviews.map(review => ({ fieldId: review.id, action: 'check' })), {}, { pause: async () => {} }).catch(() => {});
          await scrollPrivacyStatement(page);
        }
        const refreshed = await extractFields(page, NAVIGATION).catch(() => null);
        const { accept, reviews = [] } = controlsForOpenedDialog(refreshed || {});
        const reviewed = reviews.every(review => review.checked) && expectedReviews.every(expected =>
          reviews.some(review => review.id === expected.id && review.frame === expected.frame && review.checked));
        if (accept && !accept.disabled && reviewed) {
          try {
            await clickButton(page, accept);
            await page.waitForTimeout(800);
            // Accepted only once the dialog has gone: a click it ignored proves nothing.
            const closed = await extractFields(page, NAVIGATION).catch(() => null);
            const scannedFrame = closed?.frames?.some(frame => frame.index === Number(trigger.frame || 0));
            const remaining = closed && [...visibleDialogTokens(closed)].some(token => token.startsWith(triggerFrame) && !beforeDialogTokens.has(token));
            if (scannedFrame && !remaining) return 'accepted';
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

const registrationButton = (snapshot) => {
  const openers = new Set(inPageApplicationOpeners(snapshot, snapshot?.url).map(portalControlIdentity));
  const buttons = (snapshot.buttons || []).filter((button) => !openers.has(portalControlIdentity(button)));
  return [CREATE_ACCOUNT_RE, SUBMIT_RE, NEXT_RE]
    .map((pattern) => findButton(buttons, pattern, { includeDisabled: true })).find(Boolean) || null;
};

/**
 * Before the registration's button: the notice accepted and the button free,
 * or `blocked`, with nothing pressed. A portal keeps its button shut until the
 * notice is accepted, and a press on it answers nothing: read afterwards, that
 * silence would be a registration that may have gone through.
 * @returns {Promise<{ privacy: 'none'|'accepted'|'unavailable', filled: object, blocked: boolean }>}
 */
export async function registrationPrivacyPreflight(page, { accepted = false, timeoutMs = PRIVACY_ENABLE_TIMEOUT_MS } = {}) {
  const initial = await extractFields(page, NAVIGATION);
  const targetControl = registrationButton(initial);
  const privacy = await acceptPrivacyStatement(page, initial, { targetControl });
  let filled = await extractFields(page, NAVIGATION);
  if (privacy === 'unavailable') return { privacy, filled, blocked: true };
  // A repair of the same form: the link of a notice already accepted can stay on the page, shut.
  if (privacy === 'none' && accepted) return { privacy, filled, blocked: false };
  if (privacy === 'none') {
    // A button shut by its styling alone reads as free: only an optional notice
    // leaves the way open, and then only past a button that is not shut.
    const sameForm = control => targetControl && targetControl.form >= 0 && control.form === targetControl.form && control.frame === targetControl.frame;
    const { notice } = privacyConsentControls({ ...filled, buttons: filled.buttons.filter(sameForm), links: (filled.links || []).filter(sameForm) });
    // A link off the form is no way to accept: a ticked own box of the form already is.
    const cta = registrationButton(filled);
    const answered = Boolean(notice?.leavesDocument) && cta && !cta.disabled && notice.form >= 0
      && notice.form === cta.form && notice.frame === cta.frame
      && (filled.fields || []).some((field) => field.checked && ownConsent(field)
        && field.form === notice.form && field.frame === notice.frame);
    const blocked = Boolean(notice) && !answered && (!optionalNotice(notice) || Boolean(registrationButton(filled)?.disabled));
    return blocked ? { privacy: 'unavailable', filled, blocked } : { privacy, filled, blocked };
  }
  if (!registrationButton(filled)?.disabled) return { privacy, filled, blocked: false };
  for (const deadline = Date.now() + timeoutMs; Date.now() < deadline;) {
    await page.waitForTimeout(250);
    filled = await extractFields(page, NAVIGATION).catch(() => filled);
    if (!registrationButton(filled)?.disabled) return { privacy, filled, blocked: false };
  }
  return { privacy: 'unavailable', filled, blocked: true };
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
const ANONYMOUS_FILE_LABEL_RE = /^\(?\s*(?:unlabel(?:led|ed)|without\s+(?:a\s+)?label|no\s+label|senza\s+etichetta|sans\s+(?:étiquette|etiquette)|ohne\s+(?:beschriftung|label))\s*\)?$/iu;
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

const anonymousFileField = (field) => {
  if (!isFileField(field)) return false;
  const label = String(field?.label || '').replace(/\s+/g, ' ').trim();
  const identity = [
    field?.label,
    field?.name,
    field?.domId,
    field?.controlId,
    field?.semanticId,
    field?.context,
    field?.section,
  ].filter(Boolean).join(' ');
  if (CV_DOCUMENT_CONTEXT_RE.test(identity)
    || COVER_LETTER_DOCUMENT_CONTEXT_RE.test(identity)
    || isNonCvDocumentLabel(identity)) return false;
  return !label || machineLabel(label) || ANONYMOUS_FILE_LABEL_RE.test(label);
};

const singleAnonymousFileField = (snapshot) => {
  const fileFields = (snapshot?.fields || []).filter(isFileField);
  return fileFields.length === 1 && anonymousFileField(fileFields[0]) ? fileFields[0] : null;
};

const hasSingleAnonymousFileField = (snapshot) => Boolean(singleAnonymousFileField(snapshot));

const buttonMatchesDocumentContext = (button, contextPattern) => {
  const context = buttonHasExplicitDocumentContext(button);
  return !context || contextPattern.test(context);
};

const genericUploadPickerContextMatches = (button, contextPattern, otherPattern) => {
  const section = String(button?.section || '').trim();
  if (section && (contextPattern.test(section) || otherPattern.test(section) || isNonCvDocumentLabel(section))) {
    return contextPattern.test(section) && !otherPattern.test(section) && !isNonCvDocumentLabel(section);
  }
  const context = [button?.context, button?.fileContext].filter(Boolean).join(' ');
  return contextPattern.test(context) && !otherPattern.test(context) && !isNonCvDocumentLabel(context);
};

const anonymousCvPickerCandidate = (snapshot) => {
  const field = singleAnonymousFileField(snapshot);
  if (!field) return null;
  const eligible = (snapshot?.buttons || []).filter((button) => {
    if (button.disabled || button.chrome || !FILE_PICKER_ACTION_RE.test(String(button?.text || '').trim())) return false;
    const context = buttonHasExplicitDocumentContext(button);
    return !context || !(CV_DOCUMENT_CONTEXT_RE.test(context)
      || COVER_LETTER_DOCUMENT_CONTEXT_RE.test(context)
      || isNonCvDocumentLabel(context));
  });
  if (eligible.length !== 1) return null;
  const [candidate] = eligible;
  const candidateFrame = Number.isInteger(candidate.frame) ? candidate.frame : 0;
  return candidateFrame === fieldFrame(field) ? candidate : null;
};

const isAnonymousCvPickerButton = (snapshot, button) => anonymousCvPickerCandidate(snapshot) === button;

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
// SuccessFactors draws each document slot as one button: the slot's caption, its action and the dialog it opens
// («* Lebenslauf - Zeugnisse - Diplome Lebenslauf Öffnet ein Dialogfeld», Helsana s2Tbwwjd; «* Lebenslauf
// Lebenslauf hinzufügen Öffnet ein Dialogfeld», Bund eHSYErA1, 2026-11-10). Its action has no verb the upload
// patterns know (none at all on Helsana), so the CV was never attached (trigger_not_found) and the empty slot
// came back as a text question. The caption says which document the slot takes; a slot that already holds one
// («Edit document <file>») is not a new upload.
const SUCCESS_FACTORS_DIALOG_SLOT_RE = /\s(?:öffnet\s+ein\s+dialog(?:feld|fenster)?|opens\s+a\s+dialog(?:\s+box)?|ouvre\s+une\s+(?:boîte\s+de\s+)?dialogue|apre\s+(?:una\s+)?(?:finestra\s+di\s+)?dialogo)\s*$/iu;
const SUCCESS_FACTORS_FILLED_SLOT_RE = /\b(?:edit\s+document|dokument\s+bearbeiten|modifica\s+(?:il\s+)?documento|modifier\s+(?:le\s+)?document)\b/i;

/** The document a slot caption names ('cv' | 'cover_letter'); '' when it names neither, or both. */
function documentSlotCaptionKind(caption) {
  const cv = CV_DOCUMENT_CONTEXT_RE.test(caption);
  const coverLetter = COVER_LETTER_DOCUMENT_CONTEXT_RE.test(caption);
  return cv && !coverLetter ? 'cv' : coverLetter && !cv ? 'cover_letter' : '';
}

/** The document a SuccessFactors slot button takes ('cv' | 'cover_letter'), or '' for any other control. */
export function successFactorsDocumentSlotKind(button) {
  const text = String(button?.text || '').replace(/\s+/g, ' ').trim();
  if (!SUCCESS_FACTORS_DIALOG_SLOT_RE.test(text) || SUCCESS_FACTORS_FILLED_SLOT_RE.test(text)) return '';
  const caption = text.replace(SUCCESS_FACTORS_DIALOG_SLOT_RE, '');
  // «Cover Letter Delete document <file> Opens a dialog» (Damiani, 2026-11-10) holds a file and takes it away:
  // read as the letter's upload slot, it was clicked three times as one, and each click asked to delete the file.
  if (REMOVE_FILE_RE.test(caption)) return '';
  return documentSlotCaptionKind(caption);
}

// The other documents a slot caption may list beside the CV («Lebenslauf - Zeugnisse - Diplome», Helsana
// s2Tbwwjd). Every part of the caption must be one of these nouns: a caption with any other word is a question.
const SLOT_CAPTION_PART_RE = new RegExp(`^(?:${CV_DOCUMENT_TERMS}|${COVER_LETTER_DOCUMENT_TERMS}|${QUALIFICATION_DOCUMENT_TERMS}`
  + '|dokumente|documents|documenti|(?:bewerbungs)?unterlagen|bewerbungsdossier|anh[aä]nge|beilagen|attachments|allegati'
  + '|pi[eè]ces\\s+jointes)$', 'iu');
const SLOT_CAPTION_SEPARATOR_RE = /\s*[-–—/,;|+&·]\s*|\s+(?:und|and|et|e|ed|sowie)\s+/iu;
const anchoredPattern = (pattern) => new RegExp(`^(?:${pattern.source})$`, pattern.flags.replace('g', ''));
const CAPTION_UPLOAD_RE = { cv: anchoredPattern(CV_UPLOAD_RE), cover_letter: anchoredPattern(COVER_LETTER_UPLOAD_RE) };

/**
 * The document a held portal question really is ('cv' | 'cover_letter'), or '' for a question. A runner that
 * found no upload action in a document slot reported the empty slot as a required text question (Helsana
 * s2Tbwwjd, «Lebenslauf - Zeugnisse - Diplome»): the draft keeps only the slot's caption, so it is read with
 * the slot rule above (successFactorsDocumentSlotKind) and accepted only when the caption is nothing but
 * document names, or exactly an upload instruction («Lebenslauf hochladen»), on a free text field with no
 * options and no format. «Lebenslauf und Motivationsschreiben», a question mark, or any other word: ''.
 */
export function portalQuestionDocumentSlotKind(question) {
  if (question?.source !== 'portal') return '';
  const type = String(question.type || 'text').trim().toLowerCase();
  if (!['text', 'file'].includes(type) || (Array.isArray(question.options) && question.options.length)
    || String(question.validation?.pattern || '').trim()) return '';
  const caption = String(question.applicationQuestion || question.question || '').replace(/\s+/g, ' ')
    .replace(/^[\s*:]+|[\s*:]+$/g, '').trim();
  if (!caption || caption.length > 120 || /[?¿()]/.test(caption)) return '';
  const kind = documentSlotCaptionKind(caption);
  if (!kind) return '';
  if (CAPTION_UPLOAD_RE[kind].test(caption)) return kind;
  const parts = caption.split(SLOT_CAPTION_SEPARATOR_RE).map(part => part.trim());
  return parts.length <= 6 && parts.every(part => SLOT_CAPTION_PART_RE.test(part)) ? kind : '';
}

export function uploadButtonCandidatesFor(snapshot, kind) {
  const pattern = kind === 'cv' ? CV_UPLOAD_RE : kind === 'cover_letter' ? COVER_LETTER_UPLOAD_RE : null;
  const contextPattern = kind === 'cv' ? CV_DOCUMENT_CONTEXT_RE : kind === 'cover_letter' ? COVER_LETTER_DOCUMENT_CONTEXT_RE : null;
  if (!pattern || !contextPattern) return [];
  const hasAnonymousCvPicker = kind === 'cv' && hasSingleAnonymousFileField(snapshot);
  const candidates = [];
  const candidateKeys = new Set();
  const contextIconCandidates = [];
  const iconCandidates = [];
  const add = (button) => {
    if (!button || button.disabled || button.chrome) return;
    // A control that takes a file away is never the one that puts a file in.
    if (REMOVE_FILE_RE.test(String(button.text || ''))) return;
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
    if (!button.disabled && !button.chrome && successFactorsDocumentSlotKind(button) === kind) add(button);
  }
  for (const button of snapshot?.buttons || []) {
    if (button.disabled || button.chrome) continue;
    const context = [button.section, button.context, button.fileContext].filter(Boolean).join(' ');
    if (!contextPattern.test(context)) continue;
    const text = String(button.text || '').trim();
    if (pattern.test(text)) {
      add(button);
      continue;
    }
    const otherPattern = kind === 'cv' ? COVER_LETTER_DOCUMENT_CONTEXT_RE : CV_DOCUMENT_CONTEXT_RE;
    if (FILE_PICKER_ACTION_RE.test(text)
      && genericUploadPickerContextMatches(button, contextPattern, otherPattern)) {
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
  // Workday's French «Présentez-vous» step can expose only one anonymous file
  // input and a generic «sélectionner un fichier» button. There is no safe
  // document word to put in the button's context, so bind that picker only to
  // the sole anonymous file field; multiple anonymous inputs stay ambiguous.
  if (hasAnonymousCvPicker && candidates.length === 0 && contextIconCandidates.length === 0) {
    for (const button of snapshot?.buttons || []) {
      if (button.disabled || button.chrome || !isAnonymousCvPickerButton(snapshot, button)) continue;
      add(button);
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
async function uploadThroughDialog(page, trigger, file, triggerFrame = 0, trace = null, canUpload = () => true) {
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
  if (!canUpload()) {
    if (page.keyboard?.press) await page.keyboard.press('Escape').catch(() => {});
    if (trace) trace.failure = 'posting_mismatch';
    return finish('blocked');
  }
  if (target?.chooser) {
    if (trace) trace.target = 'chooser';
    try {
      const chooser = target.chooser;
      // SuccessFactors can replace the file input while handling the native
      // chooser's change event. Capture the triggering element before the
      // selection so the receipt check still has a stable reference when the
      // post-selection `chooser.element()` points at no node.
      const initialInput = await Promise.resolve().then(() => chooser.element()).catch(() => null);
      if (trace) trace.chooserElementBeforeSelection = Boolean(initialInput);
      if (!canUpload()) {
        if (page.keyboard?.press) await page.keyboard.press('Escape').catch(() => {});
        if (trace) trace.failure = 'posting_mismatch';
        return finish('blocked');
      }
      const receipt = await chooseChooserFiles(page, chooser, file);
      if (trace) trace.chooserResponse = receipt.accepted ? 'accepted' : 'not_confirmed';
      if (receipt.accepted) return finish('uploaded');
      const refreshedInput = await Promise.resolve().then(() => chooser.element()).catch(() => null);
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
  if (!canUpload()) {
    if (page.keyboard?.press) await page.keyboard.press('Escape').catch(() => {});
    if (trace) trace.failure = 'posting_mismatch';
    return finish('blocked');
  }
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

/** Upload the one anonymous field already mounted behind a generic Workday picker. */
async function uploadThroughExistingFileField(page, field, file, trace = null, canUpload = () => true) {
  if (!canUpload()) {
    if (trace) trace.failure = 'posting_mismatch';
    return 'blocked';
  }
  const locator = locatorFor(page, field);
  try {
    if (!canUpload()) {
      if (trace) trace.failure = 'posting_mismatch';
      return 'blocked';
    }
    const [result] = await applyActions(page, [field], [{
      fieldId: field.id,
      action: 'upload',
      document: 'cv',
    }], { cv: file }, { pause: async () => {} });
    if (trace) {
      trace.target = 'existing_field';
      trace.selection = result?.ok ? 'succeeded' : 'failed';
    }
    if (!result?.ok) {
      if (trace) trace.failure = result?.error || 'existing_field_selection_failed';
      return 'unavailable';
    }
    const confirmed = await uploadReceipt(page, locator, [file], {
      acceptedResponse: result.uploadAccepted === true,
    });
    if (trace) trace.portalReceipt = confirmed;
    return confirmed ? 'uploaded' : 'uploaded_unconfirmed';
  } catch (error) {
    if (trace) trace.failure = error?.message === 'upload_http_failed' ? 'upload_http_failed' : 'existing_field_selection_failed';
    return 'unavailable';
  }
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
export async function openFormSections(page, snapshot, { files = {}, done = new Set(), tries = new Map(), channelType = '', applyUrl = '' } = {}) {
  let current = snapshot;
  const where = anonymizePath(page.url());
  const cvUploadDiagnostics = [];
  const routeMismatch = () => workdayPostingRouteMismatch(page.url(), applyUrl);
  if (routeMismatch()) return { snapshot: current, handoff: 'posting_mismatch' };
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
  if (routeMismatch()) return { snapshot: current, handoff: 'posting_mismatch' };
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
    if (routeMismatch()) return { snapshot: current, handoff: 'posting_mismatch' };
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
    const anonymousField = isAnonymousCvPickerButton(current, triggerButton)
      ? singleAnonymousFileField(current) : null;
    const boundWorkdayApplication = isWorkdayTenantUrl(page.url()) && Boolean(applyUrl)
      && isWorkdayJobRouteBound(page.url(), applyUrl);
    const canUpload = () => !routeMismatch();
    cv = anonymousField && !boundWorkdayApplication
      ? await uploadThroughExistingFileField(page, anonymousField, cvFile, trace, canUpload)
      : await uploadThroughDialog(page, trigger, cvFile, triggerButton.frame || 0, trace, canUpload);
    if (cv === 'blocked') return { snapshot: current, handoff: 'posting_mismatch' };
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
    if (routeMismatch()) return { snapshot: current, handoff: 'posting_mismatch' };
    const triggerButton = nextAllowedUploadTrigger(page, current, 'cover_letter', channelType, pendingCoverLetterTriggers, triedCoverLetterTriggers);
    const triggerKey = triggerButton && uploadTriggerKey(triggerButton);
    if (triggerKey) triedCoverLetterTriggers.add(triggerKey);
    if (!triggerButton) break;
    const trigger = ICON_ONLY_BUTTON_RE.test(String(triggerButton.text || '').trim())
      ? { snapshot: triggerButton } : locatorFor(page, triggerButton);
    const visible = trigger?.snapshot ? true : await trigger?.isVisible().catch(() => false);
    if (!trigger || !visible) continue;
    coverLetter = await uploadThroughDialog(page, trigger, coverLetterFile, triggerButton.frame || 0, null, () => !routeMismatch());
    if (coverLetter === 'blocked') return { snapshot: current, handoff: 'posting_mismatch' };
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
      if (plan) {
        const actions = Array.isArray(plan.actions) ? plan.actions : [];
        const missingRequired = Array.isArray(plan.missingRequired) ? plan.missingRequired : [];
        const profileActions = new Map();
        for (const field of rowFields) {
          const answer = profileEntryAnswer(entry, kind, field);
          if (!answer) continue;
          profileActions.set(field.id, {
            ...actions.find((action) => action.fieldId === field.id),
            fieldId: field.id,
            action: field.options?.length ? 'select' : 'fill',
            ...answer,
            document: 'none',
            evidence: '',
          });
        }
        plan = {
          ...plan,
          actions: [...actions.filter((action) => !profileActions.has(action.fieldId)), ...profileActions.values()],
          missingRequired: missingRequired.filter((missing) => !profileActions.has(missing.fieldId)),
        };
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

/** Open only the job-bound SuccessFactors registration view on the same HTTPS origin. */
async function openSuccessFactorsRegistrationNavigation(page, snapshot) {
  const identity = authFormIdentity(snapshot);
  const frame = identity && page.frames()[identity.frame];
  const currentUrl = frame?.url?.() || '';
  const target = successFactorsRegistrationTarget(currentUrl);
  if (!frame || !target) return null;
  let before;
  try {
    before = new URL(currentUrl);
    await frame.goto(target, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    const after = new URL(frame.url());
    if (after.protocol !== 'https:' || after.origin !== before.origin || after.pathname !== before.pathname
      || after.searchParams.get('career_ns') !== before.searchParams.get('career_ns')
      || after.searchParams.get('career_job_req_id') !== before.searchParams.get('career_job_req_id')
      || after.searchParams.get('company') !== before.searchParams.get('company')
      || after.searchParams.get('login_ns') !== 'register') return null;
  } catch {
    return null;
  }
  const registration = await awaitAuthView(page, snapshot).catch(() => null);
  return registration && authPageKind(registration) === 'create' ? registration : null;
}

/** Only classify a dialog as a cookie manager when its live copy and own choice agree. */
async function knownCookieDialogSnapshot(page, snapshot) {
  for (const dialog of snapshot?.dialogs || []) {
    const dialogId = String(dialog.dialogId || '');
    if (!/^d\d+$/.test(dialogId)) continue;
    const buttons = (snapshot.buttons || []).filter((button) => {
      if (!button.dialog || button.dialogId !== dialogId) return false;
      // dismissCookieBanner/findButton selects on the visible text, not the
      // accessible label; validate the same value before passing it through.
      const label = String(button.text || '').trim();
      return COOKIE_REJECT_RE.test(label) || (COOKIE_ACCEPT_RE.test(label) && !COOKIE_GENERIC_ACCEPT_LABEL_RE.test(label));
    });
    if (!buttons.length) continue;
    const frame = page.frames()[Number(dialog.frame ?? buttons[0].frame) || 0] || page.mainFrame();
    const dialogText = await frame.locator(`[data-aa-dialog-id="${dialogId}"]`)
      .innerText({ timeout: 1_000 }).catch(() => '');
    if (COOKIE_DIALOG_CONTEXT_RE.test(dialogText)) return { ...snapshot, buttons, dialogs: [dialog] };
  }
  return null;
}

/**
 * Follow only an explicitly named sign-in destination. Workday's `signInLink`
 * is a button, so it is accepted only when its live node is inside the same
 * form as that page's email and password fields; the site-header control is
 * never an account-navigation action.
 */
export async function openVerifiedSignInNavigation(page, snapshot) {
  let currentSnapshot = snapshot;
  if (currentSnapshot?.dialogs?.length) {
    // Cookie managers are the only overlays this path is allowed to dismiss:
    // live dialog copy and its own explicit choice must confirm that context.
    // Pass only this dialog to shared policy so a generic «Accept» elsewhere
    // can never be mistaken for a cookie decision.
    const cookieSnapshot = await knownCookieDialogSnapshot(page, currentSnapshot);
    if (!cookieSnapshot) return false;
    const cookieResult = await dismissCookieBanner(page, cookieSnapshot);
    if (cookieResult !== true && cookieResult?.status !== 'dismissed') return false;
    currentSnapshot = cookieResult?.snapshot || await extractFields(page, NAVIGATION).catch(() => null);
    if (!currentSnapshot || currentSnapshot.dialogs?.length) return false;
  }
  const candidates = [...(currentSnapshot?.links || []), ...(currentSnapshot?.buttons || [])]
    .filter((control) => !control.dialog && isExplicitSignInNavigationLabel(
      control.text, control.label, control.title, control.ariaLabel,
    ));
  for (const candidate of candidates) {
    const id = String(candidate.id || '');
    if (!/^[\w-]{1,80}$/.test(id)) continue;
    const frame = page.frames()[Number(candidate.frame) || 0] || page.mainFrame();
    const locator = frame.locator(`[data-aa-id="${id}"]`).first();
    // Keep detached DOM failures observable while tolerating minimal locator
    // adapters used by the account-navigation contract tests.
    if (typeof locator?.isVisible !== 'function' || typeof locator?.evaluate !== 'function') {
      if (typeof frame?.evaluate === 'function') {
        try {
          await frame.evaluate(() => null);
        } catch (error) {
          if (/detached/i.test(String(error?.message || error))) {
            throw new Error('locator.detached', { cause: error });
          }
          throw error;
        }
      }
      continue;
    }
    if (!await locator.isVisible().catch(() => false)) continue;
    const liveControl = await locator.evaluate((element) => {
      const doc = element.ownerDocument;
      const form = element.form || element.closest('form');
      const labelledBy = (element.getAttribute('aria-labelledby') || '').split(/\s+/).filter(Boolean)
        .map((id) => doc.getElementById(id)?.innerText || doc.getElementById(id)?.textContent || '')
        .join(' ');
      const inputs = form ? [...form.querySelectorAll('input')] : [];
      return {
        tagName: String(element.tagName || '').toUpperCase(),
        text: element.innerText || element.textContent || '',
        ariaLabel: element.getAttribute('aria-label') || '',
        title: element.getAttribute('title') || '',
        labelledBy,
        disabled: Boolean(element.disabled) || element.getAttribute('aria-disabled') === 'true',
        href: element.getAttribute('href'),
        dataAutomationId: element.getAttribute('data-automation-id') || '',
        formId: form?.getAttribute('data-aa-id') || '',
        formIdentityFields: inputs.map((input) => ({
          inputType: String(input.type || '').toLowerCase(),
          kind: String(input.type || '').toLowerCase() === 'text' ? 'text' : String(input.type || '').toLowerCase(),
          label: [
            ...(input.labels ? [...input.labels].map((node) => node.innerText || node.textContent || '') : []),
            input.getAttribute('aria-label') || '',
            input.getAttribute('placeholder') || '',
          ].join(' '),
          name: input.name || '',
          autocomplete: input.getAttribute('autocomplete') || '',
        })),
        formHasPassword: inputs.some((input) => input.type === 'password'),
      };
    }).catch(() => null);
    const currentUrl = frame.url();
    let portalHost;
    let portalProtocol;
    try {
      const parsedCurrentUrl = new URL(currentUrl);
      portalHost = parsedCurrentUrl.hostname;
      portalProtocol = parsedCurrentUrl.protocol;
    } catch {
      continue;
    }
    const explicitSignInLabel = isExplicitSignInNavigationLabel(
      liveControl?.text, liveControl?.ariaLabel, liveControl?.title, liveControl?.labelledBy,
    );
    const workdayFormButton = liveControl?.tagName === 'BUTTON'
      && isWorkdayTenantUrl(currentUrl)
      && portalProtocol === 'https:'
      && candidate.disabled !== true
      && liveControl.disabled !== true
      && candidate.dataAutomationId === 'signInLink'
      && liveControl.dataAutomationId === 'signInLink'
      && Boolean(candidate.formId)
      && candidate.formId === liveControl.formId
      && Boolean(loginFields({ fields: liveControl.formIdentityFields || [] }).email)
      && liveControl.formHasPassword === true
      && explicitSignInLabel;
    if (workdayFormButton) {
      return locator.click({ timeout: 6_000 }).then(() => true, () => false);
    }
    if (liveControl?.tagName !== 'A' || !explicitSignInLabel) continue;
    const target = verifiedSignInTarget(liveControl.href, currentUrl, portalHost);
    if (!target) continue;
    try {
      await frame.goto(target, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    } catch {
      return false;
    }
    let finalUrl;
    try {
      finalUrl = new URL(frame.url());
    } catch {
      return false;
    }
    if (finalUrl.protocol !== 'https:' || finalUrl.username || finalUrl.password || !sameSite(finalUrl.href, portalHost)) return false;
    return true;
  }
  // SuccessFactors' job-specific registration view can omit the visible
  // sign-in anchor entirely (SBB's `login_ns=register` page). Reuse only the
  // same-origin career route with its verified job context, changing the
  // provider's explicit view parameter; never click an application control.
  if (Array.isArray(currentSnapshot?.fields) && authPageKind(currentSnapshot) === 'create') {
    const identity = authFormIdentity(currentSnapshot);
    const frame = identity && page.frames()[identity.frame];
    const currentUrl = frame?.url?.() || '';
    const target = successFactorsSignInTarget(currentUrl);
    if (frame && target) {
      let portalHost;
      try {
        portalHost = new URL(currentUrl).hostname;
        await frame.goto(target, { waitUntil: 'domcontentloaded', timeout: 60_000 });
        const finalUrl = new URL(frame.url());
        return finalUrl.protocol === 'https:' && !finalUrl.username && !finalUrl.password
          && sameSite(finalUrl.href, portalHost);
      } catch {
        return false;
      }
    }
  }
  return false;
}

/** Open a reset route only from the live email+password form that owns the control. */
export async function openVerifiedPasswordResetNavigation(page, snapshot) {
  if (snapshot?.dialogs?.length || authPageKind(snapshot) !== 'sign_in') return false;
  const candidates = [...(snapshot?.links || []), ...(snapshot?.buttons || [])]
    .filter((control) => !control.dialog
      && (FORGOT_PASSWORD_RE.test([control.text, control.label, control.title, control.ariaLabel].join(' '))
        || control.dataAutomationId === 'forgotPasswordLink'));
  for (const candidate of candidates) {
    const id = String(candidate.id || '');
    if (!/^[\w-]{1,80}$/.test(id) || !candidate.formId) continue;
    const frame = page.frames()[Number(candidate.frame) || 0] || page.mainFrame();
    const locator = frame.locator(`[data-aa-id="${id}"]`).first();
    if (typeof locator?.isVisible !== 'function' || typeof locator?.evaluate !== 'function'
      || !await locator.isVisible().catch(() => false)) continue;
    const live = await locator.evaluate((element) => {
      const form = element.form || element.closest('form');
      const inputs = form ? [...form.querySelectorAll('input')] : [];
      const labelledBy = (element.getAttribute('aria-labelledby') || '').split(/\s+/).filter(Boolean)
        .map((labelId) => element.ownerDocument.getElementById(labelId)?.innerText || '').join(' ');
      return {
        tagName: String(element.tagName || '').toUpperCase(),
        href: element.getAttribute('href'),
        text: element.innerText || element.textContent || '',
        ariaLabel: element.getAttribute('aria-label') || '',
        title: element.getAttribute('title') || '',
        labelledBy,
        dataAutomationId: element.getAttribute('data-automation-id') || '',
        disabled: Boolean(element.disabled) || element.getAttribute('aria-disabled') === 'true',
        formId: form?.getAttribute('data-aa-id') || '',
        formIdentityFields: inputs.map((input) => ({
          inputType: String(input.type || '').toLowerCase(),
          kind: String(input.type || '').toLowerCase() === 'text' ? 'text' : String(input.type || '').toLowerCase(),
          label: [
            ...(input.labels ? [...input.labels].map((node) => node.innerText || node.textContent || '') : []),
            input.getAttribute('aria-label') || '',
            input.getAttribute('placeholder') || '',
          ].join(' '),
          name: input.name || '',
          autocomplete: input.getAttribute('autocomplete') || '',
        })),
        formHasPassword: inputs.some((input) => input.type === 'password'),
      };
    }).catch(() => null);
    const label = [live?.text, live?.ariaLabel, live?.title, live?.labelledBy].join(' ');
    const explicit = FORGOT_PASSWORD_RE.test(label) || live?.dataAutomationId === 'forgotPasswordLink';
    if (!explicit || live?.disabled || candidate.disabled === true
      || live.formId !== String(candidate.formId)
      || !loginFields({ fields: live.formIdentityFields || [] }).email || live.formHasPassword !== true) continue;
    let current;
    try { current = new URL(frame.url()); } catch { continue; }
    if (current.protocol !== 'https:' || current.username || current.password) continue;
    if (live.tagName === 'BUTTON') {
      if (candidate.dataAutomationId !== 'forgotPasswordLink'
        && live.dataAutomationId !== 'forgotPasswordLink' && !FORGOT_PASSWORD_RE.test(label)) continue;
      return locator.click({ timeout: 6_000 }).then(() => true, () => false);
    }
    if (live.tagName !== 'A' || !FORGOT_PASSWORD_RE.test(label)) continue;
    let target;
    try { target = new URL(live.href, current); } catch { continue; }
    if (target.protocol !== 'https:' || target.username || target.password || target.hostname !== current.hostname) continue;
    try {
      await frame.goto(target.href, { waitUntil: 'domcontentloaded', timeout: 60_000 });
      const final = new URL(frame.url());
      return final.protocol === 'https:' && !final.username && !final.password && final.hostname === current.hostname;
    } catch {
      return false;
    }
  }
  return false;
}

function passwordResetEmailField(snapshot) {
  const candidates = (snapshot?.fields || []).filter((field) => field.inputType === 'email'
    || /(?:e-?mail|mailadresse)/i.test(`${field.label || ''} ${field.name || ''} ${field.autocomplete || ''}`));
  return candidates.length === 1 ? candidates[0] : null;
}

function resetPasswordFields(snapshot) {
  const fields = (snapshot?.fields || []).filter((field) => field.inputType === 'password');
  if (fields.length !== 2 || !fields[0].formId || fields.some((field) => String(field.formId) !== String(fields[0].formId))) return null;
  const labels = fields.map((field) => `${field.label || ''} ${field.name || ''} ${field.autocomplete || ''}`);
  const confirmation = labels.findIndex((label) => /(?:confirm|repeat|re-?enter|again|bestätigen|wiederholen|confirmer|ripeti)/i.test(label));
  const newPassword = labels.findIndex((label) => /(?:new|neue|nouveau|nuova|password|passwort|mot de passe)/i.test(label));
  if (confirmation < 0 || newPassword < 0 || confirmation === newPassword) return null;
  return { password: fields[newPassword], confirmation: fields[confirmation], formId: String(fields[0].formId) };
}

function accountApplicationDuplicate(snapshot) {
  const text = [snapshot?.title, snapshot?.heading, snapshot?.text,
    ...(snapshot?.headings || []).map((heading) => typeof heading === 'string' ? heading : heading?.text || heading?.label || '')]
    .filter(Boolean).join('\n').normalize('NFKC');
  if (ALREADY_APPLIED_RE.test(text)) return { status: 'already_applied', matchedBy: 'portal_confirmation' };
  if (APPLICATION_HISTORY_RE.test(text)) {
    if (EMPTY_APPLICATION_HISTORY_RE.test(text)) return { status: 'no_application_found', matchedBy: 'empty_application_list' };
    return { status: 'uncertain_application_history', matchedBy: 'application_list' };
  }
  return null;
}

function isApplicationHistoryPage(snapshot) {
  const headings = [snapshot?.title, snapshot?.heading,
    ...(snapshot?.headings || []).map((heading) => typeof heading === 'string' ? heading : heading?.text || heading?.label || '')]
    .filter(Boolean).join('\n');
  return APPLICATION_HISTORY_RE.test(headings);
}

function exactHttpsPortalHostUrl(value, host) {
  try {
    const target = new URL(String(value || ''));
    return target.protocol === 'https:' && !target.username && !target.password
      && target.hostname.toLowerCase() === String(host || '').toLowerCase() ? target.href : '';
  } catch {
    return '';
  }
}

async function recoverAccountPassword({ page, snapshot, ctx, host, account, diagnostics, typedSecrets, registrationRestarts, recoveryAttempts }) {
  const orderEmail = String(ctx.candidate?.identity?.email || '').trim().toLowerCase();
  const email = String(account?.email || orderEmail).trim().toLowerCase();
  if (!orderEmail || email !== orderEmail || !aliasLocalPart(email) || usesOtpAccountCreation(host) || ctx.dryRun
    || typeof ctx.accounts.beginRecovery !== 'function'
    || typeof ctx.accounts.waitForPasswordReset !== 'function') {
    return accountHandoff('account', 'account_exists', accountStageFor(snapshot));
  }
  if (recoveryAttempts.has(host)) return accountHandoff('account_recovery_timeout', 'account_recovery_timeout', 'login');
  recoveryAttempts.add(host);
  let requestAt = Number(account?.recoveryRequestedAt) || 0;
  let resetMessage = null;
  const existingRequestActive = account?.status === 'recovering' && requestAt > 0
    && Date.now() - requestAt < 15 * 60 * 1000 && Boolean(account.password);
  if (existingRequestActive) {
    resetMessage = await ctx.accounts.waitForPasswordReset({ host, sinceMs: requestAt });
  } else {
    if (authPageKind(snapshot) === 'create') {
      if (!await openVerifiedSignInNavigation(page, snapshot)) {
        return accountHandoff('account_recovery_rejected', 'account_recovery_rejected', 'login');
      }
      snapshot = await awaitAuthView(page, snapshot);
    }
    if (authPageKind(snapshot) !== 'sign_in' || !await openVerifiedPasswordResetNavigation(page, snapshot)) {
      return accountHandoff('account_recovery_rejected', 'account_recovery_rejected', 'login');
    }
    const requestForm = await awaitAuthView(page, snapshot);
    const emailField = passwordResetEmailField(requestForm);
    if (!emailField) return accountHandoff('account_recovery_rejected', 'account_recovery_rejected', 'login');
    await applyActions(page, requestForm.fields, [{ fieldId: emailField.id, action: 'fill', value: email }], {});
    const ready = await extractFields(page, NAVIGATION);
    const readyEmail = passwordResetEmailField(ready);
    if (!readyEmail || String(readyEmail.value || '').trim().toLowerCase() !== email) {
      return accountHandoff('account_recovery_rejected', 'account_recovery_rejected', 'login');
    }
    const password = newPortalPassword({ portal: host });
    typedSecrets?.add(password);
    const begun = await ctx.accounts.beginRecovery(host, { email, password });
    if (begun?.status !== 'started') {
      const failure = begun?.status === 'in_progress' || begun?.status === 'cooldown' || begun?.status === 'rate_limited'
        ? 'account_recovery_timeout' : 'account_recovery_rejected';
      return accountHandoff(failure, failure, 'login');
    }
    requestAt = Number(begun.requestedAt) || Date.now();
    const sendRequest = findButton(ready.buttons || [], PASSWORD_RESET_REQUEST_RE);
    if (!sendRequest || String(sendRequest.formId || '') !== String(readyEmail.formId || '')) {
      await ctx.accounts.abortRecovery(host, { requestSubmitted: false });
      return accountHandoff('account_recovery_rejected', 'account_recovery_rejected', 'login');
    }
    try {
      diagnostics?.beforeClick('account');
      if (!await clickButton(page, sendRequest)) {
        await ctx.accounts.abortRecovery(host, { requestSubmitted: false });
        return accountHandoff('account_recovery_rejected', 'account_recovery_rejected', 'login');
      }
      diagnostics?.afterClick();
    } catch {
      await ctx.accounts.abortRecovery(host, { requestSubmitted: false });
      return accountHandoff('account_recovery_rejected', 'account_recovery_rejected', 'login');
    }
    resetMessage = await ctx.accounts.waitForPasswordReset({ host, sinceMs: requestAt });
  }
  const resetUrl = exactHttpsPortalHostUrl(resetMessage?.url, host);
  if (!resetUrl) {
    return accountHandoff('account_recovery_timeout', 'account_recovery_timeout', 'login');
  }
  await page.goto(resetUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await settle(page);
  let resetView = await extractFields(page, NAVIGATION);
  const pageUrl = new URL(page.url());
  const resetFields = resetPasswordFields(resetView);
  const resetContext = /(?:reset|change|update).{0,30}(?:password|passwort)|(?:password|passwort).{0,30}(?:reset|change|update)|mot de passe.{0,30}(?:réinitial|reinitial|chang)|password.{0,30}(?:reimpost|cambi)/i
    .test(`${pageUrl.pathname} ${resetView.title || ''} ${resetView.heading || ''} ${resetView.text || ''}`);
  if (pageUrl.protocol !== 'https:' || pageUrl.hostname !== host || !resetContext || !resetFields) {
    return accountHandoff(PASSWORD_RESET_REFUSED_RE.test(resetView.errors?.join(' ') || resetView.text || '')
      ? 'account_recovery_rejected' : 'account_recovery_timeout',
    PASSWORD_RESET_REFUSED_RE.test(resetView.errors?.join(' ') || resetView.text || '')
      ? 'account_recovery_rejected' : 'account_recovery_timeout', 'login');
  }
  const staged = (await ctx.accounts.load(host))?.password || account?.password || '';
  if (!staged) return accountHandoff('account_recovery_timeout', 'account_recovery_timeout', 'login');
  typedSecrets?.add(staged);
  await applyActions(page, resetView.fields, [
    { fieldId: resetFields.password.id, action: 'fill', value: staged },
    { fieldId: resetFields.confirmation.id, action: 'fill', value: staged },
  ], {});
  resetView = await extractFields(page, NAVIGATION);
  const filled = resetPasswordFields(resetView);
  if (!filled || !filled.password.value || !filled.confirmation.value) {
    return accountHandoff('account_recovery_timeout', 'account_recovery_timeout', 'login');
  }
  const confirm = (resetView.buttons || []).find((button) => String(button.formId || '') === filled.formId
    && PASSWORD_RESET_CONFIRM_RE.test(String(button.text || button.label || '')) && button.disabled !== true);
  if (!confirm || !await clickButton(page, confirm)) return accountHandoff('account_recovery_timeout', 'account_recovery_timeout', 'login');
  const afterReset = await awaitAuthOutcome(page, 'create', resetView.errors || [], resetView.fields);
  const resetRejected = PASSWORD_RESET_REFUSED_RE.test([afterReset.text, ...(afterReset.errors || [])].join(' '));
  if (resetRejected) {
    await ctx.accounts.abortRecovery(host, { requestSubmitted: true, reason: 'reset_rejected' });
    return accountHandoff('account_recovery_rejected', 'account_recovery_rejected', 'login');
  }
  if (authPageKind(afterReset) !== 'sign_in') {
    return accountHandoff('account_recovery_timeout', 'account_recovery_timeout', 'login');
  }
  if (!await ctx.accounts.completeRecovery(host)) return accountHandoff('account_recovery_timeout', 'account_recovery_timeout', 'login');
  const signedIn = await handleAuth({
    page,
    snapshot: afterReset,
    ctx,
    diagnostics,
    typedSecrets,
    registrationRestarts,
    recoveryAttempts,
  });
  return { ...signedIn, accountRecovered: true };
}

/**
 * One login page (account.mjs): sign in with the order's account, or create
 * it on the alias, or verify it. Returns the next page, a handoff reason,
 * questions for the candidate, or `dryRun` (a dry run never creates an account).
 */
export async function handleAuth({ page, snapshot, ctx, allowExistingRegistration = false, diagnostics = null, recreated = false, typedSecrets = null, registrationRestarts = new Set(), recoveryAttempts = new Set() }) {
  const host = new URL(page.url()).hostname;
  const kind = authPageKind(snapshot);
  const account = await ctx.accounts.load(host);

  if (account?.status === 'exists_unknown_password') {
    return recoverAccountPassword({ page, snapshot, ctx, host, account, diagnostics, typedSecrets, registrationRestarts, recoveryAttempts });
  }

  // The federal portal can show its create form even when the alias already
  // has an account. Without saved credentials, stop before the planner fills
  // or submits another registration; the candidate must sign in themselves.
  if (!account && hasExistingAccountPrompt(snapshot)) {
    return accountHandoff('account', 'login_unobserved', 'login');
  }

  // A one-time-code page is neither a sign-in nor a registration form, even
  // when the portal masks the code as a password input (federal
  // SuccessFactors, 2026-11-10): typing the alias and password there found no
  // e-mail field and ended as `login_unobserved`. Only this order's unverified
  // account can answer it, with the e-mailed code.
  if (kind === 'none' && codeField(snapshot)) {
    if (account && !account.verifiedAt) return verifyAccount({ page, host, sinceMs: account.createdAt || 0, ctx, snapshot });
    return accountHandoff('account_verification', 'verification_unobserved', 'verification');
  }

  const canResendVerification = hasResendVerificationControl(snapshot);
  // SuccessFactors keeps the pending OTP account in this same sign-in shape;
  // its dedicated recovery below must restart registration instead of trying
  // to verify through a mailbox account that does not exist yet.
  if (kind === 'sign_in' && account && !account.verifiedAt && canResendVerification && !usesOtpAccountCreation(host)) {
    return verifyAccount({ page, host, sinceMs: account.createdAt || 0, ctx, snapshot });
  }

  if (kind === 'sign_in' && !account) {
    if (await clickFirst(page, snapshot, [CREATE_ACCOUNT_RE])) return { snapshot: await awaitAuthView(page, snapshot) };
    const registration = await openSuccessFactorsRegistrationNavigation(page, snapshot);
    return registration
      ? { snapshot: registration }
      : accountHandoff('account', 'no_create_button', 'login');
  }

  // With SuccessFactors' OTP verification the candidate is not an account
  // yet until the code is accepted. A prior run may therefore have the
  // encrypted password and `verifiedAt: null`, while the portal quite
  // correctly answers a sign-in with its generic invalid-credentials page.
  // Restart the registration flow with the same password so the portal can
  // issue a fresh OTP; do not throw the credential away and try to create a
  // second one.
  if (kind === 'sign_in' && account && !account.verifiedAt && usesOtpAccountCreation(host) && !allowExistingRegistration
    && typeof ctx.accounts.accountNotice === 'function'
    && await ctx.accounts.accountNotice({ host, sinceMs: Number(account.createdAt) || 0 })) {
    // An earlier run's code was accepted, and the portal mailed that the
    // account exists, but that run never saw its answer. A new registration
    // would be refused for an existing address: record it and sign in.
    account.verifiedAt = Date.now();
    await ctx.accounts.mark(host, { status: 'created', verifiedAt: account.verifiedAt });
  }
  // Once per run: a tenant that asks for no OTP (Damiani, 2026-11-10) answers a
  // repeated registration of an existing address and comes back to its sign-in
  // page, and every step restarted it again until `auth_steps_exhausted`. The
  // second time the saved credential signs in; a failed sign-in is handed over.
  if (kind === 'sign_in' && account && !account.verifiedAt && usesOtpAccountCreation(host) && !allowExistingRegistration
    && !registrationRestarts.has(host)) {
    // Some SuccessFactors tenants reopen `/career` on the sign-in form and
    // expose only «Anmelden». The saved credential is the safe recovery path
    // there; only restart registration when the page actually offers that
    // navigation control.
    const openedRegistration = await clickFirst(page, snapshot, [CREATE_ACCOUNT_RE]);
    if (openedRegistration) {
      registrationRestarts.add(host);
      const registration = await awaitAuthView(page, snapshot);
      if (authPageKind(registration) !== 'create') return accountHandoff('account_verification', 'verification_unobserved', 'verification');
      return handleAuth({ page, snapshot: registration, ctx, allowExistingRegistration: true, diagnostics, typedSecrets, registrationRestarts, recoveryAttempts });
    }
  }

  if (kind === 'sign_in') {
    // Typed, then read again: a form the portal draws anew meanwhile (Workday, when what it loads for the
    // page arrives late) has lost what was typed and its button is another element. It is typed once more,
    // and the button pressed is the one of the reading made right before the click.
    let form = snapshot;
    let typed = false;
    typedSecrets?.add(account.password);
    for (let attempt = 0; attempt < 2 && !typed; attempt += 1) {
      const { email, password } = loginFields(form);
      if (!email || !password) return accountHandoff('account', 'login_unobserved', 'login');
      // An e-mail already in the field (the agentic fallback typed it where a pasted value does
      // not stay) is left alone: filling it again would undo it.
      const emailKept = String(email.value || '').trim().toLowerCase() === String(account.email || '').trim().toLowerCase();
      await applyActions(page, form.fields, [
        ...(emailKept ? [] : [{ fieldId: email.id, action: 'fill', value: account.email }]),
        { fieldId: password.id, action: 'fill', value: account.password },
      ], {});
      await page.waitForTimeout(AUTH_TYPED_WAIT_MS);
      form = await extractFields(page, NAVIGATION);
      const now = loginFields(form);
      typed = Boolean(now.email?.value) && Boolean(now.password?.value);
    }
    if (!typed) return { ...accountHandoff('account', 'login_unobserved', 'login'), authStop: 'sign_in_typing_unconfirmed' };
    const shown = form.errors || [];
    diagnostics?.beforeClick('account');
    const pressed = await clickFirst(page, form, [SIGN_IN_RE, SUBMIT_RE, NEXT_RE]);
    if (!pressed) return accountHandoff('account', 'no_sign_in_button', 'login');
    const after = await awaitAuthOutcome(page, 'sign_in', shown, form.fields);
    diagnostics?.afterClick();
    if (!account.verifiedAt && (VERIFY_PAGE_RE.test(accountResponseText(after)) || codeField(after))) {
      return { ...await verifyAccount({ page, host, sinceMs: account.createdAt || 0, ctx, snapshot: after }), pressed };
    }
    // Workday can reveal the verification failure only after the first sign-in
    // click. The form remains a sign-in page and may expose the copy only as a
    // form message (without a resend control), even when the stored account
    // record was previously marked verified. The sign-in response is the
    // signal: the portal has just sent the verification mail.
    if (authPageKind(after) === 'sign_in'
      && isAccountVerificationResponse(after)
      && !usesOtpAccountCreation(host)) {
      return { ...await verifyAccount({ page, host, sinceMs: account.createdAt || 0, ctx, snapshot: after }), pressed };
    }
    // Two password fields after a sign-in are no account's home either (a dialog opened over the form).
    if (authPageKind(after) === 'create') return { ...accountHandoff('account_sign_in_failed', 'login_unobserved', 'login'), pressed };
    if (authPageKind(after) === 'sign_in') {
      // A registration the portal never answered (status `unanswered`): the account was not created after
      // all. It is created now, once; any other account that cannot sign in is the owner's to look at.
      if ((account.status !== 'unanswered' || recreated) && !recoveryAttempts.has(host)
        && !account.verifiedAt && !usesOtpAccountCreation(host)
        && String(account.email || ctx.candidate?.identity?.email || '').trim().toLowerCase()
          === String(ctx.candidate?.identity?.email || '').trim().toLowerCase()
        && aliasLocalPart(ctx.candidate?.identity?.email || '')) {
        const recovered = await recoverAccountPassword({ page, snapshot: after, ctx, host, account, diagnostics, typedSecrets, registrationRestarts, recoveryAttempts });
        return { ...recovered, pressed };
      }
      if (account.status !== 'unanswered' || recreated) return { ...accountHandoff('account_sign_in_failed', 'login_unobserved', 'login'), pressed };
      await ctx.accounts.discard(host, 'never_created');
      if (!await clickFirst(page, after, [CREATE_ACCOUNT_RE])) return accountHandoff('account_sign_in_failed', 'no_create_button', 'login');
      const registration = await awaitAuthView(page, after);
      if (authPageKind(registration) !== 'create') return accountHandoff('account_sign_in_failed', 'login_unobserved', 'login');
      return handleAuth({ page, snapshot: registration, ctx, diagnostics, recreated: true, typedSecrets, registrationRestarts, recoveryAttempts });
    }
    // Signed in: the account exists, whatever its registration left on record (`unanswered`, `pending`). A
    // later sign-in that fails is then no reason to create it again. A successful saved-credential login also
    // proves an unverified account is usable (including SuccessFactors' login-only recovery), so do not restart
    // OTP registration on the next run.
    const signedInAt = Date.now();
    await ctx.accounts.mark(host, {
      status: 'created',
      lastSignInAt: signedInAt,
      verifiedAt: account.verifiedAt || signedInAt,
    });
    return { snapshot: after, reopen: true, pressed };
  }

  // Create-account page. SuccessFactors can reopen the job URL directly on
  // registration after a prior run saved the password but did not consume its
  // OTP; it has no sign-in link on that surface. Reuse the same credential for
  // that bounded OTP retry, while other portals still require an explicit,
  // verified sign-in route before an existing account is touched.
  const retryingUnverifiedAccount = Boolean(account && !account.verifiedAt
    && (allowExistingRegistration || usesOtpAccountCreation(host)));
  if (account && !retryingUnverifiedAccount) {
    // Created by an earlier run: follow only an explicit, verified login route.
    if (!await openVerifiedSignInNavigation(page, snapshot)) return accountHandoff('account', 'no_sign_in_button', 'registration');
    return { snapshot: await awaitAuthView(page, snapshot) };
  }
  if (ctx.dryRun) return { dryRun: true };
  snapshot = await refreshChoiceCatalogues(page, snapshot);
  const others = accountRegistrationSnapshot({ ...snapshot, fields: snapshot.fields.filter((field) => field.inputType !== 'password') });
  const candidate = account
    ? { ...ctx.candidate, identity: { ...ctx.candidate.identity, email: account.email } }
    : ctx.candidate;
  const plan = await planPage({ snapshot: others, candidate, candidateLocale: ctx.candidateLocale, codex: ctx.codex });
  // Keep the account-form residence ownership contract on every reread. The
  // native extractor cannot always infer the personal-information owner from
  // an explicit residence caption alone, but losing this normalization after
  // the first redraw would turn the same known field into an unreadable hold.
  let registrationSnapshot = accountRegistrationSnapshot(snapshot);
  let registrationPlan = plan;
  let registrationReplans = 0;
  let privacySurfaceReplans = 0;
  // A successful upload belongs to the concrete control that received it.
  // ATS redraws can reuse the same data-aa-id for a fresh empty file input;
  // retaining only the field id would incorrectly authorize Create/Submit.
  const appliedRegistrationUploads = new Map();
  const uploadControlKey = (field) => JSON.stringify([
    field?.frame ?? 0,
    field?.form ?? null,
    field?.documentInstance || '',
    field?.controlInstance || '',
    field?.domId || '',
    field?.name || '',
    field?.controlId || '',
    field?.semanticId || '',
    field?.nativeControlId || '',
    field?.ownedList || '',
  ]);
  const uploadIsSatisfied = (field) => Boolean(field
    && appliedRegistrationUploads.get(field.id)
    && appliedRegistrationUploads.get(field.id) === uploadControlKey(field));
  const confirmRegistrationUpload = async (action, field, result) => {
    if (!field || !result?.ok) return false;
    const selectedPaths = documentPaths(ctx.files, action.document).slice(0, Number(result.files) || 1);
    if (!selectedPaths.length) return false;
    const confirmed = await uploadReceipt(page, locatorFor(page, field), selectedPaths, {
      acceptedResponse: result.uploadAccepted === true,
    }).catch(() => false);
    if (!confirmed) return false;
    appliedRegistrationUploads.set(action.fieldId, uploadControlKey(field));
    return true;
  };
  const knownAnswerMatches = (field, action) => {
    if (action.action === 'skip') return true;
    if (!field) return false;
    if (action.action === 'check') return field.checked === true;
    if (action.action === 'uncheck') return field.checked === false;
    if (!['fill', 'select'].includes(action.action) || !holdsValue(field)) return false;
    const normalize = (value) => String(value || '').toLowerCase().replace(/\s+/g, ' ').trim();
    const selected = (field.options || []).find((option) => option.value === field.value)?.label;
    const currentValues = [field.value, selected];
    if (currentValues.some((value) => normalize(value) === normalize(action.value))) return true;
    const topic = questionTopic(field.label, field.context, field);
    if (topic === 'residence_country') {
      const wanted = residenceCountryCode(action.value);
      return Boolean(wanted && currentValues.some((value) => residenceCountryCode(value) === wanted));
    }
    if (topic === 'nationality') {
      const wanted = nationalityOf(action.value)?.code;
      return Boolean(wanted && currentValues.some((value) => nationalityOf(value)?.code === wanted));
    }
    return false;
  };
  const registrationActionSatisfied = (field, action) => action.action === 'upload'
    ? uploadIsSatisfied(field)
    : knownAnswerMatches(field, action);
  let credentialSaved = retryingUnverifiedAccount;
  const parkRegistrationCredential = async (reason) => {
    if (retryingUnverifiedAccount) await ctx.accounts.mark(host, { status: 'unanswered' });
    else if (credentialSaved) await ctx.accounts.discard(host, reason);
  };
  const planStableRegistrationSurface = async (startingSnapshot, expectedUrl) => {
    let current = startingSnapshot;
    while (true) {
      const stable = await waitForStableQuestionSurface(page, current, expectedUrl, { registration: true });
      if (stable.status !== 'stable') return { status: 'unstable', snapshot: stable.snapshot };
      const refreshed = await refreshChoiceCatalogues(page, stable.snapshot);
      const plannedSnapshot = accountRegistrationSnapshot(refreshed);
      const planned = await planPage({
        snapshot: { ...plannedSnapshot, fields: plannedSnapshot.fields.filter((field) => field.inputType !== 'password') },
        candidate,
        candidateLocale: ctx.candidateLocale,
        codex: ctx.codex,
      });
      // The planner can take minutes. Re-read immediately after it returns so
      // its plan cannot authorize a CTA on a surface that appeared meanwhile.
      const observedRaw = await extractFields(page, NAVIGATION).catch(() => null);
      const observed = observedRaw
        ? accountRegistrationSnapshot(await refreshChoiceCatalogues(page, observedRaw))
        : null;
      if (!observed || page.url() !== expectedUrl || observed.url !== expectedUrl) {
        return { status: 'moved', snapshot: observed || plannedSnapshot };
      }
      if (registrationSurfaceSignature(observed) === registrationSurfaceSignature(plannedSnapshot)) {
        return { status: 'stable', snapshot: observed, plan: planned };
      }
      if (privacySurfaceReplans >= MAX_REDRAWS_PER_PAGE) return { status: 'unstable', snapshot: observed };
      privacySurfaceReplans += 1;
      current = observed;
    }
  };
  // A known registration answer can reveal more required fields (Coop's
  // country selection is one example). Apply only guarded, non-upload answers
  // first; do not ask from the planner's earlier, partial view of the form.
  // What the page kept of each typed answer (value-shape invariant): a value
  // the control cut at its maxlength, or replaced, is a named finding in the
  // encrypted diagnostics and in the public stop report, never a silent
  // mismatch. The same planned value cut once is cut again: no replan for it.
  let readbackFindings = [];
  const readbackHandoff = () => ({
    handoff: 'portal_needs_candidate',
    ...(readbackFindings.length ? { valueShapes: readbackFindings.map(({ planned: _planned, ...finding }) => finding) } : {}),
  });
  while (true) {
    const actions = registrationPlan.actions.filter((action) =>
      ['fill', 'select', 'check', 'uncheck'].includes(action.action)
      && !knownAnswerMatches(registrationSnapshot.fields.find((field) => field.id === action.fieldId), action));
    if (!actions.length) break;
    // A value the control cuts at its maxlength does not fit whoever types it: no agentic retry.
    if (actions.some((action) => readbackFindings.some((finding) => finding.shape === 'truncated'
      && finding.fieldId === action.fieldId && finding.planned === action.value))) return readbackHandoff();
    // `authStop` names the technical stop for the agentic fallback (AUTH_AGENT_RECOVERABLE_STOPS).
    if (registrationReplans >= MAX_REDRAWS_PER_PAGE) return { ...readbackHandoff(), authStop: 'registration_replans_exhausted' };
    const registrationUrl = page.url();
    const results = await applyActions(page, registrationSnapshot.fields, actions, ctx.files);
    if (actions.some((action) => !results.some((result) => result.fieldId === action.fieldId && result.ok))) {
      return { handoff: 'portal_needs_candidate', authStop: 'registration_answer_unconfirmed' };
    }
    if (page.url() !== registrationUrl) return { handoff: 'portal_needs_candidate', authStop: 'registration_surface_moved' };
    const stable = await waitForStableQuestionSurface(page, registrationSnapshot, registrationUrl, { registration: true });
    if (stable.status !== 'stable') return { handoff: 'portal_needs_candidate', authStop: 'registration_surface_unstable' };
    registrationSnapshot = accountRegistrationSnapshot(await refreshChoiceCatalogues(page, stable.snapshot));
    const found = registrationReadbackFindings(actions, registrationSnapshot.fields);
    // `planned` stays in memory only, to recognise the same plan next turn.
    readbackFindings = found.map((finding) => ({
      ...finding,
      planned: actions.find((action) => action.fieldId === finding.fieldId)?.value,
    }));
    if (found.length && diagnostics?.data) {
      diagnostics.data.valueShape = [
        ...(Array.isArray(diagnostics.data.valueShape) ? diagnostics.data.valueShape : []),
        ...found.map((finding) => ({ phase: 'registration', ...finding })),
      ].slice(-20);
    }
    registrationPlan = await planPage({
      snapshot: { ...registrationSnapshot, fields: registrationSnapshot.fields.filter((field) => field.inputType !== 'password') },
      candidate,
      candidateLocale: ctx.candidateLocale,
      codex: ctx.codex,
    });
    registrationReplans += 1;
  }
  // The loop has applied all known answers and re-read the stable surface.
  // Drop those now-confirmed actions so the account creation path cannot
  // trigger a second redraw by reapplying them after the candidate responds.
  registrationPlan = {
    ...registrationPlan,
    actions: registrationPlan.actions.filter((action) => !registrationActionSatisfied(
      registrationSnapshot.fields.find((field) => field.id === action.fieldId), action,
    )),
  };
  const password = account?.password || newPortalPassword({ portal: host });
  // Struck from what the agentic fallback sees of this page, should it be called after a stop.
  typedSecrets?.add(password);
  const sinceMs = Date.now();
  const saveCredentialBeforeCreate = async () => {
    if (credentialSaved) return;
    // Do not persist a fresh credential while the stable surface is still
    // asking the candidate questions: a question request must not leave
    // save/discard residue.
    await ctx.accounts.save(host, { email: candidate.identity.email, password });
    credentialSaved = true;
  };
  if (retryingUnverifiedAccount) {
    // Keep the existing encrypted password: the registration retry is the
    // continuation of the same candidate account, not a new credential.
    await ctx.accounts.mark(host, { status: 'pending' });
  }
  let privacy = 'none';
  let repairAttempts = 0;
  const noted = (result) => (privacy === 'none' ? result : { ...result, privacy });
  // A registration surface that did not converge before the create click: the credential is parked
  // as on every exit, and the stop is named for the agentic fallback (AUTH_AGENT_RECOVERABLE_STOPS).
  const technicalStop = async (authStop) => {
    await parkRegistrationCredential(authStop);
    return noted({ handoff: 'portal_needs_candidate', authStop });
  };
  while (true) {
    const plannedActions = registrationPlan.actions.filter((action) => !registrationActionSatisfied(
      registrationSnapshot.fields.find((field) => field.id === action.fieldId), action,
    ));
    const passwordActions = registrationSnapshot.fields.filter((field) => field.inputType === 'password')
      .map((field) => ({ fieldId: field.id, action: 'fill', value: password }));
    const applied = await applyActions(page, registrationSnapshot.fields, [...plannedActions, ...passwordActions], ctx.files);
    for (const action of plannedActions.filter((item) => item.action === 'upload')) {
      const field = registrationSnapshot.fields.find((candidateField) => candidateField.id === action.fieldId);
      const result = applied.find((item) => item.fieldId === action.fieldId);
      if (!await confirmRegistrationUpload(action, field, result)) {
        await parkRegistrationCredential('registration_document_upload_unconfirmed');
        return noted({ handoff: 'portal_required_file_unhandled' });
      }
    }
    // After the fields: SuccessFactors opens its statement only for a chosen country.
    const privacyStartUrl = page.url();
    const preflight = await registrationPrivacyPreflight(page, { accepted: privacy === 'accepted' });
    if (preflight.privacy !== 'none') privacy = preflight.privacy;
    if (preflight.blocked) {
      // Nothing was pressed, so no account came of this: as with no button, a
      // retry keeps the same unverified account's encrypted password.
      if (!retryingUnverifiedAccount && credentialSaved) await ctx.accounts.discard(host, 'privacy_not_accepted');
      return noted({ handoff: 'privacy_not_accepted' });
    }
    const { filled } = preflight;
    if (page.url() !== privacyStartUrl || filled.url !== privacyStartUrl) {
      return await technicalStop('privacy_question_surface_moved');
    }
    // Blur and accepting the notice can both reveal required controls. A fresh,
    // stable read and plan must prove that the account form is still complete
    // before the Create/Submit CTA is allowed.
    const privacyUrl = privacyStartUrl;
    let privacyPlan;
    if (preflight.privacy !== 'none') {
      privacyPlan = await planStableRegistrationSurface(filled, privacyUrl);
    } else {
      const settled = await waitForStableQuestionSurface(page, filled, privacyUrl, { registration: true });
      if (settled.status !== 'stable') {
        return await technicalStop('privacy_question_surface_unstable');
      }
      // A known answer can redraw the registration form before credentials are
      // typed. Keep one post-credential planner pass in that case: the
      // password itself is excluded from the planner surface, but some ATSs
      // reveal a hard question only after the credential fields change.
      const knownAnswerRedraw = registrationReplans > 0;
      privacyPlan = !knownAnswerRedraw
        && registrationSurfaceSignature(settled.snapshot) === registrationSurfaceSignature(registrationSnapshot)
        ? { status: 'stable', snapshot: accountRegistrationSnapshot(settled.snapshot), plan: registrationPlan }
        : await planStableRegistrationSurface(settled.snapshot, privacyUrl);
    }
    if (privacyPlan.status !== 'stable') {
      return await technicalStop('privacy_question_surface_unstable');
    }
    const stableRegistrationSnapshot = privacyPlan.snapshot;
    const stablePlan = privacyPlan.plan;
    const stableRequirements = portalRequirementsFromMissingRequired(stableRegistrationSnapshot.fields, stablePlan.missingRequired, {
      candidate,
      candidateLocale: ctx.candidateLocale,
    });
    if (stableRequirements.unreadableFields?.length) {
      await parkRegistrationCredential('privacy_question_unreadable');
      return noted({ handoff: 'question_label_unreadable' });
    }
    const missingRequiredFieldIds = new Set((stablePlan.missingRequired || []).map((item) => item.fieldId).filter(Boolean));
    const unhandledRequiredFiles = stableRegistrationSnapshot.fields.filter((field) =>
      (field.required === true || field.invalid === true || missingRequiredFieldIds.has(field.id))
      && (field.kind === 'file' || field.inputType === 'file')
      && !uploadIsSatisfied(field)
      && !stablePlan.actions.some((action) => action.fieldId === field.id && action.action === 'upload'));
    if (unhandledRequiredFiles.length) {
      await parkRegistrationCredential('privacy_required_file_unhandled');
      return noted({ handoff: 'portal_required_file_unhandled' });
    }
    // Emit the hard-question batch only from this stable post-privacy plan;
    // the first registration plan may not include fields revealed by the notice.
    const stableRequest = await portalRequirementsForCandidate(stableRequirements, {
      candidateLocale: ctx.candidateLocale,
      applicationLocale: ctx.language,
      codex: ctx.codex,
      log: ctx.log,
    });
    if (stableRequest) {
      await parkRegistrationCredential('privacy_question_missing');
      return noted(stableRequest);
    }
    const newlyRequiredActions = stablePlan.actions.filter((action) => !registrationActionSatisfied(
      stableRegistrationSnapshot.fields.find((field) => field.id === action.fieldId), action,
    ));
    if (newlyRequiredActions.length) {
      if (privacySurfaceReplans >= MAX_REDRAWS_PER_PAGE) {
        return await technicalStop('privacy_question_surface_unstable');
      }
      const appliedAfterPrivacy = await applyActions(page, stableRegistrationSnapshot.fields, newlyRequiredActions, ctx.files);
      if (newlyRequiredActions.some((action) => !appliedAfterPrivacy.some((result) => result.fieldId === action.fieldId && result.ok))) {
        return await technicalStop('privacy_question_answer_unconfirmed');
      }
      for (const action of newlyRequiredActions.filter((item) => item.action === 'upload')) {
        const field = stableRegistrationSnapshot.fields.find((candidateField) => candidateField.id === action.fieldId);
        const result = appliedAfterPrivacy.find((item) => item.fieldId === action.fieldId);
        if (!await confirmRegistrationUpload(action, field, result)) {
          await parkRegistrationCredential('registration_document_upload_unconfirmed');
          return noted({ handoff: 'portal_required_file_unhandled' });
        }
      }
      if (page.url() !== privacyUrl) {
        return await technicalStop('privacy_question_surface_moved');
      }
      const afterPrivacyActions = await waitForStableQuestionSurface(page, stableRegistrationSnapshot, privacyUrl, { registration: true });
      if (afterPrivacyActions.status !== 'stable') {
        return await technicalStop('privacy_question_surface_unstable');
      }
      const replanned = await planStableRegistrationSurface(afterPrivacyActions.snapshot, privacyUrl);
      if (replanned.status !== 'stable') {
        return await technicalStop('privacy_question_surface_unstable');
      }
      registrationSnapshot = accountRegistrationSnapshot(replanned.snapshot);
      registrationPlan = {
        ...replanned.plan,
        actions: replanned.plan.actions.filter((action) => !registrationActionSatisfied(
          registrationSnapshot.fields.find((field) => field.id === action.fieldId), action,
        )),
      };
      privacySurfaceReplans += 1;
      continue;
    }
    registrationSnapshot = stableRegistrationSnapshot;
    registrationPlan = {
      ...stablePlan,
      actions: stablePlan.actions.filter((action) => !registrationActionSatisfied(
        registrationSnapshot.fields.find((field) => field.id === action.fieldId), action,
      )),
    };
    await saveCredentialBeforeCreate();
    diagnostics?.beforeClick('account');
    if (!await clickFirst(page, registrationSnapshot, [CREATE_ACCOUNT_RE, SUBMIT_RE, NEXT_RE])) {
      // A retry is still the same unverified account: keep its encrypted
      // password so the owner can retry after the portal exposes its button.
      if (!retryingUnverifiedAccount && credentialSaved) await ctx.accounts.discard(host, 'no_create_button');
      return noted(accountHandoff('account', 'no_create_button', 'registration'));
    }
    const after = await awaitAuthOutcome(page, 'create', registrationSnapshot.errors, registrationSnapshot.fields);
    diagnostics?.afterClick();
    if (hasExistingAccountPrompt(after)) {
      if (typeof ctx.accounts.recordExistingUnknownPassword === 'function') {
        await ctx.accounts.recordExistingUnknownPassword(host);
      } else if (credentialSaved) {
        await ctx.accounts.discard(host, 'existing_account_unknown_password');
      }
      return noted(accountHandoff('account', 'account_exists', 'registration'));
    }
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
      return noted(accountHandoff('account_create_unanswered', 'create_unanswered', 'registration'));
    }

    // A form-level validation response can expose fields the first plan did
    // not recognize. Replan against that response before treating it as a
    // permanent refusal; the planner receives the invalid fields and messages.
    const repairSnapshot = accountRegistrationSnapshot({ ...after, fields: after.fields.filter((field) => field.inputType !== 'password') });
    const repairPlan = await planPage({ snapshot: repairSnapshot, candidate, candidateLocale: ctx.candidateLocale, codex: ctx.codex });
    if (repairPlan.missingRequired.length) {
      const repairedRequirements = portalRequirementsFromMissingRequired(repairSnapshot.fields, repairPlan.missingRequired, { candidate, candidateLocale: ctx.candidateLocale });
      if (repairedRequirements.unreadableFields?.length) {
        await ctx.accounts.mark(host, { status: 'unanswered' });
        return noted({ handoff: 'question_label_unreadable' });
      }
      const request = await portalRequirementsForCandidate(repairedRequirements, {
        candidateLocale: ctx.candidateLocale,
        applicationLocale: ctx.language,
        codex: ctx.codex,
        log: ctx.log,
      });
      if (request) {
        // Keep the credential for this order: a candidate's answer resumes this
        // registration, while a generic account flow can recreate it if absent.
        await ctx.accounts.mark(host, { status: 'unanswered' });
        return noted(request);
      }
    }

    const retryableFields = accountRegistrationSnapshot(after).fields
      .filter((field) => field.invalid || (field.required && !holdsValue(field)));
    const retryableIds = new Set(retryableFields.map((field) => field.id));
    const repairActions = repairPlan.actions.filter((action) => retryableIds.has(action.fieldId)
      && !['skip', 'uncheck'].includes(action.action));
    const openFields = retryableFields.filter((field) => field.inputType !== 'password'
      && !repairActions.some((action) => action.fieldId === field.id));
    if (openFields.some(unreadableNativeOwner)) return noted({ handoff: 'question_label_unreadable' });
    if (openFields.length) {
      const why = ({ it: 'Il portale ha rifiutato questo dato. Controllalo o correggilo.', de: 'Das Portal hat diese Angabe abgelehnt. Bitte prüfe oder korrigiere sie.', fr: 'Le portail a refusé cette réponse. Veuillez la vérifier ou la corriger.', en: 'The portal rejected this entry. Please check or correct it.' })[ctx.candidateLocale] || 'Il portale ha rifiutato questo dato. Controllalo o correggilo.';
      const openQuestions = questionsFrom(openFields.filter((field) => String(field.label || '').trim()).map((field) => ({
        fieldId: field.id,
        question: String(field.label).trim(),
        applicationQuestion: String(field.label).trim(),
        ...portalQuestionMetadata(field),
        ...(field.context ? { context: field.context } : {}),
        ...(field.section ? { section: field.section } : {}),
        ...(field.autocomplete ? { autocomplete: field.autocomplete } : {}),
        ...addressMetadata(field),
        why,
        type: field.options?.length ? 'choice' : field.kind === 'date' || field.inputType === 'date' ? 'date' : field.inputType === 'number' ? 'number' : 'text',
        options: (field.options || []).map((option) => option.label).filter(Boolean),
      })));
      const request = await portalRequirementsForCandidate({ questions: openQuestions, documents: [] }, {
        candidateLocale: ctx.candidateLocale,
        applicationLocale: ctx.language,
        codex: ctx.codex,
        log: ctx.log,
      });
      if (request?.questions.length) {
        await ctx.accounts.mark(host, { status: 'unanswered' });
        return noted(request);
      }
    }

    const passwordNeedsRefill = retryableFields.some((field) => field.inputType === 'password');
    if (repairAttempts >= 2 || (!repairActions.length && !passwordNeedsRefill)) {
      if (retryingUnverifiedAccount) return noted(accountHandoff('account_verification_retry_refused', 'create_refused', 'registration'));
      // No candidate answer or concrete correction remains: do not keep
      // credentials for an account the portal explicitly rejected.
      await ctx.accounts.discard(host, 'registration_refused');
      return noted(accountHandoff('account_create_refused', 'create_refused', 'registration'));
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
async function requiredLeftEmpty(page, uploaded = new Set(), uploadedKeyForField = null) {
  const url = page.url();
  const snapshot = await extractFields(page, NAVIGATION);
  const fields = snapshot.fields || [];
  for (const field of fields) {
    if (!field.required) continue;
    const uploadedKey = uploadedKeyForField ? uploadedKeyForField(field, fields, url) : uploadedPortalFieldKey(url, field);
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
export function pageControls(buttons, known, url, context = null) {
  const stage = context ? applicationStage(context.snapshot, { ...context, url }) : null;
  if (stage) {
    if (stage.kind === 'application_start') return { submit: null, next: stage.control, stage };
    if (stage.kind === 'review_navigation') return { submit: null, next: stage.control, stage };
    if (['receipt', 'unknown_apply', 'posting_mismatch'].includes(stage.kind)) return { submit: null, next: null, stage };
  }
  const here = anonymizePath(url);
  const learned = learnedApplicationControls(buttons, known, here);
  const gallerySnapshot = { buttons, fields: context?.snapshot?.fields };
  const nonApplicationSurface = isNonApplicationSurface(gallerySnapshot, {
    applicationEvidence: learned.next || learned.submit,
  });
  const galleryButtons = galleryNavigationButtons(buttons);
  const applicationOpeners = new Set(inPageApplicationOpeners(context?.snapshot, url).map(portalControlIdentity));
  const applicationButtons = nonApplicationSurface ? [] : buttons.filter((button) =>
    !galleryButtons.has(portalControlIdentity(button)) && !applicationOpeners.has(portalControlIdentity(button)));
  const submit = nonApplicationSurface ? null : findButton(applicationButtons, SUBMIT_RE);
  const usualNext = nonApplicationSurface ? null : findButton(applicationButtons, NEXT_RE);
  const taughtNext = nonApplicationSurface || submit || usualNext ? null : learned.next;
  const taughtSubmit = nonApplicationSurface ? null : learned.submit;
  return {
    submit: submit || (usualNext || taughtNext ? null : taughtSubmit),
    next: usualNext || taughtNext,
    ...(stage ? { stage } : {}),
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

/** Read Gravity Forms' native validation and confirmation markers after submit. */
function gravityFormsEvidenceInPage(frameIndex = 0) {
  const normalizeFormId = (value) => {
    const match = /^(?:gform_(?:confirmation_message_|confirmation_wrapper_|wrapper_)?)(\d+)$/i.exec(String(value || '').trim());
    return match ? `gform_${match[1]}` : '';
  };
  const frameFormId = (value) => {
    const formId = normalizeFormId(value);
    return formId ? `${Number(frameIndex) || 0}\u0000${formId}` : '';
  };
  const visible = (element) => {
    try {
      if (typeof element.checkVisibility === 'function') return element.checkVisibility({ visibilityProperty: true });
      const style = getComputedStyle(element);
      return style.display !== 'none' && style.visibility !== 'hidden' && element.getClientRects().length > 0;
    } catch { return false; }
  };
  const formIdFor = (element) => {
    for (let node = element; node && node.nodeType === 1; node = node.parentElement) {
      const id = frameFormId(node.id);
      if (id) return id;
    }
    return '';
  };
  const confirmationNodes = [...new Set(document.querySelectorAll(
    '.gform_confirmation_message, [id^="gform_confirmation_message_"], .gform_confirmation_wrapper',
  ))];
  const validationNodes = [...document.querySelectorAll('.gform_validation_error, .gform_validation_errors')];
  return {
    formIds: [...document.querySelectorAll('form[id^="gform_"]')]
      .map((form) => frameFormId(form.id)).filter(Boolean),
    validationError: validationNodes.length > 0,
    validationFormIds: [...new Set(validationNodes.map(formIdFor).filter(Boolean))],
    confirmations: confirmationNodes.map((element) => ({
      formId: formIdFor(element),
      visible: visible(element),
      text: String(element.innerText || element.textContent || '').replace(/\s+/gu, ' ').trim().slice(0, 800),
    })).filter((item) => item.text),
  };
}

/** Completion URLs are only supplementary: explicit receipt copy must bind the same posting. */
export function urlConfirms(url, snapshot, context = {}) {
  return DONE_URL_RE.test(url) && !REVIEW_URL_RE.test(url) && applicationReceipt(snapshot, { ...context, url });
}

/**
 * The click moved this posting's application to another page that is its
 * final review, whose own words say the application is sent only by a later
 * Submit/Apply (Deloitte's Avature, order JvKpYedw 2026-10-30: the profile's
 * Apply opened /ApplicationReview «please select Submit to finalise your
 * application»). The portal itself states that nothing was submitted yet.
 */
async function waitForOutcome(page, context = {}) {
  const started = Date.now();
  const deadline = started + OUTCOME_TIMEOUT_MS;
  let lastSnapshot = null;
  while (Date.now() < deadline) {
    await page.waitForTimeout(1000);
    const text = await page.evaluate(() => document.body?.innerText || '').catch(() => '');
    let snapshot = await extractFields(page, NAVIGATION).catch(() => null);
    if (snapshot) {
      const gravityFrame = context.finalSubmission?.frame || page.mainFrame();
      const frameIndex = Number.isSafeInteger(context.finalSubmission?.frameIndex)
        ? context.finalSubmission.frameIndex
        : Math.max(0, page.frames().indexOf(gravityFrame));
      const gravityForms = await gravityFrame.evaluate(gravityFormsEvidenceInPage, frameIndex).catch(() => null);
      lastSnapshot = { ...snapshot, ...(gravityForms ? { gravityForms } : {}), text, url: page.url() };
    }
    if (gravityFormsSubmissionOutcome(lastSnapshot, { finalSubmission: context.finalSubmission }) === 'validation') {
      return { outcome: 'validation', snapshot: lastSnapshot };
    }
    // The portal says it did not send: nothing left, by its own word.
    if (REFUSED_RE.test(text)) return { outcome: 'refused', snapshot: lastSnapshot };
    // Refusal takes precedence when an error page retains generic thank-you copy.
    if (snapshot && applicationReceipt(lastSnapshot, { ...context, url: page.url() })) return { outcome: 'confirmed', snapshot: lastSnapshot };
    if (urlConfirms(page.url(), lastSnapshot, context)) return { outcome: 'confirmed', snapshot: lastSnapshot };
    if (advancedToFinalReview(lastSnapshot, { ...context, url: page.url() })) return { outcome: 'review_pending', snapshot: lastSnapshot };
    if (snapshot?.captcha) return { outcome: 'captcha', snapshot: lastSnapshot };
    if (Date.now() > started + 4000 && (VALIDATION_RE.test(text) || snapshot?.errors?.length)) return { outcome: 'validation', snapshot: lastSnapshot };
  }
  return { outcome: 'ambiguous', snapshot: lastSnapshot };
}

function finalReviewEvidenceSnapshot(snapshot) {
  if (!snapshot || typeof snapshot.text !== 'string') return null;
  return {
    url: String(snapshot.url || ''),
    text: snapshot.text,
    protocol: snapshot.protocol || null,
    errors: (snapshot.errors || []).length ? ['observed'] : [],
    fields: (snapshot.fields || []).map(field => ({
      inputType: field?.inputType || '',
      disabled: Boolean(field?.disabled),
      chrome: Boolean(field?.chrome),
      invalid: field?.invalid === true,
    })).slice(0, 120),
    buttons: (snapshot.buttons || []).map(button => ({
      text: String(button?.text || '').slice(0, 160),
      disabled: Boolean(button?.disabled),
      chrome: Boolean(button?.chrome),
    })).slice(0, 80),
  };
}

// Forms that can be read without creating an account or sending an
// application. Account ATSs are included because some tenants expose a guest
// form; when they expose only sign-in/create-account, hasApplicationForm below
// returns false and the reader stops without touching the account flow.
export const PREREAD_CHANNELS = new Set([
  'greenhouse', 'lever', 'smartrecruiters', 'personio', 'softgarden',
  'umantis', 'refline', 'jobs_ch', 'workday', 'successfactors', 'manatal',
]);

// Solique exposes a public multi-step application form without an account.
// Keep this an exact HTTPS host allowlist for the employer-specific exception;
// unknown public routes use the bounded generic read-only capability below.
const SAFE_EMPLOYER_PREREAD_HOSTS = new Set(['live.solique.ch']);
const NON_BROWSER_APPLICATION_CHANNELS = new Set(['email', 'linkedin', 'pastahr']);

export function isSafeEmployerSitePreread(url) {
  try {
    const parsed = new URL(String(url || ''));
    return parsed.protocol === 'https:'
      && SAFE_EMPLOYER_PREREAD_HOSTS.has(parsed.hostname.toLowerCase());
  } catch {
    return false;
  }
}

/**
 * The read-ahead capability is deliberately explicit. It permits one browser
 * snapshot of controls already mounted by an allowlisted ATS or a public
 * HTTPS application route, but it never permits a fill, a wizard advance or a
 * submit during draft creation. Opening a public posting's named Apply link
 * is navigation only. Fields hidden by an actual conditional container are
 * filtered by extractFieldsInPage and are discovered only after the candidate
 * answers the step that reveals them.
 */
export function portalReadAheadCapability({ channelType = '', entryUrl = '', applyUrl = '', verifiedPostingEntry = false } = {}) {
  const channel = String(channelType || '');
  if (NON_BROWSER_APPLICATION_CHANNELS.has(channel)) return null;
  if (PREREAD_CHANNELS.has(channel)) {
    return { kind: 'mounted_read_only', source: 'ats_guest_form' };
  }
  if (verifiedPostingEntry || isSafeEmployerSitePreread(entryUrl)) {
    return { kind: 'mounted_read_only', source: 'verified_application_route' };
  }
  // The generic path is still intentionally narrow: both the source page and
  // the saved application URL must be public HTTPS URLs. DNS resolution is
  // checked immediately before launch, and every browser request is guarded
  // again below so an employer link cannot turn drafting into an SSRF proxy.
  if (isFetchablePublicUrl(entryUrl) && isFetchablePublicUrl(applyUrl || entryUrl)) {
    return { kind: 'mounted_read_only', source: 'public_application_route' };
  }
  return null;
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
function missingCandidatePortalRequirements(fields, candidate, candidateLocale = 'it') {
  if (!candidate || typeof candidate !== 'object') return { questions: [], stableQuestionIds: new Map() };
  const requiredFields = (Array.isArray(fields) ? fields : []).filter(field => field?.required === true);
  const profile = candidate.profile || {};
  const answers = candidate.answers || {};
  const folded = (value) => String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ').trim();
  const fieldText = (field) => [
    field?.label, field?.ariaLabel, field?.description, field?.ariaDescription,
    ...(Array.isArray(field?.labels) ? field.labels : []),
    ...(Array.isArray(field?.options) ? field.options.map(option => typeof option === 'string' ? option : option?.label) : []),
  ].filter(Boolean).join(' ');
  const fieldHasResidenceContext = (field) => explicitResidence([
    field?.label, field?.ariaLabel, field?.description, field?.ariaDescription, field?.context, field?.section,
    ...(Array.isArray(field?.labels) ? field.labels : []),
  ].filter(Boolean).join(' '));
  const optionLabels = field => (Array.isArray(field?.options) ? field.options : [])
    .filter(portalUsableChoiceOption)
    .map(option => String(typeof option === 'string' ? option : option?.label || '').trim())
    .filter(Boolean);
  const missing = [];
  const stableQuestionIds = new Map();
  const add = (field, id, question, why, extra = {}) => {
    const fieldId = String(field?.id || '').trim();
    const applicationQuestion = String(field?.label || '').trim();
    if (!fieldId && !applicationQuestion) return;
    missing.push({ ...(fieldId ? { fieldId } : {}), applicationQuestion, question, why, required: true, ...extra });
    if (fieldId) stableQuestionIds.set(fieldId, id);
    stableQuestionIds.set(`label:${applicationQuestion}`, id);
  };
  const hasAnswer = id => String(answers[id] ?? '').trim().length > 0;
  const datePresent = String(profile.dateOfBirth || '').trim().length > 0;
  const streetPresent = String(addressQuestionAnswer(candidate, 'address_street') || '').trim().length > 0;
  const houseNumberPresent = Boolean(String(addressQuestionAnswer(candidate, 'address_house_number') || '').trim());
  const residenceCountryPresent = Boolean(String(addressQuestionAnswer(candidate, 'residence_country') || '').trim());
  const explicitSalutationPresent = String(candidate.confirmedAnswers?.salutation || answers.salutation || '').trim().length > 0;
  // CV text is evidence to review, not the candidate's confirmation of a
  // required current residence or permit status.
  const permitStatusPresent = Boolean(permitStatusFromCandidate(candidate, { includeProfileWorkPermit: false }));
  const separateHouseNumber = requiredFields.some(field => residenceFieldRole(field?.label) === 'houseNumber');

  for (const field of requiredFields) {
    const label = folded(field.label);
    const allText = folded(fieldText(field));
    const operationalField = { ...field, question: allText, applicationQuestion: field.label || allText, options: field.options };
    const hasOperationalDefault = Boolean(operationalDefaultAnswer(operationalField, { facts: candidate.platformFacts }));
    const role = residenceFieldRole(field.label);
    const candidateAnswer = candidateAnswerForField(candidate, field, {
      includeProfileWorkPermit: !(isPermitField(field.label) && asksHeldStatus(field.label)),
    });
    if (isPermitField(field.label) && asksHeldStatus(field.label)
      && !isPermitHistoricalQuestion(field.label) && !permitStatusPresent
      && !String(candidateAnswer?.value ?? '').trim()) {
      const question = permitStatusQuestion(candidateLocale);
      add(field, 'work_permit', question,
        permitStatusQuestionWhy(candidateLocale),
        {
          type: 'choice',
          forceType: 'choice',
          options: permitOptions(candidateLocale),
          // Free-text ATS controls can accept the candidate's selected
          // canonical status. Native controls need their own option catalogue
          // so that the answer can be mapped back safely.
          requiresNativeOptions: fieldRequiresNativeOptions(field),
          candidatePrompt: question,
        });
      continue;
    }
    const isBirthDate = String(field.autocomplete || '').toLowerCase() === 'bday'
      || /\b(?:date of birth|birth date|geburtsdatum|date de naissance|data di nascita)\b/.test(allText);
    if (isBirthDate && !datePresent && !hasAnswer('portal_date_of_birth')) {
      add(field, 'portal_date_of_birth', 'Qual è la tua data di nascita completa?',
        'Il portale richiede la data di nascita per completare la candidatura.',
        { type: 'date', forceType: 'date', autocomplete: 'bday' });
      continue;
    }

    const isSalutation = /\b(?:appellativo|anrede|salutation|form of address|civilite|titolo)\b/.test(label)
      || /\b(?:signora|signor|madame|monsieur|herr|frau|mr|mrs|ms|miss)\b/.test(allText);
    const addressTitleOnly = /^titolo accademico$/.test(label);
    const salutationOptions = optionLabels(field).filter(option => /^(?:signora|signor(?:e)?|madame|monsieur|herr|frau|mr|mrs|ms|miss)\.?$/i.test(folded(option)));
    if (isSalutation && !addressTitleOnly && salutationOptions.length >= 2
      && !explicitSalutationPresent && !hasAnswer('salutation')) {
      add(field, 'salutation', 'Quale appellativo vuoi usare nei moduli di candidatura?',
        'Il portale richiede una scelta esplicita. Il valore proposto dal profilo non vale come conferma.',
        { type: 'choice' });
      continue;
    }

    if (role === 'country' && fieldHasResidenceContext(field)
      && !residenceCountryPresent && !hasAnswer('portal_residence_country')) {
      add(field, 'portal_residence_country', 'In quale Paese risiedi?',
        'Il portale richiede il Paese di residenza per creare il profilo candidato.',
        { type: 'choice', forceType: 'choice', requiresNativeOptions: true });
      continue;
    }

    const addressQuestionId = role === 'houseNumber' ? 'portal_residence_house_number'
      : role === 'street' && separateHouseNumber ? 'portal_residence_street' : 'portal_residence_address';
    const addressValuePresent = role === 'houseNumber' ? houseNumberPresent
      : role === 'street' && separateHouseNumber ? streetPresent
        : streetPresent && houseNumberPresent;
    if (['street', 'address', 'houseNumber'].includes(role) && !addressValuePresent && !hasAnswer(addressQuestionId)) {
      const id = role === 'houseNumber' ? 'portal_residence_house_number'
        : role === 'street' && separateHouseNumber ? 'portal_residence_street' : 'portal_residence_address';
      const question = role === 'houseNumber'
        ? 'Qual è il numero civico del tuo indirizzo di residenza?'
        : role === 'street' && separateHouseNumber
          ? 'Qual è la via del tuo indirizzo di residenza?'
          : 'Qual è la via e il numero civico del tuo indirizzo di residenza?';
      add(field, id, question,
        'Il portale richiede l’indirizzo stradale. CAP, località e Paese vengono letti dai dati già presenti.',
        { type: 'text' });
      continue;
    }

    const retentionPrompt = /\b(?:attivazione dati|data retention|retention period|keep (?:my |your |the )?data|retain (?:my |your |the )?data|delete (?:my |your |the )?data|eliminat\w* dopo la procedura|conserv\w* dopo la candidatura)\b/.test(allText)
      || operationalQuestionTopic({ ...field, question: allText, applicationQuestion: field.label || allText, options: field.options }) === 'application_data_retention';
    if (retentionPrompt && !hasOperationalDefault && !hasAnswer('portal_data_retention')) {
      add(field, 'portal_data_retention', 'Per quanto tempo autorizzi l’EOC a conservare i tuoi dati personali?',
        'Il portale richiede di scegliere tra la conservazione per future offerte e la cancellazione dopo questa candidatura.',
        { type: 'choice', forceType: 'choice', requiresNativeOptions: true });
      continue;
    }

    const privacyConsent = /\b(?:privacy|data protection|protezione dei dati|protezione dati|datenschutz|confidentialite)\b/.test(allText)
      && /\b(?:acconsent\w*|consent\w*|accept\w*|agree\w*|einwillig\w*|zustimm\w*)\b/.test(allText)
      && /\b(?:tratt\w*|process\w*|verarbeit\w*|trait\w*)\b/.test(allText);
    if (privacyConsent && !hasOperationalDefault && !hasAnswer('portal_privacy_consent')) {
      add(field, 'portal_privacy_consent', 'Dopo aver letto la dichiarazione sulla protezione dei dati dell’EOC, acconsenti al trattamento dei tuoi dati personali descritto nel modulo?',
        'Il portale richiede il tuo consenso per inviare la candidatura. Se non acconsenti, la candidatura non può essere inviata.',
        { type: 'yes_no', forceType: 'yes_no', options: ['Sì', 'No'], requiresAffirmativeConsent: true });
    }
  }
  return { questions: missing, stableQuestionIds };
}

export function portalRequirementsFromMissingRequired(fields, missingRequired, {
  candidate = null,
  candidateLocale = 'it',
} = {}) {
  const availableFields = Array.isArray(fields) ? fields : [];
  const folded = (value) => String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ').trim();
  const aliases = ['domId', 'name', 'controlId', 'nativeControlId', 'nativeSelectId', 'semanticId',
    'dataAutomationId', 'dataControlId', 'dataSemanticId', 'elementId', 'nativeFieldId'];
  const directFieldsFor = fieldId => availableFields.filter(field => field.id && field.id === fieldId);
  const aliasedFieldsFor = requestedId => availableFields.filter(field => aliases.some(alias => String(field?.[alias] || '').trim() === requestedId));
  const fieldFor = (item) => {
    const direct = directFieldsFor(item?.fieldId);
    if (direct.length === 1) return direct[0];
    const requestedId = String(item?.fieldId || '').trim();
    if (requestedId) {
      // The planner contract names the generated field id, but older agent
      // traces can carry the native DOM/name alias. Resolve it only when the
      // alias identifies one live field; ambiguity must remain unknown.
      const aliased = aliasedFieldsFor(requestedId);
      if (aliased.length > 1) return null;
      if (aliased.length === 1) return aliased[0];
    }
    const questions = [item?.applicationQuestion, item?.portalQuestion, item?.question].map(folded).filter(Boolean);
    if (!questions.length) return null;
    const matching = availableFields.filter((field) => {
      const label = folded(field?.label);
      return label && questions.includes(label);
    });
    return matching.length === 1 ? matching[0] : null;
  };
  const candidateRequirements = missingCandidatePortalRequirements(availableFields, candidate, candidateLocale);
  const mergedRequired = new Map();
  const mergeRequired = (item, { preferIncoming = false } = {}) => {
    const key = String(item?.fieldId || folded(item?.applicationQuestion || item?.portalQuestion || item?.question));
    if (!key) return;
    const existing = mergedRequired.get(key);
    mergedRequired.set(key, existing && !preferIncoming ? { ...existing, ...item } : item);
  };
  for (const item of Array.isArray(missingRequired) ? missingRequired : []) {
    const field = fieldFor(item);
    // Candidate questions are for facts the runner cannot already supply.
    // A value prefilled by the ATS is not candidate confirmation; suppress a
    // planner question only when the candidate's own data supplies an answer.
    // An explicitly rejected field still needs review.
    const candidateAnswer = candidate && field
      ? candidateAnswerForField(candidate, field, {
        includeProfileWorkPermit: !(isPermitField(field.label) && asksHeldStatus(field.label)),
      }) : null;
    if (field && field.invalid !== true && String(candidateAnswer?.value ?? '').trim()) continue;
    mergeRequired(item);
  }
  // Keep the planner's order when a deterministic candidate requirement
  // enriches the same live field (for example, the permit question replacing
  // a generic work-authorisation prompt). Candidate-only requirements are
  // appended after the planner's explicit missing fields.
  for (const item of candidateRequirements.questions) {
    mergeRequired(item, { preferIncoming: true });
  }
  const fieldIndexes = new Map(availableFields.map((field, index) => [field, index]));
  const orderedRequirements = [...mergedRequired.values()].sort((left, right) => {
    const leftIndex = fieldIndexes.get(fieldFor(left)) ?? Number.MAX_SAFE_INTEGER;
    const rightIndex = fieldIndexes.get(fieldFor(right)) ?? Number.MAX_SAFE_INTEGER;
    return leftIndex - rightIndex;
  });
  const hasAmbiguousAlias = (item) => {
    if (directFieldsFor(item?.fieldId).length === 1) return false;
    const requestedId = String(item?.fieldId || '').trim();
    return Boolean(requestedId && aliasedFieldsFor(requestedId).length > 1);
  };
  const documents = [];
  const readable = [];
  const unreadableFields = [];
  let reducedRequirement = false;
  for (const item of orderedRequirements) {
    const field = fieldFor(item);
    if (hasAmbiguousAlias(item)) {
      unreadableFields.push(item.fieldId || 'unknown');
      continue;
    }
    // A planner calling a field missing is not proof that it is mandatory.
    // A rejected live field remains a request even if it lacks a required marker;
    // missing metadata is unknown, not evidence that the field is optional.
    const unconfirmedHistoricalPermitPrefill = Boolean(field?.required === false
      && isPermitField(field.label) && isPermitHistoricalQuestion(field.label) && holdsValue(field)
      && !String(candidateAnswerForField(candidate, field)?.value ?? '').trim());
    if (field?.required === false && !field.invalid && !unconfirmedHistoricalPermitPrefill) {
      const optionalTechnicalFile = (field.kind === 'file' || field.inputType === 'file') && machineLabel(field.label);
      // Umantis exposes optional attachment slots as names such as
      // `form_data41`. They are not candidate questions and must not turn a
      // harmless optional slot into question_label_unreadable.
      if (!optionalTechnicalFile) reducedRequirement = true;
      continue;
    }
    if (unreadableNativeOwner(field || item)) {
      unreadableFields.push(field?.id || item.fieldId || 'unknown');
      continue;
    }
    const document = portalRequiredDocumentFromField(field ? { ...field, required: true } : field);
    if (!document) {
      // A field with a generated name is no question for a person: the submit
      // run's agent reads it from the live page instead.
      // The CV and cover-letter fields are already supplied by the runner, so
      // they are neither candidate questions nor extra document requirements.
      if (!field || (field.kind !== 'file' && field.inputType !== 'file')) {
        // A live field is authoritative. An agent's candidate-language copy
        // must never replace the exact label/options read from the ATS.
        const liveQuestionCandidates = field
          ? [field.label, field.description, field.ariaDescription]
          : [item.applicationQuestion, item.portalQuestion, item.question];
        const applicationQuestion = liveQuestionCandidates
          .map(value => String(value || '').trim())
          .find(value => readablePortalQuestionText(value) && !machineLabel(value)) || '';
        if (!readablePortalQuestionText(applicationQuestion) || machineLabel(applicationQuestion)) {
          unreadableFields.push(field?.id || item.fieldId || 'unknown');
          continue;
        }
        const liveOptions = field ? editableCombobox(field) ? [] : field.options || [] : item.applicationOptions || item.options || [];
        const readableOptions = liveOptions.filter(portalUsableChoiceOption);
        const applicationOptions = readableOptions
          .map((option) => typeof option === 'string' ? option : option?.label)
          .map((option) => String(option || '').trim())
          .filter(Boolean);
        const applicationOptionValues = field && readableOptions.length === applicationOptions.length
          && readableOptions.every(option => typeof option !== 'string' && String(option?.value || '').trim())
          ? readableOptions.map(option => String(option.value).trim()) : [];
        const nativeChoiceField = Boolean(field && fieldRequiresNativeOptions(field) && (
          ['select', 'radio', 'listbox'].includes(field.kind)
          || field.selectLike === true
          || field.nativeSelectId
          || applicationOptions.length
        ));
        const optionMap = portalOptionMap({ options: item.options, applicationOptions, optionMap: item.optionMap });
        let type = item.type;
        if (field) {
          if (item.forceType) type = item.forceType;
          else if (['select', 'radio', 'listbox'].includes(field.kind) || field.selectLike || field.nativeSelectId || applicationOptions.length) type = 'choice';
          else if (editableCombobox(field)) type = 'text';
          else if (field.kind === 'checkbox') type = 'yes_no';
          else if (field.kind === 'date' || field.inputType === 'date' || field.autocomplete === 'bday') type = 'date';
          else if (field.inputType === 'number') type = 'number';
          else if (['text', 'textarea'].includes(field.kind)) type = 'text';
        }
        if (field && type === 'choice' && !portalHasChoiceCatalogue(field)
          && (fieldRequiresNativeOptions(field) || item.requiresNativeOptions === true)) {
          unreadableFields.push(field.id || item.fieldId || 'unknown');
          continue;
        }
        if (nativeChoiceField && item.requiresNativeOptions === true && !applicationOptions.length) {
          unreadableFields.push(field.id || item.fieldId || 'unknown');
          continue;
        }
        const safeTextChoiceOptions = field && !nativeChoiceField && type === 'choice'
          && isPermitField(field.label) && asksHeldStatus(field.label)
          ? item.options || [] : [];
        readable.push({
          ...item,
          applicationQuestion,
          ...portalQuestionMetadata(field),
          type,
          validation: field && (type !== item.type || ['choice', 'yes_no'].includes(type)) ? {} : item.validation,
          required: true,
          applicationOptions,
          ...(applicationOptionValues.length ? { applicationOptionValues } : {}),
          applicationOptionsKnown: Boolean(field),
          options: field
            ? optionMap.length
              ? optionMap.map((pair) => pair.candidate)
              : applicationOptions.length
                ? applicationOptions
                : safeTextChoiceOptions.length
                  ? safeTextChoiceOptions
                  : (item.forceType || item.candidatePrompt ? item.options || [] : [])
            : item.options,
          optionMap,
          ...(item.section || !field?.section ? {} : { section: field.section }),
          ...(item.autocomplete || !field?.autocomplete ? {} : { autocomplete: field.autocomplete }),
          ...addressMetadata(field || item),
        });
      }
      continue;
    }
    if (!documents.some((candidate) => candidate.id === document.id)) documents.push(document);
  }
  const questions = questionsFrom(readable, candidateRequirements.stableQuestionIds);
  return {
    questions,
    documents,
    ...(unreadableFields.length ? { unreadableFields } : {}),
    ...(reducedRequirement && !questions.length && !documents.length ? { reduction: { kind: 'empty' } } : {}),
  };
}

/**
 * The questions a portal will ask, read while drafting (career-ops apply.md:
 * identify ALL the questions before answering), so the candidate answers them
 * on the first review instead of in a second round at submit time. The form
 * is opened and read, never filled, and nothing is pressed but "apply".
 * A supported portal that cannot be read is a technical handoff, never an
 * empty requirement list. An unreadable required field is not a question for
 * the candidate.
 * @returns {Promise<{questions:Array<object>,documents:Array<object>,handoff?:string,unreadableFields?:Array<string>,portalContract?:object}>} requirements and the metadata-only portal contract for the review page
 */
export async function readPortalRequirements(ctx) {
  const entryUrl = portalEntryUrl(ctx);
  // Umantis can publish the posting itself as its applyUrl. portalEntryUrl
  // turns that exact, same-vacancy pair into Application/New; carry the
  // verified application route through form recognition as well, so the
  // applicant identity can own an otherwise ungrouped address cluster.
  const umantisApplyUrl = umantisApplicationEntryUrl(ctx);
  const stageApplyUrl = umantisApplyUrl || ctx.applyUrl;
  const channelType = portalChannelType(ctx);
  // Some employer sites expose a Jobs2Web application URL without using a
  // SuccessFactors hostname. Only pre-read those when the validated same-ID
  // posting route above proves that this is the matching application flow.
  const verifiedJobs2WebEntry = ctx.channelType === 'employer_site'
    && entryUrl !== String(ctx.applyUrl || '');
  const verifiedPostingEntry = verifiedJobs2WebEntry || verifiedPostingEntryFor(ctx);
  // A legacy Umantis Application/New URL can be the only durable vacancy
  // identity after liveness discarded an ambiguous posting candidate. Keep
  // the inferred Description route in the form matcher; otherwise the EOC
  // form's own employer questions look like a conflicting employer before
  // the already-verified route proof gets a chance to bind it.
  const inferredUmantisPostingUrl = verifiedPostingEntry && !String(ctx.postingUrl || '').trim()
    ? umantisPostingAddressFromApplication(stageApplyUrl)
    : '';
  let formPostingUrl = String(ctx.postingUrl || '').trim() || inferredUmantisPostingUrl;
  const readAhead = portalReadAheadCapability({
    channelType,
    entryUrl,
    applyUrl: stageApplyUrl,
    verifiedPostingEntry,
  });
  if (!readAhead || !ctx.applyUrl) {
    return {
      questions: [],
      documents: [],
      portalContract: applicationContractFromPreflight({
        channelType,
        applyUrl: ctx.applyUrl,
        sourceUrl: entryUrl,
        status: readAhead ? 'unavailable' : 'handoff',
        handoff: readAhead ? 'apply_url_unavailable' : channelType === 'pastahr' ? 'candidate_handoff' : 'channel_not_preread',
        submitCapability: channelType === 'pastahr' ? 'candidate_handoff' : 'unknown',
      }),
    };
  }
  const genericPublicRoute = readAhead.source === 'public_application_route';
  // Function scope, not the block below: the browser request guard further
  // down calls it too. Declared inside the `if`, the guard's call threw a
  // ReferenceError that its `.catch(() => false)` read as «not public», so
  // every request was aborted and every generic employer page failed with
  // net::ERR_FAILED (portal_reader_failed, 2026-11-06 → 2026-11-10).
  const resolvePublicHost = typeof ctx.resolvePublicHost === 'function' ? ctx.resolvePublicHost : resolvesToPublicHost;
  if (genericPublicRoute) {
    const publicUrls = [...new Set([entryUrl, stageApplyUrl].map(value => String(value || '').trim()).filter(Boolean))];
    const publicRouteAvailable = (await Promise.all(publicUrls.map(async (url) => {
      try {
        return await resolvePublicHost(url);
      } catch {
        return false;
      }
    }))).every(Boolean);
    if (!publicRouteAvailable) {
      return {
        questions: [],
        documents: [],
        handoff: 'public_route_unavailable',
        portalContract: applicationContractFromPreflight({
          channelType, applyUrl: ctx.applyUrl, sourceUrl: entryUrl, status: 'unavailable', handoff: 'public_route_unavailable',
        }),
      };
    }
  }
  const launch = ctx.launch || (() => launchPortalBrowser(ctx));
  let browser = null;
  let page = null;
  let contractDiagnostics = null;
  let contractFinished = false;
  let contractSnapshot = null;
  let contractPostingMatch = 'unknown';
  const finish = async (result, { status = result?.handoff ? 'handoff' : 'ready', snapshot = contractSnapshot, postingMatch = contractPostingMatch } = {}) => {
    if (contractDiagnostics && !contractFinished) {
      await contractDiagnostics.finish().catch(() => {});
      contractFinished = true;
    }
    return {
      ...result,
      portalContract: applicationContractFromPreflight({
        channelType,
        applyUrl: ctx.applyUrl,
        sourceUrl: entryUrl,
        currentUrl: page?.url?.() || entryUrl,
        snapshot,
        postingMatch,
        status,
        handoff: result?.handoff || null,
        questions: result?.questions || [],
        documents: result?.documents || [],
        diagnostics: contractDiagnostics?.data || null,
      }),
    };
  };
  try {
    browser = await launch();
    const context = await browser.newContext(portalContextOptions(ctx));
    registerPortalChannelType(context, portalChannelType(ctx));
    await registerCookieSessionRecovery(context, { log: ctx.log });
    if (genericPublicRoute && typeof context.route === 'function') {
      const publicHostCache = new Map();
      const requestIsPublic = async (requestUrl) => {
        if (!/^(?:https?:|wss?:)/i.test(String(requestUrl || ''))) return true;
        if (!isFetchablePublicUrl(requestUrl)) return false;
        let check = publicHostCache.get(new URL(requestUrl).origin);
        if (!check) {
          check = Promise.resolve().then(() => resolvePublicHost(requestUrl)).catch(() => false);
          publicHostCache.set(new URL(requestUrl).origin, check);
        }
        return check;
      };
      await context.route('**/*', async (route) => {
        const requestUrl = route.request().url();
        if (await requestIsPublic(requestUrl)) {
          // Let the narrower cookie-session recovery route run first when it
          // matches. `continue()` would bypass that already-registered route.
          if (typeof route.fallback === 'function') await route.fallback();
          else await route.continue();
        }
        else await route.abort().catch(() => {});
      });
    }
    // Reuse the bounded diagnostic listener for the preflight. It records only
    // request/response locations and methods; it never reads candidate data.
    // Deterministic portal fixtures may not expose a BrowserContext event API.
    if (typeof context.on === 'function') {
      contractDiagnostics = startPortalDiagnostics(context, []);
      await contractDiagnostics.beginAttempt().catch(() => {});
    }
    page = await context.newPage();
    await page.goto(entryUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await settle(page);
    let snapshot = await extractFields(page, NAVIGATION);
    contractSnapshot = snapshot;
    const hasJobContract = Boolean(ctx.job?.company || ctx.job?.title);
    const sourceTitle = typeof page.title === 'function' ? await page.title().catch(() => '') : '';
    const sourcePostingText = `${sourceTitle}\n${snapshot.text || ''}\n${page.url()}`;
    const sourceApplicationEntryProven = applicationEntryControls(snapshot, {
      applyUrl: stageApplyUrl,
      postingUrl: ctx.postingUrl || page.url(),
      pageTitle: sourceTitle,
      sourceProtocol: snapshot.protocol || ctx.sourceProtocol || null,
      postingRouteProof: ctx.postingRouteProof,
      job: ctx.job,
      allowSingleExternalApplicationEntry: true,
    }).length === 1;
    const sourceJobRoomEntryProven = jobRoomExternalApplicationEntryProven(snapshot, {
      applyUrl: stageApplyUrl,
      postingUrl: ctx.postingUrl || page.url(),
      allowSingleExternalApplicationEntry: true,
    });
    // A posting published as a document: its host page stands for it once the document is the order's.
    const sourceDocument = hasJobContract ? await postingDocumentHostMatch(snapshot, ctx, page.url()) : null;
    const sourceDocumentHost = sourceDocument?.identity === true;
    let sourcePostingMatched = hasJobContract && (sourceDocumentHost || sourceJobRoomEntryProven || hasVacancySpecificPostingEvidence(sourcePostingText, ctx.job, {
      pageUrl: page.url(),
      pageTitle: sourceTitle,
      pageHeading: await postingMainHeading(page),
      postingUrl: ctx.postingUrl,
      postingRouteProof: ctx.postingRouteProof,
      vacancyIdentityContexts: currentVacancyIdentityContexts(snapshot),
      uniqueApplicationEntryProven: sourceApplicationEntryProven,
    }));
    const sourcePageUrl = page.url();
    const opened = await openApplicationForm(context, page, snapshot, {
      applyUrl: stageApplyUrl,
      postingUrl: ctx.postingUrl || page.url(),
      pageTitle: sourceTitle,
      sourceProtocol: snapshot.protocol || ctx.sourceProtocol || null,
      job: ctx.job,
      postingEntry: verifiedPostingEntry,
      postingRouteProof: ctx.postingRouteProof,
      allowSingleExternalApplicationEntry: sourcePostingMatched,
      ...(sourceDocumentHost ? { postingDocumentHost: true, postingDocumentHostUrl: sourcePageUrl } : {}),
    });
    ({ page, snapshot } = opened);
    if (opened.resolvedPostingUrl) {
      formPostingUrl = opened.resolvedPostingUrl;
      sourcePostingMatched = true;
    }
    contractSnapshot = snapshot;
    if (opened.handoff) return await finish({ questions: [], documents: [], handoff: opened.handoff });
    // An allowlisted ATS may keep later, unconditional steps mounted with
    // zero-sized controls. Read the complete mounted contract once, without
    // pressing Next/Continue or fabricating an answer. Conditional containers
    // stay excluded and are handled by the submit runner after an explicit
    // candidate answer.
    snapshot = await awaitFields(page, await extractFields(page, readAhead
      ? { ...NAVIGATION, includeHidden: true, listboxOptions: false }
      : NAVIGATION));
    contractSnapshot = snapshot;
    const readableApplication = hasApplicationForm(snapshot)
      && (!snapshot.passwordVisible || snapshot.fields.some((field) => field.kind === 'file') || sendsApplication(snapshot));
    if (snapshot.captcha) return await finish({ questions: [], documents: [], handoff: 'captcha_present' });
    if (!readableApplication) {
      // An account portal is allowed to expose only its sign-in/create-account
      // surface before the runner owns a portal account. That is not an
      // unreadable application: submitViaPortal will create/sign in to the
      // account and then reopen the job-bound form. Keep the pre-read
      // read-only and defer the auth gate instead of burning a draft retry.
      const authGate = ['workday', 'successfactors'].includes(channelType)
        && (['sign_in', 'create'].includes(authPageKind(snapshot)) || snapshot.passwordVisible === true);
      if (authGate) {
        (ctx.log || (() => {}))('portal pre-read deferred: account gate');
        return await finish({ questions: [], documents: [] });
      }
      return await finish({ questions: [], documents: [], handoff: 'application_form_unreadable' });
    }
    // The live form is authoritative for the selected posting. A verified
    // route is sufficient provenance for a generic ATS form; otherwise a
    // mismatch must stop before any job-specific question reaches the draft.
    if (hasJobContract) {
      // Keep the page title as a separate line. Some ATS accessibility text
      // starts with a skip-link preamble (for example Umantis' «Passa a
      // Contenuto principale»); flattening it into the first line makes the
      // employer-conflict guard mistake that chrome for another employer.
      const pageTitle = typeof page.title === 'function' ? await page.title().catch(() => '') : '';
      const formText = `${pageTitle}\n${snapshot.text || ''}\n${page.url()}`;
      const applicationEntry = sourcePostingMatched && opened.enteredThroughApplicationEntry === true;
      const formMatch = formPostingMatch(formText, ctx.job, {
        postingMatched: verifiedPostingEntry || applicationEntry,
        postingEntry: verifiedPostingEntry,
        applicationEntry,
        pageUrl: page.url(),
        postingUrl: formPostingUrl,
        postingRouteProof: ctx.postingRouteProof,
        applyUrl: ctx.applyUrl,
      });
      contractPostingMatch = formMatch === 'mismatch' ? 'mismatch' : formMatch === 'match' ? 'match' : 'unknown';
      if (formMatch === 'mismatch') return await finish({ questions: [], documents: [], handoff: 'posting_mismatch' }, { status: 'blocked' });
    }
    // A missing planner must not erase the technical preflight. The contract
    // still records the mounted form and its background traffic so the owner
    // sees whether the route was readable and what remains unknown.
    if (!ctx.codex) return await finish({ questions: [], documents: [], handoff: 'planner_unavailable' }, { status: 'unavailable' });
    let plan;
    try {
      plan = await planPage({ snapshot, candidate: ctx.candidate, candidateLocale: ctx.candidateLocale, codex: ctx.codex });
    } catch {
      (ctx.log || (() => {}))('portal pre-read skipped: question_planning_failed');
      return await finish({ questions: [], documents: [], handoff: 'question_planning_failed' });
    }
    const requirements = portalRequirementsFromMissingRequired(snapshot.fields, plan.missingRequired, {
      candidate: ctx.candidate,
      candidateLocale: ctx.candidateLocale,
    });
    if (requirements.unreadableFields?.length) {
      (ctx.log || (() => {}))('portal pre-read handoff: question_label_unreadable');
      return await finish({ ...requirements, questions: [], handoff: 'question_label_unreadable' });
    }
    const questions = await localizePortalQuestions(requirements.questions, {
      candidateLocale: ctx.candidateLocale,
      applicationLocale: ctx.language,
      codex: ctx.codex,
      log: ctx.log,
    });
    if (questions.some((question) => question.localizationStatus === 'fallback')) {
      // Preserve the native question and its fallback marker. The candidate
      // review page shows the original portal wording with a localization
      // warning, while this editable draft lets the owner record answers the
      // candidate already supplied. Submission still passes through the
      // candidate's normal review and approval gate.
      (ctx.log || (() => {}))('portal pre-read retained native questions for candidate review');
    }
    return await finish({ ...requirements, questions });
  } catch (error) {
    const handoff = error instanceof PortalQuestionLocalizationError
      ? 'question_localization_unavailable'
      : 'portal_reader_failed';
    // The class of the failure, never its message: a browser error can quote
    // the page or a value. Without it the 2026-11-10 failures were opaque
    // after the Actions log janitor ran.
    const readerError = portalReaderErrorClass(error);
    (ctx.log || (() => {}))(`portal pre-read skipped: ${handoff}`, readerError);
    return await finish({ questions: [], documents: [], handoff, readerError }, { status: 'unavailable' });
  } finally {
    if (contractDiagnostics && !contractFinished) {
      await contractDiagnostics.finish().catch(() => {});
      contractFinished = true;
    }
    await browser?.close().catch(() => {});
  }
}

/**
 * A fixed, non-personal class for a pre-read that threw: enough to tell a
 * blocked request from a timeout, a download (PDF) or a code fault, without
 * copying the browser's message (which can quote the page) anywhere.
 * @param {unknown} error
 * @returns {string}
 */
export function portalReaderErrorClass(error) {
  const message = String(error?.message || error || '');
  if (error?.name === 'TimeoutError' || /\bTimeout \d+ms exceeded\b/.test(message)) return 'timeout';
  if (/Download is starting/i.test(message)) return 'download';
  const net = message.match(/\bnet::(ERR_[A-Z_]+)/);
  if (net) return `net_${net[1].slice(4).toLowerCase()}`.slice(0, 40);
  if (/Target (?:page, context or browser|closed)|browser has been closed/i.test(message)) return 'browser_closed';
  if (/chromium|executable doesn't exist|install/i.test(message) && /launch|install/i.test(message)) return 'browser_launch';
  if (error instanceof ReferenceError || error instanceof TypeError) return 'code_error';
  return 'other';
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
 * @param {string} [ctx.cvText] the CV's text (draft.factSources.text): the decision engine checks its evidence against it
 * @param {{cv:string, cover_letter:string}} ctx.files local file paths
 * @param {Function} ctx.codex broker call
 * @param {Function} [ctx.launch] browser launcher (tests)
 * @param {boolean} [ctx.dryRun] fill every page but never press submit (nor create an account)
 * @param {Function} [ctx.onBeforeSubmit] called after the native form has been bound and immediately before
 *   the final submit click (`{ uploads, formBinding }`); the binding is a SHA-256 of the captured form contract
 * @param {Function} [ctx.onConfirmedNotSent] releases a portal validation that permits one safe retry
 * @param {Function} [ctx.onReceipt] durably records a positive portal receipt before later diagnostics run
 * @param {ReturnType<import('./account.mjs').portalAccountStore>} [ctx.accounts] the order's portal accounts; without it a login page is handed over
 * @returns {Promise<{event:object, evidence:object}>}
 */
// Stops on the posting page that an employer's regional gate produces:
// Yellowshark greys out its Apply control and keeps a consent banner on the
// gated page (order 1EpmkrDu, 2026-11-04/06: the 13 runs that got the notice
// stopped under four different reasons). handoff() reports them as the gate
// when the page states it.
const REGION_GATED_STOPS = new Set(['portal_control_click_unresolved', 'cookie_preferences_unresolved']);
// Stops that a posting closed meanwhile also produces: the page the portal shows after the registration or
// a navigation is its own «this job can no longer be applied for», which reads as another posting, as no
// application stage, or (with no form control left) as a page for the candidate. The closure is the cause
// (the flow notifies and refunds it), not a page to teach.
const CLOSURE_RECHECK_STOPS = new Set(['posting_mismatch', 'application_stage_unknown', 'portal_needs_candidate']);
const PORTAL_AUTH_FIELD_RE = /(?:login|sign[\s-]?in|username|user\s*id|password|account|anmeldung|connexion|identifiant|accedi|accesso)/iu;

function isApplicationOwnedPortalField(field) {
  const fieldIdentityText = [
    field?.label,
    field?.name,
    field?.id,
    field?.applicationQuestion,
  ].filter(Boolean).join(' ');
  const fieldContextText = [field?.context, field?.section].filter(Boolean).join(' ');
  const fieldText = `${fieldIdentityText} ${fieldContextText}`;
  if (field?.search === true || String(field?.inputType || '').toLowerCase() === 'search') return false;

  // A generic section such as «Application portal» cannot turn a Username or
  // other authentication control into an application-owned field.
  const authenticationField = PORTAL_AUTH_FIELD_RE.test(fieldIdentityText)
    || PORTAL_AUTH_FIELD_RE.test(fieldContextText);
  const explicitlyApplicationOwned = APPLICATION_CONTROL_RE.test(fieldIdentityText);
  if (authenticationField && !explicitlyApplicationOwned) return false;

  return explicitlyApplicationOwned
    || (!authenticationField && APPLICATION_CONTROL_RE.test(fieldContextText))
    || isCvFileField(field)
    || COVER_LETTER_DOCUMENT_CONTEXT_RE.test(fieldText)
    || (isFileField(field) && field.required === true)
    || (!authenticationField && APPLICATION_IDENTITY_FIELD_RE.test(fieldText));
}

export async function submitViaPortal(ctx) {
  const launch = ctx.launch || (() => launchPortalBrowser(ctx));
  const channelType = portalChannelType(ctx);
  const log = ctx.log || (() => {});
  // JOIN asks one question per page (e-mail, CV, details, links, permit, salary,
  // start date, the employer's own questions, review): 8 pages were not enough.
  const maxSteps = ctx.maxSteps || 15;
  const evidence = { steps: [], applyUrl: ctx.applyUrl };
  const registrationRestarts = new Set();
  let candidateRequestRound = Number.isInteger(Number(ctx.candidateRequestRound))
    ? Math.min(1000, Math.max(0, Number(ctx.candidateRequestRound))) : 0;
  const knownPortalQuestionKeys = new Set((Array.isArray(ctx.knownPortalQuestionKeys) ? ctx.knownPortalQuestionKeys : [])
    .map((key) => String(key || '').trim()).filter(Boolean).slice(0, 100));
  const candidateRequestTelemetryFor = (questions) => {
    const items = Array.isArray(questions) ? questions : [];
    const keys = items.map((question) => portalQuestionKey(question) || portalQuestionId(question)).filter(Boolean);
    const afterNewlyRevealedPortalFields = keys.some((key) => !knownPortalQuestionKeys.has(key));
    for (const key of keys) knownPortalQuestionKeys.add(key);
    candidateRequestRound = Math.min(1000, candidateRequestRound + 1);
    return {
      round: candidateRequestRound,
      questionCount: Math.min(20, items.length),
      afterNewlyRevealedPortalFields,
    };
  };
  const browser = await launch();
  let context = null;
  let page = null;
  let sourceProtocol = null;
  let diagnostics = null;
  let finalClickAttempt = null;
  let activeFinalFormGuard = null;
  const enteredFromMatchingPosting = verifiedPostingEntryFor(ctx);
  const clearActiveFinalFormGuard = async () => {
    if (!activeFinalFormGuard?.token) return;
    if (activeFinalFormGuard.frame?.evaluate) {
      await activeFinalFormGuard.frame.evaluate(clearFinalFormGuardInPage, activeFinalFormGuard.token).catch(() => {});
    } else if (activeFinalFormGuard.locator?.evaluate) {
      await activeFinalFormGuard.locator.evaluate(clearFinalFormGuardInPage, activeFinalFormGuard.token).catch(() => {});
    }
    activeFinalFormGuard = null;
  };
  // Some ATSes replace the file input with a non-file token after accepting
  // the upload. Keep that proof bound to the page URL so the stage guard can
  // still prove the same form owns the final Apply button.
  const uploadedCvUrls = new Set();
  // Pages where the run kept the CV an earlier run of the order left in the application's document slot.
  const keptCvUrls = new Set();
  const cvFileNames = documentPaths(ctx.files, 'cv').map((file) => path.basename(file));
  let accountRecoveryUsed = false;
  let recoveryMarkerUnreadable = false;
  let recoveredApplicationHistoryChecked = false;
  // Where the runner stopped, for whoever takes over (encrypted with the rest of the evidence).
  const handoff = async (reason, metadata = {}) => {
    // SuccessFactors, Stadt Zürich (run 42818412495): account created, then /portalcareer said «Diese Stelle
    // kann zurzeit nicht angezeigt werden … nicht länger darauf bewerben», and the run stopped as a mismatch.
    // The page in front of the runner is read with the same classifier as the posting at the start; only a
    // certain closure (isHardClosed) changes the outcome. Still-interactive forms are left as-is, and their
    // buttons and links are supplied as apply controls on pages without fields.
    if (CLOSURE_RECHECK_STOPS.has(reason) && page) {
      const currentSnapshot = await extractFields(page, NAVIGATION).catch(() => null);
      const formFields = Array.isArray(currentSnapshot?.fields) ? currentSnapshot.fields : [];
      const applicationFormVisible = formFields.some(isApplicationOwnedPortalField);
      if (!applicationFormVisible) {
        const applyControls = [
          ...(currentSnapshot?.buttons || []).map((button) => button.text || button.label || ''),
          ...(currentSnapshot?.links || []).map((link) => link.text || link.label || ''),
        ];
        const current = classifyLiveness({
          finalUrl: page.url(),
          bodyText: await pageText(page).catch(() => ''),
          applyControls,
          locale: ctx.language,
        });
        if (isHardClosed(current)) {
          evidence.livenessAtStop = { result: current.result, code: current.code, stop: reason };
          return { event: { type: 'posting_closed', reason: current.code }, evidence };
        }
      }
    }
    // A posting that refuses applications from this connection's region (the
    // employer geolocates the runner's IP) explains the stops on the posting
    // page that follow it: a dead Apply control, the gated page's consent
    // banner. Report the cause, which another runner can clear, not its symptom.
    if (REGION_GATED_STOPS.has(reason) && page && evidence.steps.length === 0
      && isApplicationRegionUnsupported(await pageText(page).catch(() => ''))) reason = 'application_region_unsupported';
    reason = portalHandoffReason(reason, {
      diagnostics: evidence.diagnostics,
      attempt: diagnostics?.currentAttempt(),
      finalClickAttempt,
    });
    if (page) {
      evidence.handoffScreenshot = (await page.screenshot({ fullPage: true }).catch(() => Buffer.from(''))).toString('base64');
      // What a fixer needs to teach the runner this page (level 3); a CAPTCHA
      // is no code fix, nor is a regional gate on the runner's IP (#17112 and
      // #17132 tried to click through it): the retry ladder owns that one.
      if (!['captcha', 'captcha_provider_unavailable', 'application_region_unsupported'].includes(reason)) {
        const seen = await extractFields(page, NAVIGATION).catch(() => null);
        evidence.stopReport = stopReportFrom({ url: page.url(), reason, step: evidence.steps.length, seen, agent: evidence.steps.at(-1)?.agent || [], readback: metadata.valueShapes || [] });
      }
    }
    const failure = serializeAccountFailure(metadata.accountFailure);
    return { event: { type: 'submit_handoff', reason, ...(failure ? { accountFailure: failure } : {}) }, evidence };
  };
  const holdRecoveredDuplicateApplication = async (view) => {
    if (!accountRecoveryUsed && typeof ctx.accounts?.load === 'function') {
      try {
        const host = new URL(page.url()).hostname;
        const storedAccount = await ctx.accounts.load(host);
        if (storedAccount?.recoveryApplicationCheckRequired === true) accountRecoveryUsed = true;
      } catch {
        accountRecoveryUsed = true;
        recoveryMarkerUnreadable = true;
      }
    }
    if (!accountRecoveryUsed) return null;
    // Reset or account verification can return to an authentication form
    // before Workday has established the candidate session. Let the normal
    // sign-in path finish first; history must be read from the account itself.
    if (authPageKind(view) !== 'none' || codeField(view)) return null;
    if (recoveryMarkerUnreadable) {
      evidence.accountRecovery = { applicationCheck: {
        status: 'uncertain_application_history', matchedBy: 'recovery_state_unreadable',
      } };
      return handoff('account_application_history_uncertain');
    }
    const visibleFinding = accountApplicationDuplicate(view);
    if (visibleFinding?.status === 'already_applied') {
      evidence.accountRecovery = { applicationCheck: visibleFinding };
      return handoff('account_application_already_applied');
    }
    if (recoveredApplicationHistoryChecked) return null;

    let historyView = view;
    const currentUrl = page.url();
    let current;
    try { current = new URL(currentUrl); } catch { current = null; }
    if (!current || current.protocol !== 'https:' || current.username || current.password) {
      const finding = { status: 'uncertain_application_history', matchedBy: 'untrusted_current_route' };
      evidence.accountRecovery = { applicationCheck: finding };
      return handoff('account_application_history_uncertain');
    }

    if (!isApplicationHistoryPage(view)) {
      const historyLink = (view?.links || []).find((link) => APPLICATION_HISTORY_RE.test(
        `${link?.text || ''} ${link?.label || ''} ${link?.ariaLabel || ''} ${link?.title || ''}`,
      ) && Number(link?.frame || 0) === 0 && typeof link?.href === 'string'
        && /^[\w-]{1,80}$/.test(String(link.id || '')));
      let historyTarget = null;
      try {
        if (historyLink) historyTarget = new URL(historyLink.href, current);
      } catch {
        historyTarget = null;
      }
      if (!historyTarget || historyTarget.protocol !== 'https:' || historyTarget.origin !== current.origin
        || historyTarget.username || historyTarget.password) {
        const finding = { status: 'uncertain_application_history', matchedBy: 'history_unavailable' };
        evidence.accountRecovery = { applicationCheck: finding };
        return handoff('account_application_history_uncertain');
      }
      try {
        await page.goto(historyTarget.href, { waitUntil: 'domcontentloaded', timeout: 60_000 });
        await settle(page);
        historyView = await extractFields(page, NAVIGATION);
      } catch {
        const finding = { status: 'uncertain_application_history', matchedBy: 'history_unreadable' };
        evidence.accountRecovery = { applicationCheck: finding };
        return handoff('account_application_history_uncertain');
      }
    }

    const finding = accountApplicationDuplicate(historyView);
    if (finding?.status === 'already_applied') {
      evidence.accountRecovery = { applicationCheck: finding };
      return handoff('account_application_already_applied');
    }
    if (finding?.status !== 'no_application_found') {
      evidence.accountRecovery = { applicationCheck: finding || {
        status: 'uncertain_application_history', matchedBy: 'history_unreadable',
      } };
      return handoff('account_application_history_uncertain');
    }

    recoveredApplicationHistoryChecked = true;
    if (page.url() !== currentUrl) {
      try {
        await page.goto(currentUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
        await settle(page);
        Object.assign(view, await extractFields(page, NAVIGATION));
      } catch {
        recoveredApplicationHistoryChecked = false;
        evidence.accountRecovery = { applicationCheck: {
          status: 'uncertain_application_history', matchedBy: 'return_to_posting_failed',
        } };
        return handoff('account_application_history_uncertain');
      }
    }
    evidence.accountRecovery = { applicationCheck: finding };
    return null;
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
  const controlsFor = async (current, known) => {
    const uploadedCv = uploadedCvUrls.has(uploadedCvPageKey(page.url()))
      || earlierCvHeld(current.buttons, cvFileNames, keptCvUrls.has(page.url()));
    const snapshot = { ...current, text: await pageText(page), uploadedCv };
    const controls = pageControls(current.buttons, known, page.url(), { snapshot, applyUrl: ctx.applyUrl, sourceProtocol, postingEntry: enteredFromMatchingPosting, job: ctx.job });
    if (controls.stage) {
      const stageEvidence = { kind: controls.stage.kind, ...(controls.stage.destination ? { destination: controls.stage.destination } : {}) };
      const lastStep = evidence.steps.at(-1);
      if (lastStep) lastStep.applicationStage = stageEvidence;
      else evidence.steps.push({ url: page.url(), applicationStage: stageEvidence });
    }
    return controls;
  };
  const confirmedReceipt = async (current) => {
    const snapshot = { ...current, text: await pageText(page) };
    const stage = applicationStage(snapshot, { applyUrl: ctx.applyUrl, sourceProtocol, postingEntry: enteredFromMatchingPosting, job: ctx.job, url: page.url() });
    if (stage.kind !== 'receipt') return null;
    const lastStep = evidence.steps.at(-1);
    if (lastStep) lastStep.applicationStage = { kind: 'receipt' };
    else evidence.steps.push({ url: page.url(), applicationStage: { kind: 'receipt' } });
    evidence.finalOutcomes = [...(evidence.finalOutcomes || []), 'confirmed'];
    evidence.finalUrl = page.url();
    evidence.afterSubmit = (await page.screenshot({ fullPage: true }).catch(() => Buffer.from(''))).toString('base64');
    return { event: { type: 'submit_succeeded', channel: 'portal' }, evidence };
  };
  // Step buttons the agent named in this run, with their page: learned only once the portal confirms.
  const namedNext = [];
  // The agentic fallback for a cookie manager the deterministic passes could
  // not close (resolveCookieConsent): once per page, COOKIE_AGENT_MAX_PAGES per
  // run, without candidate data. It may press only the manager's own controls:
  // apply, sign-in, registration, navigation and submit stay reserved.
  const cookieAgentPages = new Set();
  const cookieAgent = ctx.codex ? async (currentPage, current) => {
    const startUrl = currentPage.url();
    if (cookieAgentPages.has(startUrl) || cookieAgentPages.size >= COOKIE_AGENT_MAX_PAGES) return { status: 'budget', acted: false };
    cookieAgentPages.add(startUrl);
    let agent;
    try {
      agent = await completeWithAgent({
        page: currentPage,
        hint: 'cookie_preferences_unresolved',
        candidate: {},
        candidateLocale: ctx.candidateLocale,
        codex: ctx.codex,
        fields: current?.fields || [],
        maxRounds: COOKIE_AGENT_ROUNDS,
        reservedButtons: COOKIE_AGENT_RESERVED_BUTTONS,
        log,
      });
    } catch (error) {
      agent = { status: 'stuck', reason: `agent_error: ${String(error?.message || error).split('\n')[0].slice(0, 120)}`, evidence: { rounds: [] } };
    }
    const acted = (agent.evidence?.rounds || []).some((round) => (round.actions || []).some((action) => action.ok));
    (evidence.cookieAgent ||= []).push({
      status: agent.status,
      acted,
      rounds: (agent.evidence?.rounds || []).length,
      ...(agent.reason ? { reason: String(agent.reason).slice(0, 160) } : {}),
    });
    // A cookie choice never leaves the page: whatever moved it is not counted.
    if (agent.moved || currentPage.url() !== startUrl) return { status: 'moved', acted: false };
    return { status: agent.status, acted };
  } : null;
  try {
    context = await browser.newContext(portalContextOptions(ctx));
    registerPortalChannelType(context, channelType);
    await registerCookieSessionRecovery(context, { log: ctx.log });
    // Playwright contexts always expose addInitScript. Keep the adapter
    // boundary tolerant for the deterministic portal harness, whose minimal
    // context cannot execute page init scripts but still exercises the
    // read/plan/answer contract without a final submit.
    if (typeof context.addInitScript === 'function') await context.addInitScript(installFinalFormGuardCaptureInPage);
    diagnostics = startPortalDiagnostics(context, (evidence.submitHttpFailures = []));
    evidence.diagnostics = diagnostics.data;
    await diagnostics.installFetchObserver().catch(() => { evidence.diagnostics.fetchObserverUnavailable = true; });
    page = await context.newPage();
    // Which browser the portal saw (the run's logs are deleted): headed on the
    // virtual screen or headless, and the user agent it sent.
    evidence.browser = { headed: headedBrowser(), engine: 'chromium', userAgent: await page.evaluate(() => navigator.userAgent).catch(() => '') };
    const entryUrl = portalEntryUrl(ctx);
    await diagnostics.beginAttempt();
    const response = await page.goto(entryUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await settle(page);
    let snapshot = await extractFields(page, NAVIGATION);
    sourceProtocol = snapshot.protocol || null;
    // Consent dialogs can put their own heading before a vacancy in the
    // rendered text. Resolve the explicit cookie choice before checking that
    // the selected posting is the page the browser actually opened; the
    // vacancy and employer checks below remain unchanged after the overlay is
    // gone.
    const initialCookieState = await resolveCookieConsent(page, snapshot, { agent: cookieAgent });
    evidence.cookieConsent = {
      status: initialCookieState.status,
      attempts: initialCookieState.attempts,
      ...(initialCookieState.agent ? { agent: initialCookieState.agent } : {}),
    };
    snapshot = initialCookieState.snapshot || snapshot;
    sourceProtocol = snapshot.protocol || sourceProtocol;
    if (sourceProtocol) evidence.sourceProtocol = sourceProtocol;
    if (initialCookieState.status === 'unresolved') return await handoff('cookie_preferences_unresolved');
    const initialPageText = await pageText(page);
    // The posting as a browser renders it (career-ops liveness-browser): the
    // fetch before the run sees only the empty shell of a JavaScript portal.
    const rendered = classifyLiveness({
      status: response?.status() || 0,
      requestedUrl: entryUrl,
      finalUrl: page.url(),
      bodyText: initialPageText,
      applyControls: snapshot.buttons.map((button) => button.text || button.label || ''),
      locale: ctx.language,
    });
    evidence.liveness = { result: rendered.result, code: rendered.code };
    if (isHardClosed(rendered)) return { event: { type: 'posting_closed', reason: rendered.code }, evidence };
    const initialHandoff = initialPortalHandoffReason({ snapshot, liveness: rendered });
    if (initialHandoff) return await handoff(initialHandoff);
    // The posting itself, before its apply button: where the company is read
    // when the form behind the button names only the role (formPostingMatch).
    let postingUrl = page.url();
    const initialPublicJobSearch = isStadtZurichPublicJobSearchRoute(postingUrl)
      && isNonApplicationJobSearchSurface(snapshot);
    const postingTitle = typeof page.title === 'function' ? await page.title().catch(() => '') : '';
    const postingSeen = `${postingTitle} ${initialPageText} ${postingUrl}`;
    const initialApplicationEntryProven = applicationEntryControls(snapshot, {
      applyUrl: ctx.applyUrl,
      postingUrl: ctx.postingUrl || postingUrl,
      pageTitle: postingTitle,
      sourceProtocol,
      postingRouteProof: ctx.postingRouteProof,
      job: ctx.job,
      allowSingleExternalApplicationEntry: true,
    }).length === 1;
    const initialJobRoomEntryProven = jobRoomExternalApplicationEntryProven(snapshot, {
      applyUrl: ctx.applyUrl,
      postingUrl: ctx.postingUrl || postingUrl,
      allowSingleExternalApplicationEntry: true,
    });
    // The posting's own data (its ATS's answer for this very address, posting-liveness.mjs) may name the
    // employer where the page shows only a brand: Workday's page for «Rituals Cosmetics Switzerland» says
    // «Rituals», its data «Rituals Cosmetics Germany GmbH». One employer's two entities, and the role on
    // the page: the posting is the order's.
    const companyNamed = postingMatch(postingSeen, ctx.job, postingUrl) === 'match';
    const organizationCompatible = !ctx.job?.company || !ctx.job?.organization
      || sameEmployerFamily(ctx.job.organization, ctx.job.company);
    // The posting may use a brand while the order carries a legal entity, but
    // two unrelated employer names are a source-data conflict, not permission
    // to fall back to the role alone on an otherwise silent ATS form.
    if (companyNamed && !organizationCompatible) return await handoff('posting_mismatch');
    const namedByItsData = organizationCompatible
      && sameEmployerFamily(ctx.job?.organization, ctx.job?.company)
      && postingMatch(postingSeen, { title: ctx.job.title }, postingUrl) === 'match';
    // A posting published as a document is read as a document; the employer's
    // page that hosts it, the order's apply page, then stands for the posting.
    const postingDocument = enteredFromMatchingPosting ? null : await postingDocumentHostMatch(snapshot, ctx, postingUrl);
    if (postingDocument) evidence.postingDocument = postingDocument;
    const postingDocumentHost = postingDocument?.identity === true;
    // Every later reopening of the form (after a sign-in, a reload) enters again from the same host page.
    const documentHostContext = postingDocumentHost ? { postingDocumentHost: true, postingDocumentHostUrl: postingUrl } : {};
    // A verified apply/posting URL pair is stronger than the title of a thin
    // shell, which may still show a stale or generic role while it mounts.
    // Workday's own job route carries the requisition in its `_R-...` slug.
    // When the order opens that exact route and its single Apply control is
    // bound to it, the route is vacancy evidence even if the page omits the
    // employer and uses a localized role title.
    const workdayRouteEntryProven = initialApplicationEntryProven
      && sameWorkdayJobRoute(workdayJobRoute(ctx.applyUrl), workdayJobRoute(postingUrl));
    let postingVacancyMatched = enteredFromMatchingPosting || postingDocumentHost || workdayRouteEntryProven || initialJobRoomEntryProven
      || hasVacancySpecificPostingEvidence(initialPageText, ctx.job, {
        pageUrl: postingUrl,
        pageTitle: postingTitle,
        pageHeading: await postingMainHeading(page),
        postingUrl: ctx.postingUrl,
        postingRouteProof: ctx.postingRouteProof,
        vacancyIdentityContexts: currentVacancyIdentityContexts(snapshot),
        uniqueApplicationEntryProven: initialApplicationEntryProven,
      });
    // When the selected posting URL is the page currently open, a failed
    // vacancy-identity check is terminal. Do not let a company-only match on
    // the same page turn a stale role into an application form.
    if (ctx.postingUrl && samePostingAddress(postingUrl, ctx.postingUrl)
      && !postingVacancyMatched && !initialPublicJobSearch) {
      return await handoff('posting_mismatch');
    }
    if (postingVacancyMatched && isApplicationRegionUnsupported(initialPageText)
      && !hasApplicationEntryControl(snapshot, {
        applyUrl: ctx.applyUrl, postingUrl, sourceProtocol, job: ctx.job,
        pageTitle: postingTitle,
        postingRouteProof: ctx.postingRouteProof,
        allowSingleExternalApplicationEntry: postingVacancyMatched,
      })) {
      return await handoff('application_region_unsupported');
    }
    const opened = await openApplicationForm(context, page, snapshot, {
      applyUrl: ctx.applyUrl, postingUrl: ctx.postingUrl || postingUrl, sourceProtocol,
      pageTitle: postingTitle,
      postingEntry: enteredFromMatchingPosting, postingRouteProof: ctx.postingRouteProof, job: ctx.job,
      allowSingleExternalApplicationEntry: postingVacancyMatched,
      ...documentHostContext,
      onPortalNavigationDiagnostic: ctx.onPortalNavigationDiagnostic,
      cookieAgent,
    });
    ({ page, snapshot } = opened);
    if (opened.resolvedPostingUrl) {
      postingUrl = opened.resolvedPostingUrl;
      postingVacancyMatched = true;
    }
    let enteredThroughApplicationEntry = opened.enteredThroughApplicationEntry === true;
    if (opened.handoff) return await handoff(opened.handoff);
    const initialReceipt = await confirmedReceipt(snapshot);
    if (initialReceipt) return initialReceipt;
    if (needsPortalOptionRead(snapshot)) snapshot = await extractFields(page);
    const formHandoff = initialPortalHandoffReason({ snapshot });
    if (formHandoff) return await handoff(formHandoff);
    // The form must be the posting's: an address that lands on a list of jobs
    // with a "Bewerben" must not apply to another one. Valerie's retry, after
    // she looked at the screenshot, goes on.
    const formMatch = async () => {
      const pageUrl = page.url();
      const seen = `${await page.title().catch(() => '')}\n${await pageText(page)}\n${pageUrl}`;
      const result = formPostingMatch(seen, ctx.job, {
        postingMatched: enteredFromMatchingPosting || (postingVacancyMatched && page.url() !== postingUrl),
        postingEntry: enteredFromMatchingPosting,
        applicationEntry: postingVacancyMatched && enteredThroughApplicationEntry,
        pageUrl,
        postingUrl,
        postingRouteProof: ctx.postingRouteProof,
        applyUrl: ctx.applyUrl,
      });
      // Said in the evidence: the company was read on the posting (or in its data), the form names only the role.
      if (result === 'match' && postingMatch(seen, ctx.job, pageUrl) === 'mismatch') {
        evidence.postingMatchVia = successFactorsRequisitionShown(seen, ctx.job, { pageUrl, applyUrl: ctx.applyUrl }) ? 'successfactors_requisition'
          : namedByItsData ? 'posting_data' : 'posting_page';
      }
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
    const initialOtpAccount = await pendingOtpAccount(snapshot);
    // A generic careers landing page can mention the employer and therefore
    // pass postingMatch, while exposing only the site's Menu/Search controls.
    // Do not send that chrome to the agent as if it were an unanswered
    // candidate question; it is not the application form for this posting.
    // No recognizable form or control is not evidence that the runner reached
    // the selected vacancy: keep it as a posting mismatch until the owner can
    // inspect the page, rather than presenting a loading shell as a candidate
    // question.
    if (!hasApplicationSurface(snapshot, {
      pageUrl: page.url(),
      postingUrl,
      postingMatch: match,
    }) && !ctx.skipPostingCheck) return await handoff('posting_mismatch');
    // A sign-in page often names neither the company nor the role
    // (SuccessFactors, Coop 2026-10-02): the check waits for the form behind it.
    // An application form with its own password field is the form: checked now.
    let postingCheckPending = match === 'mismatch'
      && (snapshot.passwordVisible || initialOtpAccount)
      && !ownAccountForm(snapshot, channelType)
      && !ctx.skipPostingCheck;
    if (match === 'mismatch' && !postingCheckPending && !ctx.skipPostingCheck) return await handoff('posting_mismatch');
    let validationRetries = 0;
    let reviewAdvances = 0;
    let stuckOnPage = 0;
    let authSteps = 0;
    const recoveryAttempts = new Set();
    // The passwords this run typed into application forms that create their own account, by host.
    const ownPasswords = new Map();
    const uploaded = new Set();
    const uploadedNativeControls = new Set();
    const uploadedNativeCvFields = new Set();
    // Exclude this run's selections from prior-file cleanup checks; upload retry
    // suppression remains field-scoped in `uploaded`.
    const selectedDocumentsThisRun = new Set();
    const selectedUploadFieldsThisRun = new Map();
    const privacyAcceptedPages = new Set();
    // Bounded redraw recovery follows the logical wizard page, not the URL or
    // the loop counter (portals often keep one address for every SPA step).
    let pageEpoch = 0;
    const nativeCvFieldKey = (field) => {
      const identity = portalUploadStableControlKey(field);
      return identity ? `${pageEpoch}|${identity}` : '';
    };
    const uploadKeyForField = (fieldId, fields, url = page.url(), epoch = pageEpoch) => {
      const field = fields.find((item) => item.id === fieldId) || { id: fieldId };
      const baseKey = uploadedPortalFieldKey(`${url}|step:${epoch}`, { id: portalUploadFieldIdentity(field) });
      const fileFields = fields.filter(isFileField);
      const matchingFields = fileFields.filter((item) => portalUploadFieldIdentity(item) === portalUploadFieldIdentity(field));
      const records = selectedUploadFieldsThisRun.get(baseKey) || [];
      return portalUploadActionKey(url, epoch, field, matchingFields, records);
    };
    const rememberUploadSelection = (fieldId, fields, url = page.url(), epoch = pageEpoch) => {
      const field = fields.find((item) => item.id === fieldId) || { id: fieldId };
      const baseKey = uploadedPortalFieldKey(`${url}|step:${epoch}`, { id: portalUploadFieldIdentity(field) });
      const fileFields = fields.filter(isFileField);
      const matchingFields = fileFields.filter((item) => portalUploadFieldIdentity(item) === portalUploadFieldIdentity(field));
      const groupIndex = matchingFields.findIndex((item) => item.id === field.id);
      const records = selectedUploadFieldsThisRun.get(baseKey) || [];
      const key = portalUploadActionKey(url, epoch, field, matchingFields, records);
      if (key === null) return null;
      if (!records.some((item) => item.key === key || item.fieldId === field.id)) {
        records.push({ key, fieldId: field.id, domId: field.domId || '', groupIndex, groupSize: matchingFields.length });
        selectedUploadFieldsThisRun.set(baseKey, records);
      }
      return key;
    };
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
    // Semantic answers for planner retries (career-ops application-answers):
    // checkbox markers are never treated as candidate answers. The last answer wins.
    const given = new Map();
    // Human-readable evidence keeps the action as it appeared in the form (✓/✗).
    const evidenceGiven = new Map();
    evidence.answers = [];
    // What went into the form's file fields, for the record of what left (submit.mjs `sent`): slots and counts only.
    evidence.uploads = [];
    const noteUpload = (document, files = 1) => {
      if (!document) return;
      const name = String(document);
      evidence.uploads.push({ document: name, files: Number(files) || 1 });
    };
    const record = (question, answer, source, context = '', section = '', autocomplete = '', metadata = {}, plannerAnswer = undefined) => {
      if (!question || !String(answer ?? '').trim()) return;
      const label = String(question).slice(0, 200);
      const surrounding = String(context || '').slice(0, 240);
      const heading = String(section || '').slice(0, 240);
      const fieldAutocomplete = String(autocomplete || '').slice(0, 100);
      const item = { question: label, context: surrounding, section: heading, autocomplete: fieldAutocomplete, ...addressMetadata(metadata) };
      const key = portalQuestionKey(item) || portalQuestionId(item) || label;
      const recordedAnswer = {
        question: label,
        ...addressMetadata(metadata),
        answer: String(answer).slice(0, 2000),
        source: source || '',
        ...(surrounding ? { context: surrounding } : {}),
        ...(heading ? { section: heading } : {}),
        ...(fieldAutocomplete ? { autocomplete: fieldAutocomplete } : {}),
      };
      evidenceGiven.set(key, recordedAnswer);
      if (plannerAnswer === undefined) given.set(key, recordedAnswer);
      else {
        const semanticAnswer = String(plannerAnswer ?? '').trim();
        if (semanticAnswer) given.set(key, { ...recordedAnswer, answer: semanticAnswer.slice(0, 2000) });
        else given.delete(key);
      }
      evidence.answers = [...evidenceGiven.values()].slice(0, 80);
    };
    const candidateWithRecordedAnswers = (candidate, current) => {
      const answerKey = (item) => portalQuestionKey(item) || portalQuestionId(item);
      const isHeldPermitQuestion = (question) => isPermitField(question) && asksHeldStatus(question);
      // A held-permit value recorded during this run describes a runner form
      // action, not a separate candidate portal response. Keep it in run
      // evidence, but do not present it as an answered portal question.
      // The evidence log represents checkbox actions as ✓/✗. Those marks are
      // display-only, not candidate answers; including them beside an explicit
      // Yes/No answer makes the consent matcher treat the candidate's answer
      // as conflicting on the next planner pass. `visibleAnswers` below
      // reconstructs a checkbox answer only when it matches candidate data.
      const recorded = [...given.values()].filter((item) => !isHeldPermitQuestion(item.question)
        && !['✓', '✗'].includes(String(item.answer || '').trim()));
      const recordedKeys = new Set(recorded.map(answerKey));
      const fold = (value) => String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
      const isPhoneCode = (field) => /\b(?:country\s+phone\s+code|phone\s+code|country\s+code|dial(?:ing)?\s+code|indicativo|vorwahl|prefisso)\b/i.test(String(field?.label || ''));
      const visibleAnswers = (current?.fields || [])
        .filter((field) => field.inputType !== 'password' && field.kind !== 'file' && field.inputType !== 'file' && holdsValue(field))
        .map((field) => {
          const answer = field.kind === 'checkbox' ? (field.checked ? 'Yes' : '') : String(field.value ?? '').trim();
          // A portal's held-status prefill is never the candidate's statement.
          // Their confirmed answer remains in the candidate record itself.
          if (isHeldPermitQuestion(field.label)) return null;
          // A portal may prefill a default country or phone code before the
          // planner sees the form. Keep an explicit candidate fact above that
          // default; phone-code defaults are never candidate answers.
          const candidateAnswer = candidateAnswerForField(candidate, field, {
            includeProfileWorkPermit: !(isPermitField(field.label) && asksHeldStatus(field.label)),
          })?.value || '';
          if (addressAnswerNeedsOwnership(field.label, field) || isPhoneCode(field)
            || !candidateAnswer || fold(candidateAnswer) !== fold(answer)) return null;
          return {
            question: String(field.label || field.name || field.id || '').slice(0, 200),
            answer,
            context: String(field.context || '').slice(0, 240),
            section: String(field.section || '').slice(0, 240),
            autocomplete: String(field.autocomplete || '').slice(0, 100),
            ...addressMetadata(field),
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
    const runAgent = async (current, hint, { secrets = [], reservedButtons = [] } = {}) => {
      const key = `${pageSignature(page, current)}|${hint}`;
      if (!ctx.codex || agentTried.has(key) || agentCalls >= MAX_AGENT_CALLS) return null;
      agentTried.add(key);
      let agent;
      try {
        agent = await completeWithAgent({
          page,
          hint,
          fields: current.fields || [],
          errors: current.errors || [],
          candidate: candidateWithRecordedAnswers(ctx.candidate, current),
          candidateLocale: ctx.candidateLocale,
          codex: ctx.codex,
          files: ctx.files,
          secrets: [...ownPasswords.values(), ...secrets],
          maxRounds: Math.min(AGENT_ROUNDS, MAX_AGENT_CALLS - agentCalls),
          reservedButtons,
          log,
        });
      } catch (error) {
        // The fallback is optional: whatever it throws ends in the usual handoff, never a failed run.
        agent = { status: 'stuck', reason: `agent_error: ${String(error?.message || error).split('\n')[0].slice(0, 120)}`, calls: 1, evidence: { hint, rounds: [] } };
      }
      agentCalls += agent.calls;
      (evidence.steps.at(-1).agent ||= []).push({ ...agent.evidence, status: agent.status, ...(agent.reason ? { reason: agent.reason } : {}) });
      for (const item of agent.answers || []) record(item.question, item.answer, item.source, item.context, item.section, item.autocomplete, item);
      for (const item of (agent.evidence?.rounds || []).flatMap((round) => round.actions || [])) {
        if (item.action === 'upload' && item.ok) noteUpload(item.document, item.files);
      }
      return agent;
    };
    // Polling and control discovery deliberately use NAVIGATION, which does
    // not open lazy listboxes. Restore that catalogue at the planning boundary
    // so a readable SuccessFactors picklist is not downgraded to an unreadable
    // question merely because the stable-surface poll omitted its options.
    const snapshotWithPortalOptions = async (current) => {
      if (!needsPortalOptionRead(current)) return current;
      const refreshed = await extractFields(page).catch(() => null);
      if (!refreshed) return current;
      // Keep the navigation snapshot's field set. A full extraction can reveal
      // unrelated required controls and must not add them to this candidate
      // request; it only supplies the lazy catalogue for controls already in
      // the current planning surface.
      return mergePortalChoiceOptions(current, refreshed);
    };
    // The questions the decision engine already decided or left in this run: each is tried once.
    const engineTried = new Set();
    const askCandidate = async (questions, current = snapshot, { decide = false } = {}) => {
      const questionSnapshot = await snapshotWithPortalOptions(current);
      const requirements = portalRequirementsFromMissingRequired(questionSnapshot.fields, questions, {
        candidate: ctx.candidate,
        candidateLocale: ctx.candidateLocale,
      });
      if (requirements.unreadableFields?.length) return await handoff('question_label_unreadable');
      // What can be answered is answered before anything is translated for the candidate (owner mandate
      // 2026-11-10; Damiani rg82P9MP stopped on question_localization_unavailable with the decision engine never
      // run, because it ran after the translation and a failed translation ended the page). The rules and the
      // CV already answered in guardPlan; here the decision engine decides, over the portal's own wording, what
      // they leave, and the page is planned again so the planner fills it. Only what it leaves
      // (CANDIDATE_ONLY_CATEGORIES, failed checks) is translated and reaches the candidate.
      if (decide) {
        const fresh = (requirements.questions || []).filter((question) => !engineTried.has(portalQuestionKey(question) || question.id));
        for (const question of fresh) engineTried.add(portalQuestionKey(question) || question.id);
        const engine = fresh.length
          ? await decideLiveQuestions({ questions: fresh, candidate: ctx.candidate, codex: ctx.codex, cvText: ctx.cvText, log })
          : { ids: [], decisions: [] };
        if (engine.decisions.length) (evidence.steps.at(-1).decisions ||= []).push(...engine.decisions);
        if (engine.ids.length) {
          const facts = ctx.candidate.platformFacts;
          facts.decisionAnswers = { ...(facts.decisionAnswers || {}), ...engine.decided };
          log(`decision engine: ${engine.ids.length} of ${fresh.length} questions decided, planning again`);
          return { replan: true };
        }
      }
      let request;
      try {
        request = await portalRequirementsForCandidate(requirements, {
          candidateLocale: ctx.candidateLocale, applicationLocale: ctx.language, codex: ctx.codex, log,
        });
      } catch (error) {
        if (error?.code === 'portal_question_localization_unavailable') {
          return await handoff('question_localization_unavailable');
        }
        throw error;
      }
      if (!request) return null;
      if (request.handoff) return await handoff(request.handoff);
      return {
        event: {
          type: 'submit_needs_candidate',
          ...request,
          candidateRequestTelemetry: candidateRequestTelemetryFor(request.questions),
        },
        evidence,
      };
    };

    // Passwords handleAuth typed in this run (generated or stored): struck from the agent's snapshot.
    const authSecrets = new Set();
    const authAgentTried = new Set();
    /**
     * The agentic fallback on an account page that stopped on a technical stop. It never presses an
     * account button (AUTH_AGENT_RESERVED_BUTTONS) nor types a password (agent.mjs refuses both);
     * what the candidate data does not say becomes a candidate question (askCandidate). On the same,
     * stable account page it hands back to handleAuth, whose guards decide the click.
     * @returns {Promise<{status:string, auth?:object, request?:object}>}
     */
    const recoverAuthWithAgent = async (stopped) => {
      const startUrl = page.url();
      const current = await extractFields(page, NAVIGATION).catch(() => null);
      if (!current || !current.passwordVisible || !['create', 'sign_in'].includes(authPageKind(current))) return { status: 'not_account_page' };
      const key = `${startUrl}|${authPageKind(current)}|${stopped.authStop}`;
      if (authAgentTried.has(key)) return { status: 'already_tried' };
      authAgentTried.add(key);
      const agent = await runAgent(current, authPageKind(current) === 'sign_in' ? 'sign_in_incomplete' : 'registration_incomplete', {
        secrets: [...authSecrets],
        reservedButtons: AUTH_AGENT_RESERVED_BUTTONS,
      });
      if (!agent) return { status: 'unavailable' };
      if (agent.status === 'needs_candidate') {
        const request = await askCandidate(agent.questions, current);
        return request ? { status: agent.status, request } : { status: agent.status };
      }
      const acted = (agent.evidence?.rounds || []).some((round) => (round.actions || []).some((action) => action.ok));
      if (agent.status === 'unavailable' || (agent.status !== 'done' && !acted)) return { status: agent.status };
      // The agent may not leave the page: whatever it pressed that moved it is not retried here.
      if (agent.moved || page.url() !== startUrl) return { status: 'moved' };
      const stable = await waitForStableQuestionSurface(page, current, startUrl, { registration: true });
      if (stable.status !== 'stable' || !stable.snapshot.passwordVisible || authPageKind(stable.snapshot) !== authPageKind(current)) {
        return { status: agent.status };
      }
      const auth = await handleAuth({ page, snapshot: stable.snapshot, ctx, diagnostics, typedSecrets: authSecrets, registrationRestarts, recoveryAttempts });
      return { status: agent.status, auth };
    };

    let loopAttemptStarted = false;
    for (let step = 1; step <= maxSteps; step += 1) {
      if (loopAttemptStarted) await diagnostics?.beginAttempt();
      else loopAttemptStarted = true;
      const existingReceipt = await confirmedReceipt(snapshot);
      if (existingReceipt) return existingReceipt;
      const currentStage = applicationStage({ ...snapshot, text: await pageText(page) }, {
        applyUrl: ctx.applyUrl, sourceProtocol, postingEntry: enteredFromMatchingPosting, job: ctx.job, url: page.url(),
      });
      if (currentStage.kind === 'posting_mismatch') return await handoff('posting_mismatch');
      evidence.steps.push({ step, url: page.url(), fields: snapshot.fields.length, errors: snapshot.errors || [] });
      log(`portal step ${step}: ${snapshot.fields.length} fields`);
      if (snapshot.captcha) return await handoff('captcha');
      const observedReceipt = await confirmedReceipt(snapshot);
      if (observedReceipt) return observedReceipt;
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
        if (++authSteps > MAX_AUTH_STEPS) return await handoff('account_verification', { accountFailure: accountFailure('auth_steps_exhausted', 'verification') });
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
        if (auth.handoff) return await handoff(auth.handoff, { accountFailure: auth.accountFailure, valueShapes: auth.valueShapes });
        snapshot = auth.snapshot;
        if (auth.reopen && !hasApplicationForm(snapshot) && !findButton(snapshot.buttons, NEXT_RE) && !findButton(snapshot.buttons, SUBMIT_RE)) {
          await page.goto(entryUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
          await settle(page);
          const reopened = await openApplicationForm(context, page, await extractFields(page, NAVIGATION), {
            applyUrl: ctx.applyUrl, postingUrl: ctx.postingUrl || postingUrl, sourceProtocol,
            postingEntry: enteredFromMatchingPosting, postingRouteProof: ctx.postingRouteProof, job: ctx.job,
            allowSingleExternalApplicationEntry: postingVacancyMatched,
            ...documentHostContext,
            onPortalNavigationDiagnostic: ctx.onPortalNavigationDiagnostic,
            cookieAgent,
          });
          ({ page, snapshot } = reopened);
          if (reopened.resolvedPostingUrl) {
            postingUrl = reopened.resolvedPostingUrl;
            postingVacancyMatched = true;
          }
          enteredThroughApplicationEntry = enteredThroughApplicationEntry || reopened.enteredThroughApplicationEntry === true;
          if (reopened.handoff) return await handoff(reopened.handoff);
          snapshot = await extractFields(page);
        }
        step -= 1;
        continue;
      }
      // Closed sections opened, and the CV put in a dialog's file input (openFormSections).
      const openSections = async () => {
        const stage = applicationStage({ ...snapshot, text: await pageText(page) }, {
          applyUrl: ctx.applyUrl, sourceProtocol, postingEntry: enteredFromMatchingPosting, job: ctx.job, url: page.url(),
        });
        if (stage.kind === 'posting_mismatch') return await handoff('posting_mismatch');
        const opened = await openFormSections(page, snapshot, {
          files: ctx.files, done: openedOnce, tries: openTries, channelType, applyUrl: ctx.applyUrl,
        });
        snapshot = opened.snapshot;
        if (opened.handoff) return await handoff(opened.handoff);
        if (opened.cvUploadDiagnostics?.length) evidence.steps.at(-1).cvUploadDiagnostics = opened.cvUploadDiagnostics;
        if (opened.cv) {
          evidence.steps.at(-1).cv = opened.cv;
          if (opened.cv === 'uploaded') {
            record('Lebenslauf', uploadLabel('cv', ctx.candidate), 'documents');
            noteUpload('cv');
            uploadedCvUrls.add(uploadedCvPageKey(page.url()));
          }
          if (opened.cv !== 'unavailable' && opened.cvFieldKey) {
            const uploadedField = snapshot.fields.find((field) => uploadedPortalFieldKey(page.url(), field) === opened.cvFieldKey)
              || snapshot.fields.find(isCvFileField);
            if (uploadedField) {
              const key = rememberUploadSelection(uploadedField.id, snapshot.fields);
              if (key) uploaded.add(key);
              if (opened.cv === 'uploaded' && isWorkdayTenantUrl(page.url())) {
                const controlKey = portalUploadControlKey(uploadedField);
                if (controlKey) uploadedNativeControls.add(controlKey);
                const stableControlKey = nativeCvFieldKey(uploadedField);
                if (stableControlKey) uploadedNativeCvFields.add(stableControlKey);
              }
            }
          }
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
      if (ownAccount && !ctx.accounts) return await handoff('account', { accountFailure: accountFailure('unknown', 'application') });
      if (snapshot.passwordVisible && !ownAccount) {
        if (!ctx.accounts) return await handoff('account', { accountFailure: accountFailure('unknown', 'login') });
        if (++authSteps > MAX_AUTH_STEPS) return await handoff('account', { accountFailure: accountFailure('auth_steps_exhausted', 'login') });
        let auth;
        let agentRecovery = null;
        const authHost = new URL(page.url()).hostname;
        const storedAccount = typeof ctx.accounts?.load === 'function'
          ? await ctx.accounts.load(authHost).catch(() => null)
          : null;
        if (storedAccount?.recoveryApplicationCheckRequired === true) accountRecoveryUsed = true;
        try {
          auth = await handleAuth({ page, snapshot, ctx, diagnostics, typedSecrets: authSecrets, registrationRestarts, recoveryAttempts });
          // A technical stop of the account page (AUTH_AGENT_RECOVERABLE_STOPS) gets the agentic
          // fallback once per page and stop before the owner does: the agent fills fields only,
          // then the deterministic path runs again on a stable re-read. Its own outcome stands
          // unless it stops again on a technical stop: the owner then gets the original handoff.
          if (isAgentRecoverableAuthStop(auth)) {
            const stopped = auth;
            agentRecovery = { stop: stopped.authStop, status: 'not_run' };
            const recovered = await recoverAuthWithAgent(stopped);
            agentRecovery.status = recovered.status;
            if (recovered.request) {
              evidence.steps.at(-1).auth = { kind: authPageKind(snapshot), outcome: 'questions', agentRecovery };
              return recovered.request;
            }
            if (recovered.auth && !isAgentRecoverableAuthStop(recovered.auth)) {
              auth = recovered.auth;
              agentRecovery.outcome = auth.handoff || 'ok';
            }
          }
        } catch (error) {
          // A control of the account page that could not be pressed or typed into (covered by a dialog,
          // redrawn away): another run finds the same page. Thrown, it ended the run with no page kept
          // and, read as a timeout, the run was started again twice; the owner gets the page instead.
          const controlClickFailure = /^locator\./.test(String(error?.message || ''))
            || error?.code === 'portal_control_click_unresolved';
          if (!controlClickFailure) throw error;
          evidence.steps.at(-1).auth = { kind: authPageKind(snapshot), outcome: 'control_error' };
          // A registration whose password was stored and whose button then could not be pressed: whether the
          // account exists is not known. Left `pending`, the next run would sign in, fail and stop there;
          // as `unanswered` it signs in and, when that fails, creates the account.
          const authHost = new URL(page.url()).hostname;
          const stored = await ctx.accounts.load(authHost).catch(() => null);
          if (stored?.status === 'pending') await ctx.accounts.mark(authHost, { status: 'unanswered' }).catch(() => {});
          return await handoff('account', { accountFailure: accountFailure('locator_control_error', accountStageFor(snapshot)) });
        }
        evidence.steps.at(-1).auth = {
          kind: authPageKind(snapshot),
          outcome: auth.handoff || (auth.questions?.length || auth.documents?.length ? 'questions' : auth.dryRun ? 'dry_run' : 'ok'),
          ...(auth.authStop ? { stop: auth.authStop } : {}),
          ...(agentRecovery ? { agentRecovery } : {}),
          ...(auth.privacy ? { privacy: auth.privacy } : {}),
          // How the sign-in button was found (clickButton): by id, again after a redraw, or scoped role.
          ...(auth.pressed ? { pressed: auth.pressed } : {}),
        };
        if (auth.handoff) return await handoff(auth.handoff, { accountFailure: auth.accountFailure, valueShapes: auth.valueShapes });
        if (auth.questions?.length || auth.documents?.length) return {
          event: {
            type: 'submit_needs_candidate', questions: auth.questions || [], documents: auth.documents || [],
            candidateRequestTelemetry: candidateRequestTelemetryFor(auth.questions || []),
          }, evidence,
        };
        if (auth.dryRun) {
          evidence.dryRunScreenshot = (await page.screenshot({ fullPage: true })).toString('base64');
          return { event: { type: 'dry_run_ready', stage: 'account' }, evidence };
        }
        if (auth.accountRecovered || storedAccount?.recoveryApplicationCheckRequired === true) accountRecoveryUsed = true;
        snapshot = auth.snapshot;
        // The page a sign-in lands on may be the portal's «refresh the page» (see REFRESH_ASKED_RE): loaded
        // again here, before it is taken for a home page and left for the posting.
        const signedInPage = await refreshed(snapshot);
        if (signedInPage) {
          evidence.steps.at(-1).refreshed = true;
          snapshot = signedInPage;
        }
        const duplicateAfterRecovery = await holdRecoveredDuplicateApplication(snapshot);
        if (duplicateAfterRecovery) return duplicateAfterRecovery;
        // After a sign-in or a verification link the portal may land on its
        // home page: back to the posting and its form.
        if (auth.reopen && !hasApplicationForm(snapshot) && !findButton(snapshot.buttons, NEXT_RE) && !findButton(snapshot.buttons, SUBMIT_RE)) {
          await page.goto(entryUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
          await settle(page);
          const reopened = await openApplicationForm(context, page, await extractFields(page, NAVIGATION), {
            applyUrl: ctx.applyUrl, postingUrl: ctx.postingUrl || postingUrl, sourceProtocol,
            postingEntry: enteredFromMatchingPosting, postingRouteProof: ctx.postingRouteProof, job: ctx.job,
            allowSingleExternalApplicationEntry: postingVacancyMatched,
            ...documentHostContext,
            onPortalNavigationDiagnostic: ctx.onPortalNavigationDiagnostic,
            cookieAgent,
          });
          ({ page, snapshot } = reopened);
          if (reopened.resolvedPostingUrl) {
            postingUrl = reopened.resolvedPostingUrl;
            postingVacancyMatched = true;
          }
          enteredThroughApplicationEntry = enteredThroughApplicationEntry || reopened.enteredThroughApplicationEntry === true;
          if (reopened.handoff) return await handoff(reopened.handoff);
          snapshot = await extractFields(page);
        }
        const duplicateAfterReopen = await holdRecoveredDuplicateApplication(snapshot);
        if (duplicateAfterReopen) return duplicateAfterReopen;
        // The auth step ended in the candidate's own session on the job's form
        // (Damiani: a registration without OTP lands in /portalcareer): the
        // account is usable. Left unverified, the next run restarted its
        // registration instead of signing in.
        if (signedInApplicationSurface(snapshot)) {
          const stored = await ctx.accounts.load(authHost).catch(() => null);
          if (stored && !stored.verifiedAt) await ctx.accounts.mark(authHost, { status: 'created', verifiedAt: Date.now() });
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
      // Site navigation alone is not an unreadable candidate question. Keep
      // custom application widgets eligible for recovery, but do not ask the
      // agent to fill a shell after its bounded field wait has expired.
      if (!snapshot.fields.length && snapshot.buttons.length > 0
        && snapshot.buttons.every((button) => button.chrome === true)
        && !(snapshot.links || []).some((link) => !link.chrome)) {
        return await handoff('application_stage_unknown');
      }
      // Nothing the filler can read (a page of custom widgets): straight to the agent.
      let agentHint = workable(snapshot) ? 'next_disabled' : 'no_form_controls';

      // A file an earlier run left on the page under the name of one of this run's (the run that stopped for
      // a question, a dry run) is taken away before the page is planned: the page asks for the file again and
      // this run's goes in. One CV on the application and the current one: never two, and never the one of a
      // draft written since (a planner that sees «successfully uploaded» leaves the field alone). What this
      // run uploaded itself stays.
      const sentNow = new Set(evidence.uploads.map((upload) => upload.document));
      const earlier = Object.keys(ctx.files || {}).filter((document) => !sentNow.has(document) && !selectedDocumentsThisRun.has(document))
        .flatMap((document) => {
          const names = documentPaths(ctx.files, document).map((file) => path.basename(file));
          const removals = removalsOf(snapshot.buttons, names).map((button) => ({ document, button, names }));
          return removals;
        });
      // A portal that offers no removal (SuccessFactors keeps the earlier CV in
      // «My Documents» with only «Edit document», Damiani 2026-11-10) leaves
      // the file of an earlier run of this order in its slot: under this run's
      // own name it is our document, kept as it is, and the run goes on.
      const keptEarlier = [];
      for (const document of Object.keys(ctx.files || {}).filter((item) =>
        !sentNow.has(item) && !selectedDocumentsThisRun.has(item))) {
        const names = documentPaths(ctx.files, document).map((file) => path.basename(file));
        const matchingRemoval = earlier.some((item) => item.document === document);
        for (const name of names) {
          const visible = await page.getByText(name, { exact: false }).first().isVisible().catch(() => false);
          if (!visible || matchingRemoval) continue;
          if (ownEarlierFileShown(snapshot.buttons, [name])) {
            if (!keptEarlier.includes(document)) keptEarlier.push(document);
            continue;
          }
          return await handoff('previous_file_not_removable');
        }
      }
      if (earlier.length) {
        const replaced = [];
        const removalConfirmations = [];
        for (const { document, button, names } of earlier) {
          if (keptEarlier.includes(document)) continue;
          const removal = await removeEarlierFile(page, button, names);
          removalConfirmations.push(...removal.confirmations.map((item) => ({ document, ...item })));
          if (removal.status === 'click_failed') return await handoff('previous_file_removal_failed');
          if (removal.status === 'removed') {
            if (!replaced.includes(document)) replaced.push(document);
            continue;
          }
          // The portal did not take the file away and nothing was confirmed (its confirm() asked for something
          // else, its control does not remove): the file is ours, under this run's own name, as it was. It stays
          // only when the page has no place for a second copy of the document; any doubt goes to the owner.
          snapshot = await extractFields(page);
          if (removal.status === 'untouched' && !replaced.includes(document)
            && ownEarlierFileShown(snapshot.buttons, names) && noSecondUploadPlace(snapshot, document)) {
            if (!keptEarlier.includes(document)) keptEarlier.push(document);
            continue;
          }
          return await handoff('previous_file_removal_unconfirmed');
        }
        if (removalConfirmations.length) evidence.steps.at(-1).removalConfirmations = removalConfirmations;
        if (replaced.length) {
          evidence.steps.at(-1).replaced = replaced;
          snapshot = await extractFields(page);
          // A slot that takes its file through a dialog (SuccessFactors) is filled before the page is planned:
          // the emptied slot gets this run's file now. A file field is left to the planner, as before.
          const sectionsAgain = await openSections();
          if (sectionsAgain) return sectionsAgain;
          const sentAfter = new Set(evidence.uploads.map((upload) => upload.document));
          for (const document of replaced) {
            if (sentAfter.has(document)) continue;
            const fileField = document === 'cv'
              ? snapshot.fields.some(isCvFileField)
              : snapshot.fields.some((field) => field?.kind === 'file' || field?.inputType === 'file');
            if (!fileField) return await handoff('previous_file_replacement_unavailable');
          }
        }
      }
      if (keptEarlier.length) evidence.steps.at(-1).keptEarlier = keptEarlier;
      if (keptEarlier.includes('cv')) keptCvUrls.add(page.url());

      let after = snapshot;
      let unclearQuestions = [];
      let candidateQuestions = [];
      if (workable(snapshot)) {
        // The planner never sees a password field, nor what a retry finds typed in it.
        const cvFields = preferredCvFields(snapshot.fields);
        const preferredCvIds = new Set(cvFields.map(field => field.id));
        const planned = { ...snapshot, fields: snapshot.fields.filter(field =>
          (!ownAccount || field.inputType !== 'password') && (!isCvFileField(field) || preferredCvIds.has(field.id))) };
        const plan = await planPage({
          snapshot: planned,
          candidate: candidateWithRecordedAnswers(ctx.candidate, planned),
          candidateLocale: ctx.candidateLocale,
          codex: ctx.codex,
        });

        // This synthetic action is executed by applyActions below, which resolves
        // the extracted fieldId through data-aa-id; agent.mjs aria-ref actions
        // are a separate path and are not used for this deterministic upload.
        const cvPaths = documentPaths(ctx.files, 'cv');
        const hasApprovedCv = cvPaths.length > 0;
        const alreadyUploadedCvIds = new Set();
        if (hasApprovedCv) {
          const approvedCvNames = cvPaths.map(file => path.basename(file));
          const workdayCvRouteAlreadyUploaded = uploadedCvUrls.has(uploadedCvPageKey(page.url()));
          const singleWorkdayCvAlreadyUploaded = isWorkdayTenantUrl(page.url())
            && cvFields.length === 1 && workdayCvRouteAlreadyUploaded;
          if (isWorkdayTenantUrl(page.url())) {
            evidence.steps.at(-1).cvUploadGuard = {
              fieldCount: cvFields.length,
              routeAlreadyUploaded: workdayCvRouteAlreadyUploaded,
            };
          }
          for (const field of cvFields) {
            const controlKey = portalUploadControlKey(field);
            const stableControlKey = nativeCvFieldKey(field);
            const workdayPage = isWorkdayTenantUrl(page.url());
            const sameNativeControlUploaded = workdayPage && controlKey && uploadedNativeControls.has(controlKey);
            const sameLogicalControlUploaded = workdayPage && stableControlKey && uploadedNativeCvFields.has(stableControlKey);
            const selectedApprovedFile = !sameNativeControlUploaded && !sameLogicalControlUploaded
              && uploadedCvUrls.has(uploadedCvPageKey(page.url()))
              && await locatorFor(page, field).evaluate((element, fileNames) =>
                [...(element.files || [])].some(file => fileNames.includes(file.name)), approvedCvNames).catch(() => false);
            if (singleWorkdayCvAlreadyUploaded || sameNativeControlUploaded || sameLogicalControlUploaded || selectedApprovedFile) {
              alreadyUploadedCvIds.add(field.id);
            }
          }
        }
        const automaticCvUploads = hasApprovedCv ? cvFields.filter(field => !alreadyUploadedCvIds.has(field.id)).map(field => ({
          fieldId: field.id, ref: field.ref, action: 'upload', value: '', document: 'cv', source: 'documents', evidence: '',
        })) : [];
        const managedCvIds = hasApprovedCv ? new Set(cvFields.map(field => field.id)) : new Set();
        // One file action per CV control: a model-selected different file
        // must not overwrite the approved CV or leave two conflicting receipts.
        const plannedActions = [...plan.actions.filter(action => !managedCvIds.has(action.fieldId)), ...automaticCvUploads];
        candidateQuestions = plan.missingRequired.filter(item => !managedCvIds.has(item.fieldId));
        // A file already uploaded on this page is not uploaded again when the
        // page is planned a second time (Personio empties the input after the upload).
        const uploadKey = (fieldId) => uploadKeyForField(fieldId, snapshot.fields, page.url(), pageEpoch);
        for (const field of cvFields) {
          if (!alreadyUploadedCvIds.has(field.id)) continue;
          const key = uploadKey(field.id);
          if (key) uploaded.add(key);
        }
        const uploadKeys = new Map(plannedActions.filter((action) => action.action === 'upload')
          .map((action) => [action.fieldId, uploadKey(action.fieldId)]));
        if ([...uploadKeys.values()].some((key) => key === null)) {
          evidence.steps.at(-1).uploadIdentityAmbiguous = true;
          return await handoff('portal_needs_candidate');
        }
        const actions = plannedActions.filter((action) => {
          if (action.action !== 'upload') return true;
          return !uploaded.has(uploadKeys.get(action.fieldId));
        });
        const plannedUrl = page.url();
        const redrawKey = `${pageEpoch}|${plannedUrl}`;
        // Choices first: one of them may redraw the form (on Workday the name and address fields follow the
        // country), and what was typed before into fields that are no more is lost without a word (dry run of
        // 2026-10-07: the address went into «Address Line 1», the country was chosen last, and the form that
        // was saved had «Street Name» and «Postcode» empty). A choice the field already shows is not made again.
        const fieldOf = (action) => snapshot.fields.find((field) => field.id === action.fieldId);
        const tidy = (value) => String(value || '').toLowerCase().replace(/\s+/g, ' ').trim();
        const isChoice = (action) => action.action !== 'skip' && ['select', 'listbox', 'combobox'].includes(fieldOf(action)?.kind);
        const shown = (action) => isChoice(action) && Boolean(tidy(action.value)) && tidy(fieldOf(action)?.value) === tidy(action.value);
        const choices = actions.filter((action) => isChoice(action) && !shown(action));
        const applyBoundActions = async (pendingActions, options = {}) => {
          if (!isWorkdayTenantUrl(ctx.applyUrl)) {
            return { results: await applyActions(page, snapshot.fields, pendingActions, ctx.files, options), handoff: '' };
          }
          const applied = [];
          for (const action of pendingActions) {
            if (workdayPostingRouteMismatch(page.url(), ctx.applyUrl)) return { results: applied, handoff: 'posting_mismatch' };
            applied.push(...await applyActions(page, snapshot.fields, [action], ctx.files, options));
            if (workdayPostingRouteMismatch(page.url(), ctx.applyUrl)) return { results: applied, handoff: 'posting_mismatch' };
          }
          return { results: applied, handoff: '' };
        };
        const selectedUploads = new Map();
        const appliedChoices = await applyBoundActions(choices);
        if (appliedChoices.handoff) return await handoff(appliedChoices.handoff);
        const results = [
          ...actions.filter(shown).map((action) => ({ fieldId: action.fieldId, ok: true })),
          ...appliedChoices.results,
        ];
        // The form after the choices: with other fields than the ones planned it is read and planned again
        // (up to four times for one page), and nothing is typed into what is no longer there.
        let redrawn = false;
        if (choices.length) {
          for (let waited = 0; waited < REDRAW_WAIT_MS && !redrawn && page.url() === plannedUrl; waited += 500) {
            await page.waitForTimeout(500);
            const now = await extractFields(page, NAVIGATION).catch(() => null);
            const comparableNow = now ? await snapshotWithPortalOptions(now) : null;
            redrawn = Boolean(comparableNow) && comparableNow.fields.length > 0
              && questionSurfaceSignature(comparableNow) !== questionSurfaceSignature(snapshot);
          }
        }
        if (!redrawn) {
          const appliedRemaining = await applyBoundActions(actions.filter((action) => !isChoice(action)), {
            onUploadSelection: (fieldId, paths) => {
              selectedUploads.set(fieldId, paths);
              if (paths.length) {
                rememberUploadSelection(fieldId, snapshot.fields, page.url(), pageEpoch);
                const selectedAction = actions.find((action) => action.fieldId === fieldId && action.action === 'upload');
                if (selectedAction?.document) selectedDocumentsThisRun.add(selectedAction.document);
              }
            },
          });
          if (appliedRemaining.handoff) return await handoff(appliedRemaining.handoff);
          results.push(...appliedRemaining.results);
        }
        if (!redrawn) {
          for (const action of actions.filter((item) => item.action === 'upload')) {
            const result = results.find((item) => item.fieldId === action.fieldId);
            const field = snapshot.fields.find((item) => item.id === action.fieldId);
            const files = selectedUploads.get(action.fieldId) || [];
            const confirmed = result?.ok && field
              && await uploadReceipt(page, locatorFor(page, field), files, { acceptedResponse: result.uploadAccepted === true });
            if (!confirmed) {
              // A generated cover letter is optional. If its upload is not
              // confirmed, omit it and continue; a missing required file still
              // stops the application below the same fail-closed boundary.
              const optionalCoverLetter = action.document === 'cover_letter'
                && field?.required === false && !field.invalid;
              if (optionalCoverLetter) {
                // This selection belongs to the current run, even when its
                // upload receipt is missing. Do not retry it on a redraw or
                // mistake its still-visible filename for an older upload.
                uploaded.add(uploadKey(action.fieldId));
                if (result) {
                  result.ok = false;
                  result.error ||= 'upload_not_confirmed';
                } else results.push({ fieldId: action.fieldId, ok: false, error: 'upload_not_confirmed' });
                continue;
              }
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
          if (uploadAction) {
            noteUpload(uploadAction.document, result.files);
            if (uploadAction.document === 'cv') uploadedCvUrls.add(uploadedCvPageKey(page.url()));
          }
          const action = result.ok && actions.find((item) => item.fieldId === result.fieldId);
          const field = action && snapshot.fields.find((item) => item.id === result.fieldId);
          if (uploadAction?.document === 'cv' && field && isWorkdayTenantUrl(page.url())) {
            const controlKey = portalUploadControlKey(field);
            if (controlKey) uploadedNativeControls.add(controlKey);
            const stableControlKey = nativeCvFieldKey(field);
            if (stableControlKey) uploadedNativeCvFields.add(stableControlKey);
          }
          if (!field || field.inputType === 'password') continue;
          const answer = { upload: uploadLabel(action.document, ctx.candidate), check: '✓', uncheck: '✗' }[action.action] ?? action.value;
          const isCheckboxAction = ['check', 'uncheck'].includes(action.action);
          const plannerAnswer = !isCheckboxAction ? undefined
            : ['answers', 'candidate', 'user'].includes(action.source)
              ? (action.action === 'check' ? 'ja' : 'nein') : null;
          record(field.label || field.name || field.id, answer, action.source, field.context, field.section, field.autocomplete, field, plannerAnswer);
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
          const redrawCount = redraws.get(redrawKey) || 0;
          if (redrawCount >= MAX_REDRAWS_PER_PAGE) return await handoff('portal_needs_candidate');
          redraws.set(redrawKey, redrawCount + 1);
          evidence.steps.at(-1).redrawn = true;
          snapshot = await awaitFields(page, await extractFields(page));
          step -= 1; // the same page, planned again
          continue;
        }
        if (ownAccount) {
          const typed = await typeOwnPassword({ page, snapshot, ctx, passwords: ownPasswords });
          evidence.steps.at(-1).auth = { kind: 'inline', outcome: !typed ? 'password_not_typed' : ctx.dryRun ? 'dry_run' : 'ok' };
          if (!typed) return await handoff('account', { accountFailure: accountFailure('login_unobserved', 'application') });
        }

        after = await extractFields(page, NAVIGATION);
        // The portal moved to another page by itself (JOIN registers the e-mail
        // and shows the CV page a moment later): plan that page, instead of
        // judging it by the buttons of the one just filled. Giro di prova 2026-10-01.
        if (page.url() !== plannedUrl) {
          pageEpoch += 1;
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
        if (actions.length || candidateQuestions.length) {
          const stable = await waitForStableQuestionSurface(page, after, plannedUrl);
          after = stable.snapshot;
          if (stable.status === 'moved') {
            pageEpoch += 1;
            snapshot = await awaitFields(page, await extractFields(page));
            continue;
          }
          if (stable.status !== 'stable') return await handoff('portal_needs_candidate');
          after = await snapshotWithPortalOptions(after);
          if (questionSurfaceSignature(after) !== questionSurfaceSignature(snapshot)) {
            const redrawCount = redraws.get(redrawKey) || 0;
            if (redrawCount >= MAX_REDRAWS_PER_PAGE) return await handoff('portal_needs_candidate');
            redraws.set(redrawKey, redrawCount + 1);
            evidence.steps.at(-1).redrawn = true;
            snapshot = after;
            step -= 1;
            continue;
          }
          snapshot = after;
          if (candidateQuestions.length) {
            // Ask only after known answers have settled and any fields they
            // reveal have been re-read and planned on the next pass.
            const requirements = portalRequirementsFromMissingRequired(snapshot.fields, candidateQuestions, { candidate: ctx.candidate, candidateLocale: ctx.candidateLocale });
            if (requirements.unreadableFields?.length) {
              unclearQuestions = candidateQuestions;
              agentHint = 'unclear_fields';
            } else {
              const request = await askCandidate(candidateQuestions, snapshot, { decide: true });
              // Planned again without spending a step: each question goes to the engine once (engineTried).
              if (request?.replan) { step -= 1; continue; }
              if (request) return request;
            }
          }
        }
      }
      if (after.captcha) return await handoff('captcha');
      // A usual name, or one this portal taught a confirmed submission (level 2).
      const known = await knownFor(page.url());
      let { submit, next, stage } = await controlsFor(after, known);
      const receiptResult = await confirmedReceipt(after);
      if (receiptResult) return receiptResult;
      if (stage?.kind === 'posting_mismatch') return await handoff('posting_mismatch');
      if (stage?.kind === 'unknown_apply') return await handoff('application_stage_unknown');
      // A later SPA step can land on public site content that still exposes a
      // generic optional upload and gallery controls. The entry-point guard
      // above does not run again, so stop before the no-controls agent fallback
      // treats that content as an unanswered application question.
      if (!hasApplicationSurface(after, {
        pageUrl: page.url(),
        postingUrl,
        postingMatch: evidence.postingMatch,
      })) return await handoff('posting_mismatch');
      let advance = null;
      let finalByAgent = null;
      // The filler cannot move this page on (its Next stays disabled: JOIN's
      // calendar of "Quando sei nato?"), or left fields it could not name:
      // the agent completes the page, then the runner moves on as before.
      if ((!submit && !next) || agentHint === 'unclear_fields') {
        const agentUrl = page.url();
        const agent = await runAgent(after, agentHint);
        if (agent?.status === 'needs_candidate') {
          const request = await askCandidate(agent.questions, after);
          if (request) return request;
        }
        // Required fields left unanswered: the owner looks when the agent could
        // not answer them; without the agent, the planner's questions as before.
        if (unclearQuestions.length && agent?.status !== 'done') {
          if (!agent || agent.status === 'unavailable') {
            const request = await askCandidate(unclearQuestions, after);
            if (request) return request;
          } else return await handoff('portal_needs_candidate');
        }
        if (agent?.status === 'done') {
          if (agent.moved || page.url() !== agentUrl) {
            pageEpoch += 1;
            snapshot = await awaitFields(page, await extractFields(page));
            continue;
          }
          after = await extractFields(page, NAVIGATION);
          for (let waited = 0; waited < 6000 && !findButton(after.buttons, SUBMIT_RE) && !findButton(after.buttons, NEXT_RE); waited += 2000) {
            await page.waitForTimeout(2000);
            after = await extractFields(page, NAVIGATION);
          }
          ({ submit, next, stage } = await controlsFor(after, known));
          const receiptResult = await confirmedReceipt(after);
          if (receiptResult) return receiptResult;
          if (stage?.kind === 'posting_mismatch') return await handoff('posting_mismatch');
          if (stage?.kind === 'unknown_apply') return await handoff('application_stage_unknown');
          // A step button with an unusual name ("Salva e prosegui"), never one that may send.
          if (!submit && !next && agent.advanceRef) advance = await advanceLocator(page, agent.advanceRef);
          // The last page's send button with an unusual name («Conferma e applica», level 1):
          // the agent names it, the runner presses it below, behind the submission guard,
          // only when nothing required is left empty on the page.
          if (!submit && !next && !advance && agent.submitRef) {
            if (!await requiredLeftEmpty(page, uploaded, (field, fields, url) => uploadKeyForField(field.id, fields, url, pageEpoch))) {
              finalByAgent = await submitLocator(page, agent.submitRef);
            }
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
          ({ submit, next, stage } = await controlsFor(after, known));
          const receiptResult = await confirmedReceipt(after);
          if (receiptResult) return receiptResult;
          if (stage?.kind === 'posting_mismatch') return await handoff('posting_mismatch');
          if (stage?.kind === 'unknown_apply') return await handoff('application_stage_unknown');
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
        const beforePageMarker = String(after.pageMarker || '');
        if (stage?.kind === 'review_navigation') {
          // Follow the owned review href with GET; an onclick handler cannot
          // turn this navigation into a hidden application commit.
          await page.goto(stage.destination, { waitUntil: 'domcontentloaded' });
        } else if (next) await clickButton(page, next);
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
        snapshot = await awaitFields(page, snapshot, (current) => {
          const sameMarker = String(current.pageMarker || '') === beforePageMarker;
          const sameLabels = current.fields.length > 0
            && current.fields.map((field) => field.label).join('|') === labelsBefore;
          return pageSignature(page, current) === before || (sameMarker && sameLabels);
        });
        const movedToNextPage = pageSignature(page, snapshot) !== before;
        if (movedToNextPage) pageEpoch += 1;
        // Still the same page: the form refused a value. A correction by the
        // planner, one by the agent (it reads the page's own messages), then the owner.
        stuckOnPage = pageSignature(page, snapshot) === before ? stuckOnPage + 1 : 0;
        if (stuckOnPage >= 2) {
          const agent = await runAgent(snapshot, 'refused');
          if (agent?.status === 'needs_candidate') {
            const request = await askCandidate(agent.questions, snapshot);
            if (request) return request;
          }
          if (agent?.status === 'done') snapshot = await extractFields(page);
          else if ((agent && agent.status !== 'unavailable') || stuckOnPage > 2) return await handoff('portal_needs_candidate');
        }
        continue;
      }
      // The final button: a usual or learned name (the runner's), or the one the agent named.
      const runnerFinalTarget = button => {
        const frame = page.frames()[button.frame || 0] || page.mainFrame();
        const id = String(button.id || '');
        return {
          label: button.text,
          by: 'runner',
          buttonId: id,
          formId: String(button.formId || ''),
          dialogId: String(button.dialogId || ''),
          frame,
          locator: frame.locator(`[data-aa-id="${id}"]`).first(),
          click: () => clickButton(page, button),
        };
      };
      const agentFinalTarget = button => ({
        label: button.name,
        by: 'agent',
        buttonId: String(button.buttonId || ''),
        formId: String(button.formId || ''),
        dialogId: String(button.dialogId || ''),
        frame: button.frame || page.mainFrame(),
        locator: button.locator,
        click: () => clickSubmitButton(page, button),
      });
      let final = submit
        ? runnerFinalTarget(submit)
        : finalByAgent && agentFinalTarget(finalByAgent);
      if (!final) {
        if (findButton(after.buttons, SUBMIT_RE, { includeDisabled: true }) && validationRetries < 1) {
          validationRetries += 1;
          snapshot = await extractFields(page);
          continue;
        }
        return await handoff('portal_needs_candidate');
      }
      const duplicateBeforeFinal = await holdRecoveredDuplicateApplication(after);
      if (duplicateBeforeFinal) return duplicateBeforeFinal;
      // A normal send button is not evidence that the portal form is complete.
      // Let the agent repair any required fields the deterministic fill missed;
      // never click Send while a required answer or upload is still empty.
      if (await requiredLeftEmpty(page, uploaded, (field, fields, url) => uploadKeyForField(field.id, fields, url, pageEpoch))) {
        evidence.steps.at(-1).requiredFieldsUnfilled = true;
        const repairUrl = page.url();
        const repair = await runAgent(after, 'required_fields_unfilled');
        if (repair?.status === 'needs_candidate') {
          const request = await askCandidate(repair.questions, after);
          if (request) return request;
        }
        if (repair?.status !== 'done') return await handoff('portal_required_fields_unfilled');
        if (repair.moved || page.url() !== repairUrl) {
          pageEpoch += 1;
          snapshot = await awaitFields(page, await extractFields(page));
          step -= 1;
          continue;
        }
        after = await extractFields(page, NAVIGATION);
        if (await requiredLeftEmpty(page, uploaded, (field, fields, url) => uploadKeyForField(field.id, fields, url, pageEpoch))) {
          return await handoff('portal_required_fields_unfilled');
        }
        const repairedControls = await controlsFor(after, known);
        const receiptResult = await confirmedReceipt(after);
        if (receiptResult) return receiptResult;
        if (repairedControls.stage?.kind === 'posting_mismatch') return await handoff('posting_mismatch');
        if (repairedControls.stage?.kind === 'unknown_apply') return await handoff('application_stage_unknown');
        if (repairedControls.next && !repairedControls.submit) {
          snapshot = after;
          step -= 1;
          continue;
        }
        if (repairedControls.submit) {
          final = runnerFinalTarget(repairedControls.submit);
        } else if (repair.submitRef) {
          const repairedSubmit = await submitLocator(page, repair.submitRef);
          if (!repairedSubmit) return await handoff('portal_required_fields_unfilled');
          final = agentFinalTarget(repairedSubmit);
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
      evidence.submissionUrl = finalUrl;
      await diagnostics.beforeSubmit(page);
      const guardToken = randomUUID();
      const armed = await final.locator.evaluate(armFinalFormClickGuardInPage, {
        token: guardToken,
        expectedButtonId: final.buttonId,
        expectedFormId: final.formId,
        expectedButtonName: final.label,
      }).catch(() => ({ ok: false, reason: 'final_control_unavailable' }));
      if (!armed?.ok) {
        evidence.finalFormGuardFailure = {
          reason: armed?.reason || 'final_control_unavailable',
          expectedButtonId: final.buttonId,
          expectedFormId: final.formId,
          ...(armed?.buttonId ? { buttonId: armed.buttonId } : {}),
          ...(armed?.formId ? { formId: armed.formId } : {}),
        };
        return await handoff('portal_final_form_unbound');
      }
      const formBinding = createHash('sha256').update(armed.contractJson).digest('hex');
      const nativeFormId = String(armed.nativeFormId || '');
      const frameIndex = Math.max(0, page.frames().indexOf(final.frame || page.mainFrame()));
      activeFinalFormGuard = { frame: final.frame, locator: final.locator, token: guardToken };
      // The native form is bound before the durable send arm. The installed
      // capture listener compares it again synchronously before portal click
      // handlers can act.
      if (ctx.onBeforeSubmit) await ctx.onBeforeSubmit({ uploads: evidence.uploads, formBinding });
      finalClickAttempt = diagnostics?.currentAttempt?.() ?? null;
      diagnostics.finalClick();
      await final.click();
      const clickGuardStatus = final.frame?.evaluate
        ? await final.frame.evaluate(readFinalFormGuardStatusInPage, guardToken).catch(() => 'missing')
        : await final.locator.evaluate(readFinalFormGuardStatusInPage, guardToken).catch(() => 'missing');
      if (clickGuardStatus === 'blocked_before_click') {
        finalClickAttempt = null;
        evidence.finalOutcomes = ['form_changed_before_click'];
        return { event: { type: 'submit_failed', error: 'form_changed_before_click' }, evidence };
      }
      await clearActiveFinalFormGuard();
      const finalSubmission = {
        clicked: true,
        formId: nativeFormId ? `${frameIndex}\u0000${nativeFormId}` : '',
        nativeFormId,
        frame: final.frame || page.mainFrame(),
        frameIndex,
      };
      const observed = await waitForOutcome(page, { applyUrl: ctx.applyUrl, submissionUrl: finalUrl, sourceProtocol, job: ctx.job, finalSubmission });
      const outcome = observed.outcome;
      (evidence.finalOutcomes ||= []).push(outcome);
      if (outcome === 'confirmed' && ctx.onReceipt) await ctx.onReceipt({ finalUrl: page.url() });
      await diagnostics.afterSubmit(page, outcome);
      evidence.afterSubmit = (await page.screenshot({ fullPage: true }).catch(() => Buffer.from(''))).toString('base64');
      evidence.finalUrl = page.url();
      evidence.afterSubmitSnapshot = finalReviewEvidenceSnapshot(observed.snapshot);
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
      if (outcome === 'review_pending') {
        // Not an unknown outcome: the portal's review page says the
        // application still waits for its own final button. Release the
        // claim as not sent, then let the loop bind and guard that button.
        if (ctx.onConfirmedNotSent) await ctx.onConfirmedNotSent({ reason: 'portal_review_pending' });
        if (reviewAdvances >= 1) return await handoff('application_stage_unknown');
        reviewAdvances += 1;
        snapshot = await extractFields(page);
        continue;
      }
      if (outcome === 'validation' && validationRetries < 1) {
        if (ctx.onConfirmedNotSent) await ctx.onConfirmedNotSent({ reason: 'portal_validation' });
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
  } catch (error) {
    const currentAttempt = diagnostics?.currentAttempt?.();
    const finalClickInCurrentAttempt = Number.isSafeInteger(finalClickAttempt)
      && Number.isSafeInteger(currentAttempt)
      && finalClickAttempt === currentAttempt;
    const message = [error?.message, error?.code]
      .filter((value) => typeof value === 'string' && value.trim())
      .join('\n') || String(error);
    const exhaustedPreDispatchLocatorClick = /\blocator\.click\b/i.test(message)
      && isPreDispatchLocatorClickFailure({ message });
    if ((error?.code === 'portal_control_click_unresolved' || exhaustedPreDispatchLocatorClick) && !finalClickInCurrentAttempt) {
      evidence.controlClickFailure = { stage: 'intermediate', outcome: 'pre_dispatch' };
      return await handoff('portal_control_click_unresolved');
    }
    throw error;
  } finally {
    await clearActiveFinalFormGuard();
    await diagnostics?.finish();
    // Keep the route/API protocol next to the encrypted submit evidence. This
    // is metadata only: diagnostics has already removed queries and never
    // exports request bodies or response bodies.
    evidence.portalContract = applicationContractFromSubmission({
      channelType,
      applyUrl: ctx.applyUrl,
      currentUrl: evidence.finalUrl || page?.url?.() || ctx.applyUrl,
      diagnostics: diagnostics?.data || null,
      outcome: evidence.finalOutcomes?.at(-1) || null,
    });
    await context?.close().catch(() => {});
    await browser?.close().catch(() => {});
  }
}

export { locatorFor };
