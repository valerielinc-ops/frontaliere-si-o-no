/** Application stages are proved by the page's controls and instructions, never its URL alone. */
import { avaturePortalDirectory, avaturePostingJobKey, sameAvaturePortal } from './protocol.mjs';
import { isCvDocumentLabel } from './document-labels.mjs';
import { CONFIRM_RE, NEXT_RE, REFUSED_RE, SUBMIT_RE } from './fill.mjs';

// Match the complete route relative to the proved source directory, never a
// suffix under an unknown parent such as ApplicationSave/ApplicationReview.
const REVIEW_PATH_RE = /^(?:application\/|application)?(?:review|preview|summary)\/?$/i;
const PROFILE_CONTINUATION_RE = /(?:already submitted your personal information|(?:account|profile|personal information) (?:has been |was |is )?(?:created|saved|updated)).{0,300}(?:application|apply|review|continue)/i;
const NOT_SUBMITTED_APPLICATION_RE = new RegExp([
  String.raw`\bapplication\b.{0,120}\b(?:(?:has|was|is)(?:\s+(?:not|n['’]t)|n['’]t)\s+(?:been\s+)?(?:submitted|sent|received|completed)|not\s+(?:yet\s+)?(?:submitted|sent|received|completed))\b`,
  String.raw`\bbewerbung\b.{0,120}\b(?:nicht|noch nicht)\b.{0,60}\b(?:eingereicht|gesendet|übermittelt|abgeschickt|abgeschlossen)\b`,
  String.raw`\bcandidatura\b.{0,120}\bnon\b.{0,60}\b(?:inviata|presentata|trasmessa|completata)\b`,
  String.raw`\bcandidature\b.{0,120}\bn['’](?:a pas été|est pas)(?=$|[^\p{L}\p{N}]).{0,60}\b(?:envoyée|soumise|transmise|terminée)(?=$|[^\p{L}\p{N}])`,
].join('|'), 'iu');
const INCOMPLETE_APPLICATION_RE = new RegExp([
  String.raw`\b(?:continue|resume|proceed|complete|finish)(?:\s+(?:your|the|this|my|a|an|with|to|and|filling|out|online|job|current|next|rest|application|process)){0,8}\s+\b(?:application|candidature|bewerbung)\b`,
  String.raw`\b(?:incomplete|unfinished)\s+(?:job\s+)?application\b`,
  String.raw`\bapplication\b.{0,120}\b(?:incomplete|unfinished|not (?:yet )?(?:complete|finished|submitted|sent)|has not been (?:completed|submitted|sent)|still (?:needs|requires) completion|to be completed|to complete)\b`,
  String.raw`\bbewerbung\b.{0,120}\b(?:unvollständig(?:e|en)?|nicht (?:vollständig|abgeschlossen|eingereicht|gesendet|fertig)|noch nicht (?:abgeschlossen|eingereicht|vollständig|fertig)|fortsetzen|vervollständigen)\b`,
  String.raw`\bcandidature\b.{0,120}\b(?:incomplète|inachevée|pas encore (?:terminée|envoyée|complète|soumise)|n['’]est pas (?:encore )?(?:complète|terminée|envoyée|soumise)|(?:à|a) compléter|poursuivre|compléter)(?=$|[^\p{L}\p{N}])`,
  String.raw`\bcandidatura\b.{0,120}\b(?:incomplet[ao]|non (?:è|e')\s+(?:ancora\s+)?(?:stata\s+)?(?:completat[ao]|inviat[ao]|complet[ao])|non (?:ancora\s+)?(?:completat[ao]|inviat[ao]|complet[ao])|da completare|continua|completa|prosegui)\b`,
].join('|'), 'iu');
const DOCUMENT_ROLE_LABEL_RE = /\b(?:resume|cv|curriculum\s+vitae|lebenslauf)\s*\/\s*(?:resume|cv|curriculum\s+vitae|lebenslauf)\b|\bresume\s*(?:[*:])(?=\s|$)/gi;
const APPLICATION_REFERENCE_RE = /\b(?:application|candidatur[ae]|bewerbung)\b/iu;
const APPLICATION_ANAPHORIC_INCOMPLETE_RE = new RegExp([
  String.raw`^\s*(?:(?:it|this|that)\s+)?(?:(?:is|remains|was)\s+)?(?:(?:still\s+)?(?:incomplete|unfinished)|not\s+(?:yet\s+)?(?:complete|finished|submitted|sent)|(?:still\s+)?(?:needs|requires)\s+completion)\b`,
  String.raw`^\s*(?:sie|diese)\s+(?:(?:ist|bleibt|war)\s+)?(?:(?:noch\s+)?(?:unvollständig|unvollstaendig|unvollendet)|nicht\s+(?:vollständig|vollstaendig|abgeschlossen|eingereicht|gesendet|fertig))\b`,
  String.raw`^\s*(?:questa\s+)?(?:(?:è|e')\s+(?:ancora\s+)?(?:incomplet[ao]|da\s+completare)|(?:non\s+è|non\s+e')\s+(?:ancora\s+)?(?:complet[ao]|(?:stata\s+)?completat[ao]|inviat[ao]))\b`,
  String.raw`^\s*(?:elle|cette)\s+(?:(?:est|reste|était)\s+)?(?:(?:encore\s+)?(?:incomplète|inachevée)|n['’]est\s+pas\s+(?:encore\s+)?(?:complète|terminée|envoyée|soumise))(?=$|[^\p{L}\p{N}])`,
].join('|'), 'iu');
const APPLICATION_ANAPHORIC_BRIDGE_RE = new RegExp([
  String.raw`^\s*(?:it|this|that)\s+(?:(?:is|was|has been|remains|will be)\s+)?(?:saved|submitted|received|created|updated|ready\b|available\b|processed\b)`,
  String.raw`^\s*(?:sie|diese)\s+(?:(?:wurde|ist|bleibt|war)\s+)?(?:gespeichert|eingereicht|erhalten|bereit|verfügbar|aktualisiert)`,
  String.raw`^\s*(?:(?:essa|questa)\s+)?(?:(?:è stata|e' stata|è|e'|rimane|era)\s+)?(?:salvata|registrata|inviata|ricevuta|pronta|disponibile|aggiornata)`,
  String.raw`^\s*elle\s+(?:(?:a été|est|reste|était)\s+)?(?:enregistrée|envoyée|reçue|prête|disponible|mise à jour)`,
].join('|'), 'iu');
const REVIEW_INSTRUCTIONS_RE = /(?:please )?review (?:the |your )?information.{0,600}(?:select|click|press).{0,50}(?:submit|apply).{0,80}(?:finali[sz]e|send|submit|complete).{0,40}(?:application|candidature)/i;
const BEFORE_SEND_RE = /(?:review|check).{0,160}(?:before (?:you )?(?:submit|send|apply)|next (?:step|page))/i;
const GENERIC_APPLY_RE = /^(?:apply(?: now)?|bewerben|jetzt bewerben|candidati(?: ora)?|applica|postuler)\W*$/i;
const APPLICANT_IDENTITY_LABEL_RE = /^(?:e-?mail|first name|last name|nome|cognome|vorname|nachname)\b/i;
const GRAVITY_FORMS_RECEIPT_RE = new RegExp([
  String.raw`\bthank\s+you\s+for\s+your\s+application\b`,
  String.raw`\byour\s+application\s+(?:has\s+been\s+)?received\b`,
  String.raw`\bapplication\s+(?:has\s+been\s+)?successfully\s+submitted\b`,
  String.raw`\bvielen\s+dank\s+f(?:ü|ue)r\s+(?:ihre|deine)\s+bewerbung\b`,
  String.raw`\bihre\s+bewerbung\s+ist\s+eingegangen\b`,
  String.raw`\bbewerbung\s+(?:wurde|ist)\s+(?:erfolgreich\s+)?(?:eingereicht|übermittelt|uebermittelt|eingegangen)\b`,
  String.raw`\bmerci\s+pour\s+votre\s+candidature\b`,
  String.raw`\bvotre\s+candidature\s+(?:a\s+été\s+)?(?:reçue|recu|envoyée|envoyee|transmise)\b`,
  String.raw`\bgrazie\s+per\s+la\s+candidatura\b`,
  String.raw`\bla\s+tua\s+candidatura\s+(?:è\s+stata\s+)?(?:ricevuta|inviata|inoltrata)\b`,
  String.raw`\babbiamo\s+ricevuto\s+la\s+tua\s+candidatura\b`,
].join('|'), 'iu');

