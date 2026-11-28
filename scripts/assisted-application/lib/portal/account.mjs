/**
 * Portal accounts (fase 3c: Workday, SuccessFactors and every portal that
 * asks for a login). career-ops hands a login over to the person; the owner
 * decided instead (2026-09-30) that the runner creates the account itself on
 * the order's alias (`candidature.frontaliereticino.ch`), so the verification
 * e-mail reaches our inbox, never the candidate's.
 *
 *   sign-in page, no account yet  → the "create account" link
 *   create-account page           → random password, stored encrypted BEFORE
 *                                   the click; the planner fills the rest
 *   "check your e-mail"           → the inbox's verification link or code
 *   SuccessFactors sign-in with an unverified account
 *                             → restart registration to issue a fresh OTP
 *   sign-in page, account known   → alias + password
 *   application form with its own → the same random password, typed with the
 *   password field                  rest of the form (portal.mjs)
 *
 * The password never reaches a log, an event or the evidence: the agent masks
 * it and Firestore holds only its AES-GCM envelope under the run key.
 */

import { randomBytes, randomUUID } from 'node:crypto';
import { ASSISTED_APPLICATIONS_COLLECTION, PORTAL_ACCOUNTS_DOC_ID } from '../../../../functions/src/assistedApplicationConstants.js';
import { aliasLocalPart } from '../../../../functions/src/assistedApplicationAlias.js';
import { sameSite, exactPortalVerificationUrl, currentPendingPortalAccount, PORTAL_ACCOUNT_NOTICES_CONFIRMING } from '../../../../functions/src/assistedApplicationPortalSites.js';
import { portalAccountHostKey } from '../../../../functions/src/lib/applicationExistsReconciliation.js';
import { decryptJson, encryptJson } from '../secure-run.mjs';

export const VERIFICATION_TIMEOUT_MS = 10 * 60 * 1000;
const VERIFICATION_POLL_MS = 10_000;
export const PASSWORD_RESET_TIMEOUT_MS = 10 * 60 * 1000;
const RECOVERY_WINDOW_MS = 24 * 60 * 60 * 1000;
const RECOVERY_BACKOFF_MS = [15 * 60 * 1000, 2 * 60 * 60 * 1000];
const RECOVERY_ACTIVATION_LOOKBACK_MS = 15 * 60 * 1000;
// The federal SuccessFactors tenant mailed «Ihr Bewerbungskonto wurde
// erfolgreich erstellt» 25 s after its code (2026-11-10).
export const ACCOUNT_NOTICE_TIMEOUT_MS = 2 * 60 * 1000;

// SuccessFactors (Coop, 2026-10-02) words its link as a question and an
// answer: «Noch kein Profil? Hier registrieren», «Non hai ancora un profilo?
// Registrati qui», «Vous n'avez pas encore de compte? Créez-en un»; its
// button is «Konto anlegen» / «Crea account» / «Créer un compte». The Swiss
// federal portal instead asks «Sie haben noch kein Bewerbungskonto? Melden Sie
// sich jetzt an.» or «Bewerbungskonto erstellen»; the question is required so
// «Melden Sie sich jetzt an» by itself remains a sign-in action.
const GERMAN_ACCOUNT_CREATION_RE = String.raw`(?:(?:bewerbungs)?konto|profil)\s+(?:erstellen|anlegen)|(?:erstellen|legen)\s+sie\s+(?:sich\s+)?(?:ein\s+)?(?:neues?\s+)?(?:(?:bewerbungs)?konto|profil)(?:\s+an)?|registrieren\s+sie\s+sich(?:\s+(?:hier|jetzt))?|neues\s+(?:bewerbungs)?konto(?:\s+(?:erstellen|anlegen))?`;
export const CREATE_ACCOUNT_RE = new RegExp(String.raw`^(?:sie haben noch kein bewerbungskonto\?\s*melden sie sich jetzt an\.?|(?:don['’]?t|do not)\s+have\s+an?\s+account(?:\s+yet)?\??|(?:[^?]{0,60}\?\s*)?(hier |jetzt )?(?:${GERMAN_ACCOUNT_CREATION_RE}|registrieren|create (an? )?(?:account|profile)|sign up|register|crea (un )?(?:account|profilo)|registrati( qui)?|créer (un )?(?:compte|profil)|créez-en un|s'inscrire))[,.;:]?$`, 'i');
export const SIGN_IN_RE = /^(anmelden|einloggen|sign in|log ?in|accedi|connexion|se connecter)$/i;
const SIGN_IN_NAVIGATION_RE = /(?:^|[^\p{L}\p{N}])(?:sign[\s-]*in|log[\s-]*in|anmelden|einloggen|accedi|connexion|se\s+connecter|connectez[-\s]vous)(?=$|[^\p{L}\p{N}])/iu;
const ACCOUNT_CREATION_ACTION_RE = new RegExp(String.raw`(?:\b(?:create|new)\s+(?:an?\s+)?(?:account|profile)\b|\b(?:${GERMAN_ACCOUNT_CREATION_RE})|\b(?:register|sign\s*up)\b|\bregistrier\w*\b|\bregistrati(?:\s+qui)?\b|\bcrea(?:re)?\s+(?:un\s+)?(?:account|profilo)\b|\bcr[ée]er\s+(?:un\s+)?(?:compte|profil)\b|\bcr[ée]ez[-\s]+en\s+un\b|\bs['’]inscrire\b)`, 'iu');
export const RESEND_VERIFICATION_RE = /(resend|send (?:a )?new (?:verification )?code|request a new code|neuen code (?:senden|anfordern)|code (?:erneut|noch einmal) senden|renvoyer|réenvoyer|envoyer un nouveau code|invia(?:re)? un nuovo codice|nuovo codice|reinvia)/i;
export const VERIFY_PAGE_RE = /((verify|verifizier|bestätig|verifica|confirm|vérifi)[^.]{0,80}(e-?mail|konto|account|adresse|indirizzo|compte)|check your (e-?mail|inbox)|e-?mail (wurde )?(gesendet|verschickt|sent|inviata|envoyé)|e-?mail\s+d['’]activation\s+envoy[ée]|lien\s+d['’]activation\b[^.\n]{0,80}\benvoy[ée]|(?:pas\s+encore\s+[ée]t[ée]\s+activ[ée]|not\s+yet\s+activated|noch\s+nicht\s+aktiviert)|(?:activation\s+(?:e-?mail|email|link)|aktivierungs[-\s]?(?:e-?mail|link)|link\s+di\s+attivazione)\s+(?:has been\s+|was\s+|ist\s+|wurde\s+|è\s+stato\s+)?(?:sent|inviat[oa]|gesendet|verschickt)|one[- ]time (?:password|passcode)|otp|mot de passe [àa] usage unique|code (?:de |di )?(?:vérification|verification|confirmation|verifica)|code confidentiel|einmal(?:passwort|kennwort|code))/i;
// SBB's SuccessFactors tenant (career5, 2026-11-10) says «Einmalkennwort» and labels its field «*Passcode:».
const CODE_FIELD_RE = /code|codice|\bpin\b|\btoken\b|bestätigungs|one[- ]time (?:password|passcode)|\botp\b|einmal(?:passwort|kennwort|code)|mot de passe [àa] usage unique/i;
// The code of an address, a phone, a discount or a file is no verification code: «Postal Code», «Country Phone
// Code», «postalCode», «Code postal», «Codice fiscale». Workday's first page of the form was taken for a
// verification page by its postal code, and the run waited ten minutes for an e-mail nobody sends (dry run
// of 2026-10-07). Whole words otherwise: «Shipping» holds no PIN.
const OTHER_CODE_RE = /(?:postal|post|zip|plz|area|dial(?:l?ing)?|country|l[aä]nder|landes|phone|telefon|telephone|mobile|promo(?:tion)?|aktions|discount|rabatt|coupon|voucher|gutschein|referral|tax|steuer|bank|swift|bic|sort|employee|company|job|requisition|currency|language|region|state|province)[\s_-]*(?:code|codice|kode)|(?:code|codice)\s+(?:postal|postale|fiscale|pays|paese|promo|sconto|r[ée]gion|area)/gi;
const PASSWORD_CODE_FIELD_RE = /one[- ]time|\botp\b|einmal|usage unique|\b(?:verification|confirmation) code\b|code (?:de |di )?(?:vérification|verification|confirmation|verifica)|code confidentiel|bestätigungs(?:code|passwort)|verifizierungscode|\bpin\b|\btoken\b/i;
// The federal SuccessFactors tenant (career74, 2026-11-10) masks its OTP input:
// `type=password` behind an «Anzeigen» toggle, labelled only «*Code:», with no
// e-mail or user field on the page; SBB's (career5, same day) labels the same
// input «*Passcode:». Such a bare word is the e-mailed code; next to a login
// identity it stays that form's secret, and «Zugangscode» or «Kennwort» remain
// passwords.
const BARE_CODE_LABEL_RE = /^[\s*:]*(?:code|codice|pass[\s-]?code)[\s*:]*$/i;