function gravityFormKey(value) {
  const match = /^(?:gform_(?:confirmation_message_|confirmation_wrapper_|wrapper_)?)(\d+)$/i.exec(String(value || '').trim());
  return match ? `gform_${match[1]}` : '';
}

/** The same posting-bound final-review test is shared by the runner and encrypted-evidence repair. */
export function finalReviewStageChecks(snapshot, { url = snapshot?.url, applyUrl, sourceProtocol = null } = {}) {
  return {
    routeBound: Boolean(boundRoute(url, applyUrl, sourceProtocol)),
    reviewInstructions: REVIEW_INSTRUCTIONS_RE.test(String(snapshot?.text || '')),
  };
}

/**
 * SuccessFactors prefixes required labels with a visual marker (for example
 * "* E-Mail") while keeping the control itself as a plain text input. Strip
 * only that marker before checking the semantic identity label; an arbitrary
 * nearby field must not substitute for applicant identity.
 */
function applicantIdentityLabel(value) {
  return String(value || '').normalize('NFKC').replace(/\p{Cf}/gu, '').replace(/\s+/gu, ' ').trim()
    .replace(/^(?:[*•·]\s*)+/u, '').trim();
}

function isApplicantIdentity(field) {
  return field?.inputType === 'email' || APPLICANT_IDENTITY_LABEL_RE.test(applicantIdentityLabel(field?.label));
}

function applicantIdentityKind(field) {
  const label = applicantIdentityLabel(field?.label);
  if (field?.inputType === 'email' || /^e-?mail\b/i.test(label)) return 'email';
  if (/^(?:first name|given name|forename|vorname|nome)\b/i.test(label)) return 'first_name';
  if (/^(?:last name|surname|family name|nachname|cognome)\b/i.test(label)) return 'last_name';
  return '';
}

function applicationFormKey(control) {
  const formId = String(control?.formId || '').trim();
  return formId ? `${Number(control?.frame || 0)}\u0000${formId}` : '';
}

function sameDocumentFragment(href, url) {
  if (!String(href || '').includes('#')) return false;
  const current = parsed(url);
  if (!current) return false;
  let destination;
  try { destination = new URL(href, current.href); } catch { return false; }
  return Boolean(destination && current.origin === destination.origin
    && current.pathname === destination.pathname && current.search === destination.search);
}

/**
 * A bare Apply link is an in-page opener only when the same frame contains a
 * single applicant form with its own step or send control. Ambiguous links
 * remain visible to the stage classifier as unknown Apply actions.
 */
export function inPageApplicationOpeners(snapshot, url = snapshot?.url) {
  const buttons = Array.isArray(snapshot?.buttons) ? snapshot.buttons : [];
  const fields = Array.isArray(snapshot?.fields) ? snapshot.fields : [];
  const identityKindsByForm = new Map();
  const cvForms = new Set();
  const uploadedRequiredFileForms = new Set();
  for (const field of fields) {
    const inputType = String(field?.inputType || '').toLowerCase();
    if (field?.disabled || ['hidden', 'submit', 'button', 'reset', 'image'].includes(inputType)) continue;
    const form = applicationFormKey(field);
    if (!form) continue;
    const isFile = field?.kind === 'file' || String(field?.inputType || '').toLowerCase() === 'file';
    if (isFile && isCvDocumentLabel(field?.label)) cvForms.add(form);
    if (isFile && field?.required === true && snapshot?.uploadedCv === true) uploadedRequiredFileForms.add(form);
    if (isApplicantIdentity(field)) {
      const kind = applicantIdentityKind(field);
      if (!kind) continue;
      if (!identityKindsByForm.has(form)) identityKindsByForm.set(form, new Set());
      identityKindsByForm.get(form).add(kind);
    }
  }
  // A single e-mail field and an adjacent Submit/Weiter control are common
  // newsletter/contact forms, not enough evidence to hide the posting CTA.
  const identityForms = new Set([...identityKindsByForm]
    .filter(([, kinds]) => kinds.size >= 2).map(([form]) => form));
  const applicationForms = new Set([...identityForms, ...cvForms, ...uploadedRequiredFileForms]);
  const qualifyingForms = new Set(buttons
    .filter((button) => !button?.chrome && !button?.disabled && !button?.href && !button?.leavesDocument
      && (NEXT_RE.test(String(button?.text || '')) || SUBMIT_RE.test(String(button?.text || ''))))
    .map(applicationFormKey).filter((key) => key && applicationForms.has(key)));
  if (qualifyingForms.size !== 1) return [];
  const [applicationForm] = qualifyingForms;
  const applicationFrame = Number(applicationForm.split('\u0000', 1)[0]);
  return buttons.filter((button) => Number(button?.frame || 0) === applicationFrame
    && !String(button?.formId || '').trim()
    && GENERIC_APPLY_RE.test(String(button?.text || ''))
    && !button?.leavesDocument
    && (!button?.href || sameDocumentFragment(button.href, url)));
}