const VERIFY_OK_RE = /(?:^|[^\p{L}\p{N}])(verified|verifiziert|bestätigt|aktiviert|activated|confirmed|verificat[oa]|confermat[oa]|attivat[oa]|vérifiée?s?|confirmée?s?|activée?s?|erfolgreich|successfully)(?=$|[^\p{L}\p{N}])/iu;
const VERIFY_FAILED_RE = /(abgelaufen|expired|scadut[oa]|expirée?|ungültig|invalid|non valid[oa]|invalide|nicht (mehr )?gültig|falsch|incorrect|errat[oa]|wrong)/i;
const VERIFY_LOADING_RE = /(chargement en cours|loading(?:\.\.\.|…)?|caricamento in corso|wird geladen|in bearbeitung|processing|traitement en cours)/i;

/** The portal can expose a form message outside the body text (for example as role=alert). */
export function accountResponseText(snapshot = {}) {
  return [snapshot.text, ...(Array.isArray(snapshot.errors) ? snapshot.errors : [])]
    .map((value) => String(value ?? '').trim())
    .filter(Boolean)
    // Page copy and each form error are independent messages. Keep a sentence
    // boundary so a discriminator cannot assemble a phrase across them.
    .join('. ');
}

const EXISTING_ACCOUNT_ERROR_RE = /(?:\b(?:account|e-?mail(?: address)?|emailadresse|adresse e-?mail|courriel|benutzer|login|konto|bewerbungskonto|compte|indirizzo e-?mail)\b[^.!?\n]{0,60}(?:already exists|already registered|already in use|already used|already taken|is already registered|is already in use|is already used|exists already|existiert bereits|bereits registriert|bereits verwendet|bereits benutzt|bereits(?: im system)? vorhanden|esiste già|già registrat[oa]|già utilizzat[oa]|già in uso|existe déjà|déjà inscrit|déjà enregistr[ée]e?|déjà utilisé[ee]?|déjà en usage)(?=$|[^\p{L}\p{N}])|(?:^|[^\p{L}\p{N}])(?:already exists|already registered|already in use|already used|already taken|existiert bereits|bereits registriert|bereits verwendet|bereits(?: im system)? vorhanden|esiste già|existe déjà|déjà inscrit|déjà enregistr[ée]e?|déjà utilisé[ee]?)[^.!?\n]{0,60}\b(?:account|e-?mail|emailadresse|adresse|courriel|benutzer|login|konto|bewerbungskonto|compte|indirizzo)\b|(?:^|[^\p{L}\p{N}])(?:il\s+)?existe\s+d[ée]j[àa]\s+un\s+(?:autre\s+)?(?:compte|profil)(?=$|[^\p{L}\p{N}]))/iu;
const EXISTING_ACCOUNT_RE = new RegExp(String.raw`(?:${EXISTING_ACCOUNT_ERROR_RE.source}|\b(?:already have an? (?:application )?account|an? (?:application )?account already exists|account with (?:this|that) (?:e-?mail|address) already exists|already registered|this (?:e-?mail|address) is already in use)\b|\b(?:sie haben bereits ein(?:en)? (?:bewerbungs?)?konto|es gibt bereits ein(?:en)? (?:bewerbungs?)?konto|bereits ein konto vorhanden)\b|\b(?:vous avez déjà un compte|un compte existe déjà|vous êtes déjà inscrit)\b|\b(?:hai già un account|esiste già un account|sei già registrato)\b)`, 'iu');
const EXISTING_ACCOUNT_NAV_QUESTION_RE = /(?:\balready have an? (?:application )?account|\balready registered|\bbereits registriert|\bsie haben bereits ein(?:en)? (?:bewerbungs?)?konto|\bvous avez déjà un compte|\bvous êtes déjà inscrit|\bhai già un account|\bsei già registrato)\s*\?/iu;
const REGISTRATION_SIGN_IN_QUESTION_RE = /\bsei già registrat(?:o(?:\/a)?|a) come utente\s*\?/giu;
const EXPLICIT_EXISTING_ACCOUNT_RE = new RegExp(String.raw`(?:${EXISTING_ACCOUNT_ERROR_RE.source}|\b(?:an? (?:application )?account already exists|account with (?:this|that) (?:e-?mail|address) already exists|already registered|this (?:e-?mail|address) is already in use)\b|\b(?:es gibt bereits ein(?:en)? (?:bewerbungs?)?konto|bereits ein konto vorhanden)\b|\b(?:un compte existe déjà|vous êtes déjà inscrit)\b|\b(?:esiste già un account|sei già registrato)\b)`, 'iu');
const REGISTRATION_EMAIL_FIELD_RE = /(?:e[-\s]?mail|emailadresse|mailadresse|benutzer(?:name)?|username|login)/iu;
const DUPLICATE_VALUE_RE = /\b(?:der eingegebene wert|dieser wert)\b[^.!?\n]{0,40}\bbereits(?:\s+im\s+system)?\s+vorhanden\b/iu;
const DUPLICATE_VALUE_WITH_IDENTITY_RE = new RegExp(
  String.raw`(?:${DUPLICATE_VALUE_RE.source}[.!?\s]{0,12}\b(?:e-?mail(?:[-\s]?adresse)?|login|benutzer(?:name)?|account|konto)\b|\b(?:e-?mail(?:[-\s]?adresse)?|login|benutzer(?:name)?|account|konto)\b[^!\n]{0,60}${DUPLICATE_VALUE_RE.source})`,
  'iu',
);

function hasRegistrationEmailField(snapshot) {
  return Array.isArray(snapshot.fields)
    && authPageKind(snapshot) === 'create'
    && snapshot.fields.some((field) => field.inputType !== 'password'
      && REGISTRATION_EMAIL_FIELD_RE.test(`${field.label || ''} ${field.name || ''} ${field.autocomplete || ''}`));
}