// A SuccessFactors profile/application page may keep the CV in «Meine
// Dokumente» and expose no file input in the current snapshot. Only a
// question-specific label/name may prove the same form; section headings,
// context inherited from an ancestor, and arbitrary profile text do not.
const APPLICATION_QUESTION_RE = /(?:work\s+permit|permit\s+for|salary\s+expectations?|expected\s+salary|workload(?=[^?？]{0,100}[?？])|starting\s+date|earliest\s+start|notice\s+period|how\s+did\s+you\s+hear|motivat(?:ion|ed).{0,80}(?:apply|position|role|stelle|poste|posto|candidatur)|experience.{0,80}(?:position|role|stelle|job|poste|posto|emploi)|nebenbeschäftigung|brutto[-\s]jahreslohn(?:vorstellung)?|wie\s+haben\s+sie\s+von\s+dieser\s+stelle\s+erfahren|was\s+hat\s+dich\s+motiviert|welche\s+erfahrungen|salaire.{0,80}(?:attendu|souhait)|rémunération.{0,80}(?:attendue|souhait)|expérience.{0,80}(?:poste|emploi|fonction)|pourquoi.{0,80}(?:poste|emploi|candidature)|esperienza.{0,80}(?:ruolo|posizione|lavoro)|retribuzione(?:\s+attesa)?)/iu;
const APPLICANT_PROFILE_SECTION_RE = /\b(?:profile information|personal information|personal details|candidate information|contact information|profilinformationen|persönliche (?:daten|angaben|informationen)|données personnelles|informazioni personali|dati personali)\b/iu;
const JOB_QUESTIONS_SECTION_RE = /\b(?:job[-\s]specific (?:information|questions)|position[-\s]specific (?:information|questions)|application questions|stellenspezifische informationen|stellenbezogene fragen|questions (?:sur|liées à) (?:le poste|la candidature)|domande (?:specifiche|relative) (?:alla posizione|alla candidatura))\b/iu;
// With no posting key, a submission handoff can bind only a recognized receipt
// endpoint. A same-origin `/other/` page repeating the role title is not a
// receipt proof, even when the preceding review route was observed.
const RECEIPT_PATH_RE = /(?:^|\/)(?:thank[-_ ]?you|receipt|complete(?:d)?|confirmation|success|submitted)\/?$/i;
// SuccessFactors keeps its application, and the page that confirms it, at the same session route
// (`/portalcareer?_s.crb=…`, Helsana s2Tbwwjd 2026-11-10: «Vielen Dank für Ihre Bewerbung. Ihre Angaben wurden
// übermittelt.» with «Zurück zum Stellenüberblick» and «Profil anzeigen» only): no posting key and no receipt path.
const SUCCESS_FACTORS_APPLICATION_PATH_RE = /^\/(?:portalcareer|career)\/?$/i;
// The site's own language selector is chrome, not a form field left to fill.

/**
 * A SuccessFactors receipt: the runner pressed the final control on a SuccessFactors application page of this
 * origin, and the page now at the same application route says explicitly that the application was received
 * (CONFIRM_RE), with no form left on it (no field but the site's own controls the extractor marks `chrome`, no submit control) and no
 * validation error. The thank-you copy of a page that still holds the form is not one.
 */
function successFactorsReceipt(snapshot, { actual, source }) {
  if (!SUCCESS_FACTORS_APPLICATION_PATH_RE.test(actual.pathname) || !SUCCESS_FACTORS_APPLICATION_PATH_RE.test(source.pathname)) return false;
  if ((snapshot.errors || []).length) return false;
  const formFields = (snapshot.fields || []).filter(field => !field.disabled && !field.chrome
    && !['hidden', 'submit', 'button', 'reset', 'image'].includes(field.inputType));
  return formFields.length === 0 && !(snapshot.fields || []).some(field => field.invalid === true);
}

const APPLICATION_REGION_UNSUPPORTED_PATTERNS = [
  /\bbewerbung\w*\b.{0,120}\b(?:region|gebiet)\b.{0,120}\bnicht\s+(?:unterstütz|möglich|annehm|zulass)/iu,
  /\bapplication\w*\b.{0,120}\bregion\b.{0,120}\bnot\s+(?:currently\s+)?(?:support|accept)|\b(?:cannot|can't|unable\s+to)\b.{0,120}\bapplication\w*\b.{0,120}\bregion\b/iu,
  /\bcandidature\w*\b.{0,120}\brégion\b.{0,120}\b(?:ne\s+)?(?:pouvons\s+pas|accept|support)|\b(?:ne\s+)?(?:pouvons\s+pas|accept|support)\b.{0,120}\bcandidature\w*\b.{0,120}\brégion\b/iu,
  /\bcandidatur\w*\b.{0,120}\bregion(?:e)?\b.{0,120}\bnon\s+(?:support|accett|ammett)|\bnon\s+(?:possiamo|è\s+possibile|accettiamo)\b.{0,120}\bcandidatur\w*\b.{0,120}\bregion(?:e)?\b/iu,
];

/** The employer page explicitly blocks applications from the candidate's region. */
export function isApplicationRegionUnsupported(text = '') {
  const normalized = String(text || '').replace(/\s+/g, ' ');
  return APPLICATION_REGION_UNSUPPORTED_PATTERNS.some(pattern => pattern.test(normalized));
}

/** The directory containing a route, treating a canonical trailing slash as decoration. */
export function routeDirectory(pathname) {
  const path = String(pathname || '').replace(/\/+$/, '') || '/';
  const slash = path.lastIndexOf('/');
  return slash >= 0 ? path.slice(0, slash + 1) : '/';
}

function incompleteApplication(text) {
  // ATS labels such as "Resume / CV" name a document role. Treating that
  // noun as the verb "resume" can join it to a nearby "Submit application"
  // button and freeze an otherwise complete form.
  // An unrelated sentence about an application and a later CTA must not be
  // combined into an incomplete-state cue (for example, a profile link that
  // says it can be used "to complete your profile").
  const segments = String(text || '').replace(DOCUMENT_ROLE_LABEL_RE, 'CV document')
    // Require whitespace after sentence punctuation so periods inside URLs
    // remain part of the same segment.
    .split(/(?<=[.!?;])\s+/u).map((segment) => segment.trim()).filter(Boolean);
  let applicationContext = false;
  for (const segment of segments) {
    if (INCOMPLETE_APPLICATION_RE.test(segment)) return true;
    if (APPLICATION_REFERENCE_RE.test(segment)) {
      applicationContext = true;
      continue;
    }
    if (applicationContext && APPLICATION_ANAPHORIC_INCOMPLETE_RE.test(segment)) return true;
    // Carry application context through only an explicit saved/review-ready
    // state. An unrelated task such as "It takes two minutes to complete your
    // profile" ends the chain and cannot borrow the earlier application noun.
    applicationContext = applicationContext && APPLICATION_ANAPHORIC_BRIDGE_RE.test(segment);
  }
  return false;
}

function parsed(value) {
  try { return new URL(value); } catch { return null; }
}

function isLoopbackHostname(hostname) {
  const host = String(hostname || '').toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost') || host === '[::1]' || host === '::1') return true;
  const octets = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host)?.slice(1).map(Number);
  return Boolean(octets && octets[0] === 127 && octets.every(octet => Number.isInteger(octet) && octet >= 0 && octet <= 255));
}

function trustedPortalTransport(url) {
  return url.protocol === 'https:' || (url.protocol === 'http:' && isLoopbackHostname(url.hostname));
}

/** Only explicit posting keys bind a route. Account IDs/application IDs are not job IDs. */
export function portalJobKey(value, protocol = null) {
  const url = parsed(value);
  if (!url) return null;
  const entries = [...url.searchParams.entries()].filter(([key]) => /^(?:jobid|job_id|requisitionid|requisition_id|postingid)$/i.test(key));
  if (entries.length > 1 || (entries.length === 1 && !/^[a-z0-9_-]{1,100}$/i.test(entries[0][1]))) return null;
  const quotedPathKey = avaturePostingJobKey(value, protocol);
  if (quotedPathKey && entries.length === 1 && entries[0][1] !== quotedPathKey) return null;
  return entries[0]?.[1] || quotedPathKey || null;
}