function hasEmailAndPasswordFields(snapshot) {
  if (!Array.isArray(snapshot.fields)) return false;
  const hasEmail = snapshot.fields.some((field) => field.inputType !== 'password'
    && REGISTRATION_EMAIL_FIELD_RE.test(`${field.label || ''} ${field.name || ''} ${field.autocomplete || ''}`));
  const hasPassword = snapshot.fields.some((field) => field.inputType === 'password' && !isCodeField(field, snapshot.fields));
  return hasEmail && hasPassword;
}

/** The portal says this candidate already has an account; registration must stop. */
export function hasExistingAccountPrompt(snapshot = {}) {
  // SuccessFactors flattens the registration heading directly before its sign-in
  // question. Remove that navigation copy before matching an account conflict.
  const text = String(snapshot.text ?? '').replace(REGISTRATION_SIGN_IN_QUESTION_RE, '. ');
  const rawErrors = Array.isArray(snapshot.errors)
    ? snapshot.errors.map((value) => String(value ?? '').trim()).filter(Boolean)
    : [];
  const authFormPresent = hasEmailAndPasswordFields(snapshot);
  if (rawErrors.some((error) => DUPLICATE_VALUE_WITH_IDENTITY_RE.test(error)
    || (authFormPresent && DUPLICATE_VALUE_RE.test(error)))
    || DUPLICATE_VALUE_WITH_IDENTITY_RE.test(text)) {
    return true;
  }
  const messages = [text, ...rawErrors]
    .map((value) => String(value ?? '').trim())
    .filter(Boolean)
    .flatMap((message) => message.split(/(?<=[.!?;])\s+|[\r\n]+/u).map((part) => part.trim()).filter(Boolean));
  const registrationSurface = hasRegistrationEmailField(snapshot);
  return messages.some((message) => {
    // A concrete identity error can itself be phrased as a question by the
    // portal (for example, “This email is already registered?”). Suppress
    // only the generic account-navigation prompt, not an explicit conflict.
    if (EXISTING_ACCOUNT_NAV_QUESTION_RE.test(message)
      && !EXISTING_ACCOUNT_ERROR_RE.test(message)) return false;
    // A concrete e-mail/account error remains authoritative even when the
    // portal leaves the registration form mounted. Generic account copy on a
    // complete create form is only navigation, not proof that this candidate
    // already owns an account; let the registration flow inspect its fields.
    if (EXPLICIT_EXISTING_ACCOUNT_RE.test(message)) return true;
    return !registrationSurface && EXISTING_ACCOUNT_RE.test(message);
  });
}