function invalidPostingKey(value, protocol = null) {
  const url = parsed(value);
  return url && [...url.searchParams.keys()].some(key => /^(?:jobid|job_id|requisitionid|requisition_id|postingid)$/i.test(key))
    && !portalJobKey(value, protocol);
}

function boundRoute(value, applyUrl, sourceProtocol = null) {
  const url = parsed(value);
  const expected = parsed(applyUrl);
  const key = portalJobKey(applyUrl, sourceProtocol);
  const namespace = avaturePortalDirectory(applyUrl, sourceProtocol);
  return Boolean(url && expected && url.protocol === 'https:' && url.origin === expected.origin
    && (!namespace || routeDirectory(url.pathname) === namespace) && key && portalJobKey(value) === key);
}

function reviewNavigationRoute(value, applyUrl, sourceProtocol) {
  if (!boundRoute(value, applyUrl, sourceProtocol)) return false;
  const target = parsed(value);
  const source = parsed(applyUrl);
  if (target.username || target.password || source.username || source.password) return false;
  // An attested namespace stays exact through boundRoute. Without protocol,
  // keep direct source-directory routes and the existing root application/
  // owned-link case; do not infer another tenant's child namespace.
  const directory = avaturePortalDirectory(applyUrl, sourceProtocol)
    || routeDirectory(source.pathname);
  const route = target.pathname.slice(directory.length);
  return target.pathname.startsWith(directory) && (directory === '/' || !/^application\//i.test(route))
    && REVIEW_PATH_RE.test(route);
}

function normalized(value) {
  return String(value || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function titleBound(text, title) {
  const expected = normalized(title);
  return expected.split(' ').filter(word => word.length > 2).length >= 2
    && ` ${normalized(text)} `.includes(` ${expected} `);
}

function receiptTitleBound(text, title) {
  const match = CONFIRM_RE.exec(text);
  if (!match) return false;
  // Titles elsewhere in navigation, recommendations or footers cannot bind
  // a receipt. It must name this role in the receipt's own sentence.
  const before = text.slice(0, match.index).split(/[.!?\n]/).at(-1);
  const after = text.slice(match.index).split(/[.!?\n]/)[0];
  return titleBound(`${before} ${after}`, title);
}

/**
 * A Gravity Forms confirmation is evidence only when the guarded final click
 * belonged to that numbered form, the form has disappeared, and its native
 * confirmation container carries receipt copy. Validation always wins.
 */
export function gravityFormsSubmissionOutcome(snapshot, { finalSubmission } = {}) {
  const gravityForms = snapshot?.gravityForms;
  if (finalSubmission?.clicked !== true || !String(finalSubmission?.formId || '').trim()) return null;
  const expectedForm = gravityFormKey(finalSubmission.nativeFormId);
  if (!expectedForm) return null;
  if (gravityForms?.validationError === true
    && (gravityForms?.validationFormIds || []).some((formId) => gravityFormKey(formId) === expectedForm)) return 'validation';
  if ((gravityForms?.formIds || []).some((formId) => gravityFormKey(formId) === expectedForm)) return null;
  const receipt = (gravityForms?.confirmations || []).find((item) => item?.visible === true
    && gravityFormKey(item?.formId) === expectedForm
    && GRAVITY_FORMS_RECEIPT_RE.test(String(item?.text || '')));
  return receipt ? 'confirmed' : null;
}

/** Receipt copy must explicitly describe an application received for this posting. */
export function applicationReceipt(snapshot, { url = snapshot?.url, applyUrl, submissionUrl, sourceProtocol = null, postingEntry = false, job = {}, finalSubmission } = {}) {
  const text = String(snapshot?.text || '');
  if (!snapshot || invalidPostingKey(url) || invalidPostingKey(submissionUrl || applyUrl, sourceProtocol)) return false;
  const gravityFormsOutcome = gravityFormsSubmissionOutcome(snapshot, { finalSubmission });
  const hasGravityFormsNativeSignal = snapshot.gravityForms?.validationError === true
    || (snapshot.gravityForms?.confirmations || []).length > 0;
  if (gravityFormsOutcome === 'validation' || (hasGravityFormsNativeSignal && gravityFormsOutcome !== 'confirmed')
    || NOT_SUBMITTED_APPLICATION_RE.test(text) || REFUSED_RE.test(text)) return false;
  if (gravityFormsOutcome === 'confirmed') {
    const actual = parsed(url);
    const source = parsed(submissionUrl || applyUrl);
    return Boolean(actual && source && trustedPortalTransport(actual) && trustedPortalTransport(source)
      && actual.origin === source.origin && actual.pathname === source.pathname
      && !actual.username && !actual.password && !actual.hash && !source.username && !source.password && !source.hash);
  }
  if (!CONFIRM_RE.test(text)
    || PROFILE_CONTINUATION_RE.test(text) || incompleteApplication(text)
    || REVIEW_INSTRUCTIONS_RE.test(snapshot.text || '') || BEFORE_SEND_RE.test(snapshot.text || '')) return false;
  if ((snapshot.buttons || []).some(button => !button.chrome && SUBMIT_RE.test(button.text || ''))) return false;
  const actualJobKey = portalJobKey(url);
  const expectedJobKey = portalJobKey(submissionUrl || applyUrl, sourceProtocol);
  // A receipt naming a different posting never borrows the title from generic page chrome.
  if (actualJobKey && expectedJobKey && actualJobKey !== expectedJobKey) return false;
  const actual = parsed(url);
  const source = parsed(submissionUrl || applyUrl);
  // Production receipts require HTTPS. The only HTTP exception is the local
  // fake portal used by deterministic browser tests; public HTTP ATS hosts
  // remain unknown even when their page says thank you.
  if (!actual || !source || !trustedPortalTransport(actual) || !trustedPortalTransport(source) || actual.origin !== source.origin) return false;
  const namespace = avaturePortalDirectory(submissionUrl || applyUrl, sourceProtocol);
  if (namespace && routeDirectory(actual.pathname) !== namespace) return false;
  const samePostingKey = Boolean(actualJobKey && expectedJobKey && actualJobKey === expectedJobKey);
  // A handoff records the final form URL as an explicit binding even when the
  // ATS keeps its posting identity only in server-side session state. Without
  // that observed route, a repeated title on an arbitrary same-origin page is
  // not evidence that this application was received.
  const observedSubmissionRoute = Boolean(submissionUrl && source && source.origin === actual.origin
    && !source.username && !source.password && !source.hash);
  return samePostingKey || (observedSubmissionRoute && RECEIPT_PATH_RE.test(actual.pathname)
    && receiptTitleBound(snapshot.text, job.title))
    // SuccessFactors can redirect a verified posting/apply pair to the
    // employer root. The exact same-requisition pair is the binding here;
    // never enable this for an unverified employer landing page.
    || (postingEntry && actual.origin === source.origin && actual.pathname === '/'
      && !source.username && !source.password && !source.hash)
    || (observedSubmissionRoute && successFactorsReceipt(snapshot, { actual, source }));
}

/**
 * A direct GET link to this posting's review can be followed without arming
 * the send guard. Ambiguous Apply controls on an empty account/summary page
 * stay unknown. A review instruction explicitly announcing the final commit
 * makes its Apply control the real guarded action.
 */
export function applicationStage(snapshot, { url = snapshot?.url, applyUrl, sourceProtocol = null, postingEntry = false, job = {} } = {}) {
  if (invalidPostingKey(url) || invalidPostingKey(applyUrl, sourceProtocol)) return { kind: 'posting_mismatch' };
  const buttons = (snapshot?.buttons || []).filter(button => !button.chrome && !button.disabled);
  const text = String(snapshot?.text || '').replace(/\s+/g, ' ');
  if (applicationReceipt(snapshot, { url, applyUrl, sourceProtocol, postingEntry, job })) return { kind: 'receipt' };
  const mismatchedJob = parsed(url)?.origin === parsed(applyUrl)?.origin
    && portalJobKey(url) && portalJobKey(applyUrl, sourceProtocol) && portalJobKey(url) !== portalJobKey(applyUrl, sourceProtocol);
  if (mismatchedJob) return { kind: 'posting_mismatch' };
  // A thank-you page with an unbound route is still an observed application
  // surface, but it cannot be treated as a normal form or a receipt.
  if (CONFIRM_RE.test(text) && titleBound(text, job.title)) {
    return { kind: 'unknown_apply', prefinal: incompleteApplication(text) };
  }
  const quotedSource = avaturePostingJobKey(applyUrl, sourceProtocol);
  if (quotedSource && !sameAvaturePortal(sourceProtocol, snapshot?.protocol, url)
    && buttons.some(button => GENERIC_APPLY_RE.test(button.text || ''))) return { kind: 'unknown_apply', prefinal: true };
  const finalReview = Object.values(finalReviewStageChecks(snapshot, { url, applyUrl, sourceProtocol })).every(Boolean);
  if (finalReview) return { kind: 'final_review' };
  const pending = NOT_SUBMITTED_APPLICATION_RE.test(text) || PROFILE_CONTINUATION_RE.test(text)
    || incompleteApplication(text) || BEFORE_SEND_RE.test(text);
  const links = buttons.filter(button => GENERIC_APPLY_RE.test(button.text || '') && button.href
    && boundRoute(url, applyUrl, sourceProtocol) && reviewNavigationRoute(button.href, applyUrl, sourceProtocol)
    && !parsed(button.href)?.hash
    && [...parsed(button.href).searchParams.keys()].every(key => /^(?:jobid|job_id|requisitionid|requisition_id|postingid)$/i.test(key))
    && button.href !== url);
  if (pending && links.length === 1 && !(snapshot?.fields || []).some(field => !field.disabled && !['hidden', 'submit', 'button'].includes(field.inputType))) return { kind: 'review_navigation', control: links[0], destination: links[0].href };
  if (pending) return { kind: 'unknown_apply', prefinal: true };
  // A form's Apply can be a final send. A bare Apply on a profile/summary is
  // insufficient, even if an agent or a learned button calls it a submission.
  const openers = new Set(inPageApplicationOpeners(snapshot, url));
  const apply = buttons.filter(button => !openers.has(button) && GENERIC_APPLY_RE.test(button.text || ''));
  const applicationFields = apply.length === 1
    ? (snapshot?.fields || []).filter(field => field.formId === apply[0].formId && (field.frame || 0) === (apply[0].frame || 0))
    : [];
  const hasApplicationIdentity = applicationFields.some(isApplicantIdentity);
  const hasCv = snapshot?.uploadedCv === true
    || applicationFields.some(field => field.kind === 'file' || field.inputType === 'file');
  const hasApplicationQuestion = applicationFields.some(field =>
    APPLICATION_QUESTION_RE.test([field.label, field.name].filter(Boolean).join(' ')));
  // SuccessFactors can render the candidate profile, job questions and final
  // Apply action in separate forms. Accept that layout only when the profile
  // field is in an explicit applicant section, and both the application
  // question and Apply control share the same explicit job-question section.
  // A title plus unrelated same-frame forms (for example sign-in and
  // newsletter forms) is not an application group.
  const sameFrameFields = apply.length === 1
    ? (snapshot?.fields || []).filter(field => (field.frame || 0) === (apply[0].frame || 0))
    : [];
  const profileIdentity = sameFrameFields.some(field => isApplicantIdentity(field)
    && Boolean(apply[0]?.applicationScopeId)
    && field.applicationScopeId === apply[0].applicationScopeId
    && Boolean(field.sectionGroupId)
    && APPLICANT_PROFILE_SECTION_RE.test(field.sectionGroup || ''));
  const applySection = String(apply[0]?.sectionGroup || '').replace(/\s+/g, ' ').trim().toLowerCase();
  const associatedJobQuestion = sameFrameFields.some(field => {
    const section = String(field.sectionGroup || '').replace(/\s+/g, ' ').trim().toLowerCase();
    return Boolean(apply[0]?.sectionGroupId)
      && Boolean(apply[0]?.applicationScopeId)
      && field.applicationScopeId === apply[0].applicationScopeId
      && field.sectionGroupId === apply[0].sectionGroupId
      && section && section === applySection
      && JOB_QUESTIONS_SECTION_RE.test(field.sectionGroup || '')
      && APPLICATION_QUESTION_RE.test([field.label, field.name].filter(Boolean).join(' '));
  });
  const splitFormApplication = apply.length === 1 && !apply[0].href
    && Boolean(apply[0].formId)
    && titleBound(text, job.title)
    && profileIdentity
    && associatedJobQuestion;
  const applicationForm = (apply.length === 1 && !apply[0].href && Boolean(apply[0].formId)
    && hasApplicationIdentity && (hasCv || hasApplicationQuestion))
    || splitFormApplication;
  if (apply.length && (!applicationForm || pending)) return { kind: 'unknown_apply', prefinal: pending };
  return { kind: 'form' };
}