const ACCOUNT_VERIFICATION_RE = /(?:\b(?:verify|verifizier\w*|bestätig\w*|verifica\w*|confirm\w*|vérifi\w*)\b[^.\n]{0,80}\b(?:account|konto|compte)\b|\b(?:verify|verifizier\w*|bestätig\w*|verifica\w*|confirm\w*|vérifi\w*)\b\s+(?:(?:your|the|ihr(?:e|en)?|dein(?:e|en)?|die|votre|ton|ta|son|sa|il|la|l['’])\s+){0,2}(?:e-?mail(?:[-\s]?(?:address|adresse))?|(?:address|adresse|indirizzo)\s+e-?mail)|e-?mail\s+d['’]activation\s+envoy[ée]|lien\s+d['’]activation\b[^.\n]{0,80}\benvoy[ée]|(?:pas\s+encore\s+[ée]t[ée]\s+activ[ée]|not\s+yet\s+activated|noch\s+nicht\s+aktiviert)|activ(?:ate|er)\s+(?:your|votre|ihr(?:e|en)?)\s+(?:account|compte|konto))/iu;
const GENERIC_OTP_RESPONSE_RE = /one[- ]time (?:password|passcode)|\b(?:otp|passcode)\b|mot de passe [àa] usage unique|code confidentiel|einmal(?:passwort|kennwort|code)|\b(?:verification|confirmation) code\b/i;

/** A response that asks to verify the account, not merely to complete an OTP/MFA challenge. */
export function isAccountVerificationResponse(snapshot = {}) {
  const text = accountResponseText(snapshot);
  if (!text || (GENERIC_OTP_RESPONSE_RE.test(text) && !/(?:\baccount\b|\bkonto\b|\bcompte\b)/iu.test(text))) return false;
  return ACCOUNT_VERIFICATION_RE.test(text);
}

// «Votre compte n'a pas encore été activé» holds «activé»: a negated state is no confirmation.
const NOT_YET_RE = /(?:pas\s+encore\s+(?:[ée]t[ée]\s+)?|not\s+yet\s+(?:been\s+)?|noch\s+nicht\s+|non\s+(?:[èe]\s+)?ancora\s+(?:stat[oa]\s+)?)[\p{L}]+/giu;
const withoutNegatedStates = (text) => String(text || '').replace(NOT_YET_RE, ' ');

// «Continuer à postuler», «Continue applying», «Weiter bewerben», «Continua a candidarti».
const CONTINUE_APPLYING_RE = /^(?:continuer\s+(?:à|a)\s+postuler|continue\s+(?:to\s+)?appl(?:y|ying)|weiter\s+(?:zur\s+)?bewerb(?:en|ung)|continua\s+(?:a\s+)?candidarti|continua\s+con\s+la\s+candidatura)\W*$/iu;

function verifiedLanding(after, { successFactorsLanding = false } = {}) {
  const text = String(after?.text || '').normalize('NFC').trim();
  // A verification/instructions page may expose a generic sign-in control as
  // well; it is not proof that the OTP was accepted. A create form is also
  // not the verified landing page, even if it has a similarly named control.
  if ((VERIFY_PAGE_RE.test(text) && !VERIFY_OK_RE.test(withoutNegatedStates(text))) || authPageKind(after) === 'create' || codeField(after)) return false;
  const signIn = (after.buttons || []).some((button) => !button.disabled
    && [button.text, button.label].some((value) => SIGN_IN_RE.test(String(value ?? '').trim())));
  if (signIn) return true;
  // SuccessFactors, once the activation link is followed, shows its own
  // «Continuer à postuler» / «Continue applying» control and nothing to fill:
  // it is offered only to an activated account. Only a landing the caller proved
  // to be a SuccessFactors tenant route counts; another portal's button says nothing. A page that still talks about
  // an activation mail or offers to resend it («pas encore été activé» even
  // contains «activé») never counts.
  const hasResend = (after.buttons || []).some((button) => [button.text, button.label].some((value) => RESEND_VERIFICATION_RE.test(String(value ?? ''))));
  return successFactorsLanding === true && !VERIFY_PAGE_RE.test(text) && !hasResend && !(after.errors || []).length
    && (after.buttons || []).some((button) => !button.disabled
      && [button.text, button.label].some((value) => CONTINUE_APPLYING_RE.test(String(value ?? '').trim())));
}

/**
 * What the page after the "create account" click says: `refused` (still the
 * form, or its errors), `verify` (the portal asks to confirm the e-mail) or
 * `created` (it moved on).
 */
export function registrationOutcome(after) {
  if (authPageKind(after) === 'create' || hasExistingAccountPrompt(after)) return 'refused';
  if (VERIFY_PAGE_RE.test(accountResponseText(after)) || codeField(after)) return 'verify';
  // The sign-in page is where a portal sends a new account (Workday, with a notice of its own): its notice
  // is no refusal. The sign-in that follows says whether the account is there.
  if (authPageKind(after) === 'sign_in') return 'created';
  if (after.errors?.length) return 'refused';
  return 'created';
}

/**
 * What the page after the verification link or code says. Only a positive
 * state counts as `accepted`: a confirmation, the sign-in page or the
 * application form. An expired or wrong token is `rejected`; `pending` is the
 * portal's bounded loading state after an OTP click; anything else is
 * `unconfirmed`, and neither is recorded as verified.
 */
export function verificationOutcome(after, { successFactorsLanding = false } = {}) {
  const text = String(after?.text || '').normalize('NFC').trim();
  const errors = (after.errors || []).map((error) => String(error).trim()).filter(Boolean);
  const loading = errors.some((error) => VERIFY_LOADING_RE.test(error));
  const rejected = errors.some((error) => !VERIFY_LOADING_RE.test(error)) || VERIFY_FAILED_RE.test(text);
  if (rejected) return 'rejected';
  if (loading) return 'pending';
  const positiveText = withoutNegatedStates(text);
  if (VERIFY_PAGE_RE.test(text) && !VERIFY_OK_RE.test(positiveText)) return 'unconfirmed';
  // SuccessFactors can finish the OTP route on `/career` with only a
  // «Connexion» control visible; the password fields appear after that
  // control is opened. That is the portal's sign-in landing state, not an
  // unconfirmed verification.
  if (VERIFY_OK_RE.test(positiveText) || authPageKind(after) === 'sign_in') return 'accepted';
  if (codeField(after)) return 'rejected';
  if (verifiedLanding(after, { successFactorsLanding })) return 'accepted';
  const form = after.fields.filter((field) => field.inputType !== 'password');
  return form.some((field) => field.kind === 'file') || form.length >= 3 ? 'accepted' : 'unconfirmed';
}

/**
 * The OTP page is still processing the click; its code field is not a
 * rejection yet. SuccessFactors can also briefly expose an empty document
 * while the post-verification route is loading, so that state must not be
 * classified as an unconfirmed verification either.
 */
export function verificationIsPending(after) {
  const hasVisibleResult = Boolean(String(after?.text || '').trim())
    || Boolean(after?.fields?.length)
    || Boolean(after?.buttons?.length)
    || Boolean(after?.errors?.length);
  if (!hasVisibleResult) return true;
  if (!codeField(after)) return false;
  return VERIFY_LOADING_RE.test([after.text, ...(after.errors || [])].filter(Boolean).join(' '));
}

/**
 * create: two password fields (password + repeat); sign_in: one. A masked
 * one-time-code input is no account password: the OTP page that follows a
 * SuccessFactors registration is neither a sign-in nor a create form.
 */
export function authPageKind(snapshot) {
  const fields = Array.isArray(snapshot?.fields) ? snapshot.fields : [];
  const passwords = fields.filter((field) => field.inputType === 'password' && !isCodeField(field, fields)).length;
  if (passwords >= 2) return 'create';
  if (passwords === 1) return 'sign_in';
  return 'none';
}

/** A navigation label must say how to sign in, not combine sign-in with account creation. */
export function isExplicitSignInNavigationLabel(...values) {
  const label = values.map((value) => String(value ?? '')).filter(Boolean).join(' ')
    .replace(/\p{Cf}/gu, '').normalize('NFKC').replace(/\s+/g, ' ').trim();
  return Boolean(label) && !ACCOUNT_CREATION_ACTION_RE.test(label) && SIGN_IN_NAVIGATION_RE.test(label);
}

/** Resolve only an HTTPS route on the current portal or its verified ATS family. */
export function verifiedSignInTarget(href, currentUrl, portalHost) {
  try {
    const current = new URL(String(currentUrl || ''));
    const target = new URL(String(href || ''), current);
    if (current.protocol !== 'https:' || target.protocol !== 'https:'
      || target.username || target.password || !sameSite(target.href, portalHost)) return null;
    if (target.href === current.href) return null;
    return target.href;
  } catch {
    return null;
  }
}

const SUCCESSFACTORS_AUTH_ROUTE_PARAMS = new Set([
  'company', 'career_ns', 'career_job_req_id', 'job', 'jobid', 'login_ns', 'jobpipeline', 'lang', 'site',
]);
const SUCCESSFACTORS_LEGACY_JOB_HOST_RE = /^career5\.successfactors\.eu$/i;

function singleQueryParam(params, name) {
  const values = [...params.entries()]
    .filter(([key]) => key.toLowerCase() === name)
    .map(([, value]) => value);
  // Keep a missing parameter distinct from a present-but-empty one. The
  // latter must not be accepted as an omitted selector or identifier.
  return {
    present: values.length > 0,
    value: values.length === 1 ? values[0] : null,
  };
}

function setSingleQueryParam(url, name, value) {
  const entries = [...url.searchParams.entries()];
  let replaced = false;
  url.search = '';
  for (const [key, currentValue] of entries) {
    if (key.toLowerCase() === name) {
      if (!replaced) {
        url.searchParams.append(name, value);
        replaced = true;
      }
      continue;
    }
    url.searchParams.append(key, currentValue);
  }
  if (!replaced) url.searchParams.append(name, value);
}

/**
 * SuccessFactors can send an existing account back to a job's registration
 * route without rendering a sign-in link. The `login_ns` switch is a GET-only
 * auth navigation on that same career route; require the full job-application
 * context and reject opaque or unrecognized query parameters before deriving
 * it. This is not used for an unverified account, which must restart OTP.
 */
export function successFactorsSignInTarget(currentUrl) {
  const current = successFactorsJobApplicationRoute(currentUrl);
  if (!current) return '';
  const loginNamespace = singleQueryParam(current.searchParams, 'login_ns');
  if (!loginNamespace.present || loginNamespace.value !== 'register') return '';
  setSingleQueryParam(current, 'login_ns', 'login');
  return current.href;
}

/**
 * A SuccessFactors job route may show only its sign-in form when no
 * registration link is rendered. The job-bound `login_ns` view switch opens
 * registration without clicking a guessed control or leaving the same ATS.
 */
export function successFactorsRegistrationTarget(currentUrl) {
  const current = successFactorsJobApplicationRoute(currentUrl);
  if (!current) return '';
  const loginNamespace = singleQueryParam(current.searchParams, 'login_ns');
  if (loginNamespace.present && loginNamespace.value !== 'login') return '';
  setSingleQueryParam(current, 'login_ns', 'register');
  return current.href;
}

function successFactorsJobApplicationRoute(currentUrl) {
  try {
    const current = new URL(String(currentUrl || ''));
    if (current.protocol !== 'https:' || current.username || current.password || current.hash
      || current.pathname !== '/career' || !usesOtpAccountCreation(current.hostname)) return null;
    const params = current.searchParams;
    if ([...params.keys()].some(key => !SUCCESSFACTORS_AUTH_ROUTE_PARAMS.has(key.toLowerCase()))) return null;
    for (const key of new Set([...params.keys()].map(key => key.toLowerCase()))) {
      if ([...params.keys()].filter(candidate => candidate.toLowerCase() === key).length !== 1) return null;
    }
    const company = singleQueryParam(params, 'company');
    const namespace = singleQueryParam(params, 'career_ns');
    const requisition = singleQueryParam(params, 'career_job_req_id');
    const legacyJob = singleQueryParam(params, 'job');
    const legacyJobId = singleQueryParam(params, 'jobid');
    const loginNamespace = singleQueryParam(params, 'login_ns');
    if (!company.present || company.value === null || !company.value
      || !/^[a-z0-9][a-z0-9 _-]{0,99}$/i.test(company.value)) return null;
    if (namespace.present && (namespace.value === null || !namespace.value
      || namespace.value.toLowerCase() !== 'job_application')) return null;
    if (requisition.present && (requisition.value === null || !/^\d{1,20}$/.test(requisition.value))) return null;
    if (legacyJob.present && (legacyJob.value === null || !/^\d{1,20}$/.test(legacyJob.value))) return null;
    if (legacyJobId.present && (legacyJobId.value === null || !/^\d{1,20}$/.test(legacyJobId.value))) return null;
    if (loginNamespace.present && (loginNamespace.value === null || !loginNamespace.value)) return null;
    if ((legacyJob.value || legacyJobId.value) && !SUCCESSFACTORS_LEGACY_JOB_HOST_RE.test(current.hostname)) return null;
    // Two different vacancy identifiers are ambiguous: do not choose a first match.
    if ((requisition.value && (legacyJob.value || legacyJobId.value)) || (legacyJob.value && legacyJobId.value)) return null;
    if (!requisition.value && !legacyJob.value && !legacyJobId.value) return null;
    return current;
  } catch {
    return null;
  }
}

/**
 * The application form asks for the account's password itself (umantis for
 * Grand Hotel Kronenhof, 2026-10-03: «Email address/login», one «Password»,
 * then phone, résumé and «Submit final application»): no login page comes
 * first, the form's own send button creates the account. A sign-in or a
 * registration page never asks for a CV: the file field sent with the
 * password (the same <form>, or a page without any) tells them apart. A login
 * box next to a guest form sits in a <form> of its own and stays a login. So
 * does a password the account already has, asked inside the application's own
 * form («Login password», autocomplete "current-password"): a new password
 * typed there would only be a failed sign-in (review of #11033).
 */
export function inlineAccountForm(snapshot) {
  const sentWith = (field) => `${field.frame ?? 0}:${field.form ?? -1}`;
  const passwords = snapshot.fields.filter((field) => field.inputType === 'password');
  if (!passwords.length || passwords.some(asksExistingPassword)) return false;
  const passwordForms = new Set(passwords.map(sentWith));
  return snapshot.fields.some((field) => field.kind === 'file' && passwordForms.has(sentWith(field)));
}

// The password of an account that exists: by the browser's own hint, or by the field's words.
const EXISTING_PASSWORD_RE = /(current.?password|\blog.?in\b|\bsign.?in\b|anmeld|einlogg|\baccedi\b|\baccesso\b|connexion|aktuell|attuale|\bactuel|existing|bestehend|esistente|existant)/i;

/** A password field that asks for the one an existing account has, never for a new one. */
export function asksExistingPassword(field) {
  return String(field?.autocomplete || '').trim().toLowerCase() === 'current-password'
    || EXISTING_PASSWORD_RE.test(`${field?.label || ''} ${field?.name || ''}`);
}

// SuccessFactors refuses more than 18 characters (Coop, 2026-10-02); every
// other portal keeps the 20 it has always had.
const SHORT_PASSWORD_PORTAL_RE = /(successfactors|sapsf|jobs\.sap\.com)/i;

/** SuccessFactors creates the external candidate only after its OTP succeeds. */
export function usesOtpAccountCreation(portal = '') {
  return /(?:successfactors|sapsf)\.|jobs\.sap\.com/i.test(String(portal));
}

/**
 * The password's length on this portal (its host, or its channel id): not one
 * length for all (review of #10980). career2.successfactors.eu → 16,
 * workday → 20 (tests/assisted-application-accounts.test.ts).
 */
export function portalPasswordLength(portal = '') {
  return SHORT_PASSWORD_PORTAL_RE.test(String(portal)) ? 16 : 20;
}

/** Random base64 characters plus one of each class the usual policies ask for. */
export function newPortalPassword({ portal = '', bytes = randomBytes(24) } = {}) {
  const size = portalPasswordLength(portal) - 4;
  const core = bytes.toString('base64').replace(/[^A-Za-z0-9]/g, '').slice(0, size);
  if (core.length < size) throw new Error('password_entropy');
  return `${core}Aa7!`;
}

/** Firestore map key for a host (no dots in a field name). */
export function hostKey(host) {
  // Same rule as the backend's reader of this map (functions/src/lib/applicationExistsReconciliation.js).
  return portalAccountHostKey(host);
}

const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value || {}, key);

/**
 * Pre-marker inbox documents have no authenticated-source marker. Do not
 * invent one: the bounded compatibility proof is the old persisted primary
 * host, an exact HTTPS URL, the same order's inbox path and a fresh receipt,
 * with the current pending account read again from Firestore. Schema/tenant
 * fields in the old JSON are not authority and cannot broaden this path.
 */
function legacyVerificationUrl(message, host, sinceMs) {
  if (hasOwn(message, 'portalVerificationHost') || message.category !== 'verification') return '';
  const normalizedHost = String(host || '').toLowerCase();
  if (typeof message.host !== 'string' || message.host.toLowerCase() !== normalizedHost) return '';
  const receivedAt = Number(message.receivedAt);
  if (!Number.isFinite(receivedAt) || receivedAt < sinceMs) return '';
  // An explicit failed-authentication signal is counterproof, never a value
  // to overwrite with true. Absence is handled only by the host/URL proof.
  if (message.senderAuthenticated === false || message.authenticated === false || message.senderAuth === false) return '';
  return exactPortalVerificationUrl(message.verificationUrl, normalizedHost);
}

// sameSite stays exported for compatibility. Opening verification links uses
// the exact account host and the inbound handler's validated host binding.
export { sameSite };

export function accountsRefFor(db, orderId) {
  return db.collection(ASSISTED_APPLICATIONS_COLLECTION).doc(String(orderId)).collection('automation').doc(PORTAL_ACCOUNTS_DOC_ID);
}

/**
 * The account store bound to one order: what submitViaPortal receives as
 * `ctx.accounts` (tests inject their own).
 */
export function portalAccountStore({ db, orderId, key, mask = () => {}, nowMs = () => Date.now(), sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) }) {
  const ref = accountsRefFor(db, orderId);
  const inbox = db.collection(ASSISTED_APPLICATIONS_COLLECTION).doc(String(orderId)).collection('inbox');
  /** The first not-yet-used reset message of this exact recovery request (bound by its request id), or null. */
  const unusedResetMessage = async (account, normalizedHost, since) => {
    const used = new Set(Array.isArray(account?.recoveryConsumedMessageIds) ? account.recoveryConsumedMessageIds.map(String) : []);
    const snapshot = await inbox.where('receivedAt', '>=', since).get();
    for (const doc of snapshot.docs) {
      const message = doc.data();
      if (used.has(doc.id) || String(message.passwordResetHost || '').toLowerCase() !== normalizedHost
        || message.passwordResetRequestId !== account.recoveryRequestId) continue;
      const receivedAt = Number(message.receivedAt);
      if (!Number.isFinite(receivedAt) || receivedAt <= since) continue;
      let url = '';
      let temporaryPassword = '';
      try {
        const payload = decryptJson(message.passwordResetLinkEnc, key);
        url = payload?.url || '';
        if (typeof payload?.temporaryPassword === 'string' && !/[\r\n]/.test(payload.temporaryPassword)) {
          temporaryPassword = payload.temporaryPassword;
        }
      } catch {
        url = '';
        temporaryPassword = '';
      }
      url = exactPortalVerificationUrl(url, normalizedHost);
      if (!url && !temporaryPassword) continue;
      if (url) mask(url);
      if (temporaryPassword) mask(temporaryPassword);
      return {
        ...(url ? { url } : {}),
        ...(temporaryPassword ? { temporaryPassword } : {}),
        messageId: doc.id,
        receivedAt,
      };
    }
    return null;
  };
  return {
    /** A password typed but never stored (a dry run's) is masked in the log all the same. */
    mask,
    async load(host) {
      const entry = (await ref.get()).data()?.[hostKey(host)];
      if (!entry?.passwordEnc) {
        if (entry?.status !== 'exists_unknown_password') return null;
        return { email: null, password: null, createdAt: entry.at || null, verifiedAt: entry.verifiedAt || null, status: entry.status };
      }
      const { password } = decryptJson(entry.passwordEnc, key);
      mask(password);
      // A recovery whose reset the portal never confirmed leaves the staged password in place and the one that
      // was valid in `recoveryPrevious`: it is lost to every reader that looks only at `password`.
      let previousPassword = '';
      if (entry.status === 'recovering' && entry.recoveryPrevious?.passwordEnc) {
        try {
          previousPassword = decryptJson(entry.recoveryPrevious.passwordEnc, key)?.password || '';
          if (previousPassword) mask(previousPassword);
        } catch { previousPassword = ''; }
      }
      // The last password that made a verified sign-in (mark() keeps it): never overwritten by a staged one.
      let lastGoodPassword = '';
      if (entry.lastGoodPasswordEnc) {
        try {
          lastGoodPassword = decryptJson(entry.lastGoodPasswordEnc, key)?.password || '';
          if (lastGoodPassword) mask(lastGoodPassword);
        } catch { lastGoodPassword = ''; }
      }
      return {
        ...(previousPassword && previousPassword !== password ? { previousPassword } : {}),
        ...(lastGoodPassword && lastGoodPassword !== password && lastGoodPassword !== previousPassword ? { lastGoodPassword } : {}),
        email: entry.email,
        password,
        createdAt: entry.createdAt || null,
        verifiedAt: entry.verifiedAt || null,
        status: entry.status || null,
        ...(Number.isFinite(Number(entry.recoveryRequestedAt)) ? { recoveryRequestedAt: Number(entry.recoveryRequestedAt) } : {}),
        ...(entry.recoveryRequestId ? { recoveryRequestId: String(entry.recoveryRequestId) } : {}),
        ...(entry.recoveryApplicationCheckRequired === true ? { recoveryApplicationCheckRequired: true } : {}),
      };
    },
    /** Before the "create account" click: `pending` until the portal confirms it. */
    async save(host, { email, password, securityQuestions = null }) {
      mask(password);
      for (const item of Array.isArray(securityQuestions) ? securityQuestions : []) {
        if (item?.answer) mask(item.answer);
      }
      await ref.set({
        [hostKey(host)]: {
          host: String(host).toLowerCase(),
          email,
          passwordEnc: encryptJson({ password }, key),
          ...(Array.isArray(securityQuestions) && securityQuestions.length
            ? { securityQuestionsEnc: encryptJson({ securityQuestions }, key) }
            : {}),
          status: 'pending',
          createdAt: nowMs(),
          verifiedAt: null,
          lastSignInAt: null,
        },
      }, { merge: true });
    },
    /**
     * The portal refused the registration (validation error, still on the
     * form): no account exists, so the next run creates it again instead of
     * signing in. The password envelope goes; the entry stays as a trace.
     */
    async discard(host, reason = '') {
      const current = (await ref.get()).data()?.[hostKey(host)];
      if (!current) return;
      await ref.set({ [hostKey(host)]: { ...current, passwordEnc: null, status: 'discarded', discardedAt: nowMs(), discardReason: String(reason).slice(0, 80) } }, { merge: true });
    },
    /** Replace the just-generated credential with an explicit unknown-password state. */
    async recordExistingUnknownPassword(host) {
      await ref.set({
        [hostKey(host)]: {
          host: String(host).toLowerCase(),
          email: null,
          passwordEnc: null,
          status: 'exists_unknown_password',
          at: nowMs(),
          createdAt: null,
          verifiedAt: null,
          lastSignInAt: null,
        },
      }, { merge: true });
    },
    /** Store a fresh credential before a password-reset request can leave the browser. */
    async beginRecovery(host, { email, password }) {
      const normalizedHost = String(host || '').toLowerCase();
      const normalizedEmail = String(email || '').trim().toLowerCase();
      if (!normalizedHost || !aliasLocalPart(normalizedEmail) || !password) return { status: 'rejected' };
      mask(password);
      const entryKey = hostKey(normalizedHost);
      let result = { status: 'missing' };
      await db.runTransaction(async (transaction) => {
        const accounts = (await transaction.get(ref)).data() || {};
        const current = accounts[entryKey];
        const allowedStatuses = new Set(['exists_unknown_password', 'created', 'pending', 'unanswered', 'recovering', 'recovery_rejected']);
        if (!current || String(current.host || '').toLowerCase() !== normalizedHost || !allowedStatuses.has(current.status)) {
          result = { status: 'missing' };
          return;
        }
        const now = nowMs();
        const requests = (Array.isArray(current.recoveryRequestTimes) ? current.recoveryRequestTimes : [])
          .map(Number).filter((at) => Number.isFinite(at) && at > now - RECOVERY_WINDOW_MS);
        if (current.status === 'recovering' && Number(current.recoveryRequestedAt) > now - RECOVERY_BACKOFF_MS[0]) {
          result = { status: 'in_progress', requestedAt: Number(current.recoveryRequestedAt) || 0 };
          return;
        }
        if (requests.length >= 2) {
          // The window frees when the second-to-last request leaves it.
          result = { status: 'rate_limited', retryAt: requests[requests.length - 2] + RECOVERY_WINDOW_MS };
          return;
        }
        const nextAllowedAt = Number(current.recoveryNextAllowedAt) || 0;
        if (now < nextAllowedAt) {
          result = { status: 'cooldown', retryAt: nextAllowedAt };
          return;
        }
        const requestId = randomUUID();
        const attempt = requests.length + 1;
        transaction.set(ref, {
          [entryKey]: {
            ...current,
            host: normalizedHost,
            email: normalizedEmail,
            passwordEnc: encryptJson({ password }, key),
            status: 'recovering',
            verifiedAt: null,
            recoveryPrevious: current.status === 'recovering' && current.recoveryPrevious
              ? current.recoveryPrevious : {
              email: current.email || null,
              passwordEnc: current.passwordEnc || null,
              status: current.status,
              createdAt: current.createdAt || null,
              verifiedAt: current.verifiedAt || null,
              recoveryApplicationCheckRequired: current.recoveryApplicationCheckRequired === true,
              },
            recoveryApplicationCheckRequired: true,
            recoveryRequestTimes: [...requests, now],
            recoveryRequestedAt: now,
            recoveryRequestId: requestId,
            recoveryRequestAttempt: attempt,
            recoveryNextAllowedAt: now + RECOVERY_BACKOFF_MS[Math.min(attempt - 1, RECOVERY_BACKOFF_MS.length - 1)],
            recoveryFailure: null,
          },
        }, { merge: true });
        result = { status: 'started', requestId, requestedAt: now, attempt };
      });
      return result;
    },
    /** Restore/clear the staged credential after a definite no-click or portal refusal. */
    async abortRecovery(host, { requestSubmitted = false, reason = '' } = {}) {
      const entryKey = hostKey(host);
      let result = false;
      await db.runTransaction(async (transaction) => {
        const accounts = (await transaction.get(ref)).data() || {};
        const current = accounts[entryKey];
        if (!current || current.status !== 'recovering') return;
        const previous = current.recoveryPrevious && typeof current.recoveryPrevious === 'object'
          ? current.recoveryPrevious : null;
        const requestAt = Number(current.recoveryRequestedAt);
        const requestTimes = (Array.isArray(current.recoveryRequestTimes) ? current.recoveryRequestTimes : [])
          .map(Number).filter((at) => Number.isFinite(at) && (requestSubmitted || at !== requestAt));
        transaction.set(ref, {
          [entryKey]: {
            ...current,
            ...(previous ? {
              email: previous.email || null,
              passwordEnc: previous.passwordEnc || null,
              status: previous.status || 'exists_unknown_password',
              createdAt: previous.createdAt || null,
              verifiedAt: previous.verifiedAt || null,
            } : { email: null, passwordEnc: null, status: 'exists_unknown_password', verifiedAt: null }),
            recoveryPrevious: null,
            recoveryRequestTimes: requestTimes,
            recoveryRequestedAt: null,
            recoveryRequestId: null,
            recoveryRequestAttempt: null,
            recoveryNextAllowedAt: requestSubmitted ? current.recoveryNextAllowedAt : null,
            recoveryFailure: requestSubmitted ? String(reason || 'rejected').slice(0, 40) : null,
            recoveryFailedAt: requestSubmitted ? nowMs() : null,
            recoveryApplicationCheckRequired: requestSubmitted || previous?.recoveryApplicationCheckRequired === true,
          },
        }, { merge: true });
        result = true;
      });
      return result;
    },
    /** Make the reset credential the pending account credential after the portal accepts it. */
    async completeRecovery(host, { password = '' } = {}) {
      const entryKey = hostKey(host);
      const overridePassword = typeof password === 'string' && !/[\r\n]/.test(password) ? password : '';
      if (overridePassword) mask(overridePassword);
      let result = false;
      await db.runTransaction(async (transaction) => {
        const accounts = (await transaction.get(ref)).data() || {};
        const current = accounts[entryKey];
        if (!current || current.status !== 'recovering' || (!current.passwordEnc && !overridePassword)) return;
        transaction.set(ref, {
          [entryKey]: {
            ...current,
            ...(overridePassword ? { passwordEnc: encryptJson({ password: overridePassword }, key) } : {}),
            status: 'pending',
            verifiedAt: null,
            recoveryCompletedAt: nowMs(),
            recoveryPrevious: null,
            recoveryFailure: null,
          },
        }, { merge: true });
        result = true;
      });
      return result;
    },
    /** Only the authenticated inbound claimant for this exact reset request can supply a link or temp password. */
    async waitForPasswordReset({ host, sinceMs, timeoutMs = PASSWORD_RESET_TIMEOUT_MS }) {
      const normalizedHost = String(host || '').toLowerCase();
      const since = Number(sinceMs);
      if (!normalizedHost || !Number.isFinite(since)) return null;
      const deadline = nowMs() + timeoutMs;
      while (nowMs() < deadline) {
        const account = (await ref.get()).data()?.[hostKey(normalizedHost)];
        if (account?.status !== 'recovering' || Number(account.recoveryRequestedAt) !== since) return null;
        const found = await unusedResetMessage(account, normalizedHost, since);
        if (found) return found;
        await sleep(VERIFICATION_POLL_MS);
      }
      return null;
    },
    /**
     * The portal's reset e-mail of the recovery in progress, when it already arrived and nobody used its link:
     * no waiting. A run that died after the request left (or read the e-mail and failed before the new password
     * was set) finds it here, whatever the cooldown on a NEW request says.
     */
    async pendingPasswordReset(host) {
      const normalizedHost = String(host || '').toLowerCase();
      const account = (await ref.get()).data()?.[hostKey(normalizedHost)];
      const since = Number(account?.recoveryRequestedAt);
      if (!normalizedHost || account?.status !== 'recovering' || !Number.isFinite(since) || since <= 0) return null;
      return unusedResetMessage(account, normalizedHost, since);
    },
    /** A reset link is used once: recorded before it is opened, so a retry never opens it again. */
    async consumePasswordReset(host, messageId) {
      const entryKey = hostKey(host);
      const id = String(messageId || '').slice(0, 200);
      if (!id) return false;
      let result = false;
      await db.runTransaction(async (transaction) => {
        const current = ((await transaction.get(ref)).data() || {})[entryKey];
        if (!current) return;
        const used = Array.isArray(current.recoveryConsumedMessageIds) ? current.recoveryConsumedMessageIds.map(String) : [];
        if (used.includes(id)) return;
        transaction.set(ref, { [entryKey]: { ...current, recoveryConsumedMessageIds: [...used, id].slice(-10) } }, { merge: true });
        result = true;
      });
      return result;
    },
    /** One-shot reuse of a fresh exact-host activation link from the recovery window. */
    async recoveryActivation({ host, sinceMs }) {
      const normalizedHost = String(host || '').toLowerCase();
      const requestedAt = Number(sinceMs);
      if (!normalizedHost || !Number.isFinite(requestedAt)) return null;
      const snapshot = await inbox.where('receivedAt', '>=', requestedAt - RECOVERY_ACTIVATION_LOOKBACK_MS).get();
      for (const doc of snapshot.docs) {
        const message = doc.data();
        if (message.category !== 'verification') continue;
        const receivedAt = Number(message.receivedAt);
        if (!Number.isFinite(receivedAt) || receivedAt < requestedAt - RECOVERY_ACTIVATION_LOOKBACK_MS) continue;
        const claimedAfterRequest = String(message.portalVerificationHost || '').toLowerCase() === normalizedHost
          && receivedAt > requestedAt;
        const oldAuthenticatedMessage = receivedAt <= requestedAt
          && message.senderAuthenticated === true
          && String(message.sourceVerificationLinkHost || '').toLowerCase() === normalizedHost;
        if (!claimedAfterRequest && !oldAuthenticatedMessage) continue;
        let candidateUrl = message.verificationUrl;
        if (oldAuthenticatedMessage && message.sourceVerificationLinkEnc) {
          try { candidateUrl = decryptJson(message.sourceVerificationLinkEnc, key)?.url || ''; } catch { candidateUrl = ''; }
        }
        const url = exactPortalVerificationUrl(candidateUrl, normalizedHost);
        if (!url) continue;
        mask(url);
        return { url, messageId: doc.id, receivedAt };
      }
      return null;
    },
    async mark(host, patch) {
      const current = (await ref.get()).data()?.[hostKey(host)];
      if (!current) return;
      // A verified sign-in proves the stored password: keep it apart, so a later staged password (a recovery that
      // never completed) cannot be the only one left.
      const verified = Boolean(patch?.verifiedAt) && Boolean(current.passwordEnc) && current.status !== 'recovering';
      await ref.set({ [hostKey(host)]: { ...current, ...patch, ...(verified ? { lastGoodPasswordEnc: current.passwordEnc, lastGoodAt: nowMs() } : {}) } }, { merge: true });
    },
    /**
     * The new passwords the portal e-mailed to the alias after a reset request, newest first. A portal that
     * resets the password the moment the request is sent (umantis: «Durch einen Klick auf Senden wird Ihr Passwort
     * zurückgesetzt») holds the NEWEST of them, even when the run that asked never read the e-mail.
     */
    async resetPasswordCandidates(host, { limit = 3 } = {}) {
      const normalizedHost = String(host || '').toLowerCase();
      const snapshot = await inbox.get();
      const found = [];
      for (const doc of snapshot.docs) {
        const message = doc.data();
        if (String(message.passwordResetHost || '').toLowerCase() !== normalizedHost || !message.passwordResetLinkEnc) continue;
        try {
          const payload = decryptJson(message.passwordResetLinkEnc, key);
          const secret = typeof payload?.temporaryPassword === 'string' && !/[\r\n]/.test(payload.temporaryPassword) ? payload.temporaryPassword : '';
          if (secret) found.push({ secret, receivedAt: Number(message.receivedAt) || 0 });
        } catch { /* An unreadable message is no candidate. */ }
      }
      const ordered = [...new Map(found.sort((left, right) => right.receivedAt - left.receivedAt).map(item => [item.secret, item])).values()];
      for (const item of ordered) mask(item.secret);
      return ordered.slice(0, Math.max(0, limit)).map(item => item.secret);
    },
    /** A password the portal accepted in a sign-in: stored as the account's, the recovery state cleared. */
    async adoptPassword(host, password) {
      const entryKey = hostKey(host);
      if (typeof password !== 'string' || !password || /[\r\n]/.test(password)) return false;
      mask(password);
      let result = false;
      await db.runTransaction(async (transaction) => {
        const current = ((await transaction.get(ref)).data() || {})[entryKey];
        if (!current) return;
        transaction.set(ref, { [entryKey]: {
          ...current,
          passwordEnc: encryptJson({ password }, key),
          lastGoodPasswordEnc: encryptJson({ password }, key),
          lastGoodAt: nowMs(),
          status: 'created',
          verifiedAt: nowMs(),
          recoveryPrevious: null,
          recoveryRequestedAt: null,
          recoveryRequestId: null,
          recoveryFailure: null,
        } }, { merge: true });
        result = true;
      });
      return result;
    },
    /** Message ids already present before a portal asks us to resend a code. */
    async verificationMessageIds() {
      const snapshot = await inbox.get();
      return snapshot.docs.filter((doc) => doc.data()?.category === 'verification').map((doc) => doc.id);
    },
    /**
     * The first verification message classified by the inbound handler after
     * `sinceMs` bound by inbound to this exact account host.
     */
    /**
     * The portal's own «account created/activated» mail for this exact host,
     * received after `sinceMs` and bound by the inbound handler
     * (`portalAccountNoticeHost`): proof that the account exists. Never a link to open.
     */
    async accountNotice({ host, sinceMs }) {
      const normalizedHost = String(host || '').toLowerCase();
      const since = Number(sinceMs);
      if (!normalizedHost || !Number.isFinite(since)) return null;
      const snapshot = await inbox.where('receivedAt', '>=', since).get();
      for (const doc of snapshot.docs) {
        const message = doc.data();
        if (String(message.portalAccountNoticeHost || '').toLowerCase() !== normalizedHost) continue;
        if (!PORTAL_ACCOUNT_NOTICES_CONFIRMING.includes(message.portalAccountNotice)) continue;
        const receivedAt = Number(message.receivedAt);
        if (Number.isFinite(receivedAt) && receivedAt >= since) return { messageId: doc.id, kind: message.portalAccountNotice, receivedAt };
      }
      return null;
    },
    async waitForAccountNotice({ host, sinceMs, timeoutMs = ACCOUNT_NOTICE_TIMEOUT_MS }) {
      const deadline = nowMs() + timeoutMs;
      for (;;) {
        const notice = await this.accountNotice({ host, sinceMs });
        if (notice || nowMs() >= deadline) return notice;
        await sleep(VERIFICATION_POLL_MS);
      }
    },
    async waitForVerification({ host, sinceMs, timeoutMs = VERIFICATION_TIMEOUT_MS, excludeMessageIds = [] }) {
      const excluded = new Set(excludeMessageIds);
      const normalizedHost = String(host || '').toLowerCase();
      const since = Number(sinceMs);
      if (!normalizedHost || !Number.isFinite(since)) return null;
      const deadline = nowMs() + timeoutMs;
      while (nowMs() < deadline) {
        const account = currentPendingPortalAccount((await ref.get()).data(), normalizedHost);
        if (account) {
          const snapshot = await inbox.where('receivedAt', '>=', since).get();
          for (const doc of snapshot.docs) {
            if (excluded.has(doc.id)) continue;
            const message = doc.data();
            const hasMarker = hasOwn(message, 'portalVerificationHost');
            if (message.category !== 'verification') continue;
            const receivedAt = Number(message.receivedAt);
            if (!Number.isFinite(receivedAt) || receivedAt < since) continue;
            if (hasMarker && String(message.portalVerificationHost || '').toLowerCase() !== normalizedHost) continue;
            const createdAt = Number(account.createdAt);
            if (!hasMarker && Number.isFinite(createdAt) && createdAt > receivedAt) continue;
            const url = hasMarker
              ? exactPortalVerificationUrl(message.verificationUrl, normalizedHost)
              : legacyVerificationUrl(message, normalizedHost, since);
            const code = hasMarker ? String(message.verificationCode || '') : '';
            if (url || code) {
              mask(url);
              mask(code);
              return { url, code, messageId: doc.id };
            }
          }
        }
        await sleep(VERIFICATION_POLL_MS);
      }
      return null;
    },
  };
}

/** The field asks for a verification code (plain or masked), not for a postal, phone or account secret. */
function isCodeField(field, fields = []) {
  const label = `${field.label} ${field.name}`.replace(OTHER_CODE_RE, ' ');
  if (!CODE_FIELD_RE.test(label)) return false;
  if (field.kind === 'text' && field.inputType !== 'password') return true;
  if (field.inputType !== 'password') return false;
  return PASSWORD_CODE_FIELD_RE.test(label)
    || (BARE_CODE_LABEL_RE.test(String(field.label ?? '')) && !loginIdentityField(fields));
}

export function codeField(snapshot) {
  return snapshot.fields.find((field) => isCodeField(field, snapshot.fields)) || null;
}

/** The e-mail or user name a sign-in form asks for. */
function loginIdentityField(fields) {
  return fields.find((field) => field.inputType === 'email')
    || fields.find((field) => field.kind === 'text' && field.inputType !== 'password' && /e-?mail|benutzer|user|login/i.test(`${field.label} ${field.name} ${field.autocomplete}`))
    || null;
}

export function loginFields(snapshot) {
  const password = snapshot.fields.find((field) => field.inputType === 'password') || null;
  const email = loginIdentityField(snapshot.fields);
  return { email, password };
}
